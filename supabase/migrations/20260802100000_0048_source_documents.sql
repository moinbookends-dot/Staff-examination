-- ═════════════════════════════════════════════════════════════════════════════
-- 0048 — M11a: source documents, import batches, and pages
--
-- The bottom of the cookbook platform. Everything M11c, M12 and M13 add sits on
-- these three tables, so the shape here decides what provenance can mean later.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE PAGE IS THE UNIT OF PROVENANCE, AND THAT IS NOT A STYLE CHOICE.       │
-- │                                                                           │
-- │ Both cookbooks provided are scanned image PDFs: a sweep of every stream    │
-- │ in both files found zero text-showing operators and one full-page JPEG per │
-- │ page. There is no paragraph structure to cite, no heading tree, no         │
-- │ character offsets — until OCR has run there is nothing but pages.          │
-- │                                                                           │
-- │ So "which page" is the finest citation that is true at ingest time, and    │
-- │ every finer anchor the product wants — chapter, section, paragraph — is    │
-- │ DERIVED later by extraction and hangs off a page. Modelling it the other   │
-- │ way round would mean inventing structure at upload and correcting it       │
-- │ afterwards, which is how provenance quietly becomes fiction.               │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THE BATCH IS SEPARATE FROM THE DOCUMENT.                              │
-- │                                                                           │
-- │ "Every import must be reversible" needs something to reverse. A document  │
-- │ is a file and may be re-processed many times — OCR reruns, a better        │
-- │ extraction model, a corrected page. Each of those runs is an import_batch, │
-- │ and it is the batch that gets undone, not the file.                        │
-- │                                                                           │
-- │ Collapsing the two would make "undo the import" mean "delete the           │
-- │ cookbook", which is not the same thing and not what anybody wants at the   │
-- │ moment they need it.                                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- SECURITY INVOKER throughout, no definer functions, no service-role client.
-- These are ordinary company-scoped tables and RLS answers every question about
-- them, exactly as it does for questions and exams.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── source_documents ─────────────────────────────────────────────────────────
create table public.source_documents (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  -- Null = shared across brands, matching questions.brand_id exactly. A Capiche
  -- pizza manual is irrelevant to Aiko staff, so documents are brand-scoped by
  -- default and the policies below mirror questions_read rather than inventing
  -- a second scoping rule.
  brand_id   uuid references public.brands(id) on delete restrict,

  kind text not null check (kind in ('cookbook','sop','manual','policy','vendor','other')),

  original_filename text not null check (length(btrim(original_filename)) between 1 and 300),
  -- Supabase Storage object path. `provider` is deliberately absent: unlike
  -- question_media, which supports external video to keep egress affordable,
  -- a source document must be readable by the OCR worker byte for byte, and an
  -- external URL cannot promise that.
  storage_path text not null unique,
  mime_type    text not null,
  byte_size    bigint not null check (byte_size > 0),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ sha256 IS WHAT MAKES RE-UPLOAD DETECTABLE.                              │
  -- │                                                                         │
  -- │ These files are 28 MB and 92 MB. Somebody will upload the same cookbook │
  -- │ twice — different filename, same bytes — and without this the platform  │
  -- │ would OCR 113 pages again, generate a parallel knowledge tree, and hand │
  -- │ chefs two of every question with no way to tell which was which.        │
  -- │                                                                         │
  -- │ Unique per company rather than globally: two companies may legitimately │
  -- │ hold the same published manual, and neither should learn that from a    │
  -- │ constraint violation.                                                   │
  -- └─────────────────────────────────────────────────────────────────────────┘
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),

  page_count int check (page_count > 0),

  -- Ingest lifecycle, deliberately NOT the question lifecycle. A document is
  -- never "drawable"; it is uploaded, processed, and then either usable or
  -- broken. Reusing question_status here would put states on it that mean
  -- nothing (approved? retired?) and invite code to treat the two as one.
  status text not null default 'uploaded'
    check (status in ('uploaded','processing','processed','failed','archived')),

  -- Version chain. A replacement points BACK at what it replaces, so the old
  -- row keeps its provenance and every question citing it stays truthful.
  supersedes_id uuid references public.source_documents(id) on delete set null,

  title       text,
  description text,

  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint source_documents_sha_per_company unique (company_id, sha256)
);

create index source_documents_company_idx
  on public.source_documents (company_id, kind, status) where deleted_at is null;

create trigger source_documents_set_updated_at
  before update on public.source_documents
  for each row execute function public.set_updated_at();

-- ── import_batches ───────────────────────────────────────────────────────────
create table public.import_batches (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  source_document_id uuid not null
    references public.source_documents(id) on delete cascade,

  kind text not null check (kind in ('ocr','extraction','generation')),

  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','reverted')),

  -- Counts, errors and timings. jsonb rather than columns because what is worth
  -- recording differs per kind — pages for OCR, units for extraction, questions
  -- for generation — and three sets of mostly-null columns would be worse.
  stats jsonb not null default '{}'::jsonb,
  last_error text,

  started_by uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Set when the batch is undone. Kept rather than deleted: "this import was
  -- reverted, by whom, when" is exactly the question somebody asks later.
  reverted_at timestamptz,
  reverted_by uuid references public.profiles(id) on delete set null
);

