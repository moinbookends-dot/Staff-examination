import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase } from './helpers/db'

/**
 * WHO CAN CALL WHAT.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE BUG THIS EXISTS FOR.                                                  │
 * │                                                                           │
 * │ 0014 and 0018 protected four SECURITY DEFINER helpers with                │
 * │ `revoke all on function … from public`. That removes only the PUBLIC      │
 * │ pseudo-role's ACL entry; it does nothing to an explicit grant held by a   │
 * │ named role, and this database auto-grants EXECUTE on new functions to     │
 * │ `anon` and `authenticated`. So all four stayed callable over PostgREST.   │
 * │                                                                           │
 * │ With nothing but the publishable key and NO SESSION, anon could read the  │
 * │ whole frozen paper (draw_paper, seeded reproducibly with the exam id),    │
 * │ every question's stem and options (question_snapshot), and every          │
 * │ assignee's email address (exam_audience).                                 │
 * │                                                                           │
 * │ CI hid it: the workflow used to run `grant execute on all functions in    │
 * │ schema public to anon, authenticated` AFTER the migrations, so CI and     │
 * │ production disagreed about the one thing that mattered.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The rule these tests enforce: a SECURITY DEFINER function is either granted
 * to `authenticated` AND carries its own permission check, or it is granted to
 * nobody and reached only from another definer function. Never "revoked from
 * public" and left at that.
 */

const describeDb = hasDatabase ? describe : describe.skip

/** Internal helpers. No permission check of their own, so the ACL is the guard. */
const INTERNAL = [
  'question_snapshot',
  'draw_paper',
  'exam_audience',
  'question_pool',
  // 0022: returns answer keys for grading. The one thing that must never be
  // reachable from a browser.
  'answer_key_at_revision',
] as const

/** Public entry points. Granted, and each carries has_perm/my_company/auth.uid(). */
const GUARDED_ENTRY_POINTS = [
  'exam_health',
  'exam_paper',
  'exam_rule_counts',
  'preview_rule_count',
  'publish_exam',
  'duplicate_exam',
  'get_question_revision',
  'me_status',
] as const

describeDb('function privileges', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
  })

  afterAll(async () => {
    await db.end()
  })

  const privileges = async (name: string) => {
    const { rows } = await db.query(
      `select p.proname,
              p.prosecdef as definer,
              has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              pg_get_functiondef(p.oid) ~* 'has_perm|auth\\.uid\\(\\)|my_company|is_approved' as guarded
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [name],
    )
    return rows
  }

  describe('internal helpers are reachable by nobody', () => {
    it.each(INTERNAL)('%s is not executable by anon or authenticated', async (name) => {
      const rows = await privileges(name)
      expect(rows.length, `${name} does not exist`).toBeGreaterThan(0)

      for (const row of rows) {
        expect(row.anon, `anon CAN EXECUTE ${name} — see migration 0020`).toBe(false)
        expect(
          row.authenticated,
          `authenticated CAN EXECUTE ${name} — see migration 0020`,
        ).toBe(false)
      }
    })
  })

  describe('granted entry points defend themselves', () => {
    it.each(GUARDED_ENTRY_POINTS)('%s is callable and carries its own check', async (name) => {
      const rows = await privileges(name)
      expect(rows.length, `${name} does not exist`).toBeGreaterThan(0)

      for (const row of rows) {
        expect(row.authenticated, `${name} is not callable by the app`).toBe(true)
        // Being granted is only safe because the function checks for itself.
        // A granted definer function with no guard is the exact shape of the
        // vulnerability this file exists to prevent.
        expect(
          row.guarded,
          `${name} is granted to authenticated but has no has_perm/my_company/auth.uid() check`,
        ).toBe(true)
      }
    })
  })

  it('no SECURITY DEFINER function is both anon-reachable and unguarded', async () => {
    // The general form of the rule, so a function added later is caught even if
    // nobody remembers to list it above.
    const { rows } = await db.query(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and p.prosecdef
         and p.prorettype::regtype::text <> 'trigger'
         and has_function_privilege('anon', p.oid, 'EXECUTE')
         and pg_get_functiondef(p.oid) !~* 'has_perm|auth\\.uid\\(\\)|my_company|is_approved'
       order by p.proname`)

    expect(
      rows.map((r) => r.proname),
      'these run with owner rights, are reachable without a session, and check nothing',
    ).toEqual([])
  })

  it('the auth hook is callable by nobody', async () => {
    // It computes a user's roles and permissions from their id. Reachable, it
    // would let anyone read anyone else's authorisation.
    const rows = await privileges('custom_access_token_hook')
    expect(rows[0]?.anon).toBe(false)
    expect(rows[0]?.authenticated).toBe(false)
  })
})
