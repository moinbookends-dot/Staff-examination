-- ═════════════════════════════════════════════════════════════════════════════
-- 0010 — RLS for the question bank
--
-- The critical policy in this file is on question_answer_keys. Everything else
-- is routine.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── categories · tags ────────────────────────────────────────────────────────
-- Readable by any approved user: category names appear on results and reports
-- that employees see, so gating them behind questions.read would just mean
-- granting that to everyone.

create policy categories_read on public.categories
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and company_id = (select public.my_company())
  );

create policy categories_write on public.categories
  for all to authenticated
  using      ((select public.has_perm('questions.update')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('questions.update')) and company_id = (select public.my_company()));

create policy tags_read on public.tags
  for select to authenticated
  using ((select public.is_approved()) and company_id = (select public.my_company()));

create policy tags_write on public.tags
  for all to authenticated
  using      ((select public.has_perm('questions.update')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('questions.update')) and company_id = (select public.my_company()));

-- ── questions ────────────────────────────────────────────────────────────────
--
-- Note what is NOT here: no policy grants employees read access. Employees
-- never query this table. They see questions only through exam delivery, which
-- reads the frozen snapshot on exam_questions via a sanitising server route.
-- If an employee could select from `questions` directly they would be able to
-- browse the whole bank before sitting an exam.

create policy questions_read on public.questions
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
    -- Brand scoping: null brand = shared across all brands.
    and (brand_id is null
         or brand_id = (select public.my_brand())
         or (select public.is_super_admin()))
  );

create policy questions_insert on public.questions
  for insert to authenticated
  with check (
    (select public.has_perm('questions.create'))
    and company_id = (select public.my_company())
    -- Authorship is asserted by the database, not by the client payload.
    and created_by = (select auth.uid())
  );

create policy questions_update on public.questions
  for update to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('questions.update'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- No delete policy: retirement is `status = 'retired'`, removal is
-- `deleted_at = now()`. A question referenced by a past exam attempt must never
-- vanish, or historical results become unexplainable.

-- ═════════════════════════════════════════════════════════════════════════════
-- question_answer_keys — the one that matters
--
-- Read is restricted to holders of questions.read, i.e. chefs and admins.
-- Employees hold no policy here whatsoever, so RLS denies them by default.
--
-- This is the SECOND line of defence. The first is that exam delivery never
-- selects from this table at all — papers are assembled server-side from the
-- exam_questions snapshot with the key stripped. Either alone would suffice;
-- the combination means a mistake in one layer is not a breach.
-- ═════════════════════════════════════════════════════════════════════════════

create policy answer_keys_read on public.question_answer_keys
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

create policy answer_keys_write on public.question_answer_keys
  for all to authenticated
  using (
    (select public.has_perm('questions.update'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id and q.company_id = (select public.my_company())
    )
  )
  with check (
    (select public.has_perm('questions.create'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id and q.company_id = (select public.my_company())
    )
  );

-- ── question_media ───────────────────────────────────────────────────────────
-- Follows the parent question's visibility.

create policy question_media_read on public.question_media
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

create policy question_media_write on public.question_media
  for all to authenticated
  using      ((select public.has_perm('questions.update')))
  with check ((select public.has_perm('questions.update')));

-- ── question_tags ────────────────────────────────────────────────────────────

create policy question_tags_read on public.question_tags
  for select to authenticated
  using ((select public.has_perm('questions.read')));

create policy question_tags_write on public.question_tags
  for all to authenticated
  using      ((select public.has_perm('questions.update')))
  with check ((select public.has_perm('questions.update')));

-- ── question_translations ────────────────────────────────────────────────────

create policy question_translations_read on public.question_translations
  for select to authenticated
  using ((select public.has_perm('questions.read')));

create policy question_translations_write on public.question_translations
  for all to authenticated
  using      ((select public.has_perm('questions.translate')))
  with check ((select public.has_perm('questions.translate')));

comment on policy answer_keys_read on public.question_answer_keys is
  'Question authors only. Employees have no policy on this table and are denied by default. Exam delivery never reads it — papers are assembled from the exam_questions snapshot with keys stripped.';
