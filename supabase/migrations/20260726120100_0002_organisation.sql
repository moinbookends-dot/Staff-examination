-- ═════════════════════════════════════════════════════════════════════════════
-- 0002 — Organisation hierarchy
--
--   companies ─┬─ brands ─── outlets
--              └─ departments
--
-- A NOTE ON DEPARTMENTS, because this deviates from the PRD's implied chain
-- (companies → brands → outlets → departments):
--
-- Departments hang off the COMPANY, not the outlet. Staff carry an outlet_id
-- and a department_id independently.
--
-- Why: PRD §4.8 requires an Outlet Report with "cross-department benchmarks"
-- and a Department Report comparing performance across the group. If each
-- outlet owned its own "Kitchen" row, every such comparison would have to join
-- on department *name* — fragile the moment someone types "Kitchens" or
-- "kitchen". A shared taxonomy makes it a group-by on a foreign key.
--
-- Outlets that lack a department simply have no staff assigned to it. Nothing
-- is lost, and the reporting requirement is satisfied by construction.
--
-- RLS is enabled on creation, not deferred to 0005. A table with RLS enabled
-- and no policies denies everything, which is the correct default; a table
-- created without RLS is world-readable until the policy migration lands, and
-- that window is a real hole if a deploy stops in between.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── companies ────────────────────────────────────────────────────────────────
-- Single-tenant today (Bookends Hospitality). Modelled anyway because every
-- table below needs a company_id for scoping, and retrofitting one across
-- thirty tables later is far worse than carrying it from the start.
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  logo_path   text,
  settings    jsonb not null default '{}'::jsonb,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Partial unique index, not a plain UNIQUE: soft-deleted rows must not block
-- reuse of a slug. This pattern repeats on every soft-deletable table.
create unique index companies_slug_uq
  on public.companies (slug) where deleted_at is null;

-- ── brands ───────────────────────────────────────────────────────────────────
-- Aiko (Japanese/Asian), Capiche (Italian), Prep.
-- Brand matters beyond labelling: a Capiche pasta question is irrelevant to
-- Aiko staff, so questions.brand_id scopes the bank (null = shared).
create table public.brands (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  name        text not null,
  slug        text not null,
  cuisine     text,
  logo_path   text,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index brands_slug_uq
  on public.brands (company_id, slug) where deleted_at is null;
create index brands_company_idx on public.brands (company_id) where deleted_at is null;

-- ── outlets ──────────────────────────────────────────────────────────────────
-- Physical locations. Three today; the schema is N-outlet from day one so
-- expansion needs no migration (PRD Open Question §11.4).
create table public.outlets (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  brand_id    uuid not null references public.brands(id)    on delete restrict,
  name        text not null,
  code        text not null,                -- short human key, e.g. AIKO-AHM
  city        text,
  state       text default 'Gujarat',
  address     text,
  timezone    text not null default 'Asia/Kolkata',
  is_active   boolean not null default true,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index outlets_code_uq
  on public.outlets (company_id, code) where deleted_at is null;
create index outlets_brand_idx   on public.outlets (brand_id)   where deleted_at is null;
create index outlets_company_idx on public.outlets (company_id) where deleted_at is null;

-- Timezone is explicit and defaults to Asia/Kolkata because exam windows are
-- wall-clock commitments ("opens 9am Monday"). Storing timestamptz alone is
-- not enough to render that correctly if the group ever operates outside IST.

-- ── departments ──────────────────────────────────────────────────────────────
-- Company-wide taxonomy: Kitchen, Service, Bar, Housekeeping, Management.
create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  name        text not null,
  slug        text not null,
  description text,
  sort_order  smallint not null default 0,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index departments_slug_uq
  on public.departments (company_id, slug) where deleted_at is null;
create index departments_company_idx on public.departments (company_id) where deleted_at is null;

-- ── updated_at triggers ──────────────────────────────────────────────────────
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

create trigger outlets_set_updated_at
  before update on public.outlets
  for each row execute function public.set_updated_at();

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();

-- ── RLS: on, deny-all until 0005 grants explicitly ───────────────────────────
alter table public.companies   enable row level security;
alter table public.brands      enable row level security;
alter table public.outlets     enable row level security;
alter table public.departments enable row level security;

comment on table public.departments is
  'Company-wide department taxonomy. Staff reference outlet_id and department_id independently so cross-outlet department benchmarking (PRD 4.8) is a group-by rather than a name match.';
