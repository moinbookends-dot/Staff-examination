import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, fixtures, type TestClaims } from './helpers/db'

/**
 * What a refused soft delete actually returns.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE BUG.                                                                  │
 * │                                                                           │
 * │ deleteQuestion checked only `error`. RLS does not raise on a refusal — it  │
 * │ filters the row out, and the UPDATE then reports success having changed    │
 * │ nothing. So "Question removed" was shown for questions that were never     │
 * │ touched: another company's, another brand's, and ones already removed.     │
 * │                                                                           │
 * │ The action now keys on the affected-row count, so this file asserts the    │
 * │ thing that count is reading: how many rows the statement actually hits.    │
 * │ Testing the count and not the action is deliberate — the count is where    │
 * │ the truth is, and it is what would change if a policy were rewritten.      │
 * │                                                                           │
 * │ Every refusal case is paired with a POSITIVE CONTROL in the same           │
 * │ transaction. "Zero rows updated" also passes against a delete that is      │
 * │ simply broken for everyone, which would be a worse bug than the one being  │
 * │ fixed.                                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaabbbb-2222-2222-2222-222222222222'
const MINE = '00000000-0000-0000-0000-0000000d0001'
const THEIRS = '00000000-0000-0000-0000-0000000d0002'
const OTHER_COMPANY = '00000000-0000-0000-0000-0000000d00ff'

const CONTENT =
  '{"format":"choice_single","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'

describeDb('the soft delete reports what it did', () => {
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

  /** One question the chef owns, one belonging to a company they have never heard of. */
  async function seed() {
    await actAsOwner()

    await db.query(
      `insert into auth.users (id, email) values ($1,'deletechef@test.local')
       on conflict (id) do nothing`,
      [CHEF],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
      [CHEF, fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `insert into public.companies (id, name, slug) values ($1,'Elsewhere','elsewhere-d00ff')
       on conflict (id) do nothing`,
      [OTHER_COMPANY],
    )

    for (const [id, companyId] of [
      [MINE, fixtures.company],
      [THEIRS, OTHER_COMPANY],
    ] as const) {
      await db.query(
        `insert into public.questions
           (id, company_id, created_by, type, response_format, stem, content, status)
         values ($1,$2,$3,'mcq_single','choice_single',$4,$5::jsonb,'draft')`,
        [id, companyId, CHEF, `Delete probe ${id.slice(-3)}`, CONTENT],
      )
    }
  }

  /** Exactly the statement deleteQuestion issues, returning what it counts. */
  async function softDelete(id: string): Promise<number> {
    const { rowCount } = await db.query(
      `update public.questions set deleted_at = now()
        where id = $1 and deleted_at is null`,
      [id],
    )
    return rowCount ?? 0
  }

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  it('removes a question the chef may remove', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // The positive control every other case in this file leans on. If this
      // ever returns 0, the assertions below are all passing vacuously.
      expect(await softDelete(MINE), 'the chef must be able to remove their own').toBe(1)
    })
  })

  it('touches nothing when the question belongs to another company', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      expect(await softDelete(THEIRS)).toBe(0)
      // Paired control, same transaction, same session: the chef is not simply
      // unable to delete anything.
      expect(await softDelete(MINE)).toBe(1)

      await actAsOwner()
      const { rows } = await db.query(
        `select deleted_at from public.questions where id = $1`,
        [THEIRS],
      )
      expect(rows[0].deleted_at, "the other company's row must be untouched").toBeNull()
    })
  })

  it('touches nothing when the question is already removed', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      expect(await softDelete(MINE)).toBe(1)
      // The second press of the button. Before the fix this reported success
      // and the audit trail gained nothing, because nothing happened.
      expect(await softDelete(MINE)).toBe(0)
    })
  })

  it('touches nothing when the question does not exist', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      expect(await softDelete('00000000-0000-0000-0000-0000000d0fff')).toBe(0)
      expect(await softDelete(MINE)).toBe(1)
    })
  })
})
