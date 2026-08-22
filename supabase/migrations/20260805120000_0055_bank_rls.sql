-- ═════════════════════════════════════════════════════════════════════════════
-- 0055 — Row-level security for the question bank
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ A CHEF HAS NO POLICY ON THIS TABLE. THAT IS THE DESIGN, NOT AN OMISSION.  ║
-- ║                                                                           ║
-- ║ The requirement is that a question's UUID never reaches anybody but an    ║
-- ║ Editor. There are two ways to build that:                                 ║
-- ║                                                                           ║
-- ║   · let a chef read the bank and be careful never to select the id        ║
-- ║   · do not let a chef read the bank                                       ║
-- ║                                                                           ║
-- ║ Only the second is a boundary. The first is a promise that every future   ║
-- ║ query, every `select *`, every PostgREST call from a browser console and  ║
-- ║ every new screen keeps — and PostgREST means the browser can compose its  ║
-- ║ own queries, so "the UI never asks for the id" is not a control at all.   ║
-- ║                                                                           ║
-- ║ So every policy below keys on a bank.* permission, and a chef holds none  ║
-- ║ of them. A chef reaches papers exclusively through the SECURITY DEFINER   ║
-- ║ functions, which choose their columns and return no question ids.         ║
-- ║                                                                           ║
-- ║ THE COROLLARY, WHICH MUST NOT BE UNDONE LATER: do not grant bank.read to  ║
-- ║ the chef role to make some screen easier. The screen is meant to be       ║
-- ║ impossible.                                                               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ COMPANY-SCOPED, NOT BRAND-SCOPED, AND THAT IS DELIBERATE.                 │
-- │                                                                           │
-- │ Every other brand-aware policy in this schema carries                     │
-- │ `brand_id = my_brand()`. These do not, because the only holders of        │
-- │ bank.read are Editors and super admins, and both are explicitly allowed   │
-- │ to work across every brand in their company — an Editor maintains all the │
-- │ banks, not one of them.                                                   │
-- │                                                                           │
-- │ Brand pinning is real, but it belongs where it bites: generate_exam_paper │
-- │ refuses a chef a brand they are not assigned to. Putting it here as well  │
-- │ would lock Editors out of the work they exist to do.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── bank_questions ───────────────────────────────────────────────────────────

create policy bank_questions_read on public.bank_questions
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('bank.read'))
    and company_id = (select public.my_company())
  );

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE RECYCLE BIN — AND WITHOUT IT THE SOFT DELETE ITSELF IS REFUSED.       │
-- │                                                                           │
-- │ This is not a convenience policy for a "Deleted" filter, though it powers │
-- │ one. 0048 proved the mechanism by experiment on public.questions: on a    │
-- │ table with RLS, an UPDATE that moves a row outside EVERY select policy is │
-- │ rejected outright, even when the update policy's WITH CHECK is satisfied. │
-- │                                                                           │
-- │ bank_questions_read carries `deleted_at is null`. So `update … set        │
-- │ deleted_at = now()` puts the row where no policy can see it, and the      │
-- │ write fails — not silently, but with a row-level-security error on an     │
-- │ operation that looks obviously permitted.                                 │
-- │                                                                           │
-- │ Keyed on bank.delete: whoever may delete a question may see the ones they │
-- │ deleted, and may restore them. 0041 established the shape.                │
-- └───────────────────────────────────────────────────────────────────────────┘
create policy bank_questions_read_deleted on public.bank_questions
  for select to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('bank.delete'))
    and company_id = (select public.my_company())
  );

-- created_by = auth.uid() is the same rule source_documents_insert applies to
-- uploaded_by: a question cannot be attributed to somebody who did not write it.
create policy bank_questions_insert on public.bank_questions
  for insert to authenticated
  with check (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
    and created_by = (select auth.uid())
  );

