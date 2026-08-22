-- ═════════════════════════════════════════════════════════════════════════════
-- 0011 — Question revisions
--
-- THE PROBLEM
--
-- Questions are edited in place. Snapshot-at-publish keeps historical exam
-- PAPERS correct, but analytics aggregate on question_id — so if a chef rewords
-- a question on 1 March, every attempt before and after collapses into one
-- difficulty statistic. Two genuinely different questions, one number.
--
-- That silently corrupts:
--   · the per-question difficulty and discrimination index (M7)
--   · any future adaptive-exam calibration, which reads exactly those stats
--   · "is this question working?" judgements a chef makes when curating
--
-- THE PROPERTY THAT FORCES THE DECISION NOW: it cannot be retrofitted. Once
-- attempts exist there is no way to reconstruct which wording a candidate
-- actually saw. The information is simply gone.
--
-- THE FIX (chosen over full immutable versioning)
--
-- Keep editing in place — chefs' workflow is unchanged, no version-picker UI,
-- no row explosion — but stamp a monotonic `revision` on the question and bump
-- it whenever anything that changes WHAT IS ASKED or HOW IT IS SCORED changes.
--
-- Analytics then group by (question_id, revision) and stay honest, while the
-- bank still shows one row per question.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ M4 OBLIGATION — DO NOT SKIP.                                              │
-- │ attempt_answers MUST carry `question_revision int not null`, populated at  │
-- │ answer time from questions.revision (or from the exam_questions snapshot). │
-- │ Without it this migration achieves nothing: the revision exists but no     │
-- │ answer records which one it was. exam_questions.snapshot must also record  │
-- │ the revision it froze.                                                     │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.questions
  add column revision int not null default 1 check (revision > 0);

-- Analytics group by (question_id, revision); the bank lists by question alone.
create index questions_revision_idx on public.questions (id, revision);

-- ── Bump on substantive edits ────────────────────────────────────────────────
--
-- Deliberately narrow. A revision means "this is a different question now", so
-- it must NOT fire on housekeeping — retiring, re-tagging, re-categorising, or
-- correcting a typo in the explanation shown after the fact. Bumping on those
-- would fragment analytics for no reason and make every question look freshly
-- unproven.
--
-- Included, and why:
--   stem, content, type, response_format — changes what is asked
--   marks, negative_marks               — changes how it scores, so scores
--                                         before and after are not comparable
--
-- Excluded: status, category_id, difficulty (a chef's label, not a measurement),
-- explanation, reference_note, usage_count, tags.
create or replace function public.bump_question_revision()
returns trigger
language plpgsql
as $$
begin
  if new.stem            is distinct from old.stem
  or new.content         is distinct from old.content
  or new.type            is distinct from old.type
  or new.response_format is distinct from old.response_format
  or new.marks           is distinct from old.marks
  or new.negative_marks  is distinct from old.negative_marks
  then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger questions_bump_revision
  before update on public.questions
  for each row execute function public.bump_question_revision();

-- ── Answer-key edits count too ───────────────────────────────────────────────
--
-- Changing the correct answer changes the question more fundamentally than
-- rewording it — every prior response was graded against a different truth.
-- The key lives in another table, so it bumps the parent explicitly.
create or replace function public.bump_revision_from_answer_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.answer_key is not distinct from old.answer_key then
    return new;   -- no substantive change
  end if;

  -- Only for keys attached to a question that already exists. On INSERT during
  -- question creation the question is at revision 1 and should stay there.
  if tg_op = 'UPDATE' then
    update public.questions
       set revision = revision + 1
     where id = new.question_id;
  end if;

  return new;
end;
$$;

create trigger answer_keys_bump_question_revision
  after insert or update on public.question_answer_keys
  for each row execute function public.bump_revision_from_answer_key();

comment on column public.questions.revision is
  'Monotonic. Bumped when the question text, content, type, format or marks change, or when its answer key changes. attempt_answers.question_revision records which one a candidate answered so analytics never mix two different questions into one statistic.';
