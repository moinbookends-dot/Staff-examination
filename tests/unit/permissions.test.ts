import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_KEYS,
  splitPermission,
  type Permission,
  type RoleKey,
} from '@/lib/auth/permissions'

/**
 * Guards the seam between the TypeScript permission union and the database
 * seed. They are written in two languages in two files and nothing but this
 * test stops them diverging.
 *
 * Drift is silent and nasty in both directions: a key seeded but not in the
 * union can never be checked, so a role appears to grant something it cannot;
 * a key in the union but not seeded makes has_perm() return false forever, so
 * a feature is invisible with no error anywhere.
 */

const seedSql = readFileSync(
  resolve(__dirname, '../../supabase/seed.sql'),
  'utf-8',
)

/** Keys from the `insert into public.permissions` block. */
function permissionKeysInSeed(): string[] {
  const block = seedSql.split('insert into public.permissions')[1]
  if (!block) throw new Error('No permissions insert found in seed.sql')

  const upToNextStatement = block.split('on conflict')[0]
  // Rows look like:  ('questions.read', 'questions', 'read', '…'),
  const matches = upToNextStatement.matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'\s*,/g)
  return [...matches].map((m) => m[1])
}

/**
 * Keys granted to a role in its `role_permissions` insert block.
 *
 * Anchored on `select '<roleId>', p.id` specifically. A naive split on the
 * role id matches its first occurrence — the `roles` insert — and silently
 * parses the wrong block.
 */
function grantedKeysFor(roleId: string): string[] {
  const grantBlock = new RegExp(
    `select\\s+'${roleId}',\\s*p\\.id[\\s\\S]*?where\\s+p\\.key\\s+in\\s*\\(([\\s\\S]*?)\\)`,
    'i',
  )
  const match = seedSql.match(grantBlock)
  if (!match) throw new Error(`No role_permissions grant block found for role ${roleId}`)

  return [...match[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1])
}

/**
 * Typed as Record<…, string> rather than left to inference.
 *
 * As a bare `as const` object this map was structurally typed, so adding a role
 * to ROLE_KEYS and forgetting it here was a TYPE error at the indexing site
 * below — which is a fine way to find out, but it reports as "property 'editor'
 * does not exist" several lines from the actual omission. The explicit Record
 * puts the error on this object, where the fix is.
 */
const ROLE_IDS: Record<Exclude<RoleKey, 'super_admin'>, string> = {
  // …e002 was 'chef' until migration 0071 renamed it in place. The id is
  // deliberately unchanged: renaming rather than replacing is what let every
  // user_roles and role_permissions row follow the role automatically.
  admin: '00000000-0000-0000-0000-00000000e002',
  hr: '00000000-0000-0000-0000-00000000e003',
  employee: '00000000-0000-0000-0000-00000000e004',
}

describe('permission registry ↔ seed.sql', () => {
  it('seeds exactly the keys declared in PERMISSIONS', () => {
    const seeded = permissionKeysInSeed().sort()
    const declared = [...PERMISSIONS].sort()

    // Reported as two directed diffs rather than one equality failure, because
    // "missing from seed" and "extra in seed" have completely different fixes.
    const missingFromSeed = declared.filter((k) => !seeded.includes(k))
    const extraInSeed = seeded.filter((k) => !declared.includes(k as Permission))

    expect(missingFromSeed, 'declared in permissions.ts but not seeded').toEqual([])
    expect(extraInSeed, 'seeded but not declared in permissions.ts').toEqual([])
  })

  it('seeds no duplicate keys', () => {
    const seeded = permissionKeysInSeed()
    expect(seeded.length).toBe(new Set(seeded).size)
  })

  it.each(ROLE_KEYS.filter((r) => r !== 'super_admin'))(
    'grants %s the same keys in seed.sql as in DEFAULT_ROLE_PERMISSIONS',
    (role) => {
      const inCode = [...DEFAULT_ROLE_PERMISSIONS[role]].sort()
      const inSeed = [...new Set(grantedKeysFor(ROLE_IDS[role]))].sort()
      expect(inSeed).toEqual(inCode)
    },
  )

  it('does not grant super_admin individual permissions', () => {
    // has_perm() short-circuits for super_admin (migration 0004). Enumerating
    // keys for it would mean every new permission needs remembering here, and
    // forgetting once locks the platform owner out.
    expect(seedSql).not.toContain('00000000-0000-0000-0000-00000000e001\', p.id')
  })
})

