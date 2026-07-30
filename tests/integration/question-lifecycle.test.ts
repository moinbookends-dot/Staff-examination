import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, fixtures } from './helpers/db'

/**
 * The question lifecycle — 0040.
 *
 * 0037 added `review`, `approved`, `archived` and `deprecated` to
 * question_status with nothing behind them: no transition rule, no CHECK, and
 * no way to reach them from the UI. 0040 gives them a state machine, modelled
 * on 0016's exam_status_transition_allowed.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TEST THAT MATTERS IS THE LAST ONE.                                    │
 * │                                                                           │
 * │ Every drawing path — draw_paper, exam_rule_counts, preview_rule_count —   │
 * │ routes through question_pool(), and question_pool asked for exactly       │
 * │ `status = 'active'`. So an APPROVED question, the status whose entire      │
 * │ purpose is to say a question is ready to use, was invisible to every      │
 * │ paper. Silently: the rule reported a shortfall and the questions were     │
 * │ sitting right there.                                                      │
 * │                                                                           │
 * │ Everything above it is table-checking. `an approved question is drawn` is │
 * │ the assertion the migration exists for, and it is written as a three-step │
 * │ transition on ONE question — in the pool, out of the pool, back in — so   │
 * │ it cannot pass by accident against a pool that returns everything.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const QUESTION = '00000000-0000-0000-0000-0000000aff01'

const CONTENT =
  '{"format":"choice_single","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'

describeDb('question lifecycle', () => {
  let db: Client

  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('begin')
    try {
      return await fn()
    } finally {
      await db.query('rollback')
    }
  }

  /**
   * questions.created_by is a FK to profiles, and this suite does not care who
   * the author is — only what happens to the status afterwards. Seeding a
   * person would mean reimplementing handle_new_user() for no benefit, so an
   * existing one is borrowed.
   */
  async function anAuthor(): Promise<string> {
    const { rows } = await db.query(
      'select id from public.profiles where company_id = $1 limit 1',
      [fixtures.company],
    )
    expect(rows[0], 'the seed must contain at least one profile').toBeTruthy()
    return rows[0].id as string
  }

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  /**
   * The transition table, asserted in BOTH directions.
   *
   * A table of allowed transitions tested only for what it allows passes
   * perfectly against a function that returns true for everything — which is
   * the failure that matters, since the whole point is refusing things.
   */
  const LEGAL: [string, string][] = [
    ['draft', 'review'],
    // Deliberately legal: review is available, not compulsory. A chef who is
    // both author and approver will otherwise work around it.
    ['draft', 'active'],
    ['review', 'approved'],
    ['review', 'draft'],
    ['approved', 'active'],
    ['active', 'retired'],
    ['retired', 'active'],
    ['archived', 'deprecated'],
  ]

  const ILLEGAL: [string, string][] = [
    ['draft', 'approved'], // no skipping review
    ['active', 'draft'], // no un-publishing a live question
    ['deprecated', 'active'], // terminal
    ['archived', 'active'], // terminal except to deprecated
    ['active', 'approved'], // approval is upstream of active, not downstream
    ['retired', 'review'],
  ]

  it.each(LEGAL)('allows %s -> %s', async (from, to) => {
    const { rows } = await db.query(
      'select public.question_status_transition_allowed($1,$2) as ok',
      [from, to],
    )
    expect(rows[0].ok).toBe(true)
  })

  it.each(ILLEGAL)('refuses %s -> %s', async (from, to) => {
    const { rows } = await db.query(
      'select public.question_status_transition_allowed($1,$2) as ok',
      [from, to],
    )
    expect(rows[0].ok).toBe(false)
  })

  it('treats active and approved as the only drawable states', async () => {
    const { rows } = await db.query(
      `select s::text as status, public.question_is_drawable(s) as drawable
         from unnest(enum_range(null::public.question_status)) s
        order by 1`,
    )
    const drawable = rows.filter((r) => r.drawable).map((r) => r.status).sort()
    expect(drawable).toEqual(['active', 'approved'])
  })

  it('refuses an illegal transition on a real row, not only in the table', async () => {
    await scenario(async () => {
      await db.query(
        `insert into public.questions (id, company_id, created_by, type, response_format, stem, content, status)
         values ($1, $2, $3, 'mcq_single', 'choice_single', 'Lifecycle probe', $4::jsonb, 'draft')`,
        [QUESTION, fixtures.company, await anAuthor(), CONTENT],
      )

      await db.query(`update public.questions set status='review' where id=$1`, [QUESTION])
      await db.query(`update public.questions set status='approved' where id=$1`, [QUESTION])

      await expect(
        db.query(`update public.questions set status='deprecated' where id=$1`, [QUESTION]),
      ).rejects.toThrow(/cannot move a question from approved to deprecated/)
    })
  })

  /**
   * The one this file exists for.
   */
  it('draws an approved question, which before 0040 was invisible to every paper', async () => {
    await scenario(async () => {
      const { rows: [exam] } = await db.query(
        `select id from public.exams where company_id = $1 and deleted_at is null limit 1`,
        [fixtures.company],
      )
      // No exam to draw against means this assertion would pass vacuously.
      expect(exam, 'the seed must contain at least one exam').toBeTruthy()

      await db.query(
        `insert into public.questions (id, company_id, created_by, type, response_format, stem, content, status, marks)
         values ($1, $2, $3, 'mcq_single', 'choice_single', 'Approved-and-drawable probe', $4::jsonb, 'active', 1)`,
        [QUESTION, fixtures.company, await anAuthor(), CONTENT],
      )

      const inPool = async () => {
        const { rows } = await db.query(
          `select count(*)::int as n
             from public.question_pool($1, null, true, '{}', null, 1::smallint, 5::smallint)
            where question_id = $2`,
          [exam.id, QUESTION],
        )
        return rows[0].n as number
      }

      // Three states on ONE question: present, absent, present again. A pool
      // that returned everything would fail the middle step.
      expect(await inPool(), 'active must be drawable').toBe(1)

      await db.query(`update public.questions set status='retired' where id=$1`, [QUESTION])
      expect(await inPool(), 'retired must not be drawable').toBe(0)

      await db.query(`update public.questions set status='approved' where id=$1`, [QUESTION])
      expect(await inPool(), 'APPROVED MUST BE DRAWABLE — this is the bug 0040 fixes').toBe(1)
    })
  })
})
