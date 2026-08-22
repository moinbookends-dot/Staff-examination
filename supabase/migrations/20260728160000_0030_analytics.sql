-- ═════════════════════════════════════════════════════════════════════════════
-- 0030 — Analytics
--
-- Everything M6 reports is derived. No new facts are recorded here: the columns
-- that make this possible were put in place milestones ago, each for a reason
-- that only pays off now.
--
--   0011  attempt_answers.question_revision   two wordings are two questions
--   0014  exams.counts_towards_analytics      practice must not calibrate
--   0025  attempt_questions.marks             the denominator, frozen per paper
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ NO STATISTIC WITHOUT ITS SAMPLE SIZE.                                     │
-- │                                                                           │
-- │ Every function here returns n alongside the number, and discrimination —  │
-- │ the one that is worthless on small samples and looks authoritative        │
-- │ anyway — is NULL below MIN_DISCRIMINATION_N attempts rather than rounded  │
-- │ into a confident-looking decimal.                                         │
-- │                                                                           │
-- │ The grading engine's warning applies here word for word: a wrong number   │
-- │ that looks plausible is worse than no number, because a human will trust  │
-- │ it and act on it. A chef retiring a question on a discrimination index    │
-- │ computed from four attempts is exactly that failure.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- Per-question analytics scans by question; every existing index on these
-- tables is attempt-first, which is the wrong way round for it.
create index if not exists attempt_answers_question_idx
  on public.attempt_answers (question_id);
create index if not exists attempt_questions_question_idx
  on public.attempt_questions (question_id, question_revision);

-- ═════════════════════════════════════════════════════════════════════════════
-- WHICH ATTEMPTS COUNT — one definition, every consumer
--
-- Settled means the marking is finished and the score will not change again.
-- An attempt still with an evaluator has no score worth averaging, and one that
-- was voided was invalidated on purpose.
--
-- Publication is deliberately NOT the test. A marked-but-unreleased paper is a
-- real measurement; whether the candidate may see it is a different question,
-- answered in 0028, and conflating the two would make a chef's analytics jump
-- around as results are released.
--
-- INTERNAL: reached only from the definer functions below.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace view public.analytics_attempts as
  select a.id            as attempt_id,
         a.exam_id,
         a.candidate_id,
         a.company_id,
         a.score,
         a.max_score,
         a.passed,
         a.started_at,
         a.submitted_at,
         case when coalesce(a.max_score, 0) > 0
              then round((a.score / a.max_score) * 100, 1) end as percent,
         p.outlet_id,
         p.department_id,
         e.kind          as exam_kind,
         e.pass_mark_percent
    from public.attempts a
    join public.exams e    on e.id = a.exam_id
    join public.profiles p on p.id = a.candidate_id
   where a.status in ('auto_graded', 'evaluated', 'verified', 'published')
     -- 0014: practice and quiz responses are low-stakes and would poison
     -- difficulty calibration.
     and e.counts_towards_analytics
     and e.deleted_at is null
     and p.deleted_at is null;

revoke all on public.analytics_attempts from public, anon, authenticated;

comment on view public.analytics_attempts is
  'THE definition of an attempt that counts towards analytics: marking settled, exam flagged as calibrating, exam and candidate not deleted. Every reporting function reads this rather than restating the predicate, because two copies of "which attempts count" is how two reports quietly disagree about the same number.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Scope
-- ═════════════════════════════════════════════════════════════════════════════

/**
 * How far the caller may look: 'all' (company), 'team' (their outlet), 'own'.
 *
 * Returned as one value so each report expresses its scoping the same way,
 * rather than each re-deriving it from three permission checks and one of them
 * getting the precedence wrong.
 */
create or replace function public.analytics_scope()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
           when public.has_perm('reports.read_all')  then 'all'
           when public.has_perm('reports.read_team') then 'team'
           when public.has_perm('reports.read_own')  then 'own'
           else 'none'
         end
$$;

revoke all on function public.analytics_scope() from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- One candidate's record
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.candidate_stats(p_candidate_id uuid default null)
returns table (
  candidate_id   uuid,
  attempts_n     int,
  passed_n       int,
  pass_rate      numeric,
  avg_percent    numeric,
  best_percent   numeric,
  last_attempt_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_candidate_id, auth.uid());
  v_scope  text := public.analytics_scope();
begin
  if v_uid is null or v_scope = 'none' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Looking at somebody else requires more than reports.read_own, and the
  -- reach is checked against THEM rather than against the caller's wish.
  if v_target <> v_uid then
    if v_scope = 'own' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.profiles p
       where p.id = v_target
         and p.company_id = public.my_company()
         and (v_scope = 'all' or p.outlet_id = public.my_outlet())
    ) then
      raise exception 'candidate not found' using errcode = '42501';
    end if;
  end if;

  return query
    select v_target,
           count(*)::int,
           count(*) filter (where aa.passed)::int,
           case when count(*) > 0
                then round((count(*) filter (where aa.passed))::numeric / count(*) * 100, 1) end,
           round(avg(aa.percent), 1),
           max(aa.percent),
           max(aa.submitted_at)
      from public.analytics_attempts aa
     where aa.candidate_id = v_target;
end;
$$;

grant execute on function public.candidate_stats(uuid) to authenticated;

