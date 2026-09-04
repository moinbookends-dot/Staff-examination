-- ═══════════════════════════════════════════════════════════════════════════
-- 0092 — Live-exam monitoring depth, and a candidate's history for admins.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ AN OVERLAY, NOT A SYSTEM. Everything here reads the tables and follows    ║
-- ║ the authorisation idioms that already exist:                              ║
-- ║                                                                           ║
-- ║   · analytics_scope() (0030) decides own / team / all reach, and every    ║
-- ║     candidate-scoped function below checks the TARGET's row against it —  ║
-- ║     the same shape candidate_stats() has always used.                     ║
-- ║   · exam-scoped functions gate exactly as exam_participants (0064):       ║
-- ║     exams.read AND (attempts.read_team OR attempts.read_all), company-    ║
-- ║     checked.                                                              ║
-- ║   · analytics_attempts (0030) remains THE definition of an attempt that   ║
-- ║     counts. No function below restates its predicate.                     ║
-- ║   · Scores stay WITHHELD until released, exactly as exam_participants     ║
-- ║     has always done: a monitoring screen showing a score the candidate    ║
-- ║     has not been given would make the release policy meaningless.         ║
-- ║                                                                           ║
-- ║ exam_participants IS THE LIVE DEFINITION CAPTURED VERBATIM VIA            ║
-- ║ pg_get_functiondef, EXTENDED — new output columns, same guards, same      ║
-- ║ policy comments, same represent-by-latest-attempt rule.                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

-- Return type grows, so the old signature must go first.
drop function if exists public.exam_participants(uuid);

