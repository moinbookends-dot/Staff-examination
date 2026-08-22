import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, fixtures, type TestClaims } from './helpers/db'

/**
 * Soft delete, as a rule about RLS rather than a feature of one table.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE RULE, PROVEN THREE TIMES BEFORE IT WAS WRITTEN DOWN.                  │
 * │                                                                           │
 * │ On a table with RLS, an UPDATE that moves a row outside EVERY select      │
 * │ policy is REJECTED — even when the UPDATE policy's WITH CHECK passes.     │
 * │                                                                           │
 * │ So a table whose select policies all carry `deleted_at is null` cannot    │
 * │ have its own soft delete performed. It has appeared three times:          │
 * │                                                                           │
 * │   questions         0041 — described as "one-way", and deleteQuestion     │
 * │                     reported success for rows it never touched (3b52dcc)  │
 * │   source_documents  0048 — caught by its own integration test             │
 * │   exams             0049 — caught by sweeping every table with a          │
 * │                     deleted_at column, not by a fourth bug report         │
 * │                                                                           │
 * │ The last test in this file is that sweep, kept as an assertion so a tenth │
 * │ table cannot join the list quietly.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const EXAM = '00000000-0000-0000-0000-00000000f101'

describeDb('soft delete under RLS', () => {
  let db: Client

  async function actAs(perms: string[]) {
    await db.query('set local role authenticated')
    const claims: TestClaims = {
      sub: CHEF,
      app: {
        approved: true,
        company_id: fixtures.company,
        outlet_id: fixtures.outletAiko,
        brand_id: null,
        department_id: null,
        roles: ['chef'],
        perms,
      },
    } as TestClaims
    await db.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify(claims)])
  }
  const actAsOwner = () => db.query('reset role')

  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('begin')
    try {
      return await fn()
    } finally {
      await db.query('rollback')
    }
  }

  async function seed() {
    await actAsOwner()
    await db.query(
      `insert into auth.users (id, email) values ($1,'archive@test.local')
       on conflict (id) do nothing`,
      [CHEF],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
      [CHEF, fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `insert into public.exams (id, company_id, created_by, title, kind, status,
                                 duration_minutes, pass_mark_percent)
       values ($1,$2,$3,'Archive probe','official','draft',30,50)`,
      [EXAM, fixtures.company, CHEF],
    )
  }

  const MANAGE = ['exams.read', 'exams.create', 'exams.update', 'exams.archive']

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  /**
   * The regression. deleteExam issues exactly this statement, and before 0049
   * it raised rather than archiving — so archiving an exam did not work at all.
   */
  it('archives an exam, which deleteExam has always tried and failed to do', async () => {
    await scenario(async () => {
      await seed()
      await actAs(MANAGE)

      const archived = await db.query(
        `update public.exams set deleted_at = now() where id = $1 and deleted_at is null`,
        [EXAM],
      )
      expect(archived.rowCount).toBe(1)
    })
  })

  it('still allows an ordinary edit, so the test above is about the archive', async () => {
    await scenario(async () => {
      await seed()
      await actAs(MANAGE)

      // This succeeded even while archiving was refused. Asserting both is what
      // separates "the caller is wrong" from "the transition is wrong".
      const renamed = await db.query(`update public.exams set title = 'Renamed' where id = $1`, [
        EXAM,
      ])
      expect(renamed.rowCount).toBe(1)
    })
  })

  it('shows an archived exam to whoever may archive, and lets them restore it', async () => {
    await scenario(async () => {
      await seed()
      await actAs(MANAGE)
      await db.query(`update public.exams set deleted_at = now() where id = $1`, [EXAM])

      const { rows } = await db.query(`select id from public.exams where id = $1`, [EXAM])
      expect(rows).toHaveLength(1)

      // The reverse transition, which fails for the opposite reason: an
      // UPDATE's USING is evaluated against the OLD row.
      const restored = await db.query(
        `update public.exams set deleted_at = null where id = $1`,
        [EXAM],
      )
      expect(restored.rowCount).toBe(1)
    })
  })

  it('hides an archived exam from somebody who cannot archive', async () => {
    await scenario(async () => {
      await seed()
      await actAs(MANAGE)
      await db.query(`update public.exams set deleted_at = now() where id = $1`, [EXAM])

      // exams_read_archived is keyed on exams.archive. Widening visibility to
      // archived rows must not widen it to everyone holding exams.read.
      await actAs(['exams.read', 'exams.update'])
      const { rows } = await db.query(`select id from public.exams where id = $1`, [EXAM])
      expect(rows).toHaveLength(0)

      // Positive control: the row is there, for somebody entitled to it.
      await actAs(MANAGE)
      expect(
        (await db.query(`select id from public.exams where id = $1`, [EXAM])).rows,
      ).toHaveLength(1)
    })
  })

  it('does not let another company see or restore an archived exam', async () => {
    await scenario(async () => {
      await seed()
      await actAs(MANAGE)
      await db.query(`update public.exams set deleted_at = now() where id = $1`, [EXAM])

      // Same permissions, different company. Both new policies carry the
      // company predicate; one keyed on deleted_at alone would expose every
      // other company's archive.
      await db.query('set local role authenticated')
      await db.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify({
          sub: CHEF,
          app: {
            approved: true,
            company_id: '00000000-0000-0000-0000-0000000000ff',
            outlet_id: fixtures.outletAiko,
            brand_id: null,
            department_id: null,
            roles: ['chef'],
            perms: MANAGE,
          },
        }),
      ])

      expect((await db.query(`select id from public.exams where id = $1`, [EXAM])).rows).toHaveLength(0)
      const restore = await db.query(`update public.exams set deleted_at = null where id = $1`, [EXAM])
      expect(restore.rowCount).toBe(0)
    })
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE CLASS, NOT THE INSTANCE.                                            │
   * │                                                                         │
   * │ Three tables have now hit this. Rather than wait for a fourth, this     │
   * │ asserts the property directly: no table may have a deleted_at column,   │
   * │ an UPDATE policy, and select policies that ALL exclude deleted rows.    │
   * │                                                                         │
   * │ A policy with no deleted_at predicate — a FOR ALL policy, or a          │
   * │ self-read like profiles_self_read — still matches the deleted row and   │
   * │ keeps the write legal, which is why the check is bool_and over the      │
   * │ select policies rather than "does a read_deleted policy exist".         │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('leaves no table where a soft delete would be silently impossible', async () => {
    await actAsOwner()
    const { rows } = await db.query(`
      with t as (
        select c.relname as table_name, c.oid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid
                             and a.attname = 'deleted_at' and a.attnum > 0
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      )
      select t.table_name
        from t join pg_policy p on p.polrelid = t.oid
       group by t.table_name
      having bool_and(
               case when p.polcmd in ('r','*')
                    then pg_get_expr(p.polqual, p.polrelid) ~* 'deleted_at IS NULL'
               end
             )
         and bool_or(p.polcmd in ('w','*'))
       order by t.table_name`)

    expect(
      rows.map((r) => r.table_name),
      'these tables can never be soft-deleted: every select policy excludes deleted rows',
    ).toEqual([])
  })

  it('finds tables to check, so the sweep above is not vacuous', async () => {
    await actAsOwner()
    const { rows } = await db.query(`
      select count(*)::int as n
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'deleted_at' and a.attnum > 0
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`)
    // Nine at the time of writing. If this ever reaches zero the sweep passes
    // by examining nothing.
    expect(rows[0].n).toBeGreaterThan(5)
  })
})
