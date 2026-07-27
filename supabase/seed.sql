-- ═════════════════════════════════════════════════════════════════════════════
-- Seed — organisation tree, system roles, permission matrix
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running is safe.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE PERMISSION LIST BELOW MIRRORS src/lib/auth/permissions.ts.            │
-- │ That TypeScript file is the source of truth. Adding a key here without    │
-- │ adding it there produces a permission nothing can ever check; adding it   │
-- │ there without adding it here produces a gate that always denies.          │
-- │ tests/unit/permissions.test.ts asserts the two match.                     │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- OUTLET DATA IS PLACEHOLDER. PRD Open Question §11.4 asks for the confirmed
-- outlet count and locations. One outlet per brand is seeded so the app is
-- usable immediately; replace with real data before staff onboarding.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Company ──────────────────────────────────────────────────────────────────
insert into public.companies (id, name, slug)
values ('00000000-0000-0000-0000-00000000c001', 'Bookends Hospitality', 'bookends')
on conflict do nothing;

-- ── Brands ───────────────────────────────────────────────────────────────────
insert into public.brands (id, company_id, name, slug, cuisine) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c001', 'Aiko',    'aiko',    'Japanese / Asian'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000c001', 'Capiche', 'capiche', 'Italian'),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000c001', 'Prep',    'prep',    null)
on conflict do nothing;

-- ── Outlets — PLACEHOLDER, confirm before onboarding ─────────────────────────
insert into public.outlets (id, company_id, brand_id, name, code, state) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000b001', 'Aiko — Outlet 1',    'AIKO-01', 'Gujarat'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000b002', 'Capiche — Outlet 1', 'CAPI-01', 'Gujarat'),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000b003', 'Prep — Outlet 1',    'PREP-01', 'Gujarat')
on conflict do nothing;

-- ── Departments — company-wide taxonomy (see migration 0002) ─────────────────
insert into public.departments (company_id, name, slug, sort_order) values
  ('00000000-0000-0000-0000-00000000c001', 'Kitchen',      'kitchen',      1),
  ('00000000-0000-0000-0000-00000000c001', 'Service',      'service',      2),
  ('00000000-0000-0000-0000-00000000c001', 'Bar',          'bar',          3),
  ('00000000-0000-0000-0000-00000000c001', 'Housekeeping', 'housekeeping', 4),
  ('00000000-0000-0000-0000-00000000c001', 'Management',   'management',   5)
on conflict do nothing;

-- ── System roles ─────────────────────────────────────────────────────────────
-- company_id null = built-in, shared across companies, immutable from the app.
insert into public.roles (id, company_id, key, name, description, is_system, sort_order) values
  ('00000000-0000-0000-0000-00000000e001', null, 'super_admin', 'Super Admin',
   'Full platform access. Manages organisation, roles and settings.', true, 1),
  ('00000000-0000-0000-0000-00000000e002', null, 'chef', 'Chef / Kitchen Manager',
   'Creates questions and exams, evaluates and verifies answers, approves registrations.', true, 2),
  ('00000000-0000-0000-0000-00000000e003', null, 'hr', 'HR Manager',
   'Read-only access to reports, analytics and employee profiles.', true, 3),
  ('00000000-0000-0000-0000-00000000e004', null, 'employee', 'Employee',
   'Takes assigned exams, studies materials, tracks own performance.', true, 4)
on conflict do nothing;

