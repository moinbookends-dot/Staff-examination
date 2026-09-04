import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Answering, submitting and grading — the rest of the candidate's side.
 *
 * The three that matter, and why:
 *
 *   · the deadline is enforced on EVERY write, not once at submit, or a tab
 *     left open past the clock keeps saving answers
 *   · a paper is marked against the key that was SERVED, not the key as it
 *     stands now — the 0022 obligation, and the reason question_revisions
 *     exists at all
 *   · a candidate cannot claim the server's submit reasons, or the audit trail
 *     is theirs to forge
 *
 * STRUCTURE. Every case runs inside ONE transaction that is rolled back, and
 * switches role within it. The asUser/asOwner helpers each open and roll back
 * their own transaction, so an attempt started in one would be gone by the
 * next call — these cases need the attempt, an owner-side edit to the clock or
 * the answer key, and the candidate's next move to all see each other.
 */

const describeDb = hasDatabase ? describe : describe.skip

const CHEF = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CAND = 'bbbbaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'ccccaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

// Plain hex. 'p' and 't' are not hex digits and the last group is exactly 12.
const CAT = '00000000-0000-0000-0000-00000000ca88'
const EXAM = '00000000-0000-0000-0000-00000000ef88'
const EXAM_ESSAY = '00000000-0000-0000-0000-00000000ee88'

const qid = (n: number) => `00000000-0000-0000-0000-0000000ee08${n}`
const ESSAY_Q = '00000000-0000-0000-0000-0000000ee089'

const CHOICE = {
  format: 'choice_single',
  choices: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }],
}

