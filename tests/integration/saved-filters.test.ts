import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, fixtures, type TestClaims } from './helpers/db'

/**
 * question_saved_filters — 0043.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE ONE TABLE WHERE PRIVACY IS THE WHOLE FEATURE.                 │
 * │                                                                           │
 * │ Every other table in this schema answers "who in the company may see      │
 * │ this". This one answers "nobody but me", including a Super Admin, and the │
 * │ policies say so with a bare `owner_id = auth.uid()` and no has_perm       │
 * │ escape. A test that only proved the owner can read their own would pass   │
 * │ against a table with no RLS at all — so every case below is a NEGATIVE    │
 * │ paired with a positive control in the same transaction.                   │
 * │                                                                           │
 * │ The negatives cover all four verbs, not just select. A read policy alone  │
 * │ would leave a second chef able to DELETE filters they cannot see, which   │
 * │ is a real and confusing failure: the owner's menu quietly empties.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const OWNER = 'aaaabbbb-3333-3333-3333-333333333333'
const OTHER = 'aaaabbbb-4444-4444-4444-444444444444'
const FILTER = '00000000-0000-0000-0000-0000000f0001'

describeDb('saved question filters', () => {
  let db: Client

  async function actAs(claims: TestClaims) {
    await db.query('set local role authenticated')
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

  /**
   * Run a statement that is expected to be refused, and return the error.
   *
   * A savepoint, because a refusal in Postgres aborts the whole transaction —
   * so without one, the positive control that has to follow every negative in
   * this file cannot run, and the suite reports "transaction is aborted"
   * instead of the thing it was actually asserting.
   */
  async function refused(sql: string, params: unknown[]): Promise<Error> {
    await db.query('savepoint attempt')
    try {
      await db.query(sql, params)
    } catch (error) {
      await db.query('rollback to savepoint attempt')
      return error as Error
    }
    await db.query('release savepoint attempt')
    throw new Error('the statement was allowed, and should not have been')
  }

  /** Two chefs in the SAME company and outlet — the hardest case for privacy. */
  async function seed() {
    await actAsOwner()

    for (const [id, email] of [
      [OWNER, 'filterowner@test.local'],
      [OTHER, 'filterother@test.local'],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`,
        [id, email],
      )
      await db.query(
        `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
        [id, fixtures.company, fixtures.outletAiko],
      )
    }

    await db.query(
      `insert into public.question_saved_filters (id, company_id, owner_id, name, query)
       values ($1,$2,$3,'Needs Bloom','status=draft&bloomLevel=')`,
      [FILTER, fixtures.company, OWNER],
    )
  }

  const countVisible = async () =>
    Number((await db.query('select count(*)::int as n from public.question_saved_filters')).rows[0].n)

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  it('lets the owner read their own', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(OWNER))

      const { rows } = await db.query(
        'select name, query from public.question_saved_filters where id = $1',
        [FILTER],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe('Needs Bloom')
      expect(rows[0].query).toBe('status=draft&bloomLevel=')
    })
  })

  it('hides it from another chef in the same company and outlet', async () => {
    await scenario(async () => {
      await seed()

      await actAs(chef(OTHER))
      expect(await countVisible(), 'a colleague must see none of it').toBe(0)

      // Positive control: the row exists and is readable — by its owner.
      await actAs(chef(OWNER))
      expect(await countVisible()).toBe(1)
    })
  })

  it('refuses a colleague trying to update or delete it', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(OTHER))

      const updated = await db.query(
        `update public.question_saved_filters set name = 'Stolen' where id = $1`,
        [FILTER],
      )
      expect(updated.rowCount).toBe(0)

      const deleted = await db.query(
        `delete from public.question_saved_filters where id = $1`,
        [FILTER],
      )
      expect(deleted.rowCount).toBe(0)

      // The owner's copy is intact and still theirs to change.
      await actAs(chef(OWNER))
      const { rows } = await db.query(
        'select name from public.question_saved_filters where id = $1',
        [FILTER],
      )
      expect(rows[0].name).toBe('Needs Bloom')
      expect(
        (await db.query(`update public.question_saved_filters set name='Mine' where id=$1`, [FILTER]))
          .rowCount,
      ).toBe(1)
    })
  })

  it('refuses an insert claiming somebody else as the owner', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(OTHER))

      // The whole point of the WITH CHECK. Without it a chef could plant a
      // filter in a colleague's menu — which they would then never be able to
      // remove, since the read policy hides who put it there.
      const error = await refused(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Planted','status=active')`,
        [fixtures.company, OWNER],
      )
      expect(error.message).toMatch(/row-level security/i)

      // Positive control: the same insert for themselves is allowed.
      await db.query(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Mine','status=active')`,
        [fixtures.company, OTHER],
      )
      expect(await countVisible()).toBe(1)
    })
  })

  it('refuses an insert into another company', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(OTHER))

      await refused(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Elsewhere','status=active')`,
        ['00000000-0000-0000-0000-0000000f00ff', OTHER],
      )

      // Positive control: their own company is accepted by the same statement.
      await db.query(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Here','status=active')`,
        [fixtures.company, OTHER],
      )
    })
  })

  it('keeps one row per name per owner', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(OWNER))

      const error = await refused(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Needs Bloom','status=review')`,
        [fixtures.company, OWNER],
      )
      expect(error.message).toMatch(/duplicate key/i)

      // The same name is fine for a different person — the constraint is on
      // the pair, not on the name.
      await actAs(chef(OTHER))
      await db.query(
        `insert into public.question_saved_filters (company_id, owner_id, name, query)
         values ($1,$2,'Needs Bloom','status=review')`,
        [fixtures.company, OTHER],
      )
      expect(await countVisible()).toBe(1)
    })
  })
})
