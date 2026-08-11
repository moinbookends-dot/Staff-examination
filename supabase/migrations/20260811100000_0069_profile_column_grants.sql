-- ═════════════════════════════════════════════════════════════════════════════
-- 0069 — A user may edit their own name. Not their own approval.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THIS CLOSES A LIVE PRIVILEGE ESCALATION.                                  ║
-- ║                                                                           ║
-- ║ 0005's `profiles_self_update` scopes the ROW and nothing else:            ║
-- ║                                                                           ║
-- ║     using      (id = auth.uid() and deleted_at is null)                   ║
-- ║     with check (id = auth.uid() and deleted_at is null)                   ║
-- ║                                                                           ║
-- ║ Its own comment says: "Column restrictions (a user must not set their own ║
-- ║ approval_status or outlet) cannot be expressed in RLS … The server action ║
-- ║ is the enforcement point: it accepts a whitelist of editable fields only." ║
-- ║                                                                           ║
-- ║ THAT SERVER ACTION WAS NEVER WRITTEN. The only writes to profiles in      ║
-- ║ src/ are the admin approve/reject paths in server/actions/users.ts, which ║
-- ║ use the service-role client. Nothing stood between a signed-in user and   ║
-- ║ their own approval_status.                                                ║
-- ║                                                                           ║
-- ║ Verified three ways against the live database before writing this:        ║
-- ║   1. `authenticated` holds UPDATE on approval_status, company_id,         ║
-- ║      brand_id, outlet_id, department_id and approved_by                   ║
-- ║   2. the only BEFORE trigger on profiles is set_updated_at                ║
-- ║   3. the policy carries no column predicate                               ║
-- ║                                                                           ║
-- ║ The exploit is one line from the browser console of any signed-in user,   ║
-- ║ including a brand-new registrant sitting on /pending:                     ║
-- ║                                                                           ║
-- ║   supabase.from('profiles')                                               ║
-- ║     .update({ approval_status: 'approved' }).eq('id', <own id>)           ║
-- ║                                                                           ║
-- ║ On the next token refresh the claims hook mints approved: true and        ║
-- ║ has_perm() starts answering true. Setting company_id or outlet_id instead ║
-- ║ moves the attacker across the tenancy boundary every other policy in this ║
-- ║ schema is built on.                                                       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ COLUMN GRANTS, BECAUSE RLS GENUINELY CANNOT DO THIS.                     │
-- │                                                                           │
-- │ 0005's comment is right that a policy cannot say "these columns only" —   │
-- │ a WITH CHECK sees the finished row and cannot tell which columns the      │
-- │ statement actually wrote. Postgres has a separate mechanism for exactly   │
-- │ this, and it is column-level GRANT.                                       │
-- │                                                                           │
-- │ The policy is left EXACTLY as it is. It scopes the row, the grant scopes  │
-- │ the columns, and the two compose.                                         │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Only the five columns a person owns about themselves
-- ═════════════════════════════════════════════════════════════════════════════

revoke update on public.profiles from authenticated;

/*
 * What is deliberately NOT here, and why:
 *
 *   approval_status, approved_by, approved_at, rejection_reason
 *                       — the admin decision. The whole point.
 *   company_id, brand_id, outlet_id, department_id
 *                       — the tenancy boundary my_company()/my_outlet() read.
 *   email               — synced from auth.users; letting it drift would break
 *                         the link between a profile and its login.
 *   employee_code, experience_level, joined_at
 *                       — HR facts about a person, set by HR, not claimed.
 *   deleted_at          — soft delete is an administrative act.
 *   id, created_at, updated_at
 *                       — identity and bookkeeping.
 */
grant update (full_name, phone, preferred_locale, avatar_path, email_opt_in)
  on public.profiles to authenticated;

-- anon was never meant to write a profile at all.
revoke update on public.profiles from anon;

/*
 * service_role keeps everything. approveRegistration() and rejectRegistration()
 * in src/server/actions/users.ts run through the admin client and must still be
 * able to set approval_status — they are the legitimate path, gated by
 * requirePermission('users.approve').
 */
grant update on public.profiles to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Defence in depth
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE GRANT IS THE FIX. THIS TRIGGER IS THE SEATBELT.                      │
 * │                                                                           │
 * │ A column grant is invisible in the policy list, and the next person to    │
 * │ run `grant all on public.profiles to authenticated` — a one-liner that    │
 * │ looks like routine housekeeping, and which bootstrap.sql does exactly     │
 * │ for the test container — silently reopens the hole.                      │
 * │                                                                           │
 * │ This makes the rule refuse loudly instead, and names the column, so the   │
 * │ failure explains itself rather than looking like an RLS mystery.          │
 * │                                                                           │
 * │ It fires ONLY when a user edits their own row. Admin paths run as         │
 * │ service_role, where auth.uid() is null, so they pass straight through.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create or replace function public.assert_profile_self_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Not the owner acting on themselves: an admin path, or a definer function.
  if auth.uid() is null or auth.uid() <> new.id then
    return new;
  end if;

  if new.approval_status is distinct from old.approval_status
     or new.approved_by     is distinct from old.approved_by
     or new.approved_at     is distinct from old.approved_at
     or new.rejection_reason is distinct from old.rejection_reason then
    raise exception 'You cannot change your own approval.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.company_id    is distinct from old.company_id
     or new.brand_id      is distinct from old.brand_id
     or new.outlet_id     is distinct from old.outlet_id
     or new.department_id is distinct from old.department_id then
    raise exception 'You cannot change which company or outlet you belong to.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.email is distinct from old.email then
    raise exception 'Your email address is managed by your sign-in.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.employee_code    is distinct from old.employee_code
     or new.experience_level is distinct from old.experience_level
     or new.joined_at        is distinct from old.joined_at
     or new.deleted_at       is distinct from old.deleted_at then
    raise exception 'That field is set by your manager.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.assert_profile_self_edit() is
  'Refuses a self-edit that touches approval, tenancy, email or HR fields. Column GRANTs are the primary control (0069); this exists so re-granting the table cannot silently reopen the escalation.';

drop trigger if exists profiles_self_edit_guard on public.profiles;

create trigger profiles_self_edit_guard
  before update on public.profiles
  for each row
  execute function public.assert_profile_self_edit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. role_permissions was company-blind
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * 0005's role_permissions_write is `has_perm('roles.manage')` and nothing else —
 * no company predicate in USING or WITH CHECK. Every sibling policy in that
 * migration scopes to my_company(); this one does not.
 *
 * `roles` is shared: a row with company_id IS NULL is a system role every
 * company uses, so the rule is "your company's roles, or a system role" — and
 * a system role must not be editable by a tenant at all, since changing what
 * `employee` means would change it everywhere.
 */
drop policy if exists role_permissions_write on public.role_permissions;

create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using (
    (select public.has_perm('roles.manage'))
    and exists (
      select 1 from public.roles r
       where r.id = role_permissions.role_id
         and r.company_id = (select public.my_company())
    )
  )
  with check (
    (select public.has_perm('roles.manage'))
    and exists (
      select 1 from public.roles r
       where r.id = role_permissions.role_id
         and r.company_id = (select public.my_company())
    )
  );
