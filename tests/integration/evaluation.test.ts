import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Evaluation, verification and release.
 *
 * The claims this file exists to prove, none of which may rest on the UI:
 *
 *   · a candidate cannot see a score until the attempt is 'published' — not
 *     through my_attempts(), not through attempt_review(), and not by selecting
 *     the tables directly
 *   · dual verification means two DIFFERENT people, and neither may be the
 *     evaluator who marked it
 *   · returning a paper discards the sign-offs it already had
 *   · the status graph is enforced by the database, so no function, script or
 *     psql session can move an attempt somewhere the lifecycle forbids
 */

const describeDb = hasDatabase ? describe : describe.skip

const EVAL = 'aaaa9999-9999-9999-9999-999999999999'
const VER1 = 'bbbb9999-9999-9999-9999-999999999999'
const VER2 = 'cccc9999-9999-9999-9999-999999999999'
const CAND = 'dddd9999-9999-9999-9999-999999999999'

const CAT = '00000000-0000-0000-0000-00000000ca99'
const Q_MCQ = '00000000-0000-0000-0000-0000000ee091'
const Q_ESSAY = '00000000-0000-0000-0000-0000000ee092'

// One exam per route through the lifecycle.
const EXAM_DUAL = '00000000-0000-0000-0000-00000000ed99' // essay, dual verification
const EXAM_SINGLE = '00000000-0000-0000-0000-00000000e199' // essay, single verification
const EXAM_AUTOMODE = '00000000-0000-0000-0000-00000000ea99' // essay, no sign-off required
const EXAM_MCQ_AUTO = '00000000-0000-0000-0000-00000000eb99' // mcq only, no sign-off
const EXAM_MCQ_HOLD = '00000000-0000-0000-0000-00000000ec99' // mcq only, sign-off required

const ALL_EXAMS = [EXAM_DUAL, EXAM_SINGLE, EXAM_AUTOMODE, EXAM_MCQ_AUTO, EXAM_MCQ_HOLD]