create or replace function public.exam_participants(p_exam_id uuid)
returns table(
  employee_id   uuid,
  full_name     text,
  email         text,
  department    text,
  outlet        text,
  started_at    timestamptz,
  submitted_at  timestamptz,
  expires_at    timestamptz,
  state         text,
  auto_submitted boolean,
  attempt_id    uuid,
  attempt_no    int,
  answered_n    int,
  question_n    int,
  last_activity timestamptz,
  score         numeric,
  max_score     numeric,
  passed        boolean,
  released      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
begin
  if auth.uid() is null
     or not public.has_perm('exams.read')
     or not (public.has_perm('attempts.read_all') or public.has_perm('attempts.read_team')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id and e.company_id = v_company and e.deleted_at is null
  ) then
    raise exception 'exam not found' using errcode = 'no_data_found';
  end if;

  return query
  with audience as (
    select a.id from public.exam_audience(p_exam_id) a
  ),
  best as (
    -- The attempt that represents this candidate: the latest non-voided one.
    select distinct on (t.candidate_id)
           t.id, t.candidate_id, t.started_at, t.submitted_at, t.expires_at,
           t.status, t.submit_reason, t.attempt_number,
           t.score, t.max_score, t.passed
      from public.attempts t
     where t.exam_id = p_exam_id and t.status <> 'voided'
     order by t.candidate_id, t.started_at desc
  ),
  progress as (
    -- One aggregate pass over the represented attempts, not a count per row.
    select aa.attempt_id,
           count(*) filter (where aa.answer is not null
                              and jsonb_typeof(aa.answer) <> 'null')::int as answered_n,
           max(greatest(aa.answered_at, aa.updated_at))                   as last_activity
      from public.attempt_answers aa
     where aa.attempt_id in (select best.id from best)
     group by aa.attempt_id
  ),
  sizes as (
    select aq.attempt_id, count(*)::int as question_n
      from public.attempt_questions aq
     where aq.attempt_id in (select best.id from best)
     group by aq.attempt_id
  )
  select
    p.id,
    p.full_name,
    p.email,
    d.name,
    o.name,
    b.started_at,
    b.submitted_at,
    b.expires_at,
    case
      when b.candidate_id is null        then 'not_started'
      when b.status = 'in_progress'      then 'in_progress'
      when b.status = 'expired'          then 'expired'
      when b.status = 'published'        then 'released'
      else 'submitted'
    end,
    -- The candidate did not press Submit themselves: the clock, a tab switch,
    -- or the sweeper closed the paper. 'user' and null both mean a real press.
    coalesce(b.submit_reason::text in ('timer', 'tab_switch', 'sweeper'), false),
    b.id,
    b.attempt_number,
    coalesce(pr.answered_n, 0),
    coalesce(sz.question_n, 0),
    coalesce(pr.last_activity, b.started_at),
    -- Withheld until released, exactly as my_attempts() does for the candidate.
    -- A monitoring screen showing a score the candidate has not been given
    -- would make the release policy meaningless.
    case when b.status = 'published' then b.score end,
    b.max_score,
    case when b.status = 'published' then b.passed end,
    coalesce(b.status = 'published', false)
    from audience a
    join public.profiles p on p.id = a.id
    left join public.departments d on d.id = p.department_id
    left join public.outlets o     on o.id = p.outlet_id
    left join best b     on b.candidate_id = p.id
    left join progress pr on pr.attempt_id = b.id
    left join sizes sz    on sz.attempt_id = b.id
   order by p.full_name nulls last, p.email;
end;
$$;

revoke all on function public.exam_participants(uuid) from public, anon;
grant execute on function public.exam_participants(uuid) to authenticated;

comment on function public.exam_participants(uuid) is
  'Per-person monitoring rows for one exam. 0064''s gate and score-withholding policy, extended by 0092 with outlet, attempt id/number, expiry, answered/question counts, last activity and the auto-submit flag.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Score spread for one exam's card — passed/failed and the range.
--
-- From analytics_attempts, so "counts" here can never disagree with /reports:
-- both read the one definition of an attempt that counts (0030).
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.exam_score_spread(p_exam_id uuid)
returns table(
  graded_n     int,
  passed_n     int,
  failed_n     int,
  avg_percent  numeric,
  best_percent numeric,
  worst_percent numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
begin
  -- Same gate as exam_participants: these are other people's outcomes.
  if auth.uid() is null
     or not public.has_perm('exams.read')
     or not (public.has_perm('attempts.read_all') or public.has_perm('attempts.read_team')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id and e.company_id = v_company and e.deleted_at is null
  ) then
    raise exception 'exam not found' using errcode = 'no_data_found';
  end if;

  return query
    select count(*)::int,
           count(*) filter (where aa.passed)::int,
           count(*) filter (where aa.passed is false)::int,
           round(avg(aa.percent), 1),
           max(aa.percent),
           min(aa.percent)
      from public.analytics_attempts aa
     where aa.exam_id = p_exam_id;
end;
$$;

revoke all on function public.exam_score_spread(uuid) from public, anon;
grant execute on function public.exam_score_spread(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- One candidate's attempt history — the rows behind their performance page.
--
-- Reach-checked EXACTLY as candidate_stats (0030): own always; another person
-- only with team scope (same outlet) or all scope, within the company.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.candidate_attempt_history(p_candidate_id uuid default null)
returns table(
  attempt_id   uuid,
  exam_id      uuid,
  exam_title   text,
  attempt_no   int,
  started_at   timestamptz,
  submitted_at timestamptz,
  minutes      int,
  score        numeric,
  max_score    numeric,
  percent      numeric,
  passed       boolean
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
    select aa.attempt_id,
           aa.exam_id,
           e.title,
           t.attempt_number,
           aa.started_at,
           aa.submitted_at,
           case when aa.submitted_at is not null and aa.started_at is not null
                then greatest(1, round(extract(epoch from aa.submitted_at - aa.started_at) / 60))::int
           end,
           aa.score,
           aa.max_score,
           aa.percent,
           aa.passed
      from public.analytics_attempts aa
      join public.exams e    on e.id = aa.exam_id
      join public.attempts t on t.id = aa.attempt_id
     where aa.candidate_id = v_target
     order by aa.submitted_at desc nulls last, aa.started_at desc;
end;
$$;

revoke all on function public.candidate_attempt_history(uuid) from public, anon;
grant execute on function public.candidate_attempt_history(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- One attempt, for a monitor — header and per-question breakdown.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THIS IS NOT my_result_detail. That one is own-only and release-gated,     │
-- │ because it faces the candidate. A monitor with team/all reach may open a  │
-- │ team member's settled attempt whether or not the result email went out —  │
-- │ that is what monitoring means — but the reach test is the same shape as   │
-- │ candidate_stats: company always, outlet unless attempts.read_all.         │
-- │                                                                           │
-- │ THE MODEL ANSWER IS THE ONE COLUMN GATED SEPARATELY. Correctness, the     │
-- │ candidate's answer and the score need team reach; the KEY itself needs    │
-- │ evaluation.evaluate — the permission that already sees keys in the        │
-- │ marking form. A chef who cannot mark papers has no business holding the   │
-- │ answer sheet of a paper other candidates may still be sitting.            │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.monitor_attempt_reach(p_attempt_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_candidate uuid;
begin
  if v_uid is null
     or not (public.has_perm('attempts.read_all') or public.has_perm('attempts.read_team')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.candidate_id into v_candidate
    from public.attempts a
    join public.profiles p on p.id = a.candidate_id
   where a.id = p_attempt_id
     and a.company_id = public.my_company()
     and (public.has_perm('attempts.read_all') or p.outlet_id = public.my_outlet());

  if v_candidate is null then
    -- Out of reach and nonexistent are deliberately the same answer.
    raise exception 'attempt not found' using errcode = '42501';
  end if;

  return v_candidate;
end;
$$;

revoke all on function public.monitor_attempt_reach(uuid) from public, anon, authenticated;

create or replace function public.monitor_attempt_header(p_attempt_id uuid)
returns table(
  attempt_id     uuid,
  candidate_id   uuid,
  candidate_name text,
  candidate_email text,
  department     text,
  outlet         text,
  exam_id        uuid,
  exam_title     text,
  attempt_no     int,
  status         text,
  submit_reason  text,
  started_at     timestamptz,
  submitted_at   timestamptz,
  expires_at     timestamptz,
  score          numeric,
  max_score      numeric,
  passed         boolean,
  pass_mark_percent numeric,
  question_n     int,
  answered_n     int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.monitor_attempt_reach(p_attempt_id);

  return query
    select a.id, a.candidate_id, p.full_name, p.email, d.name, o.name,
           e.id, e.title, a.attempt_number, a.status::text, a.submit_reason::text,
           a.started_at, a.submitted_at, a.expires_at,
           a.score, a.max_score, a.passed, e.pass_mark_percent,
           (select count(*)::int from public.attempt_questions aq where aq.attempt_id = a.id),
           (select count(*) filter (where aa.answer is not null and jsonb_typeof(aa.answer) <> 'null')::int
              from public.attempt_answers aa where aa.attempt_id = a.id)
      from public.attempts a
      join public.profiles p on p.id = a.candidate_id
      join public.exams e    on e.id = a.exam_id
      left join public.departments d on d.id = p.department_id
      left join public.outlets o     on o.id = p.outlet_id
     where a.id = p_attempt_id;
end;
$$;

revoke all on function public.monitor_attempt_header(uuid) from public, anon;
grant execute on function public.monitor_attempt_header(uuid) to authenticated;

create or replace function public.monitor_attempt_review(p_attempt_id uuid)
returns table(
  question_id  uuid,
  paper_position int,
  stem         text,
  marks        numeric,
  score        numeric,
  answered     boolean,
  correct      boolean,
  needs_review boolean,
  answer       jsonb,
  -- Null unless the caller holds evaluation.evaluate — see the box above.
  model_answer text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sees_keys boolean := public.has_perm('evaluation.evaluate');
begin
  perform public.monitor_attempt_reach(p_attempt_id);

  return query
    select aq.question_id,
           aq.position,
           coalesce(aq.snapshot ->> 'question', aq.snapshot #>> '{content,question}', ''),
           aq.marks,
           aa.score,
           coalesce(aa.answer is not null and jsonb_typeof(aa.answer) <> 'null', false),
           -- From grade_detail, the same verdict the grader recorded — never
           -- recomputed here, which would be a second grading engine.
           (aa.grade_detail ->> 'correct')::boolean,
           coalesce(aa.needs_review, false),
           aa.answer,
           case when v_sees_keys
                then coalesce(aq.answer_key ->> 'model', aq.answer_key ->> 'correct')
           end
      from public.attempt_questions aq
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
     order by aq.position;
end;
$$;

revoke all on function public.monitor_attempt_review(uuid) from public, anon;
grant execute on function public.monitor_attempt_review(uuid) to authenticated;
