-- ═══════════════════════════════════════════════════════════════════════════
-- 0081 — The sign-up form stops needing the key that bypasses RLS.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THIS REVERSES A DELIBERATE DECISION, SO HERE IS WHAT CHANGED.             ║
-- ║                                                                           ║
-- ║ src/server/actions/org.ts chose the admin client on purpose, and said so: ║
-- ║ the alternative was "a permanent public read grant on the org tree to     ║
-- ║ serve two dropdowns". That was a fair reading of the options as they      ║
-- ║ stood, and the code was carefully narrowed to compensate.                 ║
-- ║                                                                           ║
-- ║ What it could not compensate for is that getSecretKey() THROWS when the   ║
-- ║ variable is absent. So a missing environment variable on the host does    ║
-- ║ not degrade the sign-up page — it returns 500. That is what happened in   ║
-- ║ production: every other auth page served, and registration alone was      ║
-- ║ dead, because a PUBLIC page had been made to depend on the most           ║
-- ║ privileged credential in the system.                                      ║
-- ║                                                                           ║
-- ║ THE OBJECTION IS ANSWERED RATHER THAN OVERRULED. This is not a public     ║
-- ║ read grant on the org tree. Postgres privileges are per COLUMN, and anon  ║
-- ║ is given exactly the columns the dropdowns render — id and name (and a    ║
-- ║ sort key for departments). Every other column stays unreadable: address,  ║
-- ║ city, timezone, code, company_id, brand_id.                               ║
-- ║                                                                           ║
-- ║ And the row filter lives in the POLICY, not in the query. A policy        ║
-- ║ expression is evaluated internally, so anon needs no privilege on         ║
-- ║ deleted_at or is_active to be filtered by them — and cannot see a         ║
-- ║ retired or deactivated outlet however the request is written.             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Nothing here is newly public in substance: these names are rendered in a
-- dropdown to anybody who opens the registration page. What changes is that
-- serving them no longer requires a credential that can read every row in the
-- database.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- Columns first, and the revoke is the load-bearing half
--
-- Supabase grants anon SELECT on every column of every table in `public` by
-- default — verified on this database: 13 columns on outlets, 9 on
-- departments. Only the absence of a policy has been stopping the reads. Add a
-- policy without narrowing the grant and an anonymous visitor could read every
-- outlet's street address.
-- ═════════════════════════════════════════════════════════════════════════════

revoke select on public.outlets     from anon;
revoke select on public.departments from anon;

grant select (id, name)              on public.outlets     to anon;
grant select (id, name, sort_order)  on public.departments to anon;

/*
 * INSERT and UPDATE are deliberately left as they are.
 *
 * anon holds those grants too, from the same Supabase default, and they are
 * inert: no anon policy admits a write, so RLS refuses every one. Revoking
 * them is worth doing and is NOT done here, because it is a wider change than
 * this migration's subject and would bury a real fix inside an unrelated one.
 */

-- ═════════════════════════════════════════════════════════════════════════════
-- Rows
--
-- Retired and deactivated rows are excluded in the policy rather than in the
-- caller's query, so the guarantee holds no matter what the caller asks for.
-- ═════════════════════════════════════════════════════════════════════════════

create policy outlets_read_for_registration on public.outlets
  for select to anon
  using (deleted_at is null and is_active);

create policy departments_read_for_registration on public.departments
  for select to anon
  using (deleted_at is null);

comment on policy outlets_read_for_registration on public.outlets is
  'The outlet dropdown on the public sign-up form. anon may read id and name only — see the column grants in 0081 — and never a retired or deactivated outlet.';

comment on policy departments_read_for_registration on public.departments is
  'The department dropdown on the public sign-up form. anon may read id, name and sort_order only, and never a deleted department.';
