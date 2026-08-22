import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Bulk question operations — 0042, on top of 0041's restore policies.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TWO ASSERTIONS THIS FILE EXISTS FOR.                                  │
 * │                                                                           │
 * │ 1. A PARTIAL UPDATE IS PARTIAL. save_question is a full-record write, so   │
 * │    a bulk category change routed through it would blank the Bloom level,   │
 * │    the explanation and the reference note of every row — silently, because │
 * │    each call did exactly what it was asked. The test that matters is not   │
 * │    "the category changed", it is "NOTHING ELSE DID".                       │
 * │                                                                           │
 * │ 2. RLS IS DOING THE SCOPING. These functions are SECURITY INVOKER and      │
 * │    re-implement no company check, so the proof that a company cannot touch │
 * │    another's questions is an actual cross-company call — with a positive   │
 * │    control beside it, because "nothing was updated" also passes against a  │
 * │    function that is simply broken.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaabbbb-1111-1111-1111-111111111111'
const Q1 = '00000000-0000-0000-0000-0000000b0001'
const Q2 = '00000000-0000-0000-0000-0000000b0002'
const Q3 = '00000000-0000-0000-0000-0000000b0003'
const CAT = '00000000-0000-0000-0000-0000000b00c1'
const TAG = '00000000-0000-0000-0000-0000000b00d1'
const OTHER_COMPANY = '00000000-0000-0000-0000-0000000b00ff'

const CONTENT =
  '{"format":"choice_single","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'

