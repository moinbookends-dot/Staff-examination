-- ═════════════════════════════════════════════════════════════════════════════
-- 0065 — The Guide belongs to the Editor.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE PERSON WHO WRITES THE QUESTIONS COULD NOT OPEN THE BOOKS.             ║
-- ║                                                                           ║
-- ║ /guide is the cookbook library — the source documents a question is       ║
-- ║ written FROM. In the rebuilt product that is an Editor's reference        ║
-- ║ material. But the whole surface was keyed on the legacy `questions.read`  ║
-- ║ and `questions.import`, which only a Chef holds, so:                      ║
-- ║                                                                           ║
-- ║     Editor  → /guide 500s (and every document filtered to nothing)        ║
-- ║     Chef    → /guide opens, for a library they never write from           ║
-- ║                                                                           ║
-- ║ Exactly backwards. src/lib/auth/nav.ts has carried a note about this for  ║
-- ║ two milestones, which is why the Guide was never given a nav entry.       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EITHER KEY, NOT A SWAP — SO NOTHING IS TAKEN AWAY TODAY.                  │
-- │                                                                           │
-- │ Each policy now accepts bank.* OR questions.*. Replacing one with the     │
-- │ other would silently revoke a Chef's access to a library they can open    │
-- │ today, and that is a product decision nobody has made.                    │
-- │                                                                           │
-- │ It is also the shape that survives the legacy drop: when questions.* is   │
-- │ deleted the OR collapses to bank.* on its own, and this migration does    │
-- │ not need revisiting.                                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- Eight policies: five on public.source_documents, three on storage.objects.
-- Every one is recreated verbatim apart from the permission test — the company
-- scoping, the brand scoping, the deleted_at split and the super-admin escape
-- are all preserved exactly as they were.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- public.source_documents
-- ═════════════════════════════════════════════════════════════════════════════

drop policy if exists source_documents_read on public.source_documents;
create policy source_documents_read on public.source_documents
  for select to authenticated
  using (
    deleted_at is null
    and ((select public.has_perm('bank.read')) or (select public.has_perm('questions.read')))
    and company_id = (select public.my_company())
    and (
      brand_id is null
      or brand_id = (select public.my_brand())
      or (select public.is_super_admin())
    )
  );

drop policy if exists source_documents_read_deleted on public.source_documents;
create policy source_documents_read_deleted on public.source_documents
  for select to authenticated
  using (
    deleted_at is not null
    and ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and company_id = (select public.my_company())
    and (
      brand_id is null
      or brand_id = (select public.my_brand())
      or (select public.is_super_admin())
    )
  );

drop policy if exists source_documents_insert on public.source_documents;
create policy source_documents_insert on public.source_documents
  for insert to authenticated
  with check (
    ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and company_id = (select public.my_company())
    -- Unchanged, and load-bearing: you may only file a document as yourself.
    and uploaded_by = (select auth.uid())
  );

drop policy if exists source_documents_update on public.source_documents;
create policy source_documents_update on public.source_documents
  for update to authenticated
  using (
    deleted_at is null
    and ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

drop policy if exists source_documents_restore on public.source_documents;
create policy source_documents_restore on public.source_documents
  for update to authenticated
  using (
    deleted_at is not null
    and ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- ═════════════════════════════════════════════════════════════════════════════
-- storage.objects
--
-- The row policies above decide who may see a document's RECORD. These decide
-- who may fetch the FILE. Both have to move, or an Editor would list a library
-- of documents and be refused every download.
-- ═════════════════════════════════════════════════════════════════════════════

drop policy if exists source_documents_storage_read on storage.objects;
create policy source_documents_storage_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'source-documents'
    and ((select public.has_perm('bank.read')) or (select public.has_perm('questions.read')))
    -- The first path segment is the company id. Unchanged.
    and (storage.foldername(name))[1] = ((select public.my_company()))::text
  );

drop policy if exists source_documents_storage_insert on storage.objects;
create policy source_documents_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'source-documents'
    and ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and (storage.foldername(name))[1] = ((select public.my_company()))::text
  );

drop policy if exists source_documents_storage_update on storage.objects;
create policy source_documents_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'source-documents'
    and ((select public.has_perm('bank.import')) or (select public.has_perm('questions.import')))
    and (storage.foldername(name))[1] = ((select public.my_company()))::text
  );
