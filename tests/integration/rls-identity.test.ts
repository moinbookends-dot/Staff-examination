import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connect, hasDatabase, asUser, asAnon, asOwner,
  pendingUser, employee, chef, hr, superAdmin, fixtures,
} from './helpers/db'

/**
 * RLS policy tests — organisation and identity (migration 0005).
 *
 * Every policy gets an allow case and a deny case. The deny cases are the
 * point: an over-permissive policy throws no error and logs nothing, it just
 * quietly returns rows the caller should never have seen.
 */

const describeDb = hasDatabase ? describe : describe.skip

const ALICE = '11111111-1111-1111-1111-111111111111'   // pending employee, Aiko
const BOB = '22222222-2222-2222-2222-222222222222'     // approved employee, Aiko
const CARLA = '33333333-3333-3333-3333-333333333333'   // approved employee, Capiche
const DEV = '44444444-4444-4444-4444-444444444444'     // chef, Aiko
const HANA = '55555555-5555-5555-5555-555555555555'    // HR
const OMAR = '66666666-6666-6666-6666-666666666666'    // super admin

describeDb('RLS — organisation & identity', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()

    // Fixture profiles. Written with RLS bypassed — this is arrangement, not
    // the subject under test. auth.users rows come first for the FK.
    await db.query('begin')
    await db.query(`
      insert into auth.users (id, email) values
        ($1,'alice@test.local'), ($2,'bob@test.local'), ($3,'carla@test.local'),
        ($4,'dev@test.local'),   ($5,'hana@test.local'), ($6,'omar@test.local')
      on conflict (id) do nothing
    `, [ALICE, BOB, CARLA, DEV, HANA, OMAR])

    // The handle_new_user trigger already made profiles; correct them to the
    // states each case needs.
    await db.query(`
      update public.profiles set approval_status='approved', outlet_id=$2, company_id=$3
        where id = any($1::uuid[])
    `, [[BOB, DEV, HANA, OMAR], fixtures.outletAiko, fixtures.company])
    await db.query(`
      update public.profiles set approval_status='approved', outlet_id=$2, company_id=$3
        where id = $1
    `, [CARLA, fixtures.outletCapiche, fixtures.company])
    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from auth.users where id = any($1::uuid[])', [
      [ALICE, BOB, CARLA, DEV, HANA, OMAR],
    ])
    await db.query('commit')
    await db.end()
  })

  // ── The approval gate ──────────────────────────────────────────────────────

  describe('pending users', () => {
    it('can read their own profile — the deliberate exception', async () => {
      const rows = await asUser(db, pendingUser(ALICE), async (c) =>
        (await c.query('select id, approval_status from public.profiles where id = $1', [ALICE])).rows,
      )
      // Without this, the /pending screen cannot render the user's own name.
      expect(rows).toHaveLength(1)
      expect(rows[0].approval_status).toBe('pending')
    })

    it('cannot read anyone else’s profile', async () => {
      const rows = await asUser(db, pendingUser(ALICE), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [BOB])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('cannot read the organisation tree', async () => {
      // is_approved() is ANDed into every org read policy, so an unapproved
      // token fails them all without any explicit pending check.
      const outlets = await asUser(db, pendingUser(ALICE), async (c) =>
        (await c.query('select id from public.outlets')).rows,
      )
      const departments = await asUser(db, pendingUser(ALICE), async (c) =>
        (await c.query('select id from public.departments')).rows,
      )
      expect(outlets).toHaveLength(0)
      expect(departments).toHaveLength(0)
    })
  })

  describe('anonymous visitors', () => {
    it('see no outlets or departments', async () => {
      // The registration form needs these dropdowns, but they are served by a
      // server action through the admin client. Opening an anon read policy to
      // serve two dropdowns would be a permanent hole for a temporary need.
      const rows = await asAnon(db, async (c) =>
        (await c.query('select id from public.outlets')).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('see no profiles', async () => {
      const rows = await asAnon(db, async (c) =>
        (await c.query('select id from public.profiles')).rows,
      )
      expect(rows).toHaveLength(0)
    })
  })

  // ── Employees ──────────────────────────────────────────────────────────────

  describe('approved employees', () => {
    it('can read the organisation tree', async () => {
      const rows = await asUser(db, employee(BOB), async (c) =>
        (await c.query('select id from public.outlets')).rows,
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it('can read their own profile', async () => {
      const rows = await asUser(db, employee(BOB), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [BOB])).rows,
      )
      expect(rows).toHaveLength(1)
    })

    it('cannot read a colleague’s profile', async () => {
      // Employees hold neither users.read_team nor users.read_all.
      const rows = await asUser(db, employee(BOB), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [DEV])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('cannot modify the organisation tree', async () => {
      const result = await asUser(db, employee(BOB), async (c) =>
        c.query('update public.outlets set name = $1 where id = $2', ['Hacked', fixtures.outletAiko]),
      )
      expect(result.rowCount).toBe(0)
    })

    it('cannot grant themselves a role', async () => {
      // The escalation path that matters most.
      await expect(
        asUser(db, employee(BOB), async (c) =>
          c.query(
            `insert into public.user_roles (user_id, role_id)
             select $1, id from public.roles where key = 'super_admin'`,
            [BOB],
          ),
        ),
      ).rejects.toThrow()
    })
  })

  // ── Chefs ──────────────────────────────────────────────────────────────────

  describe('chefs', () => {
    /**
     * REGRESSION (migration 0008). The approval queue was unreachable: a
     * pending user has outlet_id = NULL because the outlet is assigned during
     * approval, so the outlet-scoped team policy could never match them and
     * the queue was permanently empty.
     *
     * ALICE is deliberately left with outlet_id NULL here — the original
     * fixtures assigned an outlet to everyone, which is what hid the bug. Do
     * not "tidy" that up.
     */
    it('can see pending registrations that have no outlet yet', async () => {
      await asOwner(db, async (c) => {
        await c.query(
          `update public.profiles
              set approval_status='pending', outlet_id=null, company_id=$2
            where id=$1`,
          [ALICE, fixtures.company],
        )
      })

      const rows = await asUser(db, chef(DEV), async (c) =>
        (await c.query(
          `select id from public.profiles
            where approval_status = 'pending' and id = $1`,
          [ALICE],
        )).rows,
      )
      expect(rows, 'approvers must see outlet-less pending registrations').toHaveLength(1)
    })

    it('cannot see an approved user from another outlet via the pending policy', async () => {
      // The pending policy must not become a general company-wide read.
      const rows = await asUser(db, chef(DEV, fixtures.outletAiko), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [CARLA])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('can read staff in their own outlet', async () => {
      const rows = await asUser(db, chef(DEV), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [BOB])).rows,
      )
      expect(rows).toHaveLength(1)
    })

    it('cannot read staff at another outlet', async () => {
      // An Aiko chef has no business reading Capiche staff records. This is the
      // policy most likely to be written as "all approved staff" by accident.
      const rows = await asUser(db, chef(DEV, fixtures.outletAiko), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [CARLA])).rows,
      )
      expect(rows).toHaveLength(0)
    })
  })

  // ── HR: read-only, company-wide ────────────────────────────────────────────

  describe('HR', () => {
    it('can read staff across every outlet', async () => {
      const rows = await asUser(db, hr(HANA), async (c) =>
        (await c.query('select id from public.profiles where id = any($1::uuid[])', [[BOB, CARLA]])).rows,
      )
      expect(rows).toHaveLength(2)
    })

    it('cannot edit a profile', async () => {
      // PRD §4.2: HR is explicitly read-only. They hold users.read_all but not
      // users.update, so the update policy finds no row to act on.
      const result = await asUser(db, hr(HANA), async (c) =>
        c.query('update public.profiles set full_name = $1 where id = $2', ['Edited', BOB]),
      )
      expect(result.rowCount).toBe(0)
    })

    it('cannot edit the organisation tree', async () => {
      const result = await asUser(db, hr(HANA), async (c) =>
        c.query('update public.outlets set name = $1 where id = $2', ['Edited', fixtures.outletAiko]),
      )
      expect(result.rowCount).toBe(0)
    })
  })

  // ── Super admin ────────────────────────────────────────────────────────────

  describe('super admin', () => {
    it('passes permission checks while holding no explicit permissions', async () => {
      // has_perm() short-circuits on the role. This is why seed.sql grants
      // super_admin nothing individually.
      const rows = await asUser(db, superAdmin(OMAR), async (c) =>
        (await c.query('select id from public.profiles where id = $1', [CARLA])).rows,
      )
      expect(rows).toHaveLength(1)
    })

    it('can edit the organisation tree', async () => {
      const result = await asUser(db, superAdmin(OMAR), async (c) =>
        c.query('update public.outlets set name = $1 where id = $2', ['Renamed', fixtures.outletAiko]),
      )
      expect(result.rowCount).toBe(1)
    })
  })

  // ── Audit log ──────────────────────────────────────────────────────────────

  describe('audit log', () => {
    it('is invisible to non-admins', async () => {
      const rows = await asUser(db, chef(DEV), async (c) =>
        (await c.query('select id from public.audit_logs')).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('cannot be written from the application', async () => {
      // No insert policy exists. The only writer is audit_row(), which is
      // SECURITY DEFINER — so the trail is append-only and nobody can forge
      // or erase their own entries.
      await expect(
        asUser(db, superAdmin(OMAR), async (c) =>
          c.query(
            `insert into public.audit_logs (action, table_name) values ('forged','profiles')`,
          ),
        ),
      ).rejects.toThrow()
    })

    it('records profile changes automatically', async () => {
      const count = await asOwner(db, async (c) => {
        await c.query('update public.profiles set full_name = $1 where id = $2', ['Audited Name', BOB])
        const { rows } = await c.query(
          `select changes from public.audit_logs
            where table_name = 'profiles' and record_id = $1
            order by occurred_at desc limit 1`,
          [BOB],
        )
        return rows
      })
      expect(count).toHaveLength(1)
      // Diff only, not a full row snapshot — that is what keeps this table
      // inside the 500 MB budget.
      expect(count[0].changes).toHaveProperty('full_name')
      expect(count[0].changes).not.toHaveProperty('email')
    })
  })

  // ── email_outbox: server-side only ─────────────────────────────────────────

  describe('email outbox', () => {
    it('is invisible to everyone, including super admins', async () => {
      // RLS enabled with no policy at all = deny. It holds other people's
      // email addresses and is written only by server-side code.
      const rows = await asUser(db, superAdmin(OMAR), async (c) =>
        (await c.query('select id from public.email_outbox')).rows,
      )
      expect(rows).toHaveLength(0)
    })
  })
})