describeDb('bulk question operations', () => {
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
   * Three questions with a full complement of metadata, so a partial update has
   * something to leave alone.
   */
  async function seed(opts: { status?: string; companyId?: string } = {}) {
    const { status = 'draft', companyId = fixtures.company } = opts
    await actAsOwner()

    await db.query(
      `insert into auth.users (id, email) values ($1,'bulkchef@test.local')
       on conflict (id) do nothing`,
      [CHEF],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
      [CHEF, fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Bulk','bulk-bu001') on conflict (id) do nothing`,
      [CAT, fixtures.company],
    )
    await db.query(
      `insert into public.tags (id, company_id, name, slug) values ($1,$2,'BulkTag','bulktag-b00d1')
       on conflict (id) do nothing`,
      [TAG, fixtures.company],
    )

    for (const id of [Q1, Q2, Q3]) {
      await db.query(
        `insert into public.questions
           (id, company_id, created_by, type, response_format, stem, content,
            status, difficulty, marks, bloom_level, explanation, reference_note,
            source, imported_from, usage_count)
         values ($1,$2,$3,'mcq_single','choice_single',$4,$5::jsonb,
                 $6::public.question_status, 3, 2, 'analyze', 'Because.', 'SOP 4.2',
                 'import','moodle_xml', 7)`,
        [id, companyId, CHEF, `Bulk probe ${id.slice(-3)}`, CONTENT, status],
      )
    }
  }

  const rowsOf = async (sql: string, params: unknown[]) =>
    (await db.query(sql, params)).rows

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  // ── 1. Partial means partial ───────────────────────────────────────────────

  it('changes only the column it was asked to change', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      await db.query('select * from public.bulk_update_questions($1::uuid[], p_set_category := $2)', [
        [Q1, Q2],
        CAT,
      ])

      await actAsOwner()
      const rows = await rowsOf(
        `select id, category_id, bloom_level, explanation, reference_note, marks,
                difficulty, source, imported_from, usage_count, stem
           from public.questions where id = any($1::uuid[]) order by id`,
        [[Q1, Q2]],
      )

      for (const q of rows) {
        expect(q.category_id).toBe(CAT)
        // Everything save_question would have blanked.
        expect(q.bloom_level, 'bloom must survive a category change').toBe('analyze')
        expect(q.explanation).toBe('Because.')
        expect(q.reference_note).toBe('SOP 4.2')
        expect(Number(q.marks)).toBe(2)
        expect(q.difficulty).toBe(3)
        expect(q.stem).toContain('Bulk probe')
        // Provenance is not even a parameter.
        expect(q.source).toBe('import')
        expect(q.imported_from).toBe('moodle_xml')
        // A hand-incremented counter with no way to recompute it.
        expect(q.usage_count).toBe(7)
      }
    })
  })

  it('clears a field only when explicitly asked to', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // Not requested → untouched.
      await db.query('select * from public.bulk_update_questions($1::uuid[], p_set_difficulty := 5)', [[Q1]])
      await actAsOwner()
      let [q] = await rowsOf('select bloom_level, difficulty from public.questions where id=$1', [Q1])
      expect(q.bloom_level).toBe('analyze')
      expect(q.difficulty).toBe(5)

      // Explicitly cleared → null.
      await actAs(chef(CHEF))
      await db.query(
        'select * from public.bulk_update_questions($1::uuid[], p_clear_bloom := true)',
        [[Q1]],
      )
      await actAsOwner()
      ;[q] = await rowsOf('select bloom_level from public.questions where id=$1', [Q1])
      expect(q.bloom_level).toBeNull()
    })
  })

  // ── 2. Status, reusing 0040 ────────────────────────────────────────────────

  it('skips an illegal transition without stopping the legal ones beside it', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()
      // Q3 is archived; archived -> active is refused by 0040.
      await db.query(`update public.questions set status='archived' where id=$1`, [Q3])
      await actAs(chef(CHEF))

      const result = await rowsOf(
        `select * from public.bulk_update_questions($1::uuid[], p_set_status := 'active')`,
        [[Q1, Q2, Q3]],
      )

      const applied = result.filter((r) => r.applied).map((r) => r.question_id).sort()
      expect(applied).toEqual([Q1, Q2].sort())

      const skipped = result.find((r) => r.question_id === Q3)
      expect(skipped.applied).toBe(false)
      expect(skipped.reason).toMatch(/not allowed/)

      // The batch committed rather than aborting on the trigger.
      await actAsOwner()
      const rows = await rowsOf(
        'select id, status from public.questions where id = any($1::uuid[]) order by id',
        [[Q1, Q2, Q3]],
      )
      expect(rows.find((r) => r.id === Q1).status).toBe('active')
      expect(rows.find((r) => r.id === Q3).status).toBe('archived')
    })
  })

  it('returns a row for every id asked about, applied or not', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))
      const ghost = '00000000-0000-0000-0000-0000000b00aa'
      const result = await rowsOf(
        'select * from public.bulk_update_questions($1::uuid[], p_set_difficulty := 4)',
        [[Q1, ghost]],
      )
      expect(result.length).toBe(2)
      expect(result.find((r) => r.question_id === ghost).applied).toBe(false)
    })
  })

  // ── 3. Tags ────────────────────────────────────────────────────────────────

  it('adds and removes tags only on the rows that actually moved', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()
      await db.query(`update public.questions set status='archived' where id=$1`, [Q3])
      await actAs(chef(CHEF))

      await db.query(
        `select * from public.bulk_update_questions($1::uuid[], p_set_status := 'active', p_add_tags := $2::uuid[])`,
        [[Q1, Q3], [TAG]],
      )

      await actAsOwner()
      const tagged = await rowsOf(
        'select question_id from public.question_tags where tag_id = $1 order by question_id',
        [TAG],
      )
      // Q3's status move was illegal, so it was skipped — and must not have
      // been quietly tagged anyway.
      expect(tagged.map((t) => t.question_id)).toEqual([Q1])
    })
  })

  // ── 4. Tenancy — the assertion RLS is standing in for ──────────────────────

  it('cannot touch another company’s questions, and can touch its own', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()
      await db.query(
        `insert into public.companies (id, name, slug) values ($1,'Other','other-bu0')
         on conflict (id) do nothing`,
        [OTHER_COMPANY],
      )
      await db.query(`update public.questions set company_id=$2 where id=$1`, [Q3, OTHER_COMPANY])
      await actAs(chef(CHEF))

      const result = await rowsOf(
        'select * from public.bulk_update_questions($1::uuid[], p_set_difficulty := 1)',
        [[Q1, Q3]],
      )

      // The negative…
      expect(result.find((r) => r.question_id === Q3).applied).toBe(false)
      // …and the positive control, without which the negative proves nothing:
      // a function that updated no rows at all would pass the line above.
      expect(result.find((r) => r.question_id === Q1).applied).toBe(true)

      await actAsOwner()
      const [other] = await rowsOf('select difficulty from public.questions where id=$1', [Q3])
      expect(other.difficulty, "the other company's row is untouched").toBe(3)
    })
  })

  it('refuses a caller who holds no question permissions at all', async () => {
    await scenario(async () => {
      await seed()
      await actAs(employee(CHEF))
      const result = await rowsOf(
        'select * from public.bulk_update_questions($1::uuid[], p_set_difficulty := 1)',
        [[Q1]],
      )
      expect(result[0].applied).toBe(false)
    })
  })

  // ── 5. Delete and restore ──────────────────────────────────────────────────

  it('removes and restores, round trip', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      const removed = await rowsOf(
        'select * from public.bulk_set_question_deleted($1::uuid[], true)',
        [[Q1, Q2]],
      )
      expect(removed.every((r) => r.applied)).toBe(true)

      await actAsOwner()
      let rows = await rowsOf(
        'select deleted_at from public.questions where id = any($1::uuid[])',
        [[Q1, Q2]],
      )
      expect(rows.every((r) => r.deleted_at !== null)).toBe(true)

      // The half that was impossible before 0041.
      await actAs(chef(CHEF))
      const restored = await rowsOf(
        'select * from public.bulk_set_question_deleted($1::uuid[], false)',
        [[Q1, Q2]],
      )
      expect(restored.every((r) => r.applied)).toBe(true)

      await actAsOwner()
      rows = await rowsOf('select deleted_at, usage_count from public.questions where id = any($1::uuid[])', [
        [Q1, Q2],
      ])
      expect(rows.every((r) => r.deleted_at === null)).toBe(true)
      // A restored question keeps the exposure it earned.
      expect(rows.every((r) => r.usage_count === 7)).toBe(true)
    })
  })

  it('reports an already-removed question as skipped rather than done', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))
      await db.query('select * from public.bulk_set_question_deleted($1::uuid[], true)', [[Q1]])
      const again = await rowsOf(
        'select * from public.bulk_set_question_deleted($1::uuid[], true)',
        [[Q1]],
      )
      expect(again[0].applied).toBe(false)
    })
  })

  /**
   * 0041 widened the read policy, and this is the boundary of that widening: a
   * deleted question is visible to somebody who could have removed it, and to
   * nobody else.
   */
  it('shows a removed question only to a holder of questions.retire', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))
      await db.query('select * from public.bulk_set_question_deleted($1::uuid[], true)', [[Q1]])

      const asChef = await rowsOf('select id from public.questions where id=$1', [Q1])
      expect(asChef.length, 'a chef can see what they removed').toBe(1)

      await actAs(employee(CHEF))
      const asEmployee = await rowsOf('select id from public.questions where id=$1', [Q1])
      expect(asEmployee.length, 'an employee cannot').toBe(0)
    })
  })

  // ── 6. The audit trail 0041 added ──────────────────────────────────────────

  it('audits a status change and a removal, and stays silent on a content edit', async () => {
    await scenario(async () => {
      await seed()
      const before = (
        await rowsOf(`select count(*)::int n from public.audit_logs where table_name='questions'`, [])
      )[0].n

      await actAs(chef(CHEF))
      await db.query(`select * from public.bulk_update_questions($1::uuid[], p_set_status := 'active')`, [[Q1]])
      await db.query('select * from public.bulk_set_question_deleted($1::uuid[], true)', [[Q2]])

      await actAsOwner()
      const afterLifecycle = (
        await rowsOf(`select count(*)::int n from public.audit_logs where table_name='questions'`, [])
      )[0].n
      expect(afterLifecycle - before, 'one row for the status move, one for the removal').toBe(2)

      // A content edit must NOT be logged — 0006's reasoning about noise, and
      // question_revisions already keeps it.
      await db.query(`update public.questions set stem = 'Reworded' where id=$1`, [Q3])
      const afterEdit = (
        await rowsOf(`select count(*)::int n from public.audit_logs where table_name='questions'`, [])
      )[0].n
      expect(afterEdit).toBe(afterLifecycle)
    })
  })

  it('records who made the change, not an anonymous actor', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))
      await db.query(`select * from public.bulk_update_questions($1::uuid[], p_set_status := 'active')`, [[Q1]])

      await actAsOwner()
      const [entry] = await rowsOf(
        `select actor_id, changes from public.audit_logs
          where table_name='questions' and record_id=$1
          order by occurred_at desc limit 1`,
        [Q1],
      )
      // The reason restore stayed on the user's client rather than going
      // through the admin one: auth.uid() is null there, and every row would
      // have been logged with no actor.
      expect(entry.actor_id).toBe(CHEF)
      expect(entry.changes).toHaveProperty('status')
    })
  })