describeDb('evaluation, verification and release', () => {
  let db: Client

  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('begin')
    try {
      return await fn()
    } finally {
      await db.query('rollback')
    }
  }

  async function actAs(claims: TestClaims) {
    await db.query('set local role authenticated')
    await db.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify(claims)])
  }

  const actAsOwner = () => db.query('reset role')

  /**
   * Asserts a statement is refused, without poisoning the scenario.
   *
   * A failed statement aborts the whole transaction in Postgres, so a rejection
   * asserted in the middle of a case makes every later query fail with
   * "current transaction is aborted" — which reads like a second bug. The
   * savepoint confines the damage to the statement being tested.
   */
  async function expectRefused(sql: string, params: unknown[], matcher: RegExp) {
    await db.query('savepoint probe')
    await expect(db.query(sql, params)).rejects.toThrow(matcher)
    await db.query('rollback to savepoint probe')
  }

  /** Sits the exam as the candidate, answering the mcq and optionally the essay. */
  async function sit(examId: string, { essay = true }: { essay?: boolean } = {}) {
    await actAs(employee(CAND))
    const { rows: started } = await db.query('select * from public.start_attempt($1)', [examId])
    const attempt = started[0].attempt_id as string

    const { rows: paper } = await db.query('select * from public.attempt_paper($1)', [attempt])
    for (const q of paper) {
      const format = q.snapshot.response_format
      if (format === 'text_long') {
        if (essay) {
          await db.query('select public.save_answer($1,$2,$3::jsonb)', [
            attempt, q.question_id, JSON.stringify({ format: 'text_long', text: 'Between 5 and 63.' }),
          ])
        }
      } else {
        await db.query('select public.save_answer($1,$2,$3::jsonb)', [
          attempt, q.question_id, JSON.stringify({ format: 'choice_single', choice: 'a' }),
        ])
      }
    }

    await db.query('select * from public.submit_attempt($1,$2)', [attempt, 'user'])
    return attempt
  }

  /**
   * Reads the raw status as the owner, then puts the caller's role back.
   *
   * It cannot simply select: 0028 dropped the candidate's policy on `attempts`,
   * which is the thing half this file is asserting. Restoring the role matters
   * because most callers are mid-scenario and go on to act as somebody.
   */
  async function statusOf(attemptId: string): Promise<string> {
    const { rows: who } = await db.query('select current_user as u')
    await db.query('reset role')
    const { rows } = await db.query('select status from public.attempts where id=$1', [attemptId])
    if (who[0].u === 'authenticated') await db.query('set local role authenticated')
    return rows[0].status
  }

  /** Marks every outstanding question and closes evaluation. */
  async function evaluateAll(attemptId: string, score = 5) {
    const { rows: items } = await db.query('select * from public.attempt_evaluation_items($1)', [
      attemptId,
    ])
    for (const item of items) {
      await db.query('select public.save_evaluation($1,$2,$3,$4)', [
        attemptId, item.question_id, Math.min(score, Number(item.marks)), 'Looks right.',
      ])
    }
    const { rows } = await db.query('select public.complete_evaluation($1) as next', [attemptId])
    return rows[0].next as string
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.exams where id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.questions where id = any($1::uuid[])', [[Q_MCQ, Q_ESSAY]])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[EVAL, VER1, VER2, CAND]])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'eval9@test.local'), ($2,'ver9a@test.local'),
         ($3,'ver9b@test.local'), ($4,'cand9@test.local')`,
      [EVAL, VER1, VER2, CAND],
    )
    await db.query(
      `update public.profiles
          set approval_status='approved', company_id=$2, outlet_id=$3,
              department_id=(select id from public.departments where slug='kitchen' limit 1)
        where id = any($1::uuid[])`,
      [[EVAL, VER1, VER2, CAND], fixtures.company, fixtures.outletAiko],
    )

    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Evaluation Test','evaluation-test')`,
      [CAT, fixtures.company],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       values ($1,$2,'mcq_single','choice_single','Eval mcq',$3::jsonb,$4,3,2,'active',$5)`,
      [
        Q_MCQ, fixtures.company,
        JSON.stringify({
          format: 'choice_single',
          choices: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }],
        }),
        CAT, EVAL,
      ],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,'{"format":"choice_single","correct":"a"}'::jsonb)`,
      [Q_MCQ],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       values ($1,$2,'essay','text_long','Describe the danger zone.',$3::jsonb,$4,3,5,'active',$5)`,
      [Q_ESSAY, fixtures.company, JSON.stringify({ format: 'text_long', maxWords: 100 }), CAT, EVAL],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,$2::jsonb)`,
      [
        Q_ESSAY,
        JSON.stringify({
          format: 'text_long',
          rubric: [{ id: 'r1', label: 'Names 5 to 63 degrees', max: 5 }],
        }),
      ],
    )

    const exams: Array<[string, string, string, string[]]> = [
      [EXAM_DUAL, 'Dual verified exam', 'dual', ['mcq_single', 'essay']],
      [EXAM_SINGLE, 'Single verified exam', 'single', ['mcq_single', 'essay']],
      [EXAM_AUTOMODE, 'No sign-off exam', 'auto', ['mcq_single', 'essay']],
      [EXAM_MCQ_AUTO, 'Auto published quiz', 'auto', ['mcq_single']],
      [EXAM_MCQ_HOLD, 'Held quiz', 'dual', ['mcq_single']],
    ]

    for (const [id, title, mode, types] of exams) {
      await db.query(
        `insert into public.exams
           (id, company_id, title, created_by, duration_minutes, paper_mode,
            max_attempts, pass_mark_percent, verification_mode, closes_at)
         values ($1,$2,$3,$4,60,'fixed',9,50,$5::public.verification_mode, now() + interval '1 day')`,
        [id, fixtures.company, title, EVAL, mode],
      )
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title) values ($1,'Only section') returning id`,
        [id],
      )
      await db.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
         values ($1,$2,$3,1,5,$4::public.question_type[])`,
        [sec[0].id, CAT, types.length, types],
      )
      await db.query(
        `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
        [id, fixtures.outletAiko],
      )
    }
    await db.query('commit')

    for (const [id] of exams) {
      await db.query('begin')
      await db.query('reset role')
      await db.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(chef(EVAL)),
      ])
      await db.query('select * from public.publish_exam($1)', [id])
      await db.query('commit')
    }
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('reset role')
    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.exams where id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.questions where id = any($1::uuid[])', [[Q_MCQ, Q_ESSAY]])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[EVAL, VER1, VER2, CAND]])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )
    await db.query('commit')
    await db.end()
  })

  // ── Routing out of submit ──────────────────────────────────────────────────

  describe('where a submitted paper goes', () => {
    it('sends a paper containing an essay to evaluation, with no verdict', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAsOwner()
        const { rows } = await db.query(
          'select status, passed from public.attempts where id=$1',
          [attempt],
        )
        expect(rows[0].status).toBe('evaluating')
        expect(rows[0].passed).toBeNull()
      })
    })

    it('publishes a fully auto-graded paper when the exam asks for no sign-off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_AUTO)
        await actAsOwner()
        const { rows } = await db.query(
          'select status, published_at, passed from public.attempts where id=$1',
          [attempt],
        )
        expect(rows[0].status).toBe('published')
        expect(rows[0].published_at).not.toBeNull()
        expect(rows[0].passed).toBe(true)
      })
    })

    it('holds a fully auto-graded paper when the exam requires sign-off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_HOLD)
        expect(await statusOf(attempt)).toBe('auto_graded')
      })
    })

    it('an unanswered essay still routes to a human rather than scoring zero', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL, { essay: false })
        expect(await statusOf(attempt)).toBe('evaluating')
      })
    })
  })

  // ── The release gate ───────────────────────────────────────────────────────

  describe('a candidate cannot see a result before it is published', () => {
    it('my_attempts withholds the score until publication', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)

        await actAs(employee(CAND))
        const { rows: before } = await db.query(
          'select * from public.my_attempts() where attempt_id=$1',
          [attempt],
        )
        expect(before).toHaveLength(1)
        // Status yes — they are entitled to know it is being marked.
        expect(before[0].status).toBe('evaluating')
        expect(before[0].score).toBeNull()
        expect(before[0].max_score).toBeNull()
        expect(before[0].passed).toBeNull()
        expect(before[0].published).toBe(false)

        await actAs(chef(EVAL))
        await evaluateAll(attempt)
        await actAs(chef(VER1))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null])
        await actAs(chef(VER2))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null])

        await actAs(employee(CAND))
        const { rows: after } = await db.query(
          'select * from public.my_attempts() where attempt_id=$1',
          [attempt],
        )
        expect(after[0].status).toBe('published')
        expect(Number(after[0].score)).toBe(7) // 2 for the mcq + 5 awarded on the essay
        expect(after[0].published).toBe(true)
      })
    })

    it('the candidate cannot read the attempts table directly', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)

        await actAs(employee(CAND))
        // The policy that used to allow this was dropped in 0028: a policy picks
        // rows and cannot withhold a column, so the row is gone and the function
        // is the whole surface.
        const { rows } = await db.query('select * from public.attempts where id=$1', [attempt])
        expect(rows).toHaveLength(0)
      })
    })

    it('the candidate cannot read their per-answer scores directly', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)

        await actAs(employee(CAND))
        const { rows } = await db.query(
          'select * from public.attempt_answers where attempt_id=$1',
          [attempt],
        )
        expect(rows).toHaveLength(0)
      })
    })

    it('attempt_review refuses before publication and answers after', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_SINGLE)

        await actAs(employee(CAND))
        await expect(
          db.query('select * from public.attempt_review($1)', [attempt]),
        ).rejects.toThrow(/not been released/i)
      })

      await scenario(async () => {
        const attempt = await sit(EXAM_SINGLE)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)
        await actAs(chef(VER1))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null])

        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.attempt_review($1)', [attempt])
        expect(rows.length).toBeGreaterThan(0)
        // The breakdown may say what they wrote and whether it was right. It
        // must not say what the right answer was.
        expect(JSON.stringify(rows)).not.toContain('rubric')
      })
    })

    it('one candidate cannot review another candidate\'s attempt', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_AUTO) // published immediately
        await actAs(employee(VER1))
        await expect(
          db.query('select * from public.attempt_review($1)', [attempt]),
        ).rejects.toThrow(/attempt not found/i)
      })
    })
  })

  // ── Evaluation ─────────────────────────────────────────────────────────────

  describe('evaluating', () => {
    it('shows the evaluator the rubric for a manual question only', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        const { rows } = await db.query('select * from public.attempt_evaluation_items($1)', [
          attempt,
        ])
        // The mcq is machine-marked and absent; only the essay needs a person.
        expect(rows).toHaveLength(1)
        expect(rows[0].response_format).toBe('text_long')
        expect(rows[0].guidance.rubric).toBeTruthy()
      })
    })

    it('is refused to a candidate', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(employee(CAND))
        await expect(
          db.query('select * from public.attempt_evaluation_items($1)', [attempt]),
        ).rejects.toThrow(/forbidden/i)
      })
    })

    it('refuses a score above the marks available', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        await expect(
          db.query('select public.save_evaluation($1,$2,$3,$4)', [attempt, Q_ESSAY, 99, null]),
        ).rejects.toThrow(/between 0 and/i)
      })
    })

    it('refuses to finish while a question is still unmarked', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        await expect(
          db.query('select public.complete_evaluation($1)', [attempt]),
        ).rejects.toThrow(/awaiting a mark/i)
      })
    })

    it('publishes on completion when the exam requires no sign-off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTOMODE)
        await actAs(chef(EVAL))
        expect(await evaluateAll(attempt)).toBe('published')
      })
    })

    it('records a zero for an unanswered essay', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL, { essay: false })
        await actAs(chef(EVAL))
        // 0027 makes a skip the absence of a row; the evaluator must still be
        // able to record the mark against it.
        await db.query('select public.save_evaluation($1,$2,$3,$4)', [attempt, Q_ESSAY, 0, 'Blank.'])
        // Completed directly rather than through evaluateAll, which re-marks
        // every outstanding item and would overwrite the zero just recorded.
        const { rows: done } = await db.query('select public.complete_evaluation($1) as next', [
          attempt,
        ])
        expect(done[0].next).toBe('verifying')

        await actAsOwner()
        const { rows } = await db.query('select score from public.attempts where id=$1', [attempt])
        expect(Number(rows[0].score)).toBe(2) // the mcq only
      })
    })
  })

  // ── Verification ───────────────────────────────────────────────────────────

  describe('verifying', () => {
    it('refuses the evaluator who marked it', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)

        // A chef holds both permissions; separation of duties is what stops
        // this, not the absence of a grant.
        await expect(
          db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null]),
        ).rejects.toThrow(/cannot verify an attempt you evaluated/i)
      })
    })

    it('single mode publishes on one sign-off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_SINGLE)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)

        await actAs(chef(VER1))
        const { rows } = await db.query('select public.verify_attempt($1,$2,$3) as s', [
          attempt, 'verified', 'Agreed.',
        ])
        expect(rows[0].s).toBe('published')
      })
    })

    it('dual mode needs two different people', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)

        await actAs(chef(VER1))
        const first = await db.query('select public.verify_attempt($1,$2,$3) as s', [
          attempt, 'verified', null,
        ])
        expect(first.rows[0].s).toBe('verifying')

        // The same person signing again must not complete it.
        await expectRefused(
          'select public.verify_attempt($1,$2,$3)',
          [attempt, 'verified', null],
          /already reviewed/i,
        )
        expect(await statusOf(attempt)).toBe('verifying')

        await actAs(chef(VER2))
        const second = await db.query('select public.verify_attempt($1,$2,$3) as s', [
          attempt, 'verified', null,
        ])
        expect(second.rows[0].s).toBe('published')
      })
    })

    it('returning discards the sign-offs already given', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)

        await actAs(chef(VER1))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null])
        await actAs(chef(VER2))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'returned', 'Mark it again.'])
        expect(await statusOf(attempt)).toBe('returned')

        // Re-marked, and back round for a fresh pair of sign-offs.
        await actAs(chef(EVAL))
        await db.query('select public.save_evaluation($1,$2,$3,$4)', [attempt, Q_ESSAY, 3, 'Revised.'])
        expect(await statusOf(attempt)).toBe('evaluating')
        expect(await evaluateAll(attempt, 3)).toBe('verifying')

        // VER1's approval belonged to round 1 and must not carry over.
        await actAs(chef(VER1))
        const again = await db.query('select public.verify_attempt($1,$2,$3) as s', [
          attempt, 'verified', null,
        ])
        expect(again.rows[0].s).toBe('verifying')

        await actAs(chef(VER2))
        const done = await db.query('select public.verify_attempt($1,$2,$3) as s', [
          attempt, 'verified', null,
        ])
        expect(done.rows[0].s).toBe('published')

        await actAsOwner()
        const { rows } = await db.query(
          'select round, decision, verifier_id from public.attempt_verifications where attempt_id=$1 order by round, created_at',
          [attempt],
        )
        // The whole history survives: two rounds, four decisions, one a return.
        expect(rows).toHaveLength(4)
        expect(rows.filter((r) => r.round === 1)).toHaveLength(2)
        expect(rows.filter((r) => r.decision === 'returned')).toHaveLength(1)
      })
    })

    it('is refused to a candidate', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_SINGLE)
        await actAs(chef(EVAL))
        await evaluateAll(attempt)

        await actAs(employee(CAND))
        await expect(
          db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null]),
        ).rejects.toThrow(/forbidden/i)
      })
    })
  })

  // ── Releasing an auto-graded paper ─────────────────────────────────────────

  describe('publish_attempt', () => {
    it('releases a held auto-graded paper', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_HOLD)
        expect(await statusOf(attempt)).toBe('auto_graded')

        await actAs(chef(VER1))
        const { rows } = await db.query('select public.publish_attempt($1) as s', [attempt])
        expect(rows[0].s).toBe('published')
      })
    })

    it('is refused to a candidate', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_HOLD)
        await actAs(employee(CAND))
        await expect(db.query('select public.publish_attempt($1)', [attempt])).rejects.toThrow(
          /forbidden/i,
        )
      })
    })

    it('refuses a paper still being evaluated', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAs(chef(VER1))
        await expect(db.query('select public.publish_attempt($1)', [attempt])).rejects.toThrow(
          /not ready to publish/i,
        )
      })
    })
  })

  // ── The graph itself ───────────────────────────────────────────────────────

  describe('the status graph is enforced by the database', () => {
    it('refuses a jump straight from evaluating to published', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_DUAL)
        await actAsOwner()
        // As the owner, with RLS off and every function bypassed — the trigger
        // is what refuses this, so a script or a psql session cannot do it
        // either.
        await expect(
          db.query("update public.attempts set status='published' where id=$1", [attempt]),
        ).rejects.toThrow(/cannot go from evaluating to published/i)
      })
    })

    it('refuses to reopen a published result', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_AUTO)
        await actAsOwner()
        await expect(
          db.query("update public.attempts set status='evaluating' where id=$1", [attempt]),
        ).rejects.toThrow(/cannot go from published to evaluating/i)
      })
    })

    it('allows a published result to be voided', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_MCQ_AUTO)
        await actAsOwner()
        await db.query("update public.attempts set status='voided' where id=$1", [attempt])
        expect(await statusOf(attempt)).toBe('voided')
      })
    })
  })
})
