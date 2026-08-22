-- ═════════════════════════════════════════════════════════════════════════════
-- 0031 — Company scoping for the question bank's side tables
--
-- SECURITY FIX. Ships on its own, ahead of the localisation work that found it,
-- because it has nothing to do with translation and a security fix should not
-- wait on a feature's review.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ FIVE POLICIES IN 0010 CHECK A PERMISSION AND NOTHING ELSE.                 │
-- │                                                                           │
-- │ `has_perm('questions.update')` asks "may this person edit questions?" It  │
-- │ does not ask "whose?". A chef holds that permission in their own company  │
-- │ and the policy then applies to every row in the table, so the only thing  │
-- │ standing between company B and company A's question bank is not knowing   │
-- │ the uuid.                                                                 │
-- │                                                                           │
-- │ The sibling policies in the same file do it correctly —                   │
-- │ answer_keys_write, question_media_read and questions_read all join back   │
-- │ to questions and compare company_id. These five were written in the loose │
-- │ style and nothing caught it, because a permission check LOOKS like        │
-- │ authorisation.                                                            │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- IN SEVERITY ORDER, WHICH IS NOT THE ORDER THEY WERE FOUND IN:
--
--   question_media_write        Cross-tenant content injection into a LIVE
--                               exam. question_snapshot() aggregates
--                               question_media unconditionally (0014), so a
--                               row attached to another company's question is
--                               frozen into their paper at publish and served
--                               to their candidates. Nothing downstream
--                               re-checks it: the snapshot is trusted by
--                               construction because only the author was
--                               supposed to be able to write it.
--
--   question_tags_write         Cross-tenant denial of service. exam_rules
--                               select on tags, so deleting another company's
--                               question_tags rows silently shrinks the pool
--                               their rules draw from. They discover it as a
--                               `rule.short` blocking health check at publish
--                               time, with no indication why.
--
--   question_translations_write Paper tampering, latent today and live the
--                               moment 0033 puts translations on the delivery
--                               path.
--
--   *_read                      Enumeration. Confirms a question id exists and
--                               leaks its tags and translated text.
--
-- NOT EXPLOITABLE AT SCALE TODAY, and that is worth stating plainly rather than
-- overselling the find: questions_read IS company-scoped, so ids are not
-- enumerable through the API and an attacker needs one to start. This is
-- defence in depth that 0033 would have turned into a real path.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE SUBQUERY INHERITS THE BRAND CLAUSE, AND THAT SURPRISES PEOPLE.        │
-- │                                                                           │
-- │ `exists (select 1 from public.questions q where …)` is itself filtered by │
-- │ questions_read, which scopes by brand as well as company. So a chef whose │
-- │ claims name brand A cannot tag, translate or attach media to a brand-B    │
-- │ question even inside their own company. That is the same behaviour        │
-- │ answer_keys_read has had since 0010 and it is intended — but it is not    │
-- │ obvious from reading this file, so: it is written down here.              │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── question_media ───────────────────────────────────────────────────────────
-- The severe one. Read was already scoped in 0010; write was not.

drop policy if exists question_media_write on public.question_media;
create policy question_media_write on public.question_media
  for all to authenticated
  using (
    (select public.has_perm('questions.update'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  )
  with check (
    (select public.has_perm('questions.update'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  );

comment on policy question_media_write on public.question_media is
  'Scoped to the parent question''s company. Before 0031 this checked only the permission, which let any chef attach media to any company''s question — and question_snapshot() would then freeze it into that company''s paper and serve it to their candidates.';

-- ── question_tags ────────────────────────────────────────────────────────────

drop policy if exists question_tags_read on public.question_tags;
create policy question_tags_read on public.question_tags
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  );

drop policy if exists question_tags_write on public.question_tags;
create policy question_tags_write on public.question_tags
  for all to authenticated
  using (
    (select public.has_perm('questions.update'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  )
  with check (
    (select public.has_perm('questions.update'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  );

comment on policy question_tags_write on public.question_tags is
  'Scoped to the parent question''s company. Unscoped, a delete here silently shrank another company''s rule pools, surfacing as an unexplained rule.short at publish time.';

-- ── question_translations ────────────────────────────────────────────────────

drop policy if exists question_translations_read on public.question_translations;
create policy question_translations_read on public.question_translations
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  );

drop policy if exists question_translations_write on public.question_translations;
create policy question_translations_write on public.question_translations
  for all to authenticated
  using (
    (select public.has_perm('questions.translate'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  )
  with check (
    (select public.has_perm('questions.translate'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
         and q.deleted_at is null
    )
  );

comment on policy question_translations_write on public.question_translations is
  'Scoped to the parent question''s company. Presentation-only content bounded the damage while nothing read this table; 0033 puts it on the candidate delivery path, at which point an unscoped write is another company''s paper.';