create index import_batches_document_idx
  on public.import_batches (source_document_id, started_at desc);

-- ── document_pages ───────────────────────────────────────────────────────────
create table public.document_pages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  source_document_id uuid not null
    references public.source_documents(id) on delete cascade,

  page_number int not null check (page_number > 0),

  -- The rendered page image. OCR reads this, and the UI shows it beside a
  -- question so "open the original cookbook page" is a real link rather than a
  -- page number somebody has to go and find.
  image_path text,

  ocr_status text not null default 'pending'
    check (ocr_status in ('pending','running','done','failed','skipped')),
  ocr_text text,
  -- 0..1. Surfaced rather than thresholded here: what counts as too low to
  -- trust is a product judgement that belongs where the pages are reviewed,
  -- not baked into a CHECK that would need a migration to tune.
  ocr_confidence numeric(4,3) check (ocr_confidence between 0 and 1),
  ocr_model text,
  -- Retry is a data property. A 113-page book that fails on page 90 must not
  -- redo 89 pages, so attempts and the error live per page.
  ocr_attempts int not null default 0 check (ocr_attempts >= 0),
  ocr_error text,
  ocr_completed_at timestamptz,

  created_at timestamptz not null default now(),

  constraint document_pages_unique unique (source_document_id, page_number)
);

create index document_pages_pending_idx
  on public.document_pages (source_document_id, page_number)
  where ocr_status in ('pending', 'failed');

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS
--
-- Modelled on 0010's question policies rather than invented: read is
-- company-scoped and brand-scoped, writes require a permission. Anyone who may
-- read the question bank may read the documents its questions cite — a citation
-- nobody can open is not provenance.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.source_documents enable row level security;
alter table public.import_batches   enable row level security;
alter table public.document_pages   enable row level security;

create policy source_documents_read on public.source_documents
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
    and (brand_id is null
         or brand_id = (select public.my_brand())
         or (select public.is_super_admin()))
  );

-- questions.import, not questions.create: uploading a cookbook is the import
-- capability the seed already grants chefs, and it is the permission M11 was
-- always going to key on.
create policy source_documents_insert on public.source_documents
  for insert to authenticated
  with check (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
    and uploaded_by = (select auth.uid())
  );

create policy source_documents_update on public.source_documents
  for update to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- No DELETE policy anywhere, exactly as public.questions has none (0010). A
-- document cited by a published question must never vanish, or the paper that
-- cites it becomes unexplainable. Removal is deleted_at; reversal is the batch.

create policy import_batches_read on public.import_batches
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
  );

create policy import_batches_write on public.import_batches
  for insert to authenticated
  with check (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
    and started_by = (select auth.uid())
  );

create policy import_batches_update on public.import_batches
  for update to authenticated
  using (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

create policy document_pages_read on public.document_pages
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
  );

-- Pages are written by the OCR worker on behalf of a person holding
-- questions.import. The worker authenticates as that user rather than as a
-- service role, so these policies are the whole story — there is no bypass to
-- audit later.
create policy document_pages_write on public.document_pages
  for insert to authenticated
  with check (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
  );

create policy document_pages_update on public.document_pages
  for update to authenticated
  using (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- ═════════════════════════════════════════════════════════════════════════════
-- Storage
--
-- A private bucket. Cookbooks are proprietary — these two were briefly
-- committed to a public repository, which is exactly the mistake this bucket
-- exists to make structurally impossible.
--
-- The path convention is  <company_id>/<source_document_id>/<filename>  so the
-- policies below can authorise on the leading folder alone. storage.foldername()
-- returns the path segments; element 1 is the company.
-- ═════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('source-documents', 'source-documents', false)
on conflict (id) do nothing;

create policy source_documents_storage_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'source-documents'
    and (select public.has_perm('questions.read'))
    and (storage.foldername(name))[1] = (select public.my_company())::text
  );

create policy source_documents_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'source-documents'
    and (select public.has_perm('questions.import'))
    and (storage.foldername(name))[1] = (select public.my_company())::text
  );

create policy source_documents_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'source-documents'
    and (select public.has_perm('questions.import'))
    and (storage.foldername(name))[1] = (select public.my_company())::text
  );

comment on table public.source_documents is
  'One uploaded file. The root of every provenance chain in the cookbook platform. sha256 is unique per company so re-uploading the same 92 MB manual under a new filename is detected rather than silently OCR''d again into a parallel knowledge tree. No DELETE policy: a document cited by a published question must not vanish, exactly as public.questions has no DELETE policy for the same reason.';

comment on table public.import_batches is
  'One processing run over a document, and the unit of reversal. Separate from the document because a file is processed many times — OCR reruns, better extraction, a corrected page — and "undo the import" must not mean "delete the cookbook". Reverted batches are kept, not deleted: who reverted it and when is exactly what gets asked later.';

comment on table public.document_pages is
  'One page of a source document, and the finest citation that is true at ingest. Both provided cookbooks are scanned images with no text layer at all, so page number is the only anchor that exists before OCR; chapter, section and paragraph are derived later and hang off a page. ocr_attempts and ocr_error are per page so a 113-page book failing at page 90 retries one page, not ninety.';
