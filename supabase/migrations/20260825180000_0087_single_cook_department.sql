-- ═══════════════════════════════════════════════════════════════════════════
-- 0087 — One department: Cook.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ ASKED FOR DIRECTLY: the approvals screen should offer Cook and nothing    ║
-- ║ else. This kitchen runs one job title for now, and a chef approving a     ║
-- ║ new starter should not have to pick from five.                            ║
-- ║                                                                          ║
-- ║ KITCHEN IS RENAMED RATHER THAN RETIRED-AND-REPLACED. Renaming keeps the  ║
-- ║ id, so the person already in Kitchen becomes a Cook without their row     ║
-- ║ being touched. Creating a new row and deleting Kitchen would have left    ║
-- ║ them pointing at a department that no longer exists, for no gain.         ║
-- ║                                                                          ║
-- ║ NOBODY'S PROFILE IS EDITED BY THIS MIGRATION. Service, Bar and           ║
-- ║ Housekeeping hold nobody, so retiring them costs nothing. Management     ║
-- ║ holds four accounts and is retired WITHOUT reassigning them: moving a    ║
-- ║ person between departments changes what exam targeting can reach them,    ║
-- ║ and that is a real change to make silently inside a rename. Their        ║
-- ║ department_id is left exactly as it was.                                  ║
-- ║                                                                          ║
-- ║ THE COST, STATED PLAINLY: departments_read filters deleted_at, so those  ║
-- ║ four see a blank department on their settings page until they are moved  ║
-- ║ to Cook or Management is restored. Cosmetic, reversible, and affects no   ║
-- ║ permission — roles carry authority here, not departments.                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Reversing this is `update public.departments set deleted_at = null where …`.
-- ═══════════════════════════════════════════════════════════════════════════

update public.departments
   set name = 'Cook'
 where lower(name) = 'kitchen'
   and deleted_at is null;

update public.departments
   set deleted_at = now()
 where deleted_at is null
   and lower(name) in ('service', 'bar', 'housekeeping', 'management');

/*
 * Belt and braces for an environment seeded differently: if no Kitchen existed
 * to rename, there would now be no department at all and the approvals screen
 * could not be used. Create Cook only if it is genuinely absent.
 */
insert into public.departments (company_id, name, sort_order)
select c.id, 'Cook', 1
  from public.companies c
 where not exists (
   select 1 from public.departments d
    where d.company_id = c.id and d.deleted_at is null and lower(d.name) = 'cook'
 );
