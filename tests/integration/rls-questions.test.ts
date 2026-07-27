import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asUser, asOwner, employee, chef, hr, superAdmin, fixtures } from './helpers/db'

/**
 * RLS for the question bank.
 *
 * The answer-key tests are the reason this file exists. Everything else is
 * routine scoping; a leak there is an inconvenience. A leak of
 * question_answer_keys to a candidate mid-exam invalidates every result the
 * platform has ever produced.
 */

const describeDb = hasDatabase ? describe : describe.skip

const CHEF_A = 'aaaa1111-1111-1111-1111-111111111111'
const EMP_A = 'bbbb2222-2222-2222-2222-222222222222'
const HR_U = 'cccc3333-3333-3333-3333-333333333333'
const ADMIN = 'dddd4444-4444-4444-4444-444444444444'

const Q_ID = 'eeee5555-5555-5555-5555-555555555555'

describeDb('RLS — question bank', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'qchef@test.local'), ($2,'qemp@test.local'),
         ($3,'qhr@test.local'),   ($4,'qadmin@test.local')
       on conflict (id) do nothing`,
      [CHEF_A, EMP_A, HR_U, ADMIN],
    )

    await db.query(
      `update public.profiles
          set approval_status='approved', outlet_id=$2, company_id=$3
        where id = any($1::uuid[])`,
      [[CHEF_A, EMP_A, HR_U, ADMIN], fixtures.outletAiko, fixtures.company],
    )

    // A question with a real answer key — the subject of the leak tests.
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, created_by, status)
       values ($1, $2, 'mcq_single', 'choice_single',
               'At what temperature should chicken be cooked through?',
               $3::jsonb, $4, 'active')
       on conflict (id) do nothing`,
      [
        Q_ID,
        fixtures.company,
        JSON.stringify({
          format: 'choice_single',
          choices: [
            { id: 'a', text: '63°C' },
            { id: 'b', text: '74°C' },
            { id: 'c', text: '82°C' },
          ],
        }),
        CHEF_A,
      ],
    )

    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1, $2::jsonb) on conflict (question_id) do nothing`,
      [Q_ID, JSON.stringify({ format: 'choice_single', correct: 'b' })],
    )

    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.questions where id = $1', [Q_ID])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF_A, EMP_A, HR_U, ADMIN]])
    await db.query('commit')
    await db.end()
  })

  // ── The answer-key isolation ───────────────────────────────────────────────

  describe('answer keys', () => {
    it('are readable by a chef', async () => {
      const rows = await asUser(db, chef(CHEF_A), async (c) =>
        (await c.query('select answer_key from public.question_answer_keys where question_id = $1', [Q_ID])).rows,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].answer_key).toMatchObject({ correct: 'b' })
    })

    it('ARE NOT readable by an employee', async () => {
      // The one that matters. Employees hold no policy on this table, so RLS
      // denies by default. If this ever returns a row, every exam result the
      // platform has produced is suspect.
      const rows = await asUser(db, employee(EMP_A), async (c) =>
        (await c.query('select answer_key from public.question_answer_keys where question_id = $1', [Q_ID])).rows,
      )
      expect(rows, 'EMPLOYEE CAN READ ANSWER KEYS — exam integrity is broken').toHaveLength(0)
    })

    it('are not readable by HR either', async () => {
      // HR is read-only across reports but has no business with answer keys —
      // they hold no questions.read permission.
      const rows = await asUser(db, hr(HR_U), async (c) =>
        (await c.query('select answer_key from public.question_answer_keys where question_id = $1', [Q_ID])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('cannot be written by an employee', async () => {
      await expect(
        asUser(db, employee(EMP_A), async (c) =>
          c.query(
            `insert into public.question_answer_keys (question_id, answer_key)
             values ($1, '{"format":"choice_single","correct":"a"}'::jsonb)
             on conflict (question_id) do update set answer_key = excluded.answer_key`,
            [Q_ID],
          ),
        ),
      ).rejects.toThrow()
    })
  })

  // ── questions ──────────────────────────────────────────────────────────────

  describe('questions', () => {
    it('are readable by a chef', async () => {
      const rows = await asUser(db, chef(CHEF_A), async (c) =>
        (await c.query('select id, stem from public.questions where id = $1', [Q_ID])).rows,
      )
      expect(rows).toHaveLength(1)
    })

    it('are NOT readable by an employee', async () => {
      // Employees never touch this table. They see questions only through
      // exam delivery, from the frozen snapshot, with keys stripped. Direct
      // access would let them browse the bank before sitting the exam.
      const rows = await asUser(db, employee(EMP_A), async (c) =>
        (await c.query('select id from public.questions where id = $1', [Q_ID])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('carry no correct answer in content', async () => {
      // Structural guarantee: content is what exam delivery serves. If a
      // `correct` key ever appears here, the split has been defeated.
      const rows = await asUser(db, chef(CHEF_A), async (c) =>
        (await c.query('select content from public.questions where id = $1', [Q_ID])).rows,
      )
      expect(rows[0].content).not.toHaveProperty('correct')
      expect(JSON.stringify(rows[0].content)).not.toContain('correct')
    })

    it('cannot be created by an employee', async () => {
      await expect(
        asUser(db, employee(EMP_A), async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'true_false','boolean','Sneaky', '{"format":"boolean"}'::jsonb, $2)`,
            [fixtures.company, EMP_A],
          ),
        ),
      ).rejects.toThrow()
    })

    it('cannot be created with someone else listed as author', async () => {
      // created_by is asserted by the policy, not accepted from the payload.
      await expect(
        asUser(db, chef(CHEF_A), async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'true_false','boolean','Forged authorship','{"format":"boolean"}'::jsonb, $2)`,
            [fixtures.company, ADMIN],
          ),
        ),
      ).rejects.toThrow()
    })

    it('are visible to a super admin', async () => {
      const rows = await asUser(db, superAdmin(ADMIN), async (c) =>
        (await c.query('select id from public.questions where id = $1', [Q_ID])).rows,
      )
      expect(rows).toHaveLength(1)
    })
  })

  // ── The database-side content validator ────────────────────────────────────

  describe('validate_question_content', () => {
    it('rejects a single-choice question with fewer than two options', async () => {
      // The CHECK exists because import, seeds, AI generation and psql all
      // bypass the Zod layer.
      await expect(
        asOwner(db, async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'mcq_single','choice_single','Too few',
                     '{"format":"choice_single","choices":[{"id":"a","text":"only"}]}'::jsonb, $2)`,
            [fixtures.company, CHEF_A],
          ),
        ),
      ).rejects.toThrow(/q_content_valid/)
    })

    it('rejects a fill-in-the-blank with no template', async () => {
      await expect(
        asOwner(db, async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'fill_blank','blanks','No template',
                     '{"format":"blanks","blanks":[{"id":"b1"}]}'::jsonb, $2)`,
            [fixtures.company, CHEF_A],
          ),
        ),
      ).rejects.toThrow(/q_content_valid/)
    })

    it('rejects a type/format mismatch', async () => {
      await expect(
        asOwner(db, async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'mcq_single','text_long','Mismatched','{"format":"text_long"}'::jsonb, $2)`,
            [fixtures.company, CHEF_A],
          ),
        ),
      ).rejects.toThrow(/q_format_matches_type/)
    })

    it('allows a media type to take any format', async () => {
      // The two-axis model: an image-based question is still an MCQ.
      const result = await asOwner(db, async (c) =>
        c.query(
          `insert into public.questions (company_id, type, response_format, stem, content, created_by)
           values ($1,'image','choice_single','Identify this cut',
                   '{"format":"choice_single","choices":[{"id":"a","text":"Sirloin"},{"id":"b","text":"Rib"}]}'::jsonb, $2)
           returning id`,
          [fixtures.company, CHEF_A],
        ),
      )
      expect(result.rowCount).toBe(1)
    })

    it('rejects malformed JSON content without crashing', async () => {
      await expect(
        asOwner(db, async (c) =>
          c.query(
            `insert into public.questions (company_id, type, response_format, stem, content, created_by)
             values ($1,'mcq_single','choice_single','Garbage','{"format":"choice_single","choices":"not-an-array"}'::jsonb, $2)`,
            [fixtures.company, CHEF_A],
          ),
        ),
      ).rejects.toThrow(/q_content_valid/)
    })
  })

  // ── save_question — the editor's only write path (migration 0013) ──────────
  //
  // Every test here runs inside asUser's rolled-back transaction, so the rows
  // these create never outlive the case. That also exercises the change_note
  // GUC in its natural habitat: set_config(…, true) is transaction-local.

  describe('save_question', () => {
    const CONTENT = JSON.stringify({
      format: 'choice_single',
      choices: [
        { id: 'a', text: 'Rice bran' },
        { id: 'b', text: 'Extra virgin olive' },
      ],
    })
    const KEY = JSON.stringify({ format: 'choice_single', correct: 'a' })

    /** Create a question as `claims`, returning the RPC's row. */
    const create = (c: Client, note: string | null = null) =>
      c.query(
        `select * from public.save_question(
           p_id              => null,
           p_type            => 'mcq_single',
           p_response_format => 'choice_single',
           p_stem            => 'Which oil has the highest smoke point?',
           p_content         => $1::jsonb,
           p_answer_key      => $2::jsonb,
           p_change_note     => $3
         )`,
        [CONTENT, KEY, note],
      )

    it('is refused for an employee', async () => {
      // SECURITY INVOKER is the whole point: the function has no privileges of
      // its own, so questions_insert refuses exactly as a direct insert would.
      // A SECURITY DEFINER version here would be an unauthenticated write path.
      await expect(asUser(db, employee(EMP_A), async (c) => create(c))).rejects.toThrow(
        /row-level security/i,
      )
    })

    it('writes the question and its answer key in one call', async () => {
      // The reason the RPC exists. Two round trips from the client would leave
      // a question with no key when the second fails — ungradeable, and nothing
      // surfaces it until an exam runs.
      const result = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows } = await create(c)
        const id = rows[0].id
        const key = await c.query(
          'select answer_key from public.question_answer_keys where question_id = $1',
          [id],
        )
        const question = await c.query(
          'select created_by, company_id, status, revision from public.questions where id = $1',
          [id],
        )
        return { rpc: rows[0], key: key.rows[0], question: question.rows[0] }
      })

      expect(result.rpc.revision).toBe(1)
      expect(result.rpc.status).toBe('draft')
      expect(result.key.answer_key).toMatchObject({ correct: 'a' })
      // Authorship is asserted by the database, never by the caller — there is
      // no created_by parameter to spoof.
      expect(result.question.created_by).toBe(CHEF_A)
      expect(result.question.company_id).toBe(fixtures.company)
    })

    it('records the change note against the revision', async () => {
      // 0012 declared change_note and nothing could write it: history rows come
      // from triggers, and a trigger cannot know WHY an edit was made. 0013
      // carries the reason in a transaction-local GUC. This is that path.
      const rows = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows: created } = await create(c, 'first draft from the SOP')
        return (
          await c.query(
            'select revision, change_note from public.question_revisions where question_id = $1 order by revision',
            [created[0].id],
          )
        ).rows
      })

      expect(rows).toHaveLength(1)
      expect(rows[0].change_note).toBe('first draft from the SOP')
    })

    it('bumps the revision on a reword and stamps the new note only', async () => {
      const rows = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows: created } = await create(c, 'first draft')
        const id = created[0].id

        await c.query(
          `select * from public.save_question(
             p_id => $1, p_type => 'mcq_single', p_response_format => 'choice_single',
             p_stem => 'Which of these oils has the highest smoke point?',
             p_content => $2::jsonb, p_answer_key => $3::jsonb,
             p_change_note => 'reworded for clarity')`,
          [id, CONTENT, KEY],
        )

        return (
          await c.query(
            'select revision, stem, change_note from public.question_revisions where question_id = $1 order by revision',
            [id],
          )
        ).rows
      })

      expect(rows.map((r) => r.revision)).toEqual([1, 2])
      // Revision 1 keeps the wording it was written with. That is the entire
      // point of the history table: revision 1 must stay renderable after
      // revision 2 exists.
      expect(rows[0].stem).toContain('Which oil has')
      expect(rows[0].change_note).toBe('first draft')
      expect(rows[1].stem).toContain('Which of these oils')
      expect(rows[1].change_note).toBe('reworded for clarity')
    })

    it('does not invent a revision for a housekeeping edit', async () => {
      // 0011 bumps on stem, content, type, format and marks — not on the
      // explanation. Re-sending an unchanged answer key must not bump either,
      // which is why save_question skips the key write when it is identical.
      const revisions = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows: created } = await create(c)
        const id = created[0].id

        await c.query(
          `select * from public.save_question(
             p_id => $1, p_type => 'mcq_single', p_response_format => 'choice_single',
             p_stem => 'Which oil has the highest smoke point?',
             p_content => $2::jsonb, p_answer_key => $3::jsonb,
             p_explanation => 'Rice bran oil sits around 230°C.')`,
          [id, CONTENT, KEY],
        )

        return (await c.query('select revision from public.questions where id = $1', [id])).rows[0]
          .revision
      })

      expect(revisions).toBe(1)
    })

    it('bumps the revision when only the correct answer changes', async () => {
      // The most consequential edit anyone makes: every response graded before
      // it was judged against a different truth.
      const result = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows: created } = await create(c)
        const id = created[0].id

        await c.query(
          `select * from public.save_question(
             p_id => $1, p_type => 'mcq_single', p_response_format => 'choice_single',
             p_stem => 'Which oil has the highest smoke point?',
             p_content => $2::jsonb,
             p_answer_key => '{"format":"choice_single","correct":"b"}'::jsonb,
             p_change_note => 'corrected the answer')`,
          [id, CONTENT],
        )

        const question = await c.query('select revision from public.questions where id = $1', [id])
        const history = await c.query(
          'select revision, answer_key, change_note from public.question_revisions where question_id = $1 order by revision',
          [id],
        )
        return { revision: question.rows[0].revision, history: history.rows }
      })

      expect(result.revision).toBe(2)
      expect(result.history).toHaveLength(2)
      expect(result.history[0].answer_key).toMatchObject({ correct: 'a' })
      expect(result.history[1].answer_key).toMatchObject({ correct: 'b' })
      expect(result.history[1].change_note).toBe('corrected the answer')
    })

    it('treats tags as a replace-set, not a merge', async () => {
      // A merge would make removing a tag impossible from an editor that sends
      // the complete list.
      const tags = await asUser(db, chef(CHEF_A), async (c) => {
        const { rows: made } = await c.query(
          `insert into public.tags (company_id, name, slug) values
             ($1,'Oils','oils-test'), ($1,'Frying','frying-test')
           returning id`,
          [fixtures.company],
        )
        const [t1, t2] = made.map((r) => r.id)

        const { rows: created } = await c.query(
          `select * from public.save_question(
             p_id => null, p_type => 'mcq_single', p_response_format => 'choice_single',
             p_stem => 'Which oil has the highest smoke point?',
             p_content => $1::jsonb, p_answer_key => $2::jsonb, p_tag_ids => $3::uuid[])`,
          [CONTENT, KEY, [t1, t2]],
        )
        const id = created[0].id

        await c.query(
          `select * from public.save_question(
             p_id => $1, p_type => 'mcq_single', p_response_format => 'choice_single',
             p_stem => 'Which oil has the highest smoke point?',
             p_content => $2::jsonb, p_answer_key => $3::jsonb, p_tag_ids => $4::uuid[])`,
          [id, CONTENT, KEY, [t1]],
        )

        return (await c.query('select tag_id from public.question_tags where question_id = $1', [id]))
          .rows
      })

      expect(tags).toHaveLength(1)
    })

    it('refuses to edit a question that is not visible to the caller', async () => {
      // The RPC conflates wrong-company, soft-deleted and no-permission on
      // purpose: distinguishing them would confirm that a question the caller
      // cannot see exists.
      await expect(
        asUser(db, chef(CHEF_A), async (c) =>
          c.query(
            `select * from public.save_question(
               p_id => '00000000-0000-0000-0000-0000000000ff',
               p_type => 'mcq_single', p_response_format => 'choice_single',
               p_stem => 'Nonexistent', p_content => $1::jsonb, p_answer_key => $2::jsonb)`,
            [CONTENT, KEY],
          ),
        ),
      ).rejects.toThrow(/not found or not editable/)
    })

    it('leaves no change note behind for the next writer', async () => {
      // set_config(…, is_local => true) dies with the transaction. If it did
      // not, an unrelated later edit would inherit somebody else's explanation.
      const note = await asUser(db, chef(CHEF_A), async (c) => {
        await create(c, 'a note that must not leak')
        return (await c.query(`select current_setting('app.change_note', true) as note`)).rows[0].note
      })
      // Still set inside the same transaction — that is correct and expected.
      expect(note).toBe('a note that must not leak')

      const afterRollback = await asUser(db, chef(CHEF_A), async (c) =>
        (await c.query(`select current_setting('app.change_note', true) as note`)).rows[0].note,
      )
      expect(afterRollback ?? '').toBe('')
    })
  })
})
