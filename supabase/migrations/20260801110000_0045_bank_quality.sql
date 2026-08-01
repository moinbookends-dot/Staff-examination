-- ═════════════════════════════════════════════════════════════════════════════
-- 0045 — What the bank looks like as a whole, and which options nobody picks
--
-- Three additions, split by what they read, because what they read decides
-- whether they need SECURITY DEFINER — and the default in this codebase is that
-- they do not.
--
--   bank_quality()          Distributions over public.questions. SECURITY
--                           INVOKER: RLS already scopes the bank to the
--                           caller's company and brand, so the correct answer
--                           falls out of the existing policies and no bypass is
--                           introduced to compute a COUNT(*).
--
--   question_distractors()  Reads attempt_answers, which a chef has no policy
--                           on and must not be given one for. DEFINER, with
--                           its own permission check, exactly as question_stats.
--
--   bank_recommendations()  Advisories about the bank. Returns the SAME shape
--                           as exam_health so the UI renders both with one
--                           component and one remedy map.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY DISTRACTOR ANALYSIS IS WORTH A FUNCTION OF ITS OWN.                   │
-- │                                                                           │
-- │ facility and discrimination say a multiple-choice question is weak. They  │
-- │ cannot say WHY, and the why is almost always one of two things:           │
-- │                                                                           │
-- │   A distractor nobody ever picks is not a distractor. A four-option       │
-- │   question with two dead options is a two-option question, and it is      │
-- │   marked as though guessing gives you one chance in four when it gives    │
-- │   you one in two.                                                         │
-- │                                                                           │
-- │   A distractor chosen MORE OFTEN than the key is either a genuinely       │
-- │   misleading question or a mis-keyed one, and those look identical in     │
-- │   every other statistic. This is the only report that separates them.     │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- Both stored shapes are read directly rather than re-derived:
--   choice_single  answer->>'choice'          key->>'correct'
--   choice_multi   answer->'choices' (array)  key->'correct' (array)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The shape of the bank ────────────────────────────────────────────────────
--
-- One call, three distributions, because the dashboard wants them together and
-- three round trips to count the same table is three chances for them to
-- disagree about which questions were in scope.
--
-- `dimension` and `bucket` rather than a column per Bloom level: the taxonomy
-- has six values today and a wide table would need a migration to add a
-- seventh. Long format costs the UI one group-by and nothing else.
create or replace function public.bank_quality()
returns table (
  dimension  text,
  bucket     text,
  /** Null for buckets that are a real value; set for "not filled in". */
  is_missing boolean,
  n          int
)
language sql
stable
security invoker
set search_path = public
as $$
  -- Drawable, not "all": a retired question is not part of what the bank can
  -- deliver, and counting it makes the distributions describe a bank that
  -- cannot be drawn from. deleted_at is excluded by 0010's policy anyway; it is
  -- restated because relying on a policy for a semantic filter is how a filter
  -- silently changes when a policy is edited for an unrelated reason.
  with pool as (
    select q.* from public.questions q
     where q.deleted_at is null
       and public.question_is_drawable(q.status)
  )
  select 'bloom'::text, coalesce(p.bloom_level::text, 'unset'), p.bloom_level is null, count(*)::int
    from pool p group by p.bloom_level

  union all
  select 'difficulty', p.difficulty::text, false, count(*)::int
    from pool p group by p.difficulty

  union all
  select 'category', coalesce(c.name, 'uncategorised'), p.category_id is null, count(*)::int
    from pool p left join public.categories c on c.id = p.category_id
   group by c.name, p.category_id is null

  union all
  select 'type', p.type::text, false, count(*)::int
    from pool p group by p.type

  union all
  select 'status', p.status::text, false, count(*)::int
    from pool p group by p.status;
$$;

