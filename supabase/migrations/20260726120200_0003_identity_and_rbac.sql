-- ═════════════════════════════════════════════════════════════════════════════
-- 0003 — Identity, roles, permissions
--
-- Model: users hold ROLES; roles hold PERMISSIONS. Permission keys are owned by
-- application code (src/lib/auth/permissions.ts) and seeded from there —
-- administrators compose existing keys into custom roles, they never invent
-- new ones. A permission key that exists in the database but not in the
-- TypeScript union is unreachable; the reverse is a runtime failure. CI
-- asserts the two stay in sync.
--
-- Enforcement split (plan §5): RLS is the coarse blast-door — role, org scope,
-- approval status. Granular per-action permissions are enforced in the app via
-- requirePermission(). Expressing 'questions.bulk_import' as a Postgres policy
-- buys nothing and costs a join on every row.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── profiles ─────────────────────────────────────────────────────────────────
-- One row per auth.users row, created by trigger. Holds everything the app
-- needs that Supabase Auth does not store.
create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  company_id        uuid references public.companies(id),
  email             text not null,
  full_name         text not null,
  phone             text,
  employee_code     text,
  brand_id          uuid references public.brands(id),
  outlet_id         uuid references public.outlets(id),
  department_id     uuid references public.departments(id),

  preferred_locale  text not null default 'en'
                      check (preferred_locale in ('en', 'hi', 'gu', 'hi-Latn')),

  approval_status   public.approval_status not null default 'pending',
  approved_by       uuid references public.profiles(id),
  approved_at       timestamptz,
  rejection_reason  text,

  experience_level  smallint check (experience_level between 1 and 5),
  joined_at         date,
  avatar_path       text,
  email_opt_in      boolean not null default true,

  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index profiles_employee_code_uq
  on public.profiles (company_id, employee_code)
  where employee_code is not null and deleted_at is null;

-- Indexes on every column that appears in an RLS predicate. An RLS policy is
-- just a WHERE clause; an unindexed one is a sequential scan on every request.
create index profiles_outlet_idx     on public.profiles (outlet_id)     where deleted_at is null;
create index profiles_department_idx on public.profiles (department_id) where deleted_at is null;
create index profiles_brand_idx      on public.profiles (brand_id)      where deleted_at is null;
create index profiles_approval_idx   on public.profiles (approval_status) where deleted_at is null;

-- Supports the chef approval queue: pending users, oldest first.
create index profiles_pending_queue_idx on public.profiles (created_at)
  where approval_status = 'pending' and deleted_at is null;

-- ── roles ────────────────────────────────────────────────────────────────────
-- Four ship by default (PRD §4.2). is_system marks those four as undeletable —
-- removing 'employee' would orphan every staff member.
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id),   -- null = built-in, all companies
  key         text not null,                          -- super_admin | chef | hr | employee
  name        text not null,
  description text,
  is_system   boolean not null default false,
  sort_order  smallint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index roles_key_uq on public.roles (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- ── permissions ──────────────────────────────────────────────────────────────
-- Seeded lookup table. Never user-editable content.
create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,       -- 'questions.create'
  module      text not null,              -- 'questions'
  action      text not null,              -- 'create'
  description text,
  created_at  timestamptz not null default now()
);

create index permissions_module_idx on public.permissions (module);

-- ── role_permissions ─────────────────────────────────────────────────────────
create table public.role_permissions (
  role_id       uuid not null references public.roles(id)       on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create index role_permissions_perm_idx on public.role_permissions (permission_id);

-- ── user_roles ───────────────────────────────────────────────────────────────
-- Many-to-many: a chef who also manages HR reporting holds both roles.
create table public.user_roles (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role_id     uuid not null references public.roles(id)    on delete restrict,
  granted_by  uuid references public.profiles(id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index user_roles_role_idx on public.user_roles (role_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- New-user trigger
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SECURITY: auth.users.raw_user_meta_data is FULLY USER-CONTROLLED. It is   │
-- │ whatever JSON the client passed to signUp(). Reading display fields from  │
-- │ it is fine. Reading a role, a company, or an approval status from it is   │
-- │ a privilege-escalation hole — a user would simply sign up with            │
-- │ {"approval_status":"approved","role":"super_admin"} and be an admin.      │
-- │                                                                           │
-- │ approval_status is therefore HARD-CODED to 'pending' below, and the role  │
-- │ is looked up server-side as 'employee'. Never parameterise either.        │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role_id    uuid;
begin
  -- Single-tenant today: attach to the only company. When multi-tenant, this
  -- resolves from an invite token, never from client-supplied metadata.
  select id into v_company_id
    from public.companies
   where deleted_at is null
   order by created_at
   limit 1;

  insert into public.profiles (
    id, company_id, email, full_name, phone, preferred_locale, approval_status
  )
  values (
    new.id,
    v_company_id,
    new.email,
    -- Display fields only. Fall back to the email local-part so full_name's
    -- NOT NULL can never fail and block signup.
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
             split_part(coalesce(new.email, 'user'), '@', 1)),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    case
      when new.raw_user_meta_data ->> 'locale' in ('en', 'hi', 'gu', 'hi-Latn')
        then new.raw_user_meta_data ->> 'locale'
      else 'en'
    end,
    'pending'::public.approval_status   -- HARD-CODED. See the box above.
  );

  -- Everyone starts as an employee. Elevation is an explicit admin action,
  -- audited, never a signup-time claim.
  select id into v_role_id
    from public.roles
   where key = 'employee' and company_id is null
   limit 1;

  if v_role_id is not null then
    insert into public.user_roles (user_id, role_id)
    values (new.id, v_role_id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── updated_at triggers ──────────────────────────────────────────────────────
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

-- ── RLS: on, deny-all until 0005 ─────────────────────────────────────────────
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles       enable row level security;

comment on function public.handle_new_user() is
  'Creates a profile for each new auth user. approval_status is hard-coded to pending and the role to employee: raw_user_meta_data is client-controlled and must never determine privilege.';
