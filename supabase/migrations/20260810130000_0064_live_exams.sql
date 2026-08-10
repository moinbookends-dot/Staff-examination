-- ═════════════════════════════════════════════════════════════════════════════
-- 0064 — Live exams: when a result is released, and who has sat what.
--
-- 0062 and 0063 built delivery. This adds the two things the operational
-- surfaces need and the delivery stack never had: a way to say WHEN results
-- come out, and a way to ask "who has sat this and who has not".
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE exam_status ENUM IS NOT TOUCHED, DELIBERATELY.                        │
-- │                                                                           │
-- │ The product speaks of DRAFT / SCHEDULED / LIVE / CLOSED / CANCELLED. The  │
-- │ column already holds draft, scheduled, active, completed, archived and    │
-- │ cancelled, and six migrations of policies and one transition trigger are  │
-- │ built on those labels. Renaming two of them to serve a screen would touch │
-- │ every one of those for no behavioural gain.                               │
-- │                                                                           │
-- │ exam_state() below maps the stored status and the dates onto the product's│
-- │ vocabulary. It is DERIVED ON READ and never stored, so it cannot go stale │
-- │ the way a status written by a nightly job would — and there is no pg_cron │
-- │ on this project to run one.                                              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ DERIVED STATE IS FOR DISPLAY. IT IS NOT THE GATE.                        ║
-- ║                                                                           ║
-- ║ start_attempt() already reads opens_at and closes_at directly on every    ║
-- ║ call and refuses outside the window, and it did so before this migration  ║
-- ║ existed. Nothing here is load-bearing for authorisation; a candidate      ║
-- ║ could not sit a closed exam even if exam_state() were wrong.              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- When results come out
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NEITHER OPTION CAN MEAN "AT SUBMIT", AND THE BLUEPRINT IS WHY.           │
 * │                                                                           │
 * │ Every generated paper is 80/20 — 16 MCQ + 4 short, or 40 + 10 — so every │
 * │ paper contains short answers and every submission stops at `evaluating`   │
 * │ for a human. A result cannot exist, let alone be released, before somebody│
 * │ marks them.                                                               │
 * │                                                                           │
 * │ So `immediate` means "the moment marking is finished, per candidate", and │
 * │ `on_close` means "when the exam's deadline passes, so everybody gets      │
 * │ theirs together". Both are honest descriptions of what the system can do. │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create type public.results_release as enum ('immediate', 'on_close');

comment on type public.results_release is
  'When a marked attempt is released to the candidate. immediate = as soon as marking finishes; on_close = held until the exam deadline so the cohort sees results together. Neither can precede marking — every paper carries short answers.';

alter table public.exams
  add column results_release public.results_release not null default 'immediate';

comment on column public.exams.results_release is
  'Release policy for this exam. Only consulted for paper-backed exams (paper_id is not null); legacy rule-drawn exams keep their manual publish_attempt() flow untouched.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The product's vocabulary, derived
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.exam_state(
  p_status    public.exam_status,
  p_opens_at  timestamptz,
  p_closes_at timestamptz
)
returns text
language sql
stable
as $$
  select case
    when p_status = 'draft'     then 'draft'
    when p_status = 'cancelled' then 'cancelled'
    -- archived and completed are both "finished with" as far as a candidate
    -- or a monitoring screen is concerned.
    when p_status in ('completed', 'archived') then 'closed'
    -- scheduled / active: the dates decide.
    when p_closes_at is not null and now() >= p_closes_at then 'closed'
    when p_opens_at  is not null and now() <  p_opens_at  then 'scheduled'
    else 'live'
  end;
$$;

comment on function public.exam_state(public.exam_status, timestamptz, timestamptz) is
  'Maps the stored status and the window onto the product vocabulary: draft, scheduled, live, closed, cancelled. Derived on read — never stored, so it cannot go stale. Display only; start_attempt() enforces the window itself.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Releasing what is due
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CALLED ON READ, BECAUSE THERE IS NO SCHEDULER.                           │
 * │                                                                           │
 * │ pg_cron is not installed on this project. Rather than pretend a timer     │
 * │ exists, the monitoring and results screens call this and it releases      │
 * │ whatever has become due. The cost is that a result appears when somebody  │
 * │ next looks, not on the exact second the exam closes.                      │
 * │                                                                           │
 * │ SCOPED TO PAPER-BACKED EXAMS ONLY. The legacy rule-drawn exams have their │
 * │ own manual evaluation → publish_attempt() flow, and auto-releasing those  │
 * │ would change behaviour nobody asked to change.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create or replace function public.release_due_results()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or not public.has_perm('exams.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with due as (
    update public.attempts a
       set status = 'published',
           published_at = now()
      from public.exams e
     where e.id = a.exam_id
       and e.company_id = public.my_company()
       -- Paper-backed only. See the box above.
       and e.paper_id is not null
       and e.deleted_at is null
       -- The transition trigger admits exactly these three into 'published'.
       and a.status in ('auto_graded', 'evaluated', 'verified')
       and (
             e.results_release = 'immediate'
          or (e.results_release = 'on_close'
              and e.closes_at is not null
              and now() >= e.closes_at)
           )
    returning a.id
  )
  select count(*)::int into v_count from due;

  return v_count;
