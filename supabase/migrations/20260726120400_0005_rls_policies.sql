-- ═════════════════════════════════════════════════════════════════════════════
-- 0005 — Row-Level Security policies for organisation + identity
--
-- THREE RULES, applied to every policy in this file and every one that follows:
--
--  1. Always name the role: `to authenticated`. A policy without it is
--     evaluated for anon too, which is rarely what you mean.
--
--  2. Always wrap helper calls: `(select public.has_perm('x'))`. Postgres then
--     hoists the call to an InitPlan evaluated ONCE PER QUERY. Unwrapped, it
--     runs once per row. Same for auth.uid(). This is the single highest-impact
--     detail in the whole RLS design.
--
--  3. Every column a policy filters on must be indexed. A policy is a WHERE
--     clause; an unindexed predicate is a seq scan on every request. The
--     indexes were created alongside the tables in 0002/0003.
--
-- NO DELETE POLICIES ANYWHERE. Deletion is `update ... set deleted_at = now()`
-- and every read policy filters `deleted_at is null`. Hard deletes would
-- destroy the audit trail that PRD §4.11 requires.
--
-- NO ANON POLICIES. The registration form needs outlet and department lists
-- before a session exists; those are served by a server action using the admin
-- client with a hand-written `select id, name`. Opening an anon read policy on
-- the org tree to serve two dropdowns is a permanent hole for a temporary need.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────────────────────

-- THE APPROVAL-GATE EXCEPTION.
--
-- Every other policy in this system requires approval. This one must not:
-- a pending user has to read their own row for the /pending screen to show
-- their name and rejection reason. Scoped to exactly one row — their own.
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Self-service edits. Column restrictions (a user must not set their own
-- approval_status or outlet) cannot be expressed in RLS — Postgres RLS is
-- row-level, not column-level. The server action is the enforcement point:
-- it accepts a whitelist of editable fields only. This policy just scopes
-- the row.
create policy profiles_self_update on public.profiles
  for update to authenticated
  using      (id = (select auth.uid()) and deleted_at is null)
  with check (id = (select auth.uid()) and deleted_at is null);

-- Chefs see their own outlet's staff. Deliberately narrower than "everyone":
-- an Aiko chef has no business reading Capiche staff records.
create policy profiles_read_team on public.profiles
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('users.read_team'))
    and outlet_id = (select public.my_outlet())
  );

-- HR and Super Admin see the whole company.
create policy profiles_read_all on public.profiles
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('users.read_all'))
    and company_id = (select public.my_company())
  );

-- Approvals and admin edits.
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('users.update'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- ─────────────────────────────────────────────────────────────────────────────
-- companies · brands · outlets · departments
--
-- Read: any approved member of the company. Staff need to see outlet and
-- department names constantly (their own profile, exam assignment targets,
-- report filters); gating that behind a permission would mean granting it to
-- all four roles anyway.
--
-- Write: org.manage only.
-- ─────────────────────────────────────────────────────────────────────────────

create policy companies_read on public.companies
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and id = (select public.my_company())
  );

create policy companies_write on public.companies
  for all to authenticated
  using      ((select public.has_perm('org.manage')) and id = (select public.my_company()))
  with check ((select public.has_perm('org.manage')) and id = (select public.my_company()));

create policy brands_read on public.brands
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and company_id = (select public.my_company())
  );

create policy brands_write on public.brands
  for all to authenticated
  using      ((select public.has_perm('org.manage')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('org.manage')) and company_id = (select public.my_company()));

create policy outlets_read on public.outlets
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and company_id = (select public.my_company())
  );

create policy outlets_write on public.outlets
  for all to authenticated
  using      ((select public.has_perm('org.manage')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('org.manage')) and company_id = (select public.my_company()));

create policy departments_read on public.departments
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and company_id = (select public.my_company())
  );

create policy departments_write on public.departments
  for all to authenticated
  using      ((select public.has_perm('org.manage')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('org.manage')) and company_id = (select public.my_company()));

-- ─────────────────────────────────────────────────────────────────────────────
-- roles · permissions · role_permissions
--
-- Readable by any approved user so the UI can render role names on a profile
-- or a directory listing. There is nothing sensitive in "a role called Chef
-- exists" — the sensitive part is who holds it (user_roles, below).
--
-- permissions has NO write policy at all: it is seeded from
-- src/lib/auth/permissions.ts and CI asserts the two match. Allowing runtime
-- inserts would let the database drift from the TypeScript union that gates
-- the UI, producing permissions that grant nothing or gates that check keys
-- nobody holds.
-- ─────────────────────────────────────────────────────────────────────────────

create policy roles_read on public.roles
  for select to authenticated
  using (
    (select public.is_approved())
    and (company_id is null or company_id = (select public.my_company()))
  );

create policy roles_write on public.roles
  for all to authenticated
  using      ((select public.has_perm('roles.manage')) and company_id = (select public.my_company()))
  with check ((select public.has_perm('roles.manage')) and company_id = (select public.my_company()));
-- company_id must be non-null on write: the four built-in roles (company_id
-- null) are system roles and stay immutable from the application.

create policy permissions_read on public.permissions
  for select to authenticated
  using ((select public.is_approved()));

create policy role_permissions_read on public.role_permissions
  for select to authenticated
  using ((select public.is_approved()));

create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using      ((select public.has_perm('roles.manage')))
  with check ((select public.has_perm('roles.manage')));

-- ─────────────────────────────────────────────────────────────────────────────
-- user_roles — who holds what. The sensitive one.
-- ─────────────────────────────────────────────────────────────────────────────

create policy user_roles_self_read on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_roles_admin_read on public.user_roles
  for select to authenticated
  using ((select public.has_perm('users.read_all')));

create policy user_roles_write on public.user_roles
  for all to authenticated
  using      ((select public.has_perm('users.assign_roles')))
  with check ((select public.has_perm('users.assign_roles')));

comment on policy profiles_self_read on public.profiles is
  'Deliberate exception to the approval gate: a pending user must read their own row so /pending can render. Scoped to exactly one row.';
