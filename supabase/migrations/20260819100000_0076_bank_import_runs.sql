-- ═════════════════════════════════════════════════════════════════════════════
-- 0076 — Import history
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHY THIS IS NOT audit_logs, WHICH ALREADY EXISTS AND ALREADY DOES THIS.   ║
-- ║                                                                           ║
-- ║ audit_logs (0006) has NO INSERT POLICY, on purpose. Its only writer is    ║
-- ║ audit_row(), a SECURITY DEFINER trigger, and that is precisely what makes ║
-- ║ it append-only from the application's point of view: nobody can edit or   ║
-- ║ erase their own trail. Adding an insert policy so the importer could      ║
-- ║ write there would dismantle that property for every other table it        ║
-- ║ protects.                                                                 ║
-- ║                                                                           ║
-- ║ The trigger cannot record this either. An import is 1,030 rows across     ║
-- ║ eleven transactions; audit_row() logs a per-row diff, so the run would    ║
-- ║ arrive as three thousand disconnected entries with no filename, no        ║
-- ║ locale and no way to tell which of them were one import.                  ║
-- ║                                                                           ║
-- ║ So this is its own table, recording the RUN rather than the rows.         ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE UPLOADED FILE IS NOT STORED, AND MUST NOT BE ADDED LATER.             │
-- │                                                                           │
-- │ The document that prompted this table is 1 MB, and the pair with its      │
-- │ answer key is 1.6 MB. Storing them per run would put the single largest   │
-- │ object in the product into a table that grows every time somebody         │
-- │ re-runs an import — against a 500 MB budget that 0006 already identifies  │
-- │ as the schema's tightest constraint.                                      │
-- │                                                                           │
-- │ The filename is enough to answer the question this table exists for:      │
-- │ "which file did those 1,030 Hindi translations come from, and who ran     │
-- │ it". The file itself lives wherever it was exported to.                   │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.bank_import_runs (
  id           uuid primary key default gen_random_uuid(),

  company_id   uuid not null references public.companies(id),
  brand_id     uuid not null references public.brands(id),

  -- set null rather than cascade: a run that happened still happened after the
  -- person who ran it leaves, and the counts are the point of the record.
  actor_id     uuid references public.profiles(id) on delete set null,
  occurred_at  timestamptz not null default now(),

  -- 'json'  — the curated dataset, through the JSON tab
  -- 'paper' — a question paper and its answer key, through the Paper tab
  kind         text not null check (kind in ('json', 'paper')),

  -- Null for a JSON import, which carries every language in one file. A paper
  -- import is always exactly one language, and which one is the whole story.
  locale       text check (locale is null or locale in ('en', 'hi', 'gu')),

  filename            text not null check (length(btrim(filename)) between 1 and 300),
  answer_key_filename text check (answer_key_filename is null
                                  or length(btrim(answer_key_filename)) between 1 and 300),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ COUNTS, NOT A STATUS WORD.                                              │
  -- │                                                                         │
  -- │ "Import completed" is the least useful thing this table could say. The  │
  -- │ question somebody actually arrives with is "we expected 1,030 — how     │
  -- │ many landed", and these five numbers answer it without opening the      │
  -- │ file. detected is what the document contained; the rest sum to it.      │
  -- └─────────────────────────────────────────────────────────────────────────┘
  detected     int not null default 0 check (detected  >= 0),
  created      int not null default 0 check (created   >= 0),
  updated      int not null default 0 check (updated   >= 0),
  skipped      int not null default 0 check (skipped   >= 0),
  rejected     int not null default 0 check (rejected  >= 0),
  warnings     int not null default 0 check (warnings  >= 0),

  -- 'partial' is a real outcome and is recorded as one: each batch is its own
  -- transaction, so an import can genuinely stop halfway with earlier batches
  -- committed. Recording that as 'failed' would be a lie somebody acts on.
  status       text not null check (status in ('completed', 'partial', 'failed')),
  message      text check (message is null or length(message) <= 2000)
);

comment on table public.bank_import_runs is
  'One row per import run. Append-only from the app: there is no update or delete policy. The uploaded file is deliberately not stored — see the migration.';
comment on column public.bank_import_runs.detected is
  'Questions the document contained. created + updated + skipped + rejected should account for it.';

-- The history panel reads the most recent runs for a brand.
create index bank_import_runs_brand_idx
  on public.bank_import_runs (company_id, brand_id, occurred_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS
--
-- Insert is keyed on bank.import — the same permission the import screen and
-- the tab are gated on — so the history cannot record a run that the caller
-- was not permitted to perform. Read is keyed on bank.read, matching every
-- other bank table in 0055: whoever may see the questions may see where they
-- came from.
--
-- THERE IS NO UPDATE POLICY AND NO DELETE POLICY. A record of what was
-- imported that the importer can rewrite afterwards is not a record.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.bank_import_runs enable row level security;

create policy bank_import_runs_read on public.bank_import_runs
  for select to authenticated
  using (
    (select public.has_perm('bank.read'))
    and company_id = (select public.my_company())
  );

create policy bank_import_runs_insert on public.bank_import_runs
  for insert to authenticated
  with check (
    (select public.has_perm('bank.import'))
    and company_id = (select public.my_company())
    -- Stamped with the caller, by the caller's own claim. A run attributed to
    -- somebody else would be worse than no history at all.
    and actor_id = (select auth.uid())
    -- The brand gate RLS does not otherwise carry, mirroring the check
    -- bank_import_commit() makes before writing a single question (0058).
    and (brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
    and exists (
      select 1 from public.brands b
       where b.id = bank_import_runs.brand_id
         and b.company_id = (select public.my_company())
         and b.deleted_at is null
    )
  );
