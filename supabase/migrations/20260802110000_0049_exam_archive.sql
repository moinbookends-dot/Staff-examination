-- ═════════════════════════════════════════════════════════════════════════════
-- 0049 — Archiving an exam has never worked
--
-- deleteExam (src/server/actions/exams.ts) archives an exam with
--
--     update exams set deleted_at = now() where id = $1 and deleted_at is null
--
-- and that statement is REFUSED. Verified against the live database as a chef
-- holding exams.read, exams.update, exams.create and exams.archive:
--
--     update exams set deleted_at = now()  ->  ERROR: new row violates
--                                              row-level security policy
--     update exams set title = 'renamed'   ->  rowCount 1
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY, AND IT IS NOT THE WITH CHECK.                                        │
-- │                                                                           │
-- │ exams_update's WITH CHECK is `company_id = my_company()`, which the new    │
-- │ row satisfies — the ordinary title update above proves the caller, the    │
-- │ row and the policy are all fine.                                          │
-- │                                                                           │
-- │ THE RULE, proven on public.questions while investigating 0048: on a table │
-- │ with RLS, an UPDATE that moves a row outside EVERY select policy is       │
-- │ rejected, even when the UPDATE policy's WITH CHECK passes. The proof was  │
-- │ the same chef, the same row and the same statement, with only one         │
-- │ variable — whether questions_read_deleted (0041) matched the result:      │
-- │                                                                           │
-- │   with    questions.retire  ->  rowCount 1                                │
-- │   without questions.retire  ->  new row violates row-level security       │
-- │                                                                           │
-- │ Both of 0015's select policies on exams carry `deleted_at is null`, so an │
-- │ archived exam is visible to neither and the write is refused.             │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- This is the third appearance of one defect. 0041 met it on questions and
-- described it as "soft delete is one-way", which undersold it: the FORWARD
-- delete was refused too, and deleteQuestion checked only `error`, so it
-- reported success for a question it never touched — the bug fixed in 3b52dcc.
-- 0048 met it on source_documents. This is exams, found by sweeping every RLS
-- table that has a deleted_at column rather than by waiting for a third report.
--
-- Of the nine such tables, exams was the only one still trapped. The others
-- each carry a FOR ALL or self-read policy with no deleted_at predicate, which
-- keeps matching the archived row and so keeps the write legal.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY exams.archive AND NOT exams.update.                                   │
-- │                                                                           │
-- │ deleteExam requires exams.archive. Keying these on exams.update would let │
-- │ somebody who may edit an exam archive it as a side effect of a policy      │
-- │ choice, which is not what the action says it needs. The rule the two      │
-- │ policies state is 0041's, in the same words: whoever may archive an exam  │
-- │ can see the ones they archived, and put them back.                       │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- Seeing what was archived — and what makes the archive possible at all.
create policy exams_read_archived on public.exams
  for select to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('exams.archive'))
    and company_id = (select public.my_company())
  );

-- Putting it back. Needed for the opposite reason to the policy above, and the
-- distinction is worth keeping straight because both involve deleted_at:
--
--   forward  (null -> now())  needs a SELECT policy covering the NEW row
--   backward (now() -> null)  needs an UPDATE policy covering the OLD row
--
-- exams_update's USING requires `deleted_at is null`, and an UPDATE's USING is
-- evaluated against the OLD row, so without this the reverse transition matches
-- no policy and changes zero rows — silently, because RLS refuses by filtering.
create policy exams_restore on public.exams
  for update to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('exams.archive'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

comment on policy exams_read_archived on public.exams is
  'Archived exams, for whoever may archive them. Not a convenience: without a select policy matching the archived row, the UPDATE that archives it is refused outright — deleteExam had never worked. Both of 0015''s read policies carry `deleted_at is null`, so an archived exam was visible to neither.';

comment on policy exams_restore on public.exams is
  'The undo half. exams_update''s USING requires `deleted_at is null` and an UPDATE''s USING reads the OLD row, so un-archiving matched no policy and quietly changed nothing. Mirrors questions_restore (0041) and source_documents_restore (0048).';
