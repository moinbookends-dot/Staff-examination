-- ═════════════════════════════════════════════════════════════════════════════
-- 0028 — Evaluation, verification, and the release of a result
--
-- Completes the lifecycle 0001 drew and every migration since has been walking
-- toward:
--
--   auto_graded (fully auto-gradable) ─────────────────→ published
--   evaluating → evaluated → verifying ─┬─ verified ───→ published
--                     ▲                 └─ returned ─┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A RESULT IS VISIBLE TO THE CANDIDATE WHEN, AND ONLY WHEN, IT IS           │
-- │ 'published'. THAT IS ENFORCED HERE, NOT IN THE UI.                        │
-- │                                                                           │
-- │ RLS cannot do it. A policy chooses ROWS, and the candidate legitimately    │
-- │ needs their own attempt row long before the result exists — to know the    │
-- │ paper was received, that it is being marked, that it was returned for      │
-- │ rework. Leaving `attempts_read_own` in place would hand them score,        │
-- │ max_score and passed over PostgREST the moment the grader wrote them,      │
-- │ hours before an evaluator had agreed to anything.                         │
-- │                                                                           │
-- │ So the candidate's read policies on attempts and attempt_answers are       │
-- │ DROPPED, and replaced by definer functions that decide per column: status  │
-- │ always, score only once published. A column cannot be hidden by a policy;  │
-- │ it can be hidden by a function that never selects it.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- SEPARATION OF DUTIES. A chef holds evaluation.evaluate AND evaluation.verify,
-- because in a two-manager restaurant the same people do both jobs on different
-- papers. What they may not do is sign off their own marking, so a verifier is
-- refused on any attempt they evaluated. Dual mode additionally needs two
-- DISTINCT verifiers, enforced by a unique constraint rather than by counting
-- in application code.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Provenance on the attempt ────────────────────────────────────────────────

alter table public.attempts
  add column if not exists evaluated_by  uuid references public.profiles(id) on delete restrict,
  add column if not exists evaluated_at  timestamptz,
  add column if not exists verified_at   timestamptz,
  add column if not exists published_at  timestamptz,
  -- How many times a verifier has sent this back. Also the round number that
  -- sign-offs are recorded against, so a return invalidates the ones before it.
  add column if not exists returned_count int not null default 0;

alter table public.attempt_answers
  add column if not exists evaluated_by uuid references public.profiles(id) on delete restrict,
  add column if not exists evaluated_at timestamptz;

comment on column public.attempts.returned_count is
  'How many times this attempt has been sent back for rework. Doubles as the verification round: sign-offs are recorded against returned_count + 1, so returning an attempt discards the approvals it already had rather than letting them carry over onto revised marks.';

-- ── The audit trail ──────────────────────────────────────────────────────────

create table if not exists public.attempt_verifications (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  verifier_id uuid not null references public.profiles(id) on delete restrict,

  decision text not null check (decision in ('verified', 'returned')),
  note     text,

  -- Which round of marking this decision was made about. Without it, a paper
  -- returned once and re-marked would still be carrying the approval somebody
  -- gave to the marks before the rework.
  round int not null check (round >= 1),

  created_at timestamptz not null default now(),

  -- DUAL VERIFICATION, ENFORCED. Two sign-offs must come from two people; this
  -- constraint is what makes that true, rather than a count in application code
  -- that a concurrent second request could pass twice.
  unique (attempt_id, verifier_id, round)
);

create index if not exists attempt_verifications_attempt_idx
  on public.attempt_verifications (attempt_id, round);

comment on table public.attempt_verifications is
  'Every verification decision, kept forever. One row per verifier per round, so "two distinct verifiers signed this off" is a fact in the table rather than an assertion in the code. Returns are recorded here too — a paper sent back twice shows both notes and both names.';

alter table public.attempt_verifications enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- The transition graph, enforced
--
-- Written as data rather than as a chain of IF statements so that "which moves
-- are legal" can be read in one place. Anything not listed is refused — including
-- from psql, an import, or a future function that forgets.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_attempt_status_transition()
returns trigger
language plpgsql
as $$
declare
  v_allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    -- The fully auto-gradable paper publishes straight out of submit when the
    -- exam asks for no human sign-off; otherwise it waits at auto_graded.
    when 'in_progress' then array['auto_graded', 'evaluating', 'published', 'expired', 'voided']
    when 'auto_graded' then array['published', 'voided']
    when 'evaluating'  then array['evaluated', 'voided']
    when 'evaluated'   then array['verifying', 'published', 'voided']
    when 'verifying'   then array['verified', 'returned', 'voided']
    when 'verified'    then array['published', 'voided']
    when 'returned'    then array['evaluating', 'voided']
    when 'expired'     then array['auto_graded', 'evaluating', 'voided']
    -- Terminal. A published result is corrected by voiding it and saying so,
    -- never by quietly editing it back into an earlier state.
    when 'published'   then array['voided']
    when 'voided'      then array[]::text[]
    else array[]::text[]
  end;

  -- ::text on both sides. new.status is attempt_status and v_allowed is text[],
  -- and Postgres offers no enum = text operator to bridge them.
  if not (new.status::text = any(v_allowed)) then
    raise exception 'attempt cannot go from % to %', old.status, new.status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists attempts_status_transition on public.attempts;
