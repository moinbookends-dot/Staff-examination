-- ═════════════════════════════════════════════════════════════════════════════
-- 0044 — Quality primitives: one definition of every threshold
--
-- M9 adds statistical quality signals in three places — the bank's health
-- column, the quality dashboard, and exam_health's advisories. Before any of
-- them exist, the thresholds they all key on have to live in exactly one place,
-- or M9 ships the drift it is supposed to detect.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE DUPLICATION THIS MIGRATION FOUND.                                     │
-- │                                                                           │
-- │ 0030's question_stats writes the facility→difficulty band expression out  │
-- │ TWICE: once to return observed_difficulty, and once inside the `misrated` │
-- │ calculation. They are identical today. Nothing makes them stay identical.  │
-- │                                                                           │
-- │ Change one band — say 0.90 to 0.92, a plausible tuning — and `misrated`   │
-- │ starts disagreeing with observed_difficulty in exactly the narrow window   │
-- │ between the two thresholds. The screen would show a question rated 1       │
-- │ against an observed 1 and flag it as misrated anyway, and the person       │
-- │ reading it has no way to tell that from a bug in their own understanding.  │
-- │                                                                           │
-- │ observed_difficulty_band() is that expression, once. question_stats below  │
-- │ is 0030's function with the two copies replaced by calls to it and NOTHING │
-- │ ELSE CHANGED — extracted programmatically from 0030 rather than retyped,   │
-- │ because retyping a function from memory is how 0039 lost a set_config.     │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY question_quality IS ONE FUNCTION AND NOT A RULE PER CONSUMER.         │
-- │                                                                           │
-- │ "Is this question any good" is asked by the bank, by the dashboard, and by │
-- │ exam_health when a paper is checked. Three implementations would be three  │
-- │ answers. question_quality() is the only one, and exam_health calls it —   │
-- │ structurally what publish_exam already does with exam_health itself.       │
-- │                                                                           │
-- │ It returns FLAGS, not a score out of ten. A single number invites ranking  │
-- │ questions by it and retiring the bottom of the list, which is precisely    │
-- │ the use these sample sizes cannot support.                                 │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The band, once ───────────────────────────────────────────────────────────
--
-- IMMUTABLE: it reads nothing but its argument, so Postgres may fold it into an
-- index expression or constant-fold it in a WHERE clause. Also the honest
-- declaration — a threshold table that varied by row would be a different bug.
--
-- Facility is the mean PROPORTION of available marks earned, so it runs 0..1
-- and the scale is inverted: everybody scoring full marks means the question is
-- easy, which is a 1 on the authors' scale.
create or replace function public.observed_difficulty_band(p_facility numeric)
returns smallint
language sql
immutable
parallel safe
set search_path = public
as $$
  select (case
            when p_facility is null then null
            when p_facility >= 0.90 then 1
            when p_facility >= 0.75 then 2
            when p_facility >= 0.55 then 3
            when p_facility >= 0.35 then 4
            else 5
          end)::smallint;
$$;

comment on function public.observed_difficulty_band(numeric) is
  'Facility (0..1) onto the authors 1-5 difficulty scale, inverted: high facility means an easy question. Extracted from 0030, where the same CASE was written out twice inside question_stats — once for observed_difficulty and once inside misrated — so that tuning a band could not make the two disagree. Bands are deliberately coarse: this is a prompt to re-read a question, not a measurement.';

-- ── The sample floor, once ───────────────────────────────────────────────────
--
-- 0030 declares `c_min_n constant int := 10` inside question_stats, where no
-- other function can see it. Every consumer that wants to say "not enough data
-- yet" would otherwise pick its own number, and the dashboard would disagree
-- with the bank about whether a question has been measured.
create or replace function public.quality_min_sample()
returns int
language sql
immutable
parallel safe
set search_path = public
as $$ select 10; $$;

comment on function public.quality_min_sample() is
  'Attempts below which a per-question statistic is noise wearing a decimal point. Matches the c_min_n that 0030 declares privately inside question_stats; exposed so the dashboard, the bank and exam_health cannot each choose a different floor.';