/**
 * Where one candidate is strong and weak, by category.
 *
 * Averages the proportion of marks earned per question rather than per paper,
 * so a category carrying one question on a long exam is not weighted as though
 * it carried ten.
 */
create or replace function public.candidate_category_stats(p_candidate_id uuid default null)
returns table (
  category_id   uuid,
  category_name text,
  questions_n   int,
  facility      numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_candidate_id, auth.uid());
  v_scope  text := public.analytics_scope();
begin
  if v_uid is null or v_scope = 'none' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target <> v_uid and v_scope = 'own' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target <> v_uid and not exists (
    select 1 from public.profiles p
     where p.id = v_target
       and p.company_id = public.my_company()
       and (v_scope = 'all' or p.outlet_id = public.my_outlet())
  ) then
    raise exception 'candidate not found' using errcode = '42501';
  end if;

  return query
    select c.id, c.name,
           count(*)::int,
           round(avg(ans.score / nullif(aq.marks, 0)), 3)
      from public.analytics_attempts aa
      join public.attempt_questions aq on aq.attempt_id = aa.attempt_id
      join public.attempt_answers  ans on ans.attempt_id = aa.attempt_id
                                      and ans.question_id = aq.question_id
      join public.questions q on q.id = aq.question_id
      join public.categories c on c.id = q.category_id
     where aa.candidate_id = v_target
       and ans.score is not null
     group by c.id, c.name
     order by 4 asc nulls last;
end;
$$;

grant execute on function public.candidate_category_stats(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The team
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.team_stats()
returns table (
  candidate_id    uuid,
  full_name       text,
  outlet_id       uuid,
  attempts_n      int,
  passed_n        int,
  pass_rate       numeric,
  avg_percent     numeric,
  last_attempt_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope text := public.analytics_scope();
begin
  if v_scope not in ('team', 'all') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select p.id, p.full_name, p.outlet_id,
           count(aa.attempt_id)::int,
           count(*) filter (where aa.passed)::int,
           case when count(aa.attempt_id) > 0
                then round((count(*) filter (where aa.passed))::numeric
                           / count(aa.attempt_id) * 100, 1) end,
           round(avg(aa.percent), 1),
           max(aa.submitted_at)
      from public.profiles p
      -- LEFT, so somebody who has sat nothing appears with a zero rather than
      -- vanishing. "Who has not done this yet" is the question a chef opens
      -- this report to answer.
      left join public.analytics_attempts aa on aa.candidate_id = p.id
     where p.company_id = public.my_company()
       and p.approval_status = 'approved'
       and p.deleted_at is null
       and (v_scope = 'all' or p.outlet_id = public.my_outlet())
     group by p.id, p.full_name, p.outlet_id
     order by p.full_name;
end;
$$;

grant execute on function public.team_stats() to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Exams
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.exam_stats(p_exam_id uuid default null)
returns table (
  exam_id          uuid,
  title            text,
  attempts_n       int,
  candidates_n     int,
  pass_rate        numeric,
  avg_percent      numeric,
  median_percent   numeric,
  avg_minutes      numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope text := public.analytics_scope();
begin
  if v_scope not in ('team', 'all') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select e.id, e.title,
           count(aa.attempt_id)::int,
           count(distinct aa.candidate_id)::int,
           case when count(aa.attempt_id) > 0
                then round((count(*) filter (where aa.passed))::numeric
                           / count(aa.attempt_id) * 100, 1) end,
           round(avg(aa.percent), 1),
           round(percentile_cont(0.5) within group (order by aa.percent)::numeric, 1),
           round(avg(extract(epoch from (aa.submitted_at - aa.started_at)) / 60)::numeric, 1)
      from public.exams e
      left join public.analytics_attempts aa on aa.exam_id = e.id
        and (v_scope = 'all' or aa.outlet_id = public.my_outlet())
     where e.company_id = public.my_company()
       and e.deleted_at is null
       and (p_exam_id is null or e.id = p_exam_id)
     group by e.id, e.title
     order by e.title;
end;
$$;

grant execute on function public.exam_stats(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Questions — the calibration report
--
-- KEYED ON (question_id, revision), which is the whole reason 0011 exists.
-- Rewording a question makes it a different question; merging the two into one
-- statistic produces a difficulty that describes neither and a discrimination
-- index that is actively misleading.
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
           (case
              when agg.facility >= 0.90 then 1
              when agg.facility >= 0.75 then 2
              when agg.facility >= 0.55 then 3
              when agg.facility >= 0.35 then 4
              else 5
            end)::smallint,
           -- Two bands apart, and only once there is enough data to say so.
           agg.n >= c_min_n
             and abs(q.difficulty - (case
                                       when agg.facility >= 0.90 then 1
                                       when agg.facility >= 0.75 then 2
                                       when agg.facility >= 0.55 then 3
                                       when agg.facility >= 0.35 then 4
                                       else 5
                                     end)) >= 2
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

comment on function public.question_stats(uuid, uuid) is
  'Item analysis, keyed on (question_id, revision) because 0011 made rewording a question produce a new revision precisely so that its statistics start again. Discrimination is NULL under ten responses rather than rounded: a correlation on four attempts is noise, and it renders identically to a real one.';
