import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connect, hasDatabase, asUser, asOwner, mutateAsOwner,
  employee, chef, superAdmin, fixtures,
} from './helpers/db'

/**
 * Question revision history (migration 0012).
 *
 * Two things under test, and they fail in completely different ways:
 *
 *   1. CAPTURE — is history actually written, at the right revision, with the
 *      answer key in force at the time? A gap here is silent: everything works
 *      until someone tries to replay an attempt months later, by which point
 *      the data never existed.
 *
 *   2. ISOLATION — this table stores answer keys. It is a second, less obvious
 *      route to them, and the kind of gap that opens precisely because the
 *      table looks like history rather than like secrets.
 */

const describeDb = hasDatabase ? describe : describe.skip

const AUTHOR = 'a1a1a1a1-1111-4111-8111-111111111111'
const LEARNER = 'b2b2b2b2-2222-4222-8222-222222222222'
const BOSS = 'c3c3c3c3-3333-4333-8333-333333333333'
const Q = 'd4d4d4d4-4444-4444-8444-444444444444'

const contentV1 = {
  format: 'choice_single',
  choices: [
    { id: 'a', text: '63°C' },
    { id: 'b', text: '74°C' },
  ],
}

describeDb('question revision history', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'revauthor@test.local'), ($2,'revlearner@test.local'), ($3,'revboss@test.local')
       on conflict (id) do nothing`,
      [AUTHOR, LEARNER, BOSS],
    )
    await db.query(
      `update public.profiles set approval_status='approved', outlet_id=$2, company_id=$3
        where id = any($1::uuid[])`,
      [[AUTHOR, LEARNER, BOSS], fixtures.outletAiko, fixtures.company],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, created_by, status, marks)
       values ($1,$2,'mcq_single','choice_single','Chicken safe temperature?',$3::jsonb,$4,'active',10)
       on conflict (id) do nothing`,
      [Q, fixtures.company, JSON.stringify(contentV1), AUTHOR],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,'{"format":"choice_single","correct":"b"}'::jsonb)
       on conflict (question_id) do nothing`,
      [Q],
    )

    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.questions where id = $1', [Q])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[AUTHOR, LEARNER, BOSS]])
    await db.query('commit')
    await db.end()
  })

  // ── Capture ────────────────────────────────────────────────────────────────

  describe('capture', () => {
    it('records revision 1 at creation', async () => {
      // If creation is not captured, the FIRST edit loses the original wording —
      // exactly the failure this migration exists to prevent.
      const rows = await asOwner(db, async (c) =>
        (await c.query(
          'select revision, stem, content from public.question_revisions where question_id = $1 order by revision',
          [Q],
        )).rows,
      )
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].revision).toBe(1)
      expect(rows[0].stem).toBe('Chicken safe temperature?')
    })

    it('stores the answer key in force at that revision', async () => {
      const rows = await asOwner(db, async (c) =>
        (await c.query(
          'select answer_key from public.question_revisions where question_id = $1 and revision = 1',
          [Q],
        )).rows,
      )
      expect(rows[0].answer_key).toMatchObject({ correct: 'b' })
    })

    it('captures a new revision when the stem changes, keeping the old one intact', async () => {
      // Committed: the trigger's write to question_revisions must outlive this
      // transaction, or the assertion below sees nothing and the trigger looks
      // broken when it is fine.
      await mutateAsOwner(db, async (c) => {
        await c.query('update public.questions set stem = $2 where id = $1', [
          Q,
          'What internal temperature is chicken safe at?',
        ])
      })

      const rows = await asOwner(db, async (c) =>
        (await c.query(
          'select revision, stem from public.question_revisions where question_id = $1 order by revision',
          [Q],
        )).rows,
      )

      expect(rows.length).toBeGreaterThanOrEqual(2)
      // The whole point: the earlier wording is still readable.
      expect(rows[0].stem).toBe('Chicken safe temperature?')
      expect(rows[rows.length - 1].stem).toBe('What internal temperature is chicken safe at?')
    })

    it('captures a revision when the answer key changes', async () => {
      // Changing what is correct alters the question more fundamentally than
      // rewording it — every prior response was graded against a different truth.
      const before = await asOwner(db, async (c) =>
        (await c.query('select revision from public.questions where id = $1', [Q])).rows[0].revision,
      )

      await mutateAsOwner(db, async (c) => {
        await c.query(
          `update public.question_answer_keys
              set answer_key = '{"format":"choice_single","correct":"a"}'::jsonb
            where question_id = $1`,
          [Q],
        )
      })

      const after = await asOwner(db, async (c) =>
        (await c.query('select revision from public.questions where id = $1', [Q])).rows[0].revision,
      )
      expect(after).toBe(before + 1)

      const rows = await asOwner(db, async (c) =>
        (await c.query(
          'select revision, answer_key from public.question_revisions where question_id = $1 order by revision',
          [Q],
        )).rows,
      )
      // Both truths survive, each against its own revision.
      expect(rows[0].answer_key).toMatchObject({ correct: 'b' })
      expect(rows[rows.length - 1].answer_key).toMatchObject({ correct: 'a' })
    })

    it('does NOT capture on housekeeping edits', async () => {
      // Bumping on re-categorising or retiring would fragment analytics and make
      // every question look freshly unproven.
      const before = await asOwner(db, async (c) =>
        (await c.query('select count(*)::int n from public.question_revisions where question_id = $1', [Q])).rows[0].n,
      )

      await mutateAsOwner(db, async (c) => {
        await c.query("update public.questions set difficulty = 5, explanation = 'Because.' where id = $1", [Q])
      })

      const after = await asOwner(db, async (c) =>
        (await c.query('select count(*)::int n from public.question_revisions where question_id = $1', [Q])).rows[0].n,
      )
      expect(after).toBe(before)
    })

    it('stores content_version so old revisions stay renderable', async () => {
      // A future JSONB shape change adds a v2 branch to the renderer rather than
      // invalidating everything already stored.
      const rows = await asOwner(db, async (c) =>
        (await c.query(
          'select content_version from public.question_revisions where question_id = $1',
          [Q],
        )).rows,
      )
      for (const r of rows) expect(r.content_version).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Isolation ──────────────────────────────────────────────────────────────

  describe('answer-key isolation', () => {
    it('is readable by an author', async () => {
      const rows = await asUser(db, chef(AUTHOR), async (c) =>
        (await c.query('select revision from public.question_revisions where question_id = $1', [Q])).rows,
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it('IS NOT readable by an employee', async () => {
      // The second route to answer keys. Employees hold no policy here.
      const rows = await asUser(db, employee(LEARNER), async (c) =>
        (await c.query('select answer_key from public.question_revisions where question_id = $1', [Q])).rows,
      )
      expect(rows, 'EMPLOYEE CAN READ HISTORICAL ANSWER KEYS').toHaveLength(0)
    })

    it('cannot be rewritten, even by a super admin', async () => {
      // History is append-only from the application's perspective: written only
      // by SECURITY DEFINER triggers, with no write policy at all. Nobody can
      // rewrite what a question used to say.
      const result = await asUser(db, superAdmin(BOSS), async (c) =>
        c.query(
          `update public.question_revisions set stem = 'Rewritten history' where question_id = $1`,
          [Q],
        ),
      )
      expect(result.rowCount).toBe(0)
    })

    it('cannot be deleted', async () => {
      const result = await asUser(db, superAdmin(BOSS), async (c) =>
        c.query('delete from public.question_revisions where question_id = $1', [Q]),
      )
      expect(result.rowCount).toBe(0)
    })

    it('cannot be forged by an employee', async () => {
      await expect(
        asUser(db, employee(LEARNER), async (c) =>
          c.query(
            `insert into public.question_revisions
               (question_id, revision, stem, content, response_format, question_type, marks, negative_marks)
             values ($1, 999, 'Forged', '{}'::jsonb, 'choice_single', 'mcq_single', 1, 0)`,
            [Q],
          ),
        ),
      ).rejects.toThrow()
    })
  })

  // ── Replay ─────────────────────────────────────────────────────────────────

  describe('get_question_revision()', () => {
    it('returns the wording as it was at that revision', async () => {
      const row = await asUser(db, chef(AUTHOR), async (c) =>
        (await c.query('select * from public.get_question_revision($1, 1)', [Q])).rows[0],
      )
      expect(row.stem).toBe('Chicken safe temperature?')
      expect(row.answer_key).toMatchObject({ correct: 'b' })
    })

    it('refuses a caller without questions.read', async () => {
      await expect(
        asUser(db, employee(LEARNER), async (c) =>
          c.query('select * from public.get_question_revision($1, 1)', [Q]),
        ),
      ).rejects.toThrow(/forbidden/)
    })
  })
})
