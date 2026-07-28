-- ═════════════════════════════════════════════════════════════════════════════
-- 0025 — Attempts: the candidate's side of an exam
--
-- This migration discharges obligations recorded across four earlier ones. Each
-- is called out at the point it is satisfied so the link survives.
--
--   0011  attempt_answers.question_revision                     → below
--   0014  attempt_questions, populated by draw_paper()          → below
--   0014  fallback_reason persisted onto the attempt            → below
--   0022  grading via answer_key_at_revision(), never the        → slice 2
--         live question_answer_keys table
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE CLOCK IS THE SERVER'S. expires_at is stamped when the attempt starts  │
-- │ and every later write is refused against it. The browser counts down for  │
-- │ display only.                                                             │
-- │                                                                           │
-- │ A client-owned timer is not a timer. Changing the system clock, pausing   │
-- │ JavaScript, or reloading would each buy unlimited time on a scored exam,  │
-- │ and none of it would leave a trace. The submit_reason enum declared back  │
-- │ in 0001 — user | timer | tab_switch | sweeper | admin — only means        │
-- │ anything if the server is the one deciding.                               │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.attempts (
  id           uuid primary key default gen_random_uuid(),
  exam_id      uuid not null references public.exams(id) on delete restrict,
  candidate_id uuid not null references public.profiles(id) on delete restrict,
  -- Denormalised from the exam so every attempt query scopes by company without
  -- a join, exactly as questions and exams do.
  company_id   uuid not null references public.companies(id) on delete restrict,

  status public.attempt_status not null default 'in_progress',
  -- 1-based, and compared against exams.max_attempts. Stored rather than
  -- counted so a concurrent second start cannot both see "0 so far".
  attempt_number int not null check (attempt_number >= 1),

  -- ── The clock ─────────────────────────────────────────────────────────────
  started_at timestamptz not null default now(),
  -- min(started_at + duration, exam.closes_at). An exam window that shuts
  -- before the candidate's personal time is up shuts the attempt too; the
  -- alternative is an attempt still accepting answers after the exam closed.
  expires_at timestamptz not null,
  submitted_at timestamptz,
  submit_reason public.submit_reason,

  -- ── Outcome, filled by slice 2 ────────────────────────────────────────────
  score      numeric(8,2),
  max_score  numeric(8,2),
  passed     boolean,
  auto_graded_at timestamptz,
  -- Copied from the exam at start: whether this attempt needs a human before
  -- it can be published. Copied, not read live, because an exam edited later
  -- must not change what an in-flight attempt requires.
  requires_manual_grading boolean not null default false,

  -- ── Integrity signals ─────────────────────────────────────────────────────
  violation_count int not null default 0 check (violation_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attempts_window_ordered check (expires_at > started_at),
  constraint attempts_submitted_has_reason check (
    (submitted_at is null and submit_reason is null)
    or (submitted_at is not null and submit_reason is not null)
  )
);

-- ONE attempt in flight per candidate per exam. Without this, two tabs start
-- two attempts, answers split across them, and max_attempts counts wrong.
create unique index attempts_one_in_flight
  on public.attempts (exam_id, candidate_id)
  where status = 'in_progress';

create unique index attempts_number_uq
  on public.attempts (exam_id, candidate_id, attempt_number);

create index attempts_candidate_idx on public.attempts (candidate_id, status);
create index attempts_exam_idx      on public.attempts (exam_id, status);
-- The sweeper's query: everything still open past its deadline.
create index attempts_expiry_idx    on public.attempts (expires_at) where status = 'in_progress';

-- ═════════════════════════════════════════════════════════════════════════════
-- attempt_questions — THE PAPER THIS CANDIDATE WAS SERVED
--
-- 0014 OBLIGATION, DISCHARGED. Same columns as exam_questions, and populated by
-- draw_paper() rather than by a second selector — for a fixed exam by copying
-- the frozen rows, for a per_attempt exam by drawing seeded on the attempt id.
-- Two implementations of "resolve rules into questions" is how the two paper
-- modes silently diverge.
--
-- fallback_reason travels with it, also per 0014: a substituted question is
-- otherwise invisible when somebody asks months later why this candidate's
-- paper looked odd.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.attempt_questions (
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  section_id  uuid references public.exam_sections(id) on delete set null,
  question_id uuid not null references public.questions(id) on delete restrict,

  question_revision int not null check (question_revision > 0),
  snapshot          jsonb not null,
  content_version   smallint not null default 1,

  position       int not null,
  marks          numeric(6,2) not null check (marks > 0),
  negative_marks numeric(6,2) not null default 0 check (negative_marks >= 0),
  fallback_reason text,

  created_at timestamptz not null default now(),

  primary key (attempt_id, question_id)
);

create index attempt_questions_order_idx on public.attempt_questions (attempt_id, position);

-- ═════════════════════════════════════════════════════════════════════════════
-- attempt_answers — what the candidate actually entered
--
-- 0011 OBLIGATION, DISCHARGED: question_revision is NOT NULL. Without it, an
-- answer cannot be matched to the wording that produced it, and the revision
-- counter 0011 introduced achieves nothing. It is also what slice 2 passes to
-- answer_key_at_revision(), so grading uses the key that was served.
--
-- Upserted continuously, one row per question. A candidate on outlet wifi loses
-- signal mid-exam; per-answer autosave costs them the question they were typing
-- rather than the whole paper.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.attempt_answers (
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,

  -- Which wording this answers. NOT the question's current revision.
  question_revision int not null check (question_revision > 0),
  answer jsonb not null,

  auto_grade_status public.auto_grade_status not null default 'pending',
  score          numeric(6,2),
  -- Set by the grader for a fuzzy near-miss: credited, but a human is asked to
  -- confirm rather than a spelling variant deciding a result silently.
  needs_review   boolean not null default false,
  grader_note    text,

  answered_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  primary key (attempt_id, question_id)
);

create index attempt_answers_review_idx
  on public.attempt_answers (attempt_id) where needs_review;

create trigger attempts_set_updated_at
  before update on public.attempts
  for each row execute function public.set_updated_at();
create trigger attempt_answers_set_updated_at
  before update on public.attempt_answers
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- start_attempt — the only way an attempt comes into existence
--
-- Everything the candidate is entitled to is decided here, once, and frozen:
-- which questions, how long, how many marks. Nothing downstream re-derives any
-- of it from the exam, because the exam can change.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.start_attempt(p_exam_id uuid)
returns table (attempt_id uuid, expires_at timestamptz, question_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam    record;
  v_uid     uuid := auth.uid();
  v_taken   int;
  v_open    uuid;
  v_attempt uuid;
  v_expires timestamptz;
  v_count   int;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.has_perm('attempts.take') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_exam from public.exams e
   where e.id = p_exam_id and e.deleted_at is null;

  -- Assignment is the gate, and it is checked here rather than trusted from the
  -- caller: this function runs as owner, so RLS will not do it for us.
  if v_exam is null or not public.is_exam_assigned_to_me(p_exam_id) then
    raise exception 'exam not found' using errcode = '42501';
  end if;
  if v_exam.status not in ('scheduled', 'active') then
    raise exception 'this exam is not open' using errcode = '22023';
  end if;
  if v_exam.opens_at is not null and now() < v_exam.opens_at then
    raise exception 'this exam has not opened yet' using errcode = '22023';
  end if;
  if v_exam.closes_at is not null and now() >= v_exam.closes_at then
    raise exception 'this exam has closed' using errcode = '22023';
  end if;

  -- Resume rather than start again. Returning the existing attempt makes a
  -- reload idempotent; creating a second one would split the answers and the
  -- partial unique index would refuse it anyway.
  select a.id into v_open
    from public.attempts a
   where a.exam_id = p_exam_id and a.candidate_id = v_uid and a.status = 'in_progress';

  if v_open is not null then
    return query
      select a.id, a.expires_at,
             (select count(*)::int from public.attempt_questions aq where aq.attempt_id = a.id)
        from public.attempts a where a.id = v_open;
    return;
  end if;

  select count(*)::int into v_taken
    from public.attempts a
   where a.exam_id = p_exam_id and a.candidate_id = v_uid and a.status <> 'voided';

  if v_taken >= v_exam.max_attempts then
    raise exception 'no attempts remaining' using errcode = '22023';
  end if;

  -- The earlier of the personal deadline and the exam window. An attempt that
  -- outlived its exam would keep accepting answers after everyone else stopped.
  v_expires := least(
    now() + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.closes_at, 'infinity'::timestamptz)
  );

  insert into public.attempts (
    exam_id, candidate_id, company_id, attempt_number,
    expires_at, requires_manual_grading
  )
  values (
    p_exam_id, v_uid, v_exam.company_id, v_taken + 1,
    v_expires, v_exam.requires_manual_grading
  )
  returning id into v_attempt;

  -- ── Freeze this candidate's paper ────────────────────────────────────────
  if v_exam.paper_mode = 'fixed' then
    -- Copy the exam's frozen rows verbatim. Re-drawing would hand two
    -- candidates different papers for an exam whose whole point is that they
    -- sit the same one.
    insert into public.attempt_questions (
      attempt_id, section_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks, fallback_reason
    )
    select v_attempt, eq.section_id, eq.question_id, eq.question_revision,
           eq.snapshot, eq.content_version, eq.position, eq.marks,
           eq.negative_marks, eq.fallback_reason
      from public.exam_questions eq
     where eq.exam_id = p_exam_id;
  else
    -- Seeded on the ATTEMPT id, so this candidate's draw is their own and is
    -- reproducible if anybody ever needs to explain it.
    insert into public.attempt_questions (
      attempt_id, section_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks, fallback_reason
    )
    select v_attempt, d.section_id, d.question_id, d.question_revision,
           public.question_snapshot(d.question_id), q.content_version,
           d.position, d.marks, d.negative_marks, d.fallback_reason
      from public.draw_paper(p_exam_id, v_attempt::text) d
      join public.questions q on q.id = d.question_id;
  end if;

  select count(*)::int into v_count
    from public.attempt_questions aq where aq.attempt_id = v_attempt;

  if v_count = 0 then
    raise exception 'this exam has no questions' using errcode = '22023';
  end if;

  update public.attempts a
     set max_score = (select sum(aq.marks) from public.attempt_questions aq
                       where aq.attempt_id = v_attempt)
   where a.id = v_attempt;

  return query select v_attempt, v_expires, v_count;
end;
$$;

grant execute on function public.start_attempt(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- attempt_paper — the sanitising delivery route
--
-- 0015 OBLIGATION, DISCHARGED. Candidates hold no policy on exam_questions
-- precisely so they cannot read a paper before the timer starts. This is how
-- they read it afterwards: gated on an attempt that is theirs and in progress,
-- and returning the stored snapshot, which question_snapshot() built and which
-- has never contained an answer key.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.attempt_paper(p_attempt_id uuid)
returns table (
  section_id     uuid,
  section_title  text,
  question_id    uuid,
  paper_position int,
  marks          numeric(6,2),
  snapshot       jsonb,
  answer         jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status public.attempt_status;
begin
  select a.candidate_id, a.status into v_owner, v_status
    from public.attempts a where a.id = p_attempt_id;

  -- Not "does it exist" but "is it yours" — and the two are deliberately
  -- indistinguishable to the caller.
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;

  return query
    select aq.section_id, s.title, aq.question_id, aq.position, aq.marks,
           aq.snapshot,
           -- Their own answer so far, so a resumed attempt comes back exactly
           -- where it was.
           aa.answer
      from public.attempt_questions aq
      left join public.exam_sections s on s.id = aq.section_id
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
     order by aq.position;
end;
$$;

grant execute on function public.attempt_paper(uuid) to authenticated;

comment on function public.attempt_paper(uuid) is
  'The only route by which a candidate reads exam questions. Gated on the attempt being theirs; returns the stored snapshot, which never contained an answer key. Candidates hold no policy on exam_questions or attempt_questions, so this is the whole surface.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.attempts          enable row level security;
alter table public.attempt_questions enable row level security;
alter table public.attempt_answers   enable row level security;

comment on table public.attempt_questions is
  'The paper one candidate was served. Populated by start_attempt() from exam_questions (fixed) or draw_paper() seeded on the attempt id (per_attempt) — never by a second selector. question_revision and fallback_reason travel with it so an attempt stays explainable after the question bank moves on.';
comment on column public.attempt_answers.question_revision is
  'Which wording was answered. NOT the question''s current revision. Slice 2 passes this to answer_key_at_revision() so grading uses the key that was served.';