// ── 7. The gate that keys on drawability ───────────────────────────────────

  /**
   * 0040 made `approved` drawable alongside `active`, and setQuestionStatus
   * routed only `active` through the publish gate. So a question whose answer
   * key names an option that no longer exists could go draft -> review ->
   * approved and be DRAWN ONTO A LIVE PAPER, marking every candidate wrong,
   * having never once passed publishIssues.
   *
   * The database cannot catch this — nothing in SQL inspects
   * question_answer_keys at publish time, and q_content_valid checks only shape
   * and arity. So this asserts the database's half: that a question reaching a
   * drawable status IS drawn. The TypeScript half — that the gate runs for both
   * drawable statuses — is asserted by the unit test on isDrawableStatus.
   */
  it('draws a question the moment it reaches any drawable status', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()
      const { rows: [exam] } = await db.query(
        `select id from public.exams where company_id = $1 and deleted_at is null limit 1`,
        [fixtures.company],
      )
      expect(exam, 'the seed must contain an exam to draw against').toBeTruthy()

      const inPool = async () =>
        (
          await db.query(
            `select count(*)::int n
               from public.question_pool($1, null, true, '{}', null, 1::smallint, 5::smallint)
              where question_id = $2`,
            [exam.id, Q1],
          )
        ).rows[0].n

      expect(await inPool(), 'a draft is not drawable').toBe(0)

      await db.query(`update public.questions set status='review' where id=$1`, [Q1])
      expect(await inPool(), 'nor is one in review').toBe(0)

      await db.query(`update public.questions set status='approved' where id=$1`, [Q1])
      expect(
        await inPool(),
        'APPROVED IS DRAWABLE — which is why the publish gate must key on drawability, not on the word active',
      ).toBe(1)
    })
  })
})
