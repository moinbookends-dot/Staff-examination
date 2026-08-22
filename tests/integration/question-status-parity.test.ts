import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase } from './helpers/db'
import {
  DRAWABLE_STATUSES,
  QUESTION_STATUSES,
  QUESTION_STATUS_TRANSITIONS,
  type QuestionStatusValue,
} from '../../src/lib/questions/status'

/**
 * The TypeScript copy of the lifecycle against the SQL one.
 *
 * src/lib/questions/status.ts restates 0040's transition table so the editor
 * can offer the moves that are legal from where you are. Two copies of a rule
 * is a liability, and this is the thing that makes it a safe one: the database
 * is authoritative, the trigger enforces it, and this asserts the mirror is
 * exact — in BOTH directions.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY BOTH DIRECTIONS.                                                      │
 * │                                                                           │
 * │ Checking only "everything TS allows, SQL allows" passes against a TS table │
 * │ that allows nothing — an editor offering no buttons at all. Checking only  │
 * │ the reverse passes against a TS table that allows everything, which offers │
 * │ buttons that fail at the trigger. The pair is the assertion.               │
 * │                                                                           │
 * │ It also covers the enum itself: a status added to Postgres and not to      │
 * │ QUESTION_STATUSES is exactly how 0037 shipped, and it is the reason a      │
 * │ question in `review` would have rendered the raw key `questions.status.    │
 * │ review` at a chef.                                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

describeDb('question status parity', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  it('knows every status the database does, and no others', async () => {
    const { rows } = await db.query(
      `select unnest(enum_range(null::public.question_status))::text as status`,
    )
    const inDatabase = rows.map((r) => r.status as string).sort()
    expect([...QUESTION_STATUSES].sort()).toEqual(inDatabase)
  })

  it('mirrors every transition the database allows, and no more', async () => {
    // One query, every ordered pair — cheaper and more complete than asking
    // per-transition, and it cannot miss a pair the TS table forgot to mention.
    const { rows } = await db.query(
      `select a::text as "from", b::text as "to",
              public.question_status_transition_allowed(a, b) as allowed
         from unnest(enum_range(null::public.question_status)) a
        cross join unnest(enum_range(null::public.question_status)) b`,
    )

    const disagreements: string[] = []

    for (const row of rows) {
      const from = row.from as QuestionStatusValue
      const to = row.to as QuestionStatusValue
      // Staying put is trivially allowed in SQL and is not a "transition" the
      // editor would ever offer, so it is excluded from the mirror.
      if (from === to) continue

      const sql = row.allowed as boolean
      const ts = (QUESTION_STATUS_TRANSITIONS[from] ?? []).includes(to)

      if (sql !== ts) {
        disagreements.push(
          `${from} -> ${to}: SQL says ${sql ? 'allowed' : 'refused'}, TypeScript says ${ts ? 'allowed' : 'refused'}`,
        )
      }
    }

    expect(disagreements, disagreements.join('\n  ')).toEqual([])
  })

  it('agrees with the database about which statuses are drawable', async () => {
    const { rows } = await db.query(
      `select s::text as status
         from unnest(enum_range(null::public.question_status)) s
        where public.question_is_drawable(s)
        order by 1`,
    )
    // Compared against the TypeScript constant, not a literal: DRAWABLE_STATUSES
    // is what the publish gate keys on, so a divergence here means the gate is
    // validating a different set of statuses than the draw actually uses.
    expect(rows.map((r) => r.status).sort()).toEqual([...DRAWABLE_STATUSES].sort())
  })
})