-- ── Permissions ──────────────────────────────────────────────────────────────
insert into public.permissions (key, module, action, description) values
  -- questions
  ('questions.read',       'questions',  'read',        'View the question bank'),
  ('questions.create',     'questions',  'create',      'Create questions'),
  ('questions.update',     'questions',  'update',      'Edit questions'),
  ('questions.retire',     'questions',  'retire',      'Retire questions from circulation'),
  ('questions.import',     'questions',  'import',      'Bulk import questions from CSV/Excel'),
  ('questions.translate',  'questions',  'translate',   'Create and approve question translations'),
  -- exams
  ('exams.read',           'exams',      'read',        'View exams'),
  ('exams.create',         'exams',      'create',      'Create exams'),
  ('exams.update',         'exams',      'update',      'Edit draft exams'),
  ('exams.publish',        'exams',      'publish',     'Publish an exam and freeze its question snapshot'),
  ('exams.assign',         'exams',      'assign',      'Assign exams to staff, departments or outlets'),
  ('exams.archive',        'exams',      'archive',     'Archive completed exams'),
  -- attempts
  ('attempts.take',        'attempts',   'take',        'Sit an assigned exam'),
  ('attempts.read_own',    'attempts',   'read_own',    'View own attempts and results'),
  ('attempts.read_team',   'attempts',   'read_team',   'View attempts within own outlet'),
  ('attempts.read_all',    'attempts',   'read_all',    'View attempts across the company'),
  ('attempts.void',        'attempts',   'void',        'Void an attempt'),
  -- evaluation
  ('evaluation.evaluate',  'evaluation', 'evaluate',    'Score submitted answers (Chef 1)'),
  ('evaluation.verify',    'evaluation', 'verify',      'Verify another evaluator''s scores (Chef 2)'),
  ('evaluation.return',    'evaluation', 'return',      'Return an evaluation for re-scoring'),
  ('evaluation.publish',   'evaluation', 'publish',     'Publish verified results to staff'),
  -- users
  ('users.read_team',      'users',      'read_team',   'View staff within own outlet'),
  ('users.read_all',       'users',      'read_all',    'View all staff company-wide'),
  ('users.approve',        'users',      'approve',     'Approve or reject registrations'),
  ('users.update',         'users',      'update',      'Edit staff profiles'),
  ('users.assign_roles',   'users',      'assign_roles','Grant and revoke roles'),
  -- platform
  ('roles.manage',         'roles',      'manage',      'Create and edit custom roles'),
  ('org.manage',           'org',        'manage',      'Manage brands, outlets and departments'),
  ('settings.manage',      'settings',   'manage',      'Change platform settings'),
  ('audit.read',           'audit',      'read',        'View the audit log'),
  -- reports
  ('reports.read_own',     'reports',    'read_own',    'View own performance reports'),
  ('reports.read_team',    'reports',    'read_team',   'View reports for own outlet'),
  ('reports.read_all',     'reports',    'read_all',    'View all company reports'),
  ('reports.export',       'reports',    'export',      'Export reports to PDF and Excel'),
  -- learning
  ('learning.read',        'learning',   'read',        'Access the learning centre'),
  ('learning.manage',      'learning',   'manage',      'Upload and organise learning materials')
on conflict (key) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Role → permission grants
--
-- super_admin is NOT granted individual permissions. public.has_perm()
-- short-circuits for it (migration 0004), so enumerating every key here would
-- mean remembering to update this file for each new permission — and forgetting
-- once would lock the platform owner out of their own feature.
-- ═════════════════════════════════════════════════════════════════════════════

-- Chef
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0000-00000000e002', p.id
  from public.permissions p
 where p.key in (
   'questions.read','questions.create','questions.update','questions.retire',
   'questions.import','questions.translate',
   'exams.read','exams.create','exams.update','exams.publish','exams.assign','exams.archive',
   'attempts.read_team','attempts.read_own',
   'evaluation.evaluate','evaluation.verify','evaluation.return','evaluation.publish',
   'users.read_team','users.approve',
   'reports.read_team','reports.read_own','reports.export',
   'learning.read','learning.manage'
 )
on conflict do nothing;

-- HR — strictly read-only, per PRD §4.2. No create, no evaluate, no approve.
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0000-00000000e003', p.id
  from public.permissions p
 where p.key in (
   'users.read_all',
   'attempts.read_all',
   'reports.read_all','reports.read_own','reports.export',
   'exams.read',
   'learning.read'
 )
on conflict do nothing;

-- Employee
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0000-00000000e004', p.id
  from public.permissions p
 where p.key in (
   'attempts.take','attempts.read_own',
   'reports.read_own',
   'learning.read'
 )
on conflict do nothing;
