-- ═════════════════════════════════════════════════════════════════════════════
-- 0041 — Undoing a removal, and leaving a trace when one happens
--
-- Two gaps, both found while designing bulk operations, both older than them.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ 1. SOFT DELETE WAS ONE-WAY BY CONSTRUCTION.                               │
-- │                                                                           │
-- │ 0010's policies both carry `deleted_at is null`:                          │
-- │                                                                           │
-- │   questions_read   using (deleted_at is null and has_perm('questions.read')│
-- │   questions_update using (deleted_at is null and has_perm('questions.update')│
-- │                                                                           │
-- │ An UPDATE's USING clause is evaluated against the OLD row, so             │
-- │ `update questions set deleted_at = null where deleted_at is not null`     │
-- │ matches zero rows. And the read policy means a chef cannot even LIST what  │
-- │ they removed. deleteQuestion's docblock states this was intentional.       │
-- │                                                                           │
-- │ It is defensible for a single accidental click and indefensible for a bulk │
-- │ one: "remove 240 questions" with no undo is not a feature anybody should   │
-- │ be handed.                                                                │
-- │                                                                           │
-- │ The two policies below are OR'd alongside 0010's — Postgres combines       │
-- │ permissive policies with OR — so nothing existing is weakened. Each adds a │
-- │ disjunct that requires `questions.retire`, which is the permission that    │
-- │ removed the question in the first place. The rule they state:              │
-- │                                                                           │
-- │     whoever can remove a question can see the ones they removed,          │
-- │     and put them back.                                                    │
-- │                                                                           │
-- │ WHY NOT A SECURITY DEFINER FUNCTION, which was the obvious alternative:    │
-- │ it would put a bypass in the write path, and RLS is the enforcement       │
-- │ boundary in this codebase. A policy keeps the rule where every other rule  │
-- │ about questions already lives, and keeps the write on the USER's client —  │
-- │ which matters for the second half of this migration.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ 2. NOTHING RECORDED THAT A QUESTION HAD BEEN REMOVED. ANYWHERE.           │
-- │                                                                           │
-- │ public.questions has no audit trigger — 0006 attaches audit_row() to five  │
-- │ tables and says the omission is deliberate: "auditing every question edit  │
-- │ would bury the events that matter under noise, and blow the storage budget │
-- │ doing it." That reasoning is right about EDITS and wrong about removals.  │
-- │                                                                           │
-- │ question_revisions does not cover it either: bump_question_revision fires  │
-- │ only on stem, content, type, response_format, marks and negative_marks, so │
-- │ a deleted_at update no-ops both revision triggers.                        │
-- │                                                                           │
-- │ So a bulk archive of 300 questions would have left no trace of any kind.   │
-- │                                                                           │
-- │ The trigger below is column-scoped to exactly the two events 0006 would    │
-- │ have called sensitive — a lifecycle move and a removal — and stays silent  │
-- │ on content, which question_revisions already keeps. audit_row() stores a   │
-- │ diff, so a status change costs one small jsonb object, not a row snapshot. │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THE TWO HALVES DEPEND ON EACH OTHER. audit_row() reads auth.uid() for the
-- actor. Had restore gone through the admin client — the other way to get past
-- the `deleted_at is null` policies — auth.uid() would be NULL and every
-- restore would have been logged anonymously. Keeping the write on the user's
-- client is what makes the audit trail worth having.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Seeing what you removed ──────────────────────────────────────────────────
--
-- Brand-scoped to match questions_read exactly. A chef who cannot see a live
-- question from another brand must not be able to see its corpse either.
create policy questions_read_deleted on public.questions
  for select to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('questions.retire'))
    and company_id = (select public.my_company())
    and (brand_id is null
         or brand_id = (select public.my_brand())
         or (select public.is_super_admin()))
  );

-- ── Putting it back ──────────────────────────────────────────────────────────
--
-- USING selects the deleted row; WITH CHECK constrains what it may become. The
-- company predicate appears in both because USING is evaluated against the OLD
-- row and WITH CHECK against the NEW one — without the second, a restore could
-- also move the row to another company.
create policy questions_restore on public.questions
  for update to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('questions.retire'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

comment on policy questions_restore on public.questions is
  'The undo half of the soft delete. 0010 made removal one-way — its USING clause is evaluated against the OLD row, so a restore matched nothing — which is defensible for one accidental click and indefensible for a bulk one. Requires questions.retire: the permission that removed the question is the permission that can put it back.';

-- ── A trace, for the two events that deserve one ─────────────────────────────
create trigger questions_lifecycle_audit
  after update on public.questions
  for each row
  when (old.status is distinct from new.status
     or old.deleted_at is distinct from new.deleted_at)
  execute function public.audit_row();

comment on trigger questions_lifecycle_audit on public.questions is
  'Status moves and removals only. 0006 deliberately left public.questions unaudited because logging every edit would bury the events that matter; that argument holds for content and not for lifecycle. question_revisions already covers edits, and covers neither of these — bump_question_revision ignores status and deleted_at entirely.';