describe('permission key hygiene', () => {
  it('uses module.action form throughout', () => {
    for (const key of PERMISSIONS) {
      expect(key, `${key} should be module.action`).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('declares no duplicates', () => {
    expect(PERMISSIONS.length).toBe(new Set(PERMISSIONS).size)
  })

  it('splits into module and action', () => {
    expect(splitPermission('questions.create')).toEqual({
      module: 'questions',
      action: 'create',
    })
    expect(splitPermission('attempts.read_own')).toEqual({
      module: 'attempts',
      action: 'read_own',
    })
  })

  it('grants only declared permissions to each role', () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const p of perms) {
        expect(PERMISSIONS, `${role} grants undeclared ${p}`).toContain(p)
      }
    }
  })

  it('keeps HR read-only', () => {
    // PRD §4.2 is explicit: HR "cannot create or evaluate exams". Encoded as a
    // test because it is the kind of boundary that erodes under feature
    // pressure — someone grants HR one write permission "just for now".
    const writeish = /\.(create|update|delete|publish|assign|approve|evaluate|verify|manage|import|retire|void|return)$/
    const violations = DEFAULT_ROLE_PERMISSIONS.hr.filter((p) => writeish.test(p))
    expect(violations, 'HR must remain read-only per PRD §4.2').toEqual([])
  })

  it('does not let employees read other people’s data', () => {
    const leaks = DEFAULT_ROLE_PERMISSIONS.employee.filter(
      (p) => p.endsWith('.read_all') || p.endsWith('.read_team'),
    )
    expect(leaks, 'employees may read only their own records').toEqual([])
  })
})

describe('the Editor role is retired (migration 0071)', () => {
  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ "REMOVED" HAS TO MEAN REMOVED FROM EVERY SOURCE OF TRUTH, NOT JUST ONE.  ║
   * ║                                                                           ║
   * ║ A role lives in four places here: ROLE_KEYS, DEFAULT_ROLE_PERMISSIONS,    ║
   * ║ the seed, and the database. Deleting it from one and not the others is    ║
   * ║ the failure mode worth a test — a stale seed would recreate the role on   ║
   * ║ the next `npm run db:seed`, quietly undoing the migration and handing     ║
   * ║ somebody bank access through a role nothing in the app knows about.       ║
   * ║                                                                           ║
   * ║ The live database is asserted separately, by scripts/check-authz.mjs,     ║
   * ║ which now refuses to run at all if a persona names a role that does not   ║
   * ║ exist.                                                                    ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  it('is absent from ROLE_KEYS', () => {
    expect(ROLE_KEYS as readonly string[]).not.toContain('editor')
    expect(ROLE_KEYS as readonly string[]).not.toContain('chef')
  })

  it('is absent from DEFAULT_ROLE_PERMISSIONS', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS)).not.toContain('editor')
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS)).not.toContain('chef')
  })

  it('is not re-created by the seed', () => {
    /*
     * COMMENTS ARE STRIPPED FIRST, and that is not a detail.
     *
     * The first version of this test scanned the raw INSERT and failed on the
     * seed's own line explaining the rename — `-- Renamed from 'chef' by
     * migration 0071`. A scanner that cannot tell code from prose reports the
     * documentation as the defect, which is the third time this repository has
     * hit that exact trap (see check-bootstrap-coverage.mjs and 0068's guard).
     */
    const start = seedSql.indexOf('insert into public.roles')
    const sql = seedSql
      .slice(start, seedSql.indexOf('on conflict do nothing', start))
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')

    expect(sql).not.toContain("'editor'")
    expect(sql).not.toContain("'chef'")
    expect(sql).toContain("'admin'")
  })

  it('leaves the Administrator holding both halves of the old split', () => {
    // The whole point of 0071: one role that can fill the bank AND run an exam.
    const admin = DEFAULT_ROLE_PERMISSIONS.admin
    for (const authoring of ['bank.read', 'bank.write', 'bank.import', 'bank.export']) {
      expect(admin, `admin lost the editor half: ${authoring}`).toContain(authoring)
    }
    for (const delivery of ['exams.publish', 'evaluation.evaluate', 'users.approve']) {
      expect(admin, `admin lost the chef half: ${delivery}`).toContain(delivery)
    }
    // And the key that made the settings screen unreachable by anyone who used it.
    expect(admin).toContain('settings.manage')
  })
})