-- ═════════════════════════════════════════════════════════════════════════════
-- question_stats — 0030's function, with the duplicated band replaced by calls
--
-- Reproduced in full because CREATE OR REPLACE FUNCTION has no patch form. Every
-- line below except the two marked substitutions is 0030's, extracted from that
-- file rather than rewritten.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.question_stats(
  p_question_id uuid default null,
  p_category_id uuid default null
)
returns table (
  question_id        uuid,
  question_revision  int,
  stem               text,
  category_id        uuid,
  category_name      text,
  author_difficulty  smallint,
  attempts_n         int,
  /** Mean proportion of the available marks earned. 1.0 = everybody got it. */
  facility           numeric,
  /** Proportion scoring full marks. Equal to facility for all-or-nothing items. */
  full_marks_rate    numeric,
  /**
   * Correlation between how a candidate did on THIS question and how they did
   * on the paper overall. Near zero means the question does not distinguish
   * people who know the material from people who do not; negative means it
   * distinguishes them backwards. NULL below the sample floor.
   */
  discrimination     numeric,
  /** Where the author's 1–5 rating disagrees with what actually happened. */
  observed_difficulty smallint,
  misrated           boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope text := public.analytics_scope();
  -- Below this, a correlation is noise wearing a decimal point.
  c_min_n constant int := 10;
begin
  if v_scope not in ('team', 'all') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    with responses as (
      select aq.question_id,
             aq.question_revision,
             ans.score / nullif(aq.marks, 0) as item_fraction,
             aa.percent                       as paper_percent,
             ans.score >= aq.marks            as full_marks
        from public.analytics_attempts aa
        join public.attempt_questions aq  on aq.attempt_id = aa.attempt_id
        join public.attempt_answers   ans on ans.attempt_id = aa.attempt_id
                                         and ans.question_id = aq.question_id
       where ans.score is not null
         and (v_scope = 'all' or aa.outlet_id = public.my_outlet())
    ),
    agg as (
      select r.question_id, r.question_revision,
             count(*)::int                       as n,
             round(avg(r.item_fraction), 3)      as facility,
             round(avg(case when r.full_marks then 1 else 0 end)::numeric, 3) as full_rate,
             case when count(*) >= c_min_n
                  then round(corr(r.item_fraction, r.paper_percent)::numeric, 3) end as disc
        from responses r
       group by r.question_id, r.question_revision
    )
    select q.id, agg.question_revision, q.stem, q.category_id, c.name, q.difficulty,
           agg.n, agg.facility, agg.full_rate, agg.disc,
           -- Facility inverted onto the authors' 1–5 scale, so the two are
           -- comparable at a glance. Bands are deliberately coarse: this is a
           -- prompt to re-read the question, not a measurement.
           public.observed_difficulty_band(agg.facility),
           -- Two bands apart, and only once there is enough data to say so.
           agg.n >= c_min_n
             and abs(q.difficulty - public.observed_difficulty_band(agg.facility)) >= 2
      from agg
      join public.questions q on q.id = agg.question_id
      left join public.categories c on c.id = q.category_id
     where q.company_id = public.my_company()
       and q.deleted_at is null
       and (p_question_id is null or q.id = p_question_id)
       and (p_category_id is null or q.category_id = p_category_id)
     order by agg.n desc, q.stem;
end;
$$;

grant execute on function public.question_stats(uuid, uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- question_quality — the statistical verdicts, for every consumer
--
-- SECURITY DEFINER with its own permission check, matching question_stats: it
-- reads attempt data across a whole outlet or company, which the caller has no
-- policy on and must not be given one for.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EVERY FLAG CARRIES ITS SAMPLE SIZE, AND NONE FIRES BELOW THE FLOOR.       │
-- │                                                                           │
-- │ 0030's warning applies verbatim: a wrong number that looks plausible is   │
-- │ worse than no number, because a human will trust it and act on it. A chef │
-- │ retiring a question because four people found it hard is that failure.    │
-- │                                                                           │
-- │ So `unproven` is a first-class verdict rather than an absence. A question │
-- │ nobody has answered enough times is not a good question or a bad one, and │
-- │ saying so out loud is what stops an empty flag list reading as a clean     │
-- │ bill of health.                                                           │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.question_quality(
  p_question_id uuid default null,
  p_category_id uuid default null
)
returns table (
  question_id   uuid,
  stem          text,
  attempts_n    int,
  facility      numeric,
  discrimination numeric,
  author_difficulty   smallint,
  observed_difficulty smallint,
  /** One of: unproven, misrated, non_discriminating, negative_discrimination,
      too_easy, too_hard, sound. Ordered worst-first by the CASE below. */
  verdict       text,
  /** Machine-readable reasons; the UI turns these into sentences. */
  flags         text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope text := public.analytics_scope();
  c_min_n constant int := public.quality_min_sample();
begin
  if v_scope not in ('team', 'all') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with s as (
    -- The ONE source of facility, discrimination and misrated. Recomputing any
    -- of them here would be the second opinion that eventually disagrees.
    select * from public.question_stats(p_question_id, p_category_id)
  )
  select s.question_id,
         s.stem,
         s.attempts_n,
         s.facility,
         s.discrimination,
         s.author_difficulty,
         s.observed_difficulty,
         case
           -- Order matters: the first true branch is the verdict, and they are
           -- arranged worst-consequence first. A question that discriminates
           -- BACKWARDS is reported as that even if it is also misrated, because
           -- that is the one to look at today.
           when s.attempts_n < c_min_n                       then 'unproven'
           when s.discrimination is not null
            and s.discrimination < 0                         then 'negative_discrimination'
           when s.misrated                                   then 'misrated'
           when s.discrimination is not null
            and s.discrimination < 0.10                      then 'non_discriminating'
           when s.facility >= 0.95                           then 'too_easy'
           when s.facility <= 0.20                           then 'too_hard'
           else 'sound'
         end,
         (
           select array_remove(array[
             case when s.attempts_n < c_min_n then 'unproven' end,
             case when s.discrimination is not null and s.discrimination < 0
                  then 'negative_discrimination' end,
             case when s.misrated then 'misrated' end,
             case when s.discrimination is not null and s.discrimination >= 0
                   and s.discrimination < 0.10 then 'non_discriminating' end,
             case when s.attempts_n >= c_min_n and s.facility >= 0.95 then 'too_easy' end,
             case when s.attempts_n >= c_min_n and s.facility <= 0.20 then 'too_hard' end
           ], null)
         )
    from s
   order by s.attempts_n desc, s.stem;
end;
$$;

grant execute on function public.question_quality(uuid, uuid) to authenticated;

comment on function public.question_quality(uuid, uuid) is
  'Statistical quality verdicts per question, derived entirely from question_stats so the bank, the dashboard and exam_health cannot disagree about what makes a question weak. Flags rather than a score: a single number invites sorting the bank by it and retiring the tail, which is exactly the use these sample sizes cannot support. Never fires below quality_min_sample() — "unproven" is a verdict, not an absence.';