comment on function public.bank_quality() is
  'Bloom, difficulty, category, type and status distributions across the DRAWABLE bank. SECURITY INVOKER on purpose: 0010 already scopes questions to the caller''s company and brand, so counting under RLS gives the right answer without introducing a bypass to compute a COUNT(*). Long format (dimension, bucket) rather than a column per Bloom level, so adding a seventh level needs no migration.';

-- ── Which options actually get picked ────────────────────────────────────────
create or replace function public.question_distractors(p_question_id uuid)
returns table (
  option_id    text,
  option_text  text,
  is_correct   boolean,
  chosen_n     int,
  chosen_share numeric,
  /** A wrong option nobody picked: it contributes nothing but a longer read. */
  is_dead      boolean,
  /** A wrong option more popular than the key. Misleading, or mis-keyed. */
  outdraws_key boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope  text := public.analytics_scope();
  v_format text;
begin
  if v_scope not in ('team', 'all') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Company scope is checked here rather than left to a policy, because this
  -- function is DEFINER and therefore has none.
  select k.answer_key ->> 'format' into v_format
    from public.question_answer_keys k
    join public.questions q on q.id = k.question_id
   where k.question_id = p_question_id
     and q.company_id = public.my_company()
     and q.deleted_at is null;

  if v_format is null or v_format not in ('choice_single', 'choice_multi') then
    -- Not a multiple-choice question, or not one this caller may see. An empty
    -- result, not an exception: the dashboard asks this for whatever row was
    -- clicked and an essay question is a perfectly ordinary thing to click.
    return;
  end if;

  return query
  -- One row per SELECTION, not per answer: a choice_multi answer naming three
  -- options is three selections, which is what "how often was this picked"
  -- means for an option.
  --
  -- A CTE rather than a temporary table. Creating one inside a function
  -- declared STABLE would be a side effect the declaration denies, and the
  -- planner is entitled to believe the declaration.
  with picks as (
    select case when v_format = 'choice_single'
                then ans.answer ->> 'choice'
                else sel.value #>> '{}'
           end as option_id
      from public.analytics_attempts aa
      join public.attempt_answers ans on ans.attempt_id = aa.attempt_id
                                     and ans.question_id = p_question_id
      left join lateral jsonb_array_elements(
                  case when v_format = 'choice_multi'
                       then coalesce(ans.answer -> 'choices', '[]'::jsonb)
                       else '[]'::jsonb end) sel on true
     where (v_scope = 'all' or aa.outlet_id = public.my_outlet())
       and (v_format = 'choice_single' or sel.value is not null)
  ),
  total as (select count(*)::int as n from picks where picks.option_id is not null),
  options as (
    select opt.value ->> 'id'   as option_id,
           opt.value ->> 'text' as option_text,
           case when v_format = 'choice_single'
                then (opt.value ->> 'id') = (k.answer_key ->> 'correct')
                else k.answer_key -> 'correct' ? (opt.value ->> 'id')
           end as is_correct
      from public.questions q
      join public.question_answer_keys k on k.question_id = q.id
      cross join lateral jsonb_array_elements(coalesce(q.content -> 'choices', '[]'::jsonb)) opt
     where q.id = p_question_id
  ),
  counted as (
    select o.*, (select count(*)::int from picks p where p.option_id = o.option_id) as n
      from options o
  ),
  key_peak as (
    select coalesce(max(c.n), 0) as n from counted c where c.is_correct
  )
  select c.option_id,
         c.option_text,
         c.is_correct,
         c.n,
         case when (select t.n from total t) > 0
              then round(c.n::numeric / (select t.n from total t), 3) end,
         -- Both flags stay false below the floor rather than announcing that an
         -- option is dead on the strength of six selections. The same floor
         -- every other quality signal uses, from 0044.
         --
         -- The denominator is SELECTIONS, not respondents. They are the same
         -- number for choice_single, which is the overwhelming majority; for
         -- choice_multi a respondent naming three options contributes three,
         -- so the floor is reached sooner. That is the right direction — more
         -- selections is more evidence about the options themselves, which is
         -- what these two flags are about.
         (select t.n from total t) >= public.quality_min_sample()
           and not c.is_correct and c.n = 0,
         (select t.n from total t) >= public.quality_min_sample()
           and not c.is_correct and c.n > (select kp.n from key_peak kp)
    from counted c
   order by c.is_correct desc, c.n desc, c.option_id;
end;
$$;

grant execute on function public.question_distractors(uuid) to authenticated;

comment on function public.question_distractors(uuid) is
  'Per-option selection counts for a multiple-choice question. The only report that separates a genuinely misleading question from a mis-keyed one — both look identical in facility and discrimination, and both show up here as a distractor that outdraws the key. Returns nothing for non-choice questions rather than raising, because the dashboard asks for whatever row was clicked. DEFINER with its own permission check: it reads attempt_answers, which a chef has no policy on.';

-- ── What to do about it ──────────────────────────────────────────────────────
--
-- Same (code, severity, message, detail) shape as exam_health, deliberately.
-- The UI already renders that shape and already maps codes to remedies; a
-- second shape would mean a second renderer and a second remedy map to forget
-- to update.
create or replace function public.bank_recommendations()
returns table (
  code     text,
  severity text,
  message  text,
  detail   jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with pool as (
    select q.* from public.questions q
     where q.deleted_at is null
       and public.question_is_drawable(q.status)
  ),
  total as (select count(*)::int as n from pool)

  -- A bank too small to draw a paper from is the only thing here that stops
  -- work outright, and rule.short already says so per exam. This says it once,
  -- before a chef has built the exam that would have failed.
  select 'bank.thin'::text, 'blocking'::text,
         format('The bank holds %s drawable question(s). Rules will fall short.', t.n),
         jsonb_build_object('drawable', t.n)
    from total t where t.n < 10

  union all
  select 'bank.uncategorised', 'advisory',
         format('%s drawable question(s) have no category, so no rule can ever draw them.', count(*)),
         jsonb_build_object('question_count', count(*))
    from pool p where p.category_id is null
   having count(*) > 0

  union all
  select 'bank.no_bloom', 'advisory',
         format('%s drawable question(s) have no Bloom level, so the paper cannot be balanced for cognitive demand.', count(*)),
         jsonb_build_object('question_count', count(*))
    from pool p where p.bloom_level is null
   having count(*) > 0

  -- Concentration, not a fixed minimum per category: a bank may legitimately be
  -- mostly Food Safety. What it may not be is so lopsided that every drawn
  -- paper is the same category regardless of the rules.
  union all
  select 'bank.category_concentrated', 'advisory',
         format('"%s" holds %s%% of the drawable bank.', c.name,
                round(100.0 * count(*) / (select t.n from total t))),
         jsonb_build_object('category_id', p.category_id, 'category', c.name,
                            'share', round(100.0 * count(*) / (select t.n from total t)))
    from pool p join public.categories c on c.id = p.category_id
   group by p.category_id, c.name
  having (select t.n from total t) >= 20
     and 100.0 * count(*) / (select t.n from total t) > 60

  -- A bank that is all one difficulty cannot tell candidates apart, which is
  -- difficulty.narrow's complaint promoted from one paper to the whole bank.
  union all
  select 'bank.difficulty_narrow', 'advisory',
         'Every drawable question is the same difficulty, so no paper drawn from this bank can distinguish candidates.',
         jsonb_build_object('difficulty', min(p.difficulty))
    from pool p
  having count(distinct p.difficulty) = 1 and count(*) > 1;
$$;

comment on function public.bank_recommendations() is
  'Advisories about the bank as a whole, in exam_health''s exact (code, severity, message, detail) shape so the UI renders both with one component and one remedy map. SECURITY INVOKER — every fact here comes from public.questions, which RLS already scopes. Thresholds are about SHAPE (concentration, spread) rather than fixed minimums per category, because a bank that is mostly Food Safety is a legitimate bank.';