describeDb('attempt lifecycle', () => {
  let db: Client

  // ── One-transaction scenario plumbing ──────────────────────────────────────

  /** Runs a whole scenario in one transaction and rolls it back. */
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
    await db.query('select set_config($1,$2,true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
  }

  async function actAsOwner() {
    await db.query('reset role')
  }

  async function startAttempt(examId = EXAM): Promise<string> {
    const { rows } = await db.query('select * from public.start_attempt($1)', [examId])
    return rows[0].attempt_id as string
  }

  async function paperOf(attemptId: string) {
    const { rows } = await db.query('select * from public.attempt_paper($1)', [attemptId])
    return rows
  }

  function save(attempt: string, question: string, answer: unknown) {
    return db.query('select public.save_answer($1,$2,$3::jsonb) as expires_at', [
      attempt, question, JSON.stringify(answer),
    ])
  }

  function choice(c: string) {
    return { format: 'choice_single', choice: c }
  }

  async function submit(attempt: string, reason = 'user') {
    const { rows } = await db.query('select * from public.submit_attempt($1,$2)', [attempt, reason])
    return rows[0]
  }

  /** Starts an attempt as the candidate and answers every question. */
  async function startAndAnswer(pick: (i: number) => string | null) {
    await actAs(employee(CAND))
    const attempt = await startAttempt()
    const rows = await paperOf(attempt)
    for (const [i, r] of rows.entries()) {
      const c = pick(i)
      if (c !== null) await save(attempt, r.question_id, choice(c))
    }
    return { attempt, rows }
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────

  async function publish(examId: string) {
    await db.query('begin')
    await db.query('reset role')
    await db.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify(chef(CHEF))])
    await db.query('select * from public.publish_exam($1)', [examId])
    await db.query('commit')
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query('delete from public.exams where id = any($1::uuid[])', [[EXAM, EXAM_ESSAY]])
    await db.query('delete from public.questions where id = any($1::uuid[])', [
      [qid(1), qid(2), qid(3), ESSAY_Q],
    ])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF, CAND, OTHER]])
    await db.query('delete from public.categories where id = $1', [CAT])
    // email_outbox has no FK to exams, so its dedupe rows outlive the exam and
    // the next run with the same fixed ids collides on the unique key.
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [[`exam-assigned:${EXAM}%`, `exam-assigned:${EXAM_ESSAY}%`]],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'lifechef@test.local'), ($2,'lifecand@test.local'), ($3,'lifeother@test.local')`,
      [CHEF, CAND, OTHER],
    )
    await db.query(
      `update public.profiles
          set approval_status='approved', company_id=$2, outlet_id=$3,
              department_id=(select id from public.departments where slug='kitchen' limit 1)
        where id = any($1::uuid[])`,
      [[CHEF, CAND, OTHER], fixtures.company, fixtures.outletAiko],
    )

    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Lifecycle Test','lifecycle-test')`,
      [CAT, fixtures.company],
    )

    const ids = [qid(1), qid(2), qid(3)]
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       select u.id, $2, 'mcq_single', 'choice_single', 'Lifecycle question ' || u.ord,
              $3::jsonb, $4, 3, 2, 'active', $5
         from unnest($1::uuid[]) with ordinality as u(id, ord)`,
      [ids, fixtures.company, JSON.stringify(CHOICE), CAT, CHEF],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       select u.id, '{"format":"choice_single","correct":"a"}'::jsonb
         from unnest($1::uuid[]) as u(id)`,
      [ids],
    )

    // A manually-graded question, for the exam that must land in 'evaluating'.
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       values ($1,$2,'essay','text_long','Describe the danger zone.',
               $3::jsonb,$4,3,5,'active',$5)`,
      [ESSAY_Q, fixtures.company, JSON.stringify({ format: 'text_long', maxWords: 100 }), CAT, CHEF],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1, $2::jsonb)`,
      [ESSAY_Q, JSON.stringify({ format: 'text_long', rubric: [{ id: 'r1', label: 'Names 5–63°C', max: 5 }] })],
    )

    for (const [id, title, count, types] of [
      [EXAM, 'Lifecycle exam', 3, ['mcq_single']],
      [EXAM_ESSAY, 'Lifecycle essay exam', 1, ['essay']],
    ] as const) {
      await db.query(
        `insert into public.exams
           (id, company_id, title, created_by, duration_minutes, paper_mode,
            max_attempts, pass_mark_percent, closes_at)
         values ($1,$2,$3,$4,60,'fixed',5,50, now() + interval '1 day')`,
        [id, fixtures.company, title, CHEF],
      )
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title) values ($1,'Only section') returning id`,
        [id],
      )
      await db.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
         values ($1,$2,$3,1,5,$4::public.question_type[])`,
        [sec[0].id, CAT, count, types as unknown as string[]],
      )
      await db.query(
        `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
        [id, fixtures.outletAiko],
      )
    }
    await db.query('commit')

    await publish(EXAM)
    await publish(EXAM_ESSAY)
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('reset role')
    await db.query('delete from public.exams where id = any($1::uuid[])', [[EXAM, EXAM_ESSAY]])
    await db.query('delete from public.questions where id = any($1::uuid[])', [
      [qid(1), qid(2), qid(3), ESSAY_Q],
    ])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF, CAND, OTHER]])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [[`exam-assigned:${EXAM}%`, `exam-assigned:${EXAM_ESSAY}%`]],
    )
    await db.query('commit')
    await db.end()
  })

  // ── save_answer ────────────────────────────────────────────────────────────

  describe('save_answer', () => {
    it('records the answer and returns the server deadline', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const rows = await paperOf(attempt)

        const { rows: saved } = await save(attempt, rows[0].question_id, choice('a'))
        // Returned on every save so the client resynchronises its countdown
        // against the server rather than trusting the clock it started with.
        expect(saved[0].expires_at).toBeInstanceOf(Date)

        await actAsOwner()
        const { rows: stored } = await db.query(
          'select answer, auto_grade_status from public.attempt_answers where attempt_id=$1',
          [attempt],
        )
        expect(stored).toHaveLength(1)
        expect(stored[0].answer).toEqual({ format: 'choice_single', choice: 'a' })
        expect(stored[0].auto_grade_status).toBe('pending')
      })
    })

    it('overwrites on re-save without changing the revision that was served', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const q = (await paperOf(attempt))[0].question_id

        await save(attempt, q, choice('b'))
        await save(attempt, q, choice('a'))

        await actAsOwner()
        const { rows } = await db.query(
          `select aa.answer, aa.question_revision, aq.question_revision as served
             from public.attempt_answers aa
             join public.attempt_questions aq
               on aq.attempt_id = aa.attempt_id and aq.question_id = aa.question_id
            where aa.attempt_id=$1`,
          [attempt],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].answer.choice).toBe('a')
        expect(rows[0].question_revision).toBe(rows[0].served)
      })
    })

    /**
     * The load-bearing one. A row-level policy cannot express "and the clock
     * has not run out" without re-reading the parent on every write, which is
     * why 0026 gave attempt_answers no write policy at all and this function is
     * the only writer.
     */
    it('refuses a write after the deadline', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const q = (await paperOf(attempt))[0].question_id

        await actAsOwner()
        // started_at moves too: attempts_window_ordered requires expires_at to
        // stay after it, so an attempt cannot expire before it began.
        await db.query(
          `update public.attempts
              set started_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 second'
            where id=$1`,
          [attempt],
        )

        await actAs(employee(CAND))
        await expect(save(attempt, q, choice('a'))).rejects.toThrow(/time is up/i)
      })
    })

    it('refuses a write to somebody else\'s attempt', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const q = (await paperOf(attempt))[0].question_id

        await actAs(employee(OTHER))
        await expect(save(attempt, q, choice('a'))).rejects.toThrow(/attempt not found/i)
      })
    })

    it('refuses a question that is not on this paper', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        // ESSAY_Q belongs to the other exam, so it is never drawn onto this one.
        await expect(
          save(attempt, ESSAY_Q, { format: 'text_long', text: 'x' }),
        ).rejects.toThrow(/question not in this paper/i)
      })
    })

    it('refuses an answer whose format does not match the question', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const q = (await paperOf(attempt))[0].question_id

        await expect(
          save(attempt, q, { format: 'boolean', value: true }),
        ).rejects.toThrow(/format does not match/i)
      })
    })

    it('blocks answering once submitted', async () => {
      await scenario(async () => {
        const { attempt, rows } = await startAndAnswer(() => 'a')
        await submit(attempt)

        await expect(save(attempt, rows[0].question_id, choice('b'))).rejects.toThrow(
          /already been submitted/i,
        )
      })
    })
  })

  // ── submit_attempt ─────────────────────────────────────────────────────────

  describe('submit_attempt', () => {
    it('grades a fully correct paper and passes it', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        const r = await submit(attempt)

        expect(r.status).toBe('auto_graded')
        expect(Number(r.score)).toBe(6)       // 3 questions × 2 marks
        expect(Number(r.max_score)).toBe(6)
        expect(r.passed).toBe(true)
      })
    })

    it('grades a fully wrong paper and fails it', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'b')
        const r = await submit(attempt)

        expect(r.status).toBe('auto_graded')
        expect(Number(r.score)).toBe(0)
        expect(r.passed).toBe(false)
      })
    })

    it('scores an unanswered question zero without penalising it', async () => {
      await scenario(async () => {
        // Answer the first correctly, skip the rest.
        const { attempt } = await startAndAnswer((i) => (i === 0 ? 'a' : null))
        const r = await submit(attempt)

        expect(Number(r.score)).toBe(2)
        expect(r.passed).toBe(false)          // 2 of 6 is 33%, under the 50% mark

        await actAsOwner()
        const { rows } = await db.query(
          'select count(*)::int as n from public.attempt_answers where attempt_id=$1',
          [attempt],
        )
        // A skip is the ABSENCE of a row, not a row scoring zero. That is what
        // makes "never penalise a skip" true by construction rather than by a
        // branch somebody could later remove.
        expect(rows[0].n).toBe(1)
      })
    })

    it('marks a paper needing a human as evaluating, with no verdict yet', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt(EXAM_ESSAY)
        const q = (await paperOf(attempt))[0].question_id

        await save(attempt, q, { format: 'text_long', text: 'Between 5 and 63 degrees.' })
        const r = await submit(attempt)

        expect(r.status).toBe('evaluating')
        // Not false — unknown. A paper with an ungraded essay has no verdict,
        // and recording one would publish a fail no evaluator agreed to.
        expect(r.passed).toBeNull()
      })
    })

    /**
     * Idempotent since 0094, deliberately: the runner submits the moment the
     * page is hidden, the timer submits at zero, and the two race whenever a
     * candidate leaves in the final second. The first closer wins; everyone
     * after gets the closed row back, not an error a client would have to
     * special-case.
     */
    it('a second submit is a no-op that returns the closed row', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        const first = await submit(attempt)
        const second = await submit(attempt)
        expect(second.status).toBe(first.status)
        expect(second.score).toBe(first.score)
      })
    })

    it("records 'focus_loss' — a window covering the visible exam", async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        const r = await submit(attempt, 'focus_loss')
        expect(r.status).not.toBe('in_progress')
        const { rows } = await db.query(
          'select submit_reason from public.attempts where id = $1', [attempt])
        expect(rows[0].submit_reason).toBe('focus_loss')
      })
    })

    it('re-submitting cannot launder a cheating mark back to normal', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        await submit(attempt, 'tab_switch')

        // The candidate returns and presses Submit — or replays the RPC by
        // hand. The recorded reason must be the first closure's, permanently.
        await submit(attempt, 'user')
        const { rows } = await db.query(
          'select submit_reason from public.attempts where id = $1', [attempt])
        expect(rows[0].submit_reason).toBe('tab_switch')
      })
    })

    it('refuses to submit somebody else\'s attempt', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        await actAs(employee(OTHER))
        await expect(submit(attempt)).rejects.toThrow(/attempt not found/i)
      })
    })

    /**
     * submit_reason is an audit trail. A candidate may say they finished, that
     * their timer expired, or that they switched tabs. Letting them also claim
     * 'sweeper' or 'admin' would hand them the server's side of the story.
     */
    it.each(['sweeper', 'admin'])('refuses the server-only reason %s', async (reason) => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer(() => 'a')
        await expect(submit(attempt, reason)).rejects.toThrow(/invalid submit reason/i)
      })
    })
  })

  // ── The 0022 obligation ────────────────────────────────────────────────────

  describe('grading uses the key that was served', () => {
    /**
     * THE test this milestone exists to make possible.
     *
     * A candidate sits a question, and before they submit somebody edits the
     * question and its answer key. Grading against the live key would mark them
     * wrong for correctly answering the question they were actually shown.
     *
     * answer_key_at_revision() is what prevents it. This proves the grader goes
     * through it rather than reading question_answer_keys directly — a change
     * that would look harmless in review and pass every other test here.
     */
    it('marks against the revision on the paper, not the current answer key', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()
        const target = (await paperOf(attempt))[0].question_id

        // Correct as the paper stands.
        await save(attempt, target, choice('a'))

        // The question is now rewritten and the correct answer becomes 'b'.
        await actAsOwner()
        await db.query(
          `update public.questions
              set stem = 'Lifecycle question 1 (rewritten)', revision = revision + 1
            where id = $1`,
          [target],
        )
        await db.query(
          `update public.question_answer_keys
              set answer_key = '{"format":"choice_single","correct":"b"}'::jsonb
            where question_id = $1`,
          [target],
        )

        await actAs(employee(CAND))
        const r = await submit(attempt)

        // Still credited: marked against the wording and key they were served.
        expect(Number(r.score)).toBe(2)

        await actAsOwner()
        const { rows } = await db.query(
          'select score, grade_detail from public.attempt_answers where attempt_id=$1 and question_id=$2',
          [attempt, target],
        )
        expect(Number(rows[0].score)).toBe(2)
        expect(rows[0].grade_detail.correct).toBe(true)
      })
    })
  })

  // ── The sweeper ────────────────────────────────────────────────────────────

  describe('expire_attempts', () => {
    it('closes an overdue attempt and records that the server did it', async () => {
      await scenario(async () => {
        const { attempt } = await startAndAnswer((i) => (i === 0 ? 'a' : null))

        await actAsOwner()
        await db.query(
          `update public.attempts
              set started_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 minute'
            where id=$1`,
          [attempt],
        )
        await db.query('select public.expire_attempts()')

        const { rows } = await db.query(
          'select status, submit_reason, score, passed from public.attempts where id=$1',
          [attempt],
        )
        expect(rows[0].status).toBe('auto_graded')
        expect(rows[0].submit_reason).toBe('sweeper')
        // Graded, not merely closed: an abandoned attempt still earns what the
        // candidate answered before they walked away.
        expect(Number(rows[0].score)).toBe(2)
        expect(rows[0].passed).toBe(false)
      })
    })

    it('leaves an attempt that is still within its window alone', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const attempt = await startAttempt()

        await actAsOwner()
        await db.query('select public.expire_attempts()')

        const { rows } = await db.query('select status from public.attempts where id=$1', [attempt])
        expect(rows[0].status).toBe('in_progress')
      })
    })

    it('is not reachable by a signed-in employee', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        await expect(db.query('select public.expire_attempts()')).rejects.toThrow(
          /permission denied/i,
        )
      })
    })
  })
})
