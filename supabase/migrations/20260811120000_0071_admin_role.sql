-- ═════════════════════════════════════════════════════════════════════════════
-- 0071 — One operational role, called Administrator. The Editor role retires.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHAT THIS IS, IN ONE LINE: `chef` BECOMES `admin` AND GAINS THE QUESTION  ║
-- ║ BANK. THE EDITOR ROLE IS DELETED.                                         ║
-- ║                                                                           ║
-- ║ The product had two operational roles that each held half of what running ║
-- ║ an examination needs. A Chef could publish an exam, mark it and release   ║
-- ║ the result, but could not open the question bank the paper was drawn      ║
-- ║ from. An Editor owned the bank and could generate a paper, but could not  ║
-- ║ publish it, mark it, or see who sat it. Neither could run the system.     ║
-- ║                                                                           ║
-- ║ The owner's decision is one role that can do all of it.                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY A RENAME IN PLACE RATHER THAN A NEW ROLE.                             │
-- │                                                                           │
-- │ `roles.id` is what `user_roles` and `role_permissions` reference. Updating │
-- │ `key` and `name` on the existing row leaves every one of those rows        │
-- │ pointing where it already pointed, so the five people who hold this role   │
-- │ keep every grant they had, with no membership migration and no window in   │
-- │ which somebody is roleless. Inserting a new role and moving people across  │
-- │ would touch `user_roles` five times to reach the same place.               │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHY RENAMING A ROLE KEY IS SAFE HERE — CHECKED AGAINST THE LIVE DATABASE  ║
-- ║ RATHER THAN ASSUMED, BECAUSE A ROLE KEY IS A STRING AND STRINGS HIDE.     ║
-- ║                                                                           ║
-- ║   · functions whose body contains 'chef' or 'editor'         → NONE       ║
-- ║   · RLS policies mentioning either key                       → NONE       ║
-- ║   · exam_assignments.target_role (role keys stored as text)  → ALL NULL   ║
-- ║     (3 rows, every one target_kind='outlet')                             ║
-- ║   · audit_logs.actor_roles (text[] of keys at the time)      → EMPTY      ║
-- ║   · application code literals                                → only       ║
-- ║     ROLE_KEYS in src/lib/auth/permissions.ts                             ║
-- ║                                                                           ║
-- ║ The one place a role key is genuinely load-bearing at runtime is          ║
-- ║ 0015's exam targeting — `has_role(a.target_role)` — and that column is    ║
-- ║ null on every row today. If it were not, this migration would have to     ║
-- ║ rewrite it, and step 1b below does exactly that for safety.               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. chef → admin
-- ═════════════════════════════════════════════════════════════════════════════

update public.roles
   set key         = 'admin',
       name        = 'Administrator',
       description = 'Runs the examination system: owns the question bank, '
                     || 'generates and publishes papers, marks attempts, '
                     || 'releases results and approves registrations.',
       sort_order  = 2
 where key = 'chef'
   and company_id is null;

/*
 * Belt and braces for the one column that stores a role key as data.
 *
 * Every row is null today, so this updates nothing. It is here because a
 * migration that is correct only for the data that happened to exist on the
 * afternoon it was written is not correct — and if somebody targets an exam at
 * chefs between this file being written and being applied, the rename would
 * silently orphan that assignment: has_role('chef') would answer false for
 * everybody, forever, and the exam would simply stop being offered to anyone.
 */
