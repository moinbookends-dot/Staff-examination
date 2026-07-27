-- ═════════════════════════════════════════════════════════════════════════════
-- 0008 — Make the approval queue reachable
--
-- THE BUG THIS FIXES
--
-- profiles_read_team (0005) scopes staff visibility by outlet:
--
--   and outlet_id = (select public.my_outlet())
--
-- A newly-registered user has outlet_id = NULL, because the outlet is assigned
-- BY the chef DURING approval — it is deliberately not taken from the signup
-- payload, which is client-controlled (see handle_new_user in 0003).
--
-- So `NULL = '<chef outlet>'` evaluates to NULL, the row is filtered out, and
-- the chef cannot see the registration they are supposed to act on. The queue
-- is permanently empty and nobody can ever be approved. Chicken-and-egg.
--
-- Caught by scripts/walkthrough.mjs, which registers a real user through the
-- HTTP API. The pg-level RLS tests missed it because their fixtures assigned an
-- outlet to every profile, including pending ones — the fixture was more
-- convenient than reality. tests/integration now covers this case.
--
-- THE FIX
--
-- A separate policy for pending registrations, scoped by COMPANY rather than
-- outlet. Company is the only scope available: an unassigned applicant belongs
-- to no outlet by definition.
--
-- Consequence, accepted deliberately: an Aiko chef can see a Capiche applicant
-- while that applicant is pending. There is no data to scope on until someone
-- decides, and the alternative — nobody can approve anyone — is worse. Once
-- approved, the outlet-scoped policy takes over and normal isolation resumes.
--
-- Note the approval WRITE is not granted here. Chefs hold users.approve, not
-- users.update, so approval goes through a server action using the admin client
-- with requirePermission('users.approve') — see src/server/actions/users.ts.
-- ═════════════════════════════════════════════════════════════════════════════

create policy profiles_read_pending on public.profiles
  for select to authenticated
  using (
    deleted_at is null
    and approval_status = 'pending'
    and (select public.has_perm('users.approve'))
    and company_id = (select public.my_company())
  );

comment on policy profiles_read_pending on public.profiles is
  'Approvers see pending registrations company-wide. Necessary because a pending user has no outlet_id yet — it is assigned during approval — so the outlet-scoped team policy can never match them.';