create trigger attempts_status_transition
  before update of status on public.attempts
  for each row execute function public.enforce_attempt_status_transition();

-- ═════════════════════════════════════════════════════════════════════════════
-- Candidate reads — the whole surface, and the release gate
-- ═════════════════════════════════════════════════════════════════════════════

drop policy if exists attempts_read_own on public.attempts;
drop policy if exists attempt_answers_read_own on public.attempt_answers;

/*
 * The candidate's own attempts.
 *
 * status is always returned — they are entitled to know their paper arrived and
 * where it has got to. score, max_score and passed are returned ONLY once the
 * attempt is published, and they are not merely blanked in the output: the
 * CASE means the value is never read for an unpublished row.
 */
create or replace function public.my_attempts()
returns table (
  attempt_id  uuid,
  exam_id     uuid,
  status      public.attempt_status,
  started_at  timestamptz,
  submitted_at timestamptz,
  expires_at  timestamptz,
  score       numeric,
  max_score   numeric,
  passed      boolean,
  published   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.exam_id, a.status, a.started_at, a.submitted_at, a.expires_at,
         case when a.status = 'published' then a.score     end,
         case when a.status = 'published' then a.max_score end,
         case when a.status = 'published' then a.passed    end,
         a.status = 'published'
    from public.attempts a
   where a.candidate_id = auth.uid()
$$;

grant execute on function public.my_attempts() to authenticated;

comment on function public.my_attempts() is
  'The only way a candidate reads their own attempts. Replaces the attempts_read_own policy, which could not withhold the score columns: a policy selects rows, and the candidate needs the row long before they are entitled to the result.';

/*
 * The runner's state. Carries no score at all — a paper being sat has no result
 * worth withholding, and the function that serves it should not be able to leak
 * one if the release rule above is ever changed.
 */
create or replace function public.my_attempt_state(p_attempt_id uuid)
returns table (
  attempt_id     uuid,
  status         public.attempt_status,
  expires_at     timestamptz,
  submitted_at   timestamptz,
  answered_count int,
  exam_title     text,
  allow_backtrack boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
    select a.id, a.status, a.expires_at, a.submitted_at,
           (select count(*)::int from public.attempt_answers aa where aa.attempt_id = a.id),
           e.title, e.allow_backtrack
      from public.attempts a
      join public.exams e on e.id = a.exam_id
     where a.id = p_attempt_id
       and a.candidate_id = auth.uid();
end;
$$;

grant execute on function public.my_attempt_state(uuid) to authenticated;

/*
 * The per-question breakdown, after publication.
 *
 * Raises rather than returning nothing for an unpublished attempt, so a caller
 * cannot mistake "not released yet" for "you got everything wrong".
 *
 * grade_detail reports what the candidate submitted and whether each part was
 * right. It has never contained the expected value — see 0027 — so this is safe
 * to hand over once the result is theirs to see.
 */
create or replace function public.attempt_review(p_attempt_id uuid)
returns table (
  question_id  uuid,
  paper_position int,
  stem         text,
  marks        numeric,
  score        numeric,
  answer       jsonb,
  grade_detail jsonb,
  grader_note  text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status public.attempt_status;
  v_owner  uuid;
begin
  select a.status, a.candidate_id into v_status, v_owner
    from public.attempts a where a.id = p_attempt_id;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_status <> 'published' then
    raise exception 'this result has not been released yet' using errcode = '22023';
  end if;

  return query
    select aq.question_id, aq.position, aq.snapshot ->> 'stem', aq.marks,
           aa.score, aa.answer, aa.grade_detail, aa.grader_note
      from public.attempt_questions aq
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
     order by aq.position;
end;
$$;

grant execute on function public.attempt_review(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The evaluator's screen
--
-- An evaluator marking an essay needs the rubric, which lives in the answer key
-- — the one thing this codebase works hardest to keep unreachable. So it is
-- handed over here under four conditions at once: the caller holds
-- evaluation.evaluate, the attempt is in their company, it is actually awaiting
-- evaluation, and the question is one a machine could not mark. An evaluator
-- cannot use this to read the key for a multiple-choice question.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.attempt_evaluation_items(p_attempt_id uuid)
returns table (
  question_id  uuid,
  paper_position int,
  stem         text,
  response_format text,
  marks        numeric,
  answer       jsonb,
  score        numeric,
  grader_note  text,
  auto_grade_status public.auto_grade_status,
  /** The rubric or keywords the author wrote. Manual formats only. */
  guidance     jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attempt record;
begin
  if not public.has_perm('evaluation.evaluate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.* into v_attempt from public.attempts a where a.id = p_attempt_id;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('evaluating', 'returned') then
    raise exception 'this attempt is not awaiting evaluation' using errcode = '22023';
  end if;

  return query
    select aq.question_id, aq.position, aq.snapshot ->> 'stem',
           aq.snapshot ->> 'response_format', aq.marks,
           aa.answer, aa.score, aa.grader_note,
           coalesce(aa.auto_grade_status, 'pending'::public.auto_grade_status),
           case
             when (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
               then public.answer_key_at_revision(aq.question_id, aq.question_revision)
             else null
           end
      from public.attempt_questions aq
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
       -- Only what a human has to decide: the manual formats, plus anything the
       -- auto-grader flagged as a near-miss it wanted confirmed.
       and (
         (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
         or coalesce(aa.needs_review, false)
       )
     order by aq.position;
end;
$$;

grant execute on function public.attempt_evaluation_items(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Evaluating
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.save_evaluation(
  p_attempt_id  uuid,
  p_question_id uuid,
  p_score       numeric,
  p_note        text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt record;
  v_marks numeric;
  v_revision int;
begin
  if v_uid is null or not public.has_perm('evaluation.evaluate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.* into v_attempt from public.attempts a where a.id = p_attempt_id for update;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('evaluating', 'returned') then
    raise exception 'this attempt is not awaiting evaluation' using errcode = '22023';
  end if;

  select aq.marks, aq.question_revision into v_marks, v_revision
    from public.attempt_questions aq
   where aq.attempt_id = p_attempt_id and aq.question_id = p_question_id;

  if v_marks is null then
    raise exception 'question not in this paper' using errcode = '42501';
  end if;
  if p_score is null or p_score < 0 or p_score > v_marks then
    raise exception 'score must be between 0 and %', v_marks using errcode = '22023';
  end if;

  -- A candidate who wrote nothing still has no answer row (0027: a skip is the
  -- absence of a row). The evaluator may still record a zero against it, so the
  -- row is created here rather than requiring one to exist.
  insert into public.attempt_answers (
    attempt_id, question_id, question_revision, answer,
    auto_grade_status, score, needs_review, grader_note, evaluated_by, evaluated_at
  )
  values (
    p_attempt_id, p_question_id, v_revision, 'null'::jsonb,
    'graded', p_score, false, p_note, v_uid, now()
  )
  on conflict (attempt_id, question_id) do update
    set score = excluded.score,
        auto_grade_status = 'graded',
        -- The human has now looked. Whatever the auto-grader wanted confirmed
        -- is confirmed, one way or the other.
        needs_review = false,
        grader_note = excluded.grader_note,
        evaluated_by = excluded.evaluated_by,
        evaluated_at = excluded.evaluated_at,
        updated_at = now();

  -- Picking up a returned paper puts it back into evaluation. Expressed as a
  -- real transition through the trigger rather than left implicit.
  if v_attempt.status = 'returned' then
    update public.attempts set status = 'evaluating' where id = p_attempt_id;
  end if;
end;
$$;

grant execute on function public.save_evaluation(uuid, uuid, numeric, text) to authenticated;

/**
 * Finishes evaluation and routes the paper according to the exam's mode.
 *
 * Refuses while anything a human owes a decision on is still unscored — an
 * attempt that reached 'evaluated' with an unmarked essay would produce a total
 * that is simply wrong, and nothing downstream would know.
 */
create or replace function public.complete_evaluation(p_attempt_id uuid)
returns public.attempt_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt record;
  v_mode public.verification_mode;
  v_outstanding int;
  v_score numeric;
  v_next public.attempt_status;
begin
  if v_uid is null or not public.has_perm('evaluation.evaluate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.*, e.verification_mode, e.pass_mark_percent
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
   for update of a;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('evaluating', 'returned') then
    raise exception 'this attempt is not awaiting evaluation' using errcode = '22023';
  end if;

  select count(*)::int into v_outstanding
    from public.attempt_questions aq
    left join public.attempt_answers aa
           on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
   where aq.attempt_id = p_attempt_id
     and (
       (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
       or coalesce(aa.needs_review, false)
     )
     -- NOT "score is null". 0027's grader already wrote score 0 and status
     -- 'not_applicable' against every manual question, so a null check would
     -- see an essay nobody has read as finished. What marks it done is a human
     -- having set it to 'graded' — which is exactly what save_evaluation does.
     and (
       coalesce(aa.auto_grade_status, 'pending'::public.auto_grade_status)
         in ('pending', 'not_applicable')
       or coalesce(aa.needs_review, false)
     );

  if v_outstanding > 0 then
    raise exception 'this attempt has % question(s) still awaiting a mark', v_outstanding
      using errcode = '22023';
  end if;

  select greatest(coalesce(sum(aa.score), 0), 0) into v_score
    from public.attempt_answers aa where aa.attempt_id = p_attempt_id;

  v_mode := v_attempt.verification_mode;

  -- 'auto' means nobody has to counter-sign, so the result is final here.
  v_next := case when v_mode = 'auto' then 'published' else 'verifying' end;

  update public.attempts a
     set status       = 'evaluated',
         score        = v_score,
         passed       = case when coalesce(a.max_score, 0) = 0 then false
                             else (v_score / a.max_score) * 100 >= v_attempt.pass_mark_percent end,
         evaluated_by = v_uid,
         evaluated_at = now()
   where a.id = p_attempt_id;

  update public.attempts a
     set status = v_next,
         published_at = case when v_next = 'published' then now() else a.published_at end
   where a.id = p_attempt_id;

  return v_next;
end;
$$;

grant execute on function public.complete_evaluation(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Verifying
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.verify_attempt(
  p_attempt_id uuid,
  p_decision   text,
  p_note       text default null
)
returns public.attempt_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt record;
  v_mode public.verification_mode;
  v_round int;
  v_required int;
  v_signoffs int;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_decision not in ('verified', 'returned') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  if p_decision = 'verified' and not public.has_perm('evaluation.verify') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_decision = 'returned' and not public.has_perm('evaluation.return') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.*, e.verification_mode into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
   for update of a;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status <> 'verifying' then
    raise exception 'this attempt is not awaiting verification' using errcode = '22023';
  end if;

  -- SEPARATION OF DUTIES. A chef holds both permissions because in a small
  -- restaurant the same people do both jobs — on different papers. Signing off
  -- your own marking is the one combination that defeats the point of having a
  -- second pair of eyes.
  if v_attempt.evaluated_by = v_uid then
    raise exception 'you cannot verify an attempt you evaluated yourself'
      using errcode = '42501';
  end if;

  v_mode  := v_attempt.verification_mode;
  v_round := v_attempt.returned_count + 1;

  begin
    insert into public.attempt_verifications (attempt_id, verifier_id, decision, note, round)
    values (p_attempt_id, v_uid, p_decision, p_note, v_round);
  exception when unique_violation then
    raise exception 'you have already reviewed this attempt' using errcode = '22023';
  end;

  if p_decision = 'returned' then
    update public.attempts a
       set status = 'returned',
           returned_count = a.returned_count + 1
     where a.id = p_attempt_id;
    return 'returned';
  end if;

  select count(*)::int into v_signoffs
    from public.attempt_verifications v
   where v.attempt_id = p_attempt_id and v.round = v_round and v.decision = 'verified';

  v_required := case v_mode when 'dual' then 2 else 1 end;

  if v_signoffs < v_required then
    -- Still 'verifying'. The first of two signatures is recorded and visible,
    -- but changes nothing about who may see the result.
    return 'verifying';
  end if;

  update public.attempts set status = 'verified', verified_at = now() where id = p_attempt_id;
  update public.attempts set status = 'published', published_at = now() where id = p_attempt_id;

  return 'published';
end;
$$;

grant execute on function public.verify_attempt(uuid, text, text) to authenticated;

comment on function public.verify_attempt(uuid, text, text) is
  'Records one verification decision. Dual mode needs two rows from two people in the same round — the unique constraint on (attempt_id, verifier_id, round) is what makes that true, not a count in application code. Refuses the evaluator of the attempt outright.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Releasing an auto-graded paper
--
-- The branch of the lifecycle with no human marking in it. Under
-- verification_mode='auto' submit_attempt has already published it; under
-- 'single' or 'dual' it waits here for somebody holding evaluation.publish.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.publish_attempt(p_attempt_id uuid)
returns public.attempt_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt record;
begin
  if auth.uid() is null or not public.has_perm('evaluation.publish') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.* into v_attempt from public.attempts a where a.id = p_attempt_id for update;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('auto_graded', 'verified') then
    raise exception 'this attempt is not ready to publish' using errcode = '22023';
  end if;

  update public.attempts set status = 'published', published_at = now() where id = p_attempt_id;
  return 'published';
end;
$$;

grant execute on function public.publish_attempt(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Submit now knows about release
--
-- Replaces 0027's version. The only change is the last update: a paper needing
-- no human at all, on an exam asking for no sign-off, is finished the moment it
-- is graded, and holding it at 'auto_graded' would mean a practice quiz never
-- showed a score.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.grade_and_close_attempt(
  p_attempt_id uuid,
  p_reason     public.submit_reason
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt record;
  v_row     record;
  v_grade   record;
  v_score   numeric;
  v_review  boolean;
  v_manual  boolean;
  v_next    public.attempt_status;
begin
  select a.*, e.pass_mark_percent, e.verification_mode
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
   for update of a;

  if v_attempt.id is null then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'this attempt has already been submitted' using errcode = '22023';
  end if;

  -- Iterating attempt_answers, not attempt_questions: an unanswered question
  -- has no row, contributes nothing, and incurs no penalty. That is the skip
  -- rule, expressed by the absence of a row rather than by a special case.
  for v_row in
    select aa.question_id, aa.question_revision, aa.answer,
           aq.snapshot, aq.marks, aq.negative_marks
      from public.attempt_answers aa
      join public.attempt_questions aq
        on aq.attempt_id = aa.attempt_id and aq.question_id = aa.question_id
     where aa.attempt_id = p_attempt_id
  loop
    select * into v_grade from public.grade_answer(
      v_row.snapshot -> 'content',
      -- 0022: the key as it was at the revision this candidate was served.
      public.answer_key_at_revision(v_row.question_id, v_row.question_revision),
      v_row.answer,
      v_row.marks,
      v_row.negative_marks
    );

    update public.attempt_answers aa
       set score             = v_grade.score,
           auto_grade_status = v_grade.status,
           needs_review      = v_grade.needs_review,
           grade_detail      = v_grade.detail
     where aa.attempt_id = p_attempt_id and aa.question_id = v_row.question_id;
  end loop;

  select greatest(coalesce(sum(aa.score), 0), 0), bool_or(aa.needs_review)
    into v_score, v_review
    from public.attempt_answers aa
   where aa.attempt_id = p_attempt_id;

  -- Does the PAPER contain anything a machine cannot mark? Asked of the paper
  -- rather than of the answers, because an unanswered essay still needs a human
  -- to record the zero.
  select exists (
    select 1 from public.attempt_questions aq
     where aq.attempt_id = p_attempt_id
       and (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
  ) into v_manual;

  v_next := case
              when v_attempt.requires_manual_grading or v_manual or coalesce(v_review, false)
                then 'evaluating'
              when v_attempt.verification_mode = 'auto'
                then 'published'
              else 'auto_graded'
            end;

  update public.attempts a
     set submitted_at   = now(),
         submit_reason  = p_reason,
         score          = v_score,
         auto_graded_at = now(),
         published_at   = case when v_next = 'published' then now() else a.published_at end,
         status         = v_next,
         -- A verdict only where the machine finished the job. Anything going to
         -- an evaluator has no result yet, and recording one would publish a
         -- fail nobody agreed to.
         passed = case
                    when v_next = 'evaluating' then null
                    when coalesce(a.max_score, 0) = 0 then false
                    else (v_score / a.max_score) * 100 >= v_attempt.pass_mark_percent
                  end
   where a.id = p_attempt_id;
end;
$$;

revoke all on function public.grade_and_close_attempt(uuid, public.submit_reason)
  from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS for the verification trail
-- ═════════════════════════════════════════════════════════════════════════════

-- Staff who can evaluate or verify see the trail for their company. Candidates
-- get no policy: who signed their paper off, and what they wrote to each other
-- about it, is not theirs to read.
drop policy if exists attempt_verifications_read_staff on public.attempt_verifications;
create policy attempt_verifications_read_staff on public.attempt_verifications
  for select to authenticated
  using (
    exists (
      select 1 from public.attempts a
       where a.id = attempt_id
         and a.company_id = (select public.my_company())
         and (
           (select public.has_perm('evaluation.evaluate'))
           or (select public.has_perm('evaluation.verify'))
           or (select public.has_perm('attempts.read_all'))
         )
    )
  );

-- No insert or update policy for anybody: verify_attempt() is the only writer,
-- and it is what enforces the round, the separation of duties and the count.
