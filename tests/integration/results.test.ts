import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Results, and being told they exist.
 *
 * What this file has to prove:
 *
 *   · a result reaches the candidate through my_results() / my_result_detail()
 *     only once it is 'published', by every route into that state
 *   · publishing notifies the candidate exactly once, whichever of the four
 *     publishers did it
 *   · the notification names who marked and verified, and never what they wrote
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — see tests/unit/fixture-ids.test.ts for why these must be unique.
const EVAL = 'aaaabbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const VER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CAND = 'ccccbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const CAT = '00000000-0000-0000-0000-00000000cab1'
const Q_MCQ = '00000000-0000-0000-0000-0000000eeb11'
const Q_ESSAY = '00000000-0000-0000-0000-0000000eeb12'

const EXAM_AUTO = '00000000-0000-0000-0000-00000000eab1' // mcq only, publishes at submit
const EXAM_HELD = '00000000-0000-0000-0000-00000000ebb1' // mcq only, released by hand
const EXAM_ESSAY = '00000000-0000-0000-0000-00000000ecb1' // essay, single verification

const ALL_EXAMS = [EXAM_AUTO, EXAM_HELD, EXAM_ESSAY]

describeDb('results and release notifications', () => {
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

  /** Sits and submits, answering the mcq correctly and the essay if present. */
  async function sit(examId: string) {
    await actAs(employee(CAND))
    const { rows: started } = await db.query('select * from public.start_attempt($1)', [examId])
    const attempt = started[0].attempt_id as string

    const { rows: paper } = await db.query('select * from public.attempt_paper($1)', [attempt])
    for (const q of paper) {
      const answer =
        q.snapshot.response_format === 'text_long'
          ? { format: 'text_long', text: 'Between 5 and 63 degrees.' }
          : { format: 'choice_single', choice: 'a' }
      await db.query('select public.save_answer($1,$2,$3::jsonb)', [
        attempt, q.question_id, JSON.stringify(answer),
      ])
    }
    await db.query('select * from public.submit_attempt($1,$2)', [attempt, 'user'])
    return attempt
  }

  async function noticesFor(attemptId: string) {
    const who = await db.query('select current_user as u')
    await actAsOwner()
    const { rows } = await db.query(
      `select n.kind, n.link, n.title, n.data
         from public.notifications n
        where n.data ->> 'attempt_id' = $1`,
      [attemptId],
    )
    const { rows: mail } = await db.query(
      `select o.template, o.priority, o.to_email
         from public.email_outbox o
        where o.payload ->> 'attempt_id' = $1`,
      [attemptId],
    )
    if (who.rows[0].u === 'authenticated') await db.query('set local role authenticated')
    return { notifications: rows, emails: mail }
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.exams where id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.questions where id = any($1::uuid[])', [[Q_MCQ, Q_ESSAY]])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[EVAL, VER, CAND]])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'evalb@test.local'), ($2,'verb@test.local'), ($3,'candb@test.local')`,
      [EVAL, VER, CAND],
    )
    await db.query(
      `update public.profiles
          set approval_status='approved', company_id=$2, outlet_id=$3, full_name = case id
                when $4::uuid then 'Ellie Evaluator'
                when $5::uuid then 'Vik Verifier'
                else 'Cass Candidate' end,
              department_id=(select id from public.departments where slug='kitchen' limit 1)
        where id = any($1::uuid[])`,
      [[EVAL, VER, CAND], fixtures.company, fixtures.outletAiko, EVAL, VER],
    )

    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Results Test','results-test')`,
      [CAT, fixtures.company],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       values ($1,$2,'mcq_single','choice_single','Results mcq',$3::jsonb,$4,3,4,'active',$5)`,
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
       values ($1,$2,'essay','text_long','Describe the danger zone.',$3::jsonb,$4,3,6,'active',$5)`,
      [Q_ESSAY, fixtures.company, JSON.stringify({ format: 'text_long', maxWords: 80 }), CAT, EVAL],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,$2::jsonb)`,
      [
        Q_ESSAY,
        JSON.stringify({ format: 'text_long', rubric: [{ id: 'r1', label: 'Names the band', max: 6 }] }),
      ],
    )

    const exams: Array<[string, string, string, string[]]> = [
      [EXAM_AUTO, 'Auto released quiz', 'auto', ['mcq_single']],
      [EXAM_HELD, 'Held quiz', 'dual', ['mcq_single']],
      [EXAM_ESSAY, 'Essay exam', 'single', ['essay']],
    ]

    for (const [id, title, mode, types] of exams) {
      await db.query(
        `insert into public.exams
           (id, company_id, title, created_by, duration_minutes, paper_mode,
            max_attempts, pass_mark_percent, verification_mode, closes_at)
         values ($1,$2,$3,$4,45,'fixed',9,50,$5::public.verification_mode, now() + interval '1 day')`,
        [id, fixtures.company, title, EVAL, mode],
      )
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title) values ($1,'Only section') returning id`,
        [id],
      )
      await db.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
         values ($1,$2,1,1,5,$3::public.question_type[])`,
        [sec[0].id, CAT, types],
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
    await db.query('delete from auth.users where id = any($1::uuid[])', [[EVAL, VER, CAND]])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )
    await db.query('commit')
    await db.end()
  })

  // ── The list ───────────────────────────────────────────────────────────────

  describe('my_results', () => {
    it('withholds the score until the result is published', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_HELD) // dual mode: held at auto_graded

        await actAs(employee(CAND))
        const { rows } = await db.query(
          'select * from public.my_results() where attempt_id=$1',
          [attempt],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe('auto_graded')
        expect(rows[0].score).toBeNull()
        expect(rows[0].percent).toBeNull()
        expect(rows[0].passed).toBeNull()
        expect(rows[0].published).toBe(false)
      })
    })

    it('shows the score and percentage once published', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO) // publishes at submit

        await actAs(employee(CAND))
        const { rows } = await db.query(
          'select * from public.my_results() where attempt_id=$1',
          [attempt],
        )
        expect(rows[0].published).toBe(true)
        expect(Number(rows[0].score)).toBe(4)
        expect(Number(rows[0].max_score)).toBe(4)
        expect(Number(rows[0].percent)).toBe(100)
        expect(rows[0].passed).toBe(true)
      })
    })

    it('leaves a paper still being sat off the list', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const { rows: started } = await db.query('select * from public.start_attempt($1)', [
          EXAM_HELD,
        ])
        const { rows } = await db.query('select * from public.my_results() where attempt_id=$1', [
          started[0].attempt_id,
        ])
        // That one belongs on /my-exams; this page is for finished papers.
        expect(rows).toHaveLength(0)
      })
    })

    it('shows one candidate nothing of another\'s', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        await actAs(employee(VER))
        const { rows } = await db.query('select * from public.my_results() where attempt_id=$1', [
          attempt,
        ])
        expect(rows).toHaveLength(0)
      })
    })
  })

  // ── The detail ─────────────────────────────────────────────────────────────

  describe('my_result_detail', () => {
    it('refuses an unpublished attempt', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_HELD)
        await actAs(employee(CAND))
        await expect(
          db.query('select * from public.my_result_detail($1)', [attempt]),
        ).rejects.toThrow(/not been released/i)
      })
    })

    it('names who marked and who signed off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_ESSAY)

        await actAs(chef(EVAL))
        await db.query('select public.save_evaluation($1,$2,$3,$4)', [
          attempt, Q_ESSAY, 5, 'Covers the band.',
        ])
        await db.query('select public.complete_evaluation($1)', [attempt])

        await actAs(chef(VER))
        await db.query('select public.verify_attempt($1,$2,$3)', [
          attempt, 'verified', 'Internal note nobody outside should read.',
        ])

        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.my_result_detail($1)', [attempt])

        expect(rows[0].evaluator_name).toBe('Ellie Evaluator')
        expect(rows[0].verifier_names).toEqual(['Vik Verifier'])
        expect(Number(rows[0].score)).toBe(5)
        expect(Number(rows[0].percent)).toBe(83.3)

        // Names yes, conversation no — 0028 kept verifier notes away from
        // candidates and this must not quietly reopen it.
        expect(JSON.stringify(rows)).not.toContain('Internal note')
      })
    })

    it('refuses somebody else\'s result', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        await actAs(employee(VER))
        await expect(
          db.query('select * from public.my_result_detail($1)', [attempt]),
        ).rejects.toThrow(/attempt not found/i)
      })
    })
  })

  // ── Notifications ──────────────────────────────────────────────────────────

  describe('release notifications', () => {
    it('notifies exactly once when a paper publishes at submit', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        const { notifications, emails } = await noticesFor(attempt)

        expect(notifications).toHaveLength(1)
        expect(notifications[0].kind).toBe('result.published')
        expect(notifications[0].link).toBe(`/results/${attempt}`)
        expect(emails).toHaveLength(1)
        expect(emails[0].template).toBe('result-published')
        // 0007's scale: under a password reset, over an exam assignment.
        expect(emails[0].priority).toBe(3)
        expect(emails[0].to_email).toBe('candb@test.local')
      })
    })

    it('notifies when a held paper is released by hand', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_HELD)
        expect((await noticesFor(attempt)).notifications).toHaveLength(0)

        await actAs(chef(VER))
        await db.query('select public.publish_attempt($1)', [attempt])

        const { notifications } = await noticesFor(attempt)
        expect(notifications).toHaveLength(1)
      })
    })

    it('notifies when the last verification signs a marked paper off', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_ESSAY)

        await actAs(chef(EVAL))
        await db.query('select public.save_evaluation($1,$2,$3,$4)', [attempt, Q_ESSAY, 6, null])
        await db.query('select public.complete_evaluation($1)', [attempt])
        // Marked but unverified: still nothing sent.
        expect((await noticesFor(attempt)).notifications).toHaveLength(0)

        await actAs(chef(VER))
        await db.query('select public.verify_attempt($1,$2,$3)', [attempt, 'verified', null])

        const { notifications, emails } = await noticesFor(attempt)
        expect(notifications).toHaveLength(1)
        expect(emails).toHaveLength(1)
      })
    })

    /**
     * The idempotency requirement, tested against the mechanism that actually
     * enforces it rather than by calling the publisher twice — the status graph
     * refuses a second publication outright, so there is no way to call it
     * twice. This asserts the second line of defence: the unique index, which
     * is what would matter if the graph were ever widened.
     */
    it('cannot record the same release notice twice', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        await actAsOwner()

        const { rows: before } = await db.query(
          `select count(*)::int n from public.notifications where data ->> 'attempt_id' = $1`,
          [attempt],
        )
        expect(before[0].n).toBe(1)

        // Exactly what the trigger writes, replayed.
        await db.query(
          `insert into public.notifications (user_id, kind, title, body, link, data)
           values ($1,'result.published','Your exam result is ready','x','/results/'||$2,
                   jsonb_build_object('dedupe_key','attempt-published:'||$2,'attempt_id',$2::uuid))
           on conflict do nothing`,
          [CAND, attempt],
        )

        const { rows: after } = await db.query(
          `select count(*)::int n from public.notifications where data ->> 'attempt_id' = $1`,
          [attempt],
        )
        expect(after[0].n).toBe(1)
      })
    })

    /**
     * Re-publishing an already-published attempt is a no-op, not an error: the
     * transition trigger returns early when the status has not changed. So the
     * thing standing between a repeated write and a repeated email is the
     * notification trigger's WHEN clause, and this is the case that exercises
     * it — the duplicate publish that the requirement is actually about.
     */
    it('sends nothing further when a published attempt is published again', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        expect((await noticesFor(attempt)).notifications).toHaveLength(1)

        await actAsOwner()
        await db.query("update public.attempts set status='published' where id=$1", [attempt])
        await db.query(
          "update public.attempts set status='published', published_at=now() where id=$1",
          [attempt],
        )

        const { notifications, emails } = await noticesFor(attempt)
        expect(notifications).toHaveLength(1)
        expect(emails).toHaveLength(1)
      })
    })

    it('never returns to published once voided, so a notice cannot be replayed', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_AUTO)
        await actAsOwner()
        await db.query("update public.attempts set status='voided' where id=$1", [attempt])
        await expect(
          db.query("update public.attempts set status='published' where id=$1", [attempt]),
        ).rejects.toThrow(/cannot go from voided to published/i)
      })
    })

    it('writes no email for somebody who opted out, but still notifies in-app', async () => {
      await scenario(async () => {
        await actAsOwner()
        await db.query('update public.profiles set email_opt_in = false where id = $1', [CAND])

        const attempt = await sit(EXAM_AUTO)
        const { notifications, emails } = await noticesFor(attempt)

        // Opting out of email is not opting out of the product.
        expect(notifications).toHaveLength(1)
        expect(emails).toHaveLength(0)
      })
    })
  })
})