end;
$$;

revoke execute on function public.release_due_results() from public, anon;
grant  execute on function public.release_due_results() to authenticated;

comment on function public.release_due_results() is
  'Releases marked attempts whose exam says they are due. Called on read by the monitoring and results screens because this project has no pg_cron. Paper-backed exams only.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Who has sat this, and who has not
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.exam_participation(p_exam_id uuid)
returns table(
  eligible    integer,
  not_started integer,
  in_progress integer,
  submitted   integer,
  released    integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
begin
  if auth.uid() is null or not public.has_perm('exams.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The same "not found rather than refused" rule the rest of this schema
  -- uses: an exam in another company cannot be probed for existence.
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
  -- One row per candidate: their FURTHEST attempt, so somebody who started,
  -- ran out of time and started again is counted once, at their best state.
  latest as (
    select t.candidate_id,
           bool_or(t.status = 'in_progress')                                as running,
           bool_or(t.status = 'published')                                  as out,
           bool_or(t.status not in ('in_progress', 'voided'))               as done
      from public.attempts t
     where t.exam_id = p_exam_id
     group by t.candidate_id
  )
  select
    (select count(*)::int from audience),
    (select count(*)::int from audience a
      where not exists (select 1 from latest l where l.candidate_id = a.id)),
    (select count(*)::int from audience a
      join latest l on l.candidate_id = a.id where l.running),
    (select count(*)::int from audience a
      join latest l on l.candidate_id = a.id where l.done),
    (select count(*)::int from audience a
      join latest l on l.candidate_id = a.id where l.out);
end;
$$;

revoke execute on function public.exam_participation(uuid) from public, anon;
grant  execute on function public.exam_participation(uuid) to authenticated;

comment on function public.exam_participation(uuid) is
  'Counts for one exam: eligible, not started, in progress, submitted, released. Definer because exam_audience() reads profiles across outlets, which no single caller''s RLS admits.';

/*
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS RETURNS OTHER PEOPLE'S SCORES, SO IT ASKS FOR MORE THAN exams.read.  ║
 * ║                                                                           ║
 * ║ exam_participation() above is counts, which reveal nothing about an        ║
 * ║ individual. This is the per-employee table, and a row here names somebody  ║
 * ║ and what they scored. attempts.read_team or attempts.read_all is the      ║
 * ║ existing grant for exactly that — a Chef and HR hold one, an Employee and ║
 * ║ an Editor hold neither.                                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
create or replace function public.exam_participants(p_exam_id uuid)
returns table(
  employee_id  uuid,
  full_name    text,
  email        text,
  department   text,
  started_at   timestamptz,
  submitted_at timestamptz,
  state        text,
  score        numeric,
  max_score    numeric,
  passed       boolean,
  released     boolean
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
           t.candidate_id, t.started_at, t.submitted_at, t.status,
           t.score, t.max_score, t.passed
      from public.attempts t
     where t.exam_id = p_exam_id and t.status <> 'voided'
     order by t.candidate_id, t.started_at desc
  )
  select
    p.id,
    p.full_name,
    p.email,
    d.name,
    b.started_at,
    b.submitted_at,
    case
      when b.candidate_id is null        then 'not_started'
      when b.status = 'in_progress'      then 'in_progress'
      when b.status = 'expired'          then 'expired'
      when b.status = 'published'        then 'released'
      else 'submitted'
    end,
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
    left join best b on b.candidate_id = p.id
   order by p.full_name nulls last, p.email;
end;
$$;

revoke execute on function public.exam_participants(uuid) from public, anon;
grant  execute on function public.exam_participants(uuid) to authenticated;

comment on function public.exam_participants(uuid) is
  'One row per eligible employee for an exam, with their attempt state. Requires attempts.read_team or attempts.read_all on top of exams.read, because unlike exam_participation() this names individuals and their scores.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Publishing gains the release policy
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * DROP then CREATE rather than adding a defaulted parameter: a new trailing
 * default would leave two overloads resolvable by the same call, and PostgREST
 * picks between them by argument names in ways that are miserable to debug.
 */
drop function if exists public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text);

create or replace function public.publish_paper_as_exam(
  p_paper_id          uuid,
  p_title             text,
  p_duration_minutes  int,
  p_opens_at          timestamptz,
  p_closes_at         timestamptz,
  p_max_attempts      int,
  p_pass_mark_percent int,
  p_instructions      text default null,
  p_results_release   public.results_release default 'immediate'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
  v_paper   record;
  v_exam    uuid;
begin
  if not (public.has_perm('exams.create') and public.has_perm('exams.publish')) then
    raise exception 'Not permitted to publish an exam.'
      using errcode = 'insufficient_privilege';
  end if;

  select p.* into v_paper
    from public.exam_papers p
   where p.id = p_paper_id
     and p.company_id = v_company
     and (p.brand_id = public.my_brand() or public.brand_unscoped());

  if v_paper.id is null then
    raise exception 'That paper could not be found.'
      using errcode = 'no_data_found';
  end if;

  if v_paper.status = 'retired' then
    raise exception 'That paper has been retired and cannot be published.'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.exams e
     where e.paper_id = p_paper_id
       and e.deleted_at is null
       and e.status in ('draft', 'scheduled', 'active')
  ) then
    raise exception 'That paper is already published as an open exam.'
      using errcode = 'unique_violation';
  end if;

  -- ── The publish validation the spec asks for, stated once, here ─────────
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'Give the exam a name.' using errcode = 'check_violation';
  end if;
  if p_duration_minutes is null or p_duration_minutes < 5 or p_duration_minutes > 480 then
    raise exception 'The time allowed must be between 5 and 480 minutes.' using errcode = 'check_violation';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'Attempts allowed must be between 1 and 10.' using errcode = 'check_violation';
  end if;
  if p_pass_mark_percent is null or p_pass_mark_percent < 1 or p_pass_mark_percent > 100 then
    raise exception 'The pass mark must be between 1 and 100 percent.' using errcode = 'check_violation';
  end if;
  /*
   * A deadline is REQUIRED for a paper-backed exam, and the legacy model does
   * not require one. Without it "closed" never arrives, on_close never
   * releases, and the exam sits live forever.
   */
  if p_closes_at is null then
    raise exception 'Give the exam a closing time.' using errcode = 'check_violation';
  end if;
  if p_opens_at is not null and p_closes_at <= p_opens_at then
    raise exception 'The closing time must be after the opening time.'
      using errcode = 'check_violation';
  end if;
  if p_closes_at <= now() then
    raise exception 'The closing time has already passed.' using errcode = 'check_violation';
  end if;

  insert into public.exams (
    company_id, brand_id, title, instructions,
    kind, status, paper_mode, paper_id,
    duration_minutes, opens_at, closes_at,
    max_attempts, pass_mark_percent,
    -- BOTH SHUFFLES OFF. Some of these candidates may be sitting the printed
    -- copy of this same paper in the same room, and question 7 has to be
    -- question 7 on every desk.
    shuffle_questions, shuffle_options,
    total_marks, question_count,
    requires_manual_grading,
    verification_mode,
    results_release,
    created_by, published_by, published_at
  )
  values (
    v_paper.company_id, v_paper.brand_id, p_title, p_instructions,
    'official', 'scheduled', 'fixed', p_paper_id,
    p_duration_minutes, p_opens_at, p_closes_at,
    p_max_attempts, p_pass_mark_percent,
    false, false,
    v_paper.marks, v_paper.mcq_n + v_paper.short_n,
    v_paper.short_n > 0,
    'single',
    p_results_release,
    auth.uid(), auth.uid(), now()
  )
  returning id into v_exam;

  if v_paper.status = 'generated' then
    update public.exam_papers
       set status = 'live', status_changed_at = now(), status_changed_by = auth.uid()
     where id = p_paper_id;
  end if;

  return jsonb_build_object(
    'examId',  v_exam,
    'paperNo', v_paper.paper_no,
    'marks',   v_paper.marks
  );
end;
$$;

revoke execute on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text, public.results_release) from public, anon;
grant  execute on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text, public.results_release) to authenticated;

comment on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text, public.results_release) is
  'Publishes a generated paper as a scheduled online exam, validating the whole configuration before anything is written. Creates the exams row only — the audience is set afterwards through exam_assignments, and until it is set the exam is invisible to everyone.';