/*
 * One update policy covering edit, archive, restore and delete.
 *
 * RLS chooses ROWS; it cannot say "this permission may write only this
 * column". Splitting bank.write / bank.archive / bank.delete into three
 * policies would therefore produce three policies with identical predicates —
 * and since policies are ORed, holding any one of them would grant all three
 * capabilities anyway. That is a distinction that reads like enforcement and
 * enforces nothing.
 *
 * So the row gate is bank.write, and which COLUMNS a given permission may
 * change is decided in the server actions, where a column is something the
 * code can actually name. Editors hold all three keys, so this is not a
 * practical narrowing today; it is written down so the next person does not
 * mistake the single policy for an oversight.
 */
create policy bank_questions_update on public.bank_questions
  for update to authenticated
  using (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- No DELETE policy, anywhere, exactly as public.questions has none. A question
-- that has ever appeared on a generated paper is referenced by
-- exam_paper_questions with ON DELETE RESTRICT, so a hard delete would either
-- be refused or destroy exam history. deleted_at is the only removal.

-- ── bank_question_texts ──────────────────────────────────────────────────────
--
-- Every policy joins back to the parent rather than re-stating the company
-- rule. 0031 is the reason this is written out longhand: five policies in 0010
-- checked a permission and never asked WHOSE row it was, because a permission
-- check looks like authorisation. The exists() below is what makes these
-- policies tenancy-aware.

create policy bank_question_texts_read on public.bank_question_texts
  for select to authenticated
  using (
    (select public.has_perm('bank.read'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = bank_question_texts.question_id
         and q.company_id = (select public.my_company())
    )
  );

create policy bank_question_texts_insert on public.bank_question_texts
  for insert to authenticated
  with check (
    (select public.has_perm('bank.write'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = bank_question_texts.question_id
         and q.company_id = (select public.my_company())
    )
  );

create policy bank_question_texts_update on public.bank_question_texts
  for update to authenticated
  using (
    (select public.has_perm('bank.write'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = bank_question_texts.question_id
         and q.company_id = (select public.my_company())
    )
  )
  with check (
    exists (
      select 1 from public.bank_questions q
       where q.id = bank_question_texts.question_id
         and q.company_id = (select public.my_company())
    )
  );

/*
 * A delete policy here, unlike on the parent, and for a reason.
 *
 * Clearing a translation is a legitimate edit while a question is a draft —
 * `question` is NOT NULL, so the only way to remove a language is to remove
 * the row. The completeness trigger (0054) is what stops that being used on an
 * ACTIVE question, and it refuses rather than filters, so the Editor is told
 * to move the question to draft first instead of silently ending up with a
 * paper that has a blank line on it.
 *
 * Note this policy is also what the parent's ON DELETE CASCADE does NOT need:
 * a cascade runs as the deleting user but is not itself subject to RLS on the
 * child. It is here for the explicit case only.
 */
create policy bank_question_texts_delete on public.bank_question_texts
  for delete to authenticated
  using (
    (select public.has_perm('bank.write'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = bank_question_texts.question_id
         and q.company_id = (select public.my_company())
    )
  );

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE INDEX THAT MAKES THE POLICIES ABOVE AFFORDABLE.                       │
-- │                                                                           │
-- │ Every bank_question_texts policy runs `exists (… where q.id = …)`. That   │
-- │ is a primary-key lookup, so it is already fast — but the reverse          │
-- │ direction, reading all three languages of one question, is the read the   │
-- │ Editor screen performs once per row on a 50-row page. The PK on           │
-- │ (question_id, locale) covers it with question_id leading, so no extra     │
-- │ index is needed and none is created. Written down because its absence     │
-- │ looks like a mistake next to the four policies above.                     │
-- └───────────────────────────────────────────────────────────────────────────┘

comment on policy bank_questions_read on public.bank_questions is
  'Keyed on bank.read, which the chef role deliberately does not hold. A chef reaches papers only through SECURITY DEFINER functions that return no question ids.';
comment on policy bank_questions_read_deleted on public.bank_questions is
  'Powers the Deleted filter AND makes the soft delete possible: without a select policy matching the deleted row, the UPDATE that sets deleted_at is itself refused.';