update public.exam_assignments
   set target_role = 'admin'
 where target_kind = 'role'
   and target_role = 'chef';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Admin gains the bank, and the settings screen
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * The eight keys that separated the two roles.
 *
 * bank.read_uuid is included deliberately. It exists so that "only some people
 * see the question UUID" is a grant somebody makes rather than a side effect of
 * being able to read the bank — and the person who now edits papers needs the
 * id to say which question to replace. Withholding it would leave the paper
 * editor unable to name what it is editing.
 *
 * papers.reset_history is still granted to NOBODY. Resetting the epoch lets an
 * already-issued paper be generated a second time; super_admin reaches it
 * through the has_perm() short-circuit, which is conspicuous in the audit log.
 */
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r
  cross join public.permissions p
 where r.key = 'admin'
   and r.company_id is null
   and p.key in (
     'bank.read', 'bank.write', 'bank.archive', 'bank.delete',
     'bank.import', 'bank.export', 'bank.read_uuid',
     'settings.manage'
   )
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Retire the Editor role
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY DESTRUCTIVE STEP IN THIS FILE, AND THE ORDER IS MANDATORY.       │
 * │                                                                           │
 * │ user_roles.role_id is ON DELETE RESTRICT (0003). So the final delete      │
 * │ REFUSES while anybody still holds the role — which is the safety          │
 * │ property, not an obstacle: it is impossible for this migration to         │
 * │ silently strip somebody's access. Every holder must be moved first, and   │
 * │ moving them is what the insert below does.                                │
 * │                                                                           │
 * │ One account holds it at the time of writing — editor@example.com, the     │
 * │ sample fixture. The insert is written as a set operation anyway, so it is │
 * │ correct for however many holders exist when it actually runs.             │
 * │                                                                           │
 * │ WHAT SURVIVES: audit_logs.actor_roles is text[] with no foreign key to    │
 * │ roles, so every historical "this was done by an editor" row keeps saying  │
 * │ exactly that. Deleting the role rewrites no history.                      │
 * │                                                                           │
 * │ ROLLBACK: re-run supabase/seed.sql. It recreates the role at its fixed    │
 * │ id 00000000-0000-0000-0000-00000000e005 with its nine grants.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

-- 3a. Every Editor becomes an Administrator. `on conflict do nothing` covers
--     somebody who already held both.
insert into public.user_roles (user_id, role_id, granted_by)
select ur.user_id,
       (select id from public.roles where key = 'admin' and company_id is null),
       ur.granted_by
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
 where r.key = 'editor'
   and r.company_id is null
on conflict do nothing;

-- 3b. Now nobody needs the old grant.
delete from public.user_roles
 where role_id = (select id from public.roles where key = 'editor' and company_id is null);

delete from public.role_permissions
 where role_id = (select id from public.roles where key = 'editor' and company_id is null);

-- 3c. And the role itself. Fails loudly if 3b missed anybody.
delete from public.roles
 where key = 'editor'
   and company_id is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Prove it, in the migration itself
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * A migration that half-applied is worse than one that failed, because the
 * failure is silent and the schema is now in a state nothing describes. These
 * assertions cost microseconds and turn "it seemed to work" into a transaction
 * that either committed correctly or rolled back entirely.
 */
do $$
declare
  v_admin uuid;
  v_perms int;
begin
  select id into v_admin from public.roles where key = 'admin' and company_id is null;
  if v_admin is null then
    raise exception '0071: the admin role does not exist after the rename';
  end if;

  if exists (select 1 from public.roles where key = 'chef' and company_id is null) then
    raise exception '0071: the chef role still exists after the rename';
  end if;

  if exists (select 1 from public.roles where key = 'editor' and company_id is null) then
    raise exception '0071: the editor role was not retired';
  end if;

  -- The eight keys that were the whole point of the migration.
  select count(*) into v_perms
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
   where rp.role_id = v_admin
     and p.key in ('bank.read','bank.write','bank.archive','bank.delete',
                   'bank.import','bank.export','bank.read_uuid','settings.manage');
  if v_perms <> 8 then
    raise exception '0071: admin holds % of the 8 new permissions', v_perms;
  end if;

  -- And the operational half it already had, spot-checked at both ends.
  if not exists (
    select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
     where rp.role_id = v_admin and p.key = 'evaluation.evaluate')
  then
    raise exception '0071: admin lost the permissions chef used to hold';
  end if;
end;
$$;

comment on table public.roles is
  'System roles: super_admin, admin, hr, employee. The editor role was retired by 0071 — its question-bank permissions were folded into admin, and super_admin reaches them through the has_perm() short-circuit.';
