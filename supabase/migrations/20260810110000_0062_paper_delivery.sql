-- ═════════════════════════════════════════════════════════════════════════════
-- 0062 — The bridge: a generated paper can be sat on a screen.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THIS AMENDS 0061's HEADER, WHICH SAID THIS WOULD NEVER HAPPEN.            ║
-- ║                                                                           ║
-- ║ 0061 stated flatly that paper status "is not online delivery" and that    ║
-- ║ the legacy attempt stack was "deliberately untouched". That was true of   ║
-- ║ 0061 and is no longer true of the product: papers may now also be sat     ║
-- ║ online. `live` therefore means "in use" — printed, on screen, or both —   ║
-- ║ and the type comment below is rewritten to say so rather than leaving two ║
-- ║ migrations contradicting each other.                                      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THERE ARE NO NEW ATTEMPT TABLES.                                      │
-- │                                                                           │
-- │ Everything needed to sit, save, submit, grade, evaluate, verify and       │
-- │ release an attempt already exists and already works. Crucially, none of   │
-- │ attempt_paper, save_answer, grade_and_close_attempt or                    │
-- │ attempt_evaluation_items joins public.questions — they all read           │
-- │ attempt_questions.snapshot. The delivery stack is ALREADY content-        │
-- │ agnostic; only start_attempt reads the question tables, and only to build │
-- │ that snapshot.                                                            │
-- │                                                                           │
-- │ So the whole bridge is: point an exam at a paper, and teach the one       │
-- │ function that builds snapshots where the other bank lives.                │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

comment on type public.paper_status is
  'Where a paper is in its working life. generated = drawn but not yet in use; live = in use, whether printed, sat online, or both; retired = finished with. 0062 widened "live" to cover online delivery.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Which bank a frozen question came from
-- ═════════════════════════════════════════════════════════════════════════════

create type public.question_source as enum ('legacy', 'bank');

comment on type public.question_source is
  'Which table attempt_questions.question_id points at. Needed because the two banks are separate tables with separate id spaces, and a single uuid column cannot say which on its own.';

-- ═════════════════════════════════════════════════════════════════════════════
-- exams → exam_papers
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.exams
  add column paper_id uuid references public.exam_papers(id) on delete restrict;

comment on column public.exams.paper_id is
  'The generated paper this exam delivers, or null for a legacy rule-drawn exam. ON DELETE RESTRICT: a paper that has been sat cannot be deleted out from under its attempts.';

/*
 * A paper-backed exam is a FIXED paper by definition — the candidates on screen
 * must get the same twenty questions as the ones holding the printout. Without
 * this constraint a per_attempt exam could point at a paper and silently redraw,
 * which would make the printed copy and the screen disagree.
 */
alter table public.exams
  add constraint exams_paper_is_fixed
  check (paper_id is null or paper_mode = 'fixed');

/*
 * One open exam per paper.
 *
 * Publishing the same paper twice would put two sets of candidates on the same
 * questions with two different windows and two different result sets — and the
 * product rule is that a paper is used once. Archived and cancelled exams drop
 * out of the index so a paper can be re-published after a mistake.
 */
create unique index exams_one_open_per_paper
  on public.exams (paper_id)
  where paper_id is not null
    and deleted_at is null
    and status in ('draft', 'scheduled', 'active');

-- ═════════════════════════════════════════════════════════════════════════════
-- The frozen paper: attempt_questions
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE FOREIGN KEY IS DROPPED, AND A TRIGGER PUTS THE INTEGRITY BACK.        │
 * │                                                                           │
 * │ The primary key is (attempt_id, question_id), so question_id CANNOT be    │
 * │ made nullable — the usual "add a second nullable column" shape is closed  │
 * │ off. The alternative was copying bank questions into public.questions,    │
 * │ which would expose bank content to every role holding legacy question     │
 * │ permissions — including Chefs, whom the Question Bank deliberately locks  │
 * │ out. That is a worse trade than dropping one constraint.                  │
 * │                                                                           │
 * │ So: question_id stays NOT NULL, `source` says which table it points at,   │
 * │ and the trigger below enforces what the FK used to. The only writer is    │
 * │ start_attempt, a definer function, so there is exactly one code path to   │
 * │ get this wrong and it is checked.                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
alter table public.attempt_questions
  drop constraint attempt_questions_question_id_fkey;

alter table public.attempt_questions
  add column source public.question_source not null default 'legacy',
  add column answer_key jsonb;

comment on column public.attempt_questions.answer_key is
  'The key as it stood when this candidate was served, for bank questions only. Legacy questions leave this null and are graded through answer_key_at_revision() as before. It is a COLUMN rather than a field inside snapshot because attempt_paper() returns the whole snapshot to the candidate — a key stored there would be handed to the person being tested.';

comment on column public.attempt_questions.source is
  'Which table question_id points at. Set by start_attempt from the exam''s paper_id; never written by a client.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The answers
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.attempt_answers
  drop constraint attempt_answers_question_id_fkey;

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS STRICTLY STRONGER THAN THE CONSTRAINT IT REPLACES.                │
 * │                                                                           │
 * │ The dropped key said "this question exists somewhere in public.questions".│
 * │ This one says "this question is on THIS candidate's paper", which is the  │
 * │ rule that actually matters and which the old key never enforced. It is    │
 * │ also source-agnostic, so attempt_answers needs no `source` column at all  │
 * │ — the join to attempt_questions already carries it.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
alter table public.attempt_answers
  add constraint attempt_answers_on_this_paper
  foreign key (attempt_id, question_id)
  references public.attempt_questions (attempt_id, question_id)
  on delete cascade;

-- ═════════════════════════════════════════════════════════════════════════════
-- What the dropped foreign key used to do
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.assert_question_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source = 'bank' then
    if not exists (
      select 1 from public.bank_questions b where b.id = new.question_id
    ) then
      raise exception
        'question % is not in the question bank', new.question_id
        using errcode = 'foreign_key_violation';
    end if;
  else
    if not exists (
      select 1 from public.questions q where q.id = new.question_id
    ) then
      raise exception
        'question % does not exist', new.question_id
        using errcode = 'foreign_key_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_question_source() is
  'Stands in for the foreign key dropped from attempt_questions.question_id, which could not survive the bank being a second table. Definer because bank_questions is behind RLS a candidate does not satisfy, and this runs during their own start_attempt.';

create trigger attempt_questions_source_check
  before insert or update of question_id, source
  on public.attempt_questions
  for each row
  execute function public.assert_question_source();
