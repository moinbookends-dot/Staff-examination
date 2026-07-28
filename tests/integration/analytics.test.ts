import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, hr, fixtures, type TestClaims } from './helpers/db'

/**
 * Analytics.
 *
 * Every number here is derived, so the risks are not "does it save" but "does it
 * count the right things". What this file pins down:
 *
 *   · practice papers never calibrate difficulty (0014's counts_towards_analytics)
 *   · an attempt still being marked contributes nothing
 *   · statistics key on (question_id, revision) — rewording starts them again
 *   · discrimination is NULL below the sample floor rather than noise rounded
 *     into a confident decimal
 *   · a report scopes to the caller's reach, and never crosses a company
 *   · no data reads as zero rather than as no data
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces this.
const CHEF = 'aaaacccc-cccc-cccc-cccc-cccccccccccc'
const CAND = 'bbbbcccc-cccc-cccc-cccc-cccccccccccc'
const QUIET = 'ccccdddd-cccc-cccc-cccc-cccccccccccc' // approved, never sits anything
const CAND2 = 'bbbbeeee-cccc-cccc-cccc-cccccccccccc'
const CAND3 = 'bbbbffff-cccc-cccc-cccc-cccccccccccc'
const HR_USER = 'ddddcccc-cccc-cccc-cccc-cccccccccccc'

const CAT = '00000000-0000-0000-0000-00000000cac1'
const Q1 = '00000000-0000-0000-0000-0000000eec11'
const Q2 = '00000000-0000-0000-0000-0000000eec12'
const Q_PRACTICE = '00000000-0000-0000-0000-0000000eec13'
const Q_ESSAY = '00000000-0000-0000-0000-0000000eec14'

const EXAM_CAL = '00000000-0000-0000-0000-00000000eac1'      // counts towards analytics
const EXAM_PRACTICE = '00000000-0000-0000-0000-00000000ebc1' // does not
const EXAM_MANUAL = '00000000-0000-0000-0000-00000000ecc1'   // stays in evaluation

const ALL_EXAMS = [EXAM_CAL, EXAM_PRACTICE, EXAM_MANUAL]
const ALL_Q = [Q1, Q2, Q_PRACTICE, Q_ESSAY]

describeDb('analytics', () => {
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
   * Sits one attempt, answering each question per `pick`.
   *
   * Runs as the candidate through the real functions — a fixture that inserted
   * attempt rows directly would not exercise the statuses the view filters on,
   * which is most of what this file is about.
   */
  async function sit(examId: string, pick: (i: number) => boolean, who: string = CAND) {
    await actAs(employee(who))
    const { rows: started } = await db.query('select * from public.start_attempt($1)', [examId])
    const attempt = started[0].attempt_id as string

    const { rows: paper } = await db.query('select * from public.attempt_paper($1)', [attempt])
    for (const [i, q] of paper.entries()) {
      await db.query('select public.save_answer($1,$2,$3::jsonb)', [
        attempt,
        q.question_id,
        JSON.stringify(
          q.snapshot.response_format === 'text_long'
            ? { format: 'text_long', text: 'An answer.' }
            : { format: 'choice_single', choice: pick(i) ? 'a' : 'b' },
        ),
      ])
    }
    await db.query('select * from public.submit_attempt($1,$2)', [attempt, 'user'])
    return attempt
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.exams where id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.questions where id = any($1::uuid[])', [ALL_Q])
    await db.query('delete from auth.users where id = any($1::uuid[])', [
      [CHEF, CAND, CAND2, CAND3, QUIET, HR_USER],
    ])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'anchef@test.local'), ($2,'ancand@test.local'),
         ($3,'ancand2@test.local'), ($4,'ancand3@test.local'),
         ($5,'anquiet@test.local'), ($6,'anhr@test.local')`,
      [CHEF, CAND, CAND2, CAND3, QUIET, HR_USER],
    )
    await db.query(
      `update public.profiles
          set approval_status='approved', company_id=$2, outlet_id=$3,
              full_name = case id when $4::uuid then 'Ana Analyst'
                                  when $5::uuid then 'Quinn Quiet' else full_name end,
              department_id=(select id from public.departments where slug='kitchen' limit 1)
        where id = any($1::uuid[])`,
      [[CHEF, CAND, CAND2, CAND3, QUIET, HR_USER], fixtures.company, fixtures.outletAiko, CAND, QUIET],
    )

    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Analytics Test','analytics-test')`,
      [CAT, fixtures.company],
    )

    // Two questions on the calibrating exam, because discrimination correlates
    // one question against the rest of the paper — with a single question the
    // correlation is trivially 1 and proves nothing.
    for (const [id, stem, difficulty] of [
      [Q1, 'Analytics question one', 2],
      [Q2, 'Analytics question two', 4],
      [Q_PRACTICE, 'Practice only question', 3],
    ] as const) {
      await db.query(
        `insert into public.questions
           (id, company_id, type, response_format, stem, content, category_id,
            difficulty, marks, status, created_by)
         values ($1,$2,'mcq_single','choice_single',$3,$4::jsonb,$5,$6,2,'active',$7)`,
        [
          id, fixtures.company, stem,
          JSON.stringify({
            format: 'choice_single',
            choices: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }],
          }),
          CAT, difficulty, CHEF,
        ],
      )
      await db.query(
        `insert into public.question_answer_keys (question_id, answer_key)
         values ($1,'{"format":"choice_single","correct":"a"}'::jsonb)`,
        [id],
      )
    }

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       values ($1,$2,'essay','text_long','Analytics essay',$3::jsonb,$4,3,2,'active',$5)`,
      [Q_ESSAY, fixtures.company, JSON.stringify({ format: 'text_long', maxWords: 50 }), CAT, CHEF],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key) values ($1,$2::jsonb)`,
      [Q_ESSAY, JSON.stringify({ format: 'text_long', rubric: [{ id: 'r1', label: 'x', max: 2 }] })],
    )

    const exams: Array<[string, string, number, boolean, string[]]> = [
      [EXAM_CAL, 'Calibrating exam', 2, true, ['mcq_single']],
      [EXAM_PRACTICE, 'Practice exam', 1, false, ['mcq_single']],
      [EXAM_MANUAL, 'Manual exam', 1, true, ['essay']],
    ]

    for (const [id, title, count, counts, types] of exams) {
      await db.query(
        `insert into public.exams
           (id, company_id, title, created_by, duration_minutes, paper_mode,
            max_attempts, pass_mark_percent, verification_mode,
            counts_towards_analytics, closes_at)
         values ($1,$2,$3,$4,60,'fixed',10,50,'auto',$5, now() + interval '2 days')`,
        [id, fixtures.company, title, CHEF, counts],
      )
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title) values ($1,'Only section') returning id`,
        [id],
      )
      // The practice exam draws its own question so the calibrating pool stays
      // exactly the two questions this file reasons about.
      await db.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
         values ($1,$2,$3,$4,$5,$6::public.question_type[])`,
        [
          sec[0].id, CAT, count,
          id === EXAM_PRACTICE ? 3 : 1,
          id === EXAM_PRACTICE ? 3 : 5,
          types,
        ],
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
        JSON.stringify(chef(CHEF)),
      ])
      await db.query('select * from public.publish_exam($1)', [id])
      await db.query('commit')
    }
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('reset role')
    await db.query(
      `delete from public.email_outbox where payload ->> 'attempt_id' in (
         select a.id::text from public.attempts a where a.exam_id = any($1::uuid[]))`,
      [ALL_EXAMS],
    )
    await db.query(
      `delete from public.notifications where data ->> 'attempt_id' in (
         select a.id::text from public.attempts a where a.exam_id = any($1::uuid[]))`,
      [ALL_EXAMS],
    )
    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.exams where id = any($1::uuid[])', [ALL_EXAMS])
    await db.query('delete from public.questions where id = any($1::uuid[])', [ALL_Q])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query('delete from auth.users where id = any($1::uuid[])', [
      [CHEF, CAND, CAND2, CAND3, QUIET, HR_USER],
    ])
    await db.query(
      `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
      [ALL_EXAMS.map((id) => `exam-assigned:${id}%`)],
    )
    await db.query('commit')
    await db.end()
  })

  // ── What counts ────────────────────────────────────────────────────────────

  describe('which attempts count', () => {
    it('counts a settled attempt', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)
        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats()')
        expect(rows[0].attempts_n).toBe(1)
        expect(Number(rows[0].pass_rate)).toBe(100)
      })
    })

    it('ignores a practice paper, which must never calibrate', async () => {
      await scenario(async () => {
        await sit(EXAM_PRACTICE, () => true)
        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats()')
        // 0014 set counts_towards_analytics for exactly this.
        expect(rows[0].attempts_n).toBe(0)
      })
    })

    it('ignores an attempt still being marked', async () => {
      await scenario(async () => {
        // An essay paper lands in 'evaluating' on its own; the 0028 graph
        // refuses to demote a published attempt, and rightly.
        const attempt = await sit(EXAM_MANUAL, () => true)
        await actAsOwner()
        const { rows: st } = await db.query('select status from public.attempts where id=$1', [attempt])
        expect(st[0].status).toBe('evaluating')

        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats()')
        expect(rows[0].attempts_n).toBe(0)
      })
    })

    it('ignores a voided attempt', async () => {
      await scenario(async () => {
        const attempt = await sit(EXAM_CAL, () => true)
        await actAsOwner()
        await db.query("update public.attempts set status='voided' where id=$1", [attempt])

        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats()')
        expect(rows[0].attempts_n).toBe(0)
      })
    })
  })

  // ── No data is not zero ────────────────────────────────────────────────────

  describe('empty states', () => {
    it('reports no attempts as no rate, not as a zero rate', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats()')
        expect(rows[0].attempts_n).toBe(0)
        // 0% would read as "everybody failed", which is a different and much
        // more alarming statement than "nobody has sat this".
        expect(rows[0].pass_rate).toBeNull()
        expect(rows[0].avg_percent).toBeNull()
      })
    })

    it('lists a candidate who has sat nothing rather than omitting them', async () => {
      await scenario(async () => {
        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.team_stats()')
        const quiet = rows.find((r) => r.candidate_id === QUIET)
        // "Who has not done this yet" is the question this report answers.
        expect(quiet).toBeDefined()
        expect(quiet.attempts_n).toBe(0)
        expect(quiet.pass_rate).toBeNull()
      })
    })
  })

  // ── Item analysis ──────────────────────────────────────────────────────────

  describe('question_stats', () => {
    it('withholds discrimination below the sample floor', async () => {
      await scenario(async () => {
        for (let i = 0; i < 3; i++) await sit(EXAM_CAL, () => true)

        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.question_stats($1,null)', [Q1])
        expect(rows[0].attempts_n).toBe(3)
        expect(Number(rows[0].facility)).toBe(1)
        // A correlation over three responses is noise, and it renders exactly
        // like a real one.
        expect(rows[0].discrimination).toBeNull()
      })
    })

    it('computes discrimination once there is enough data', async () => {
      await scenario(async () => {
        // Twelve attempts with genuine variation: some get both right, some
        // only the first, some neither. Without variance there is nothing to
        // correlate.
        const people = [CAND, CAND2, CAND3]
        for (let i = 0; i < 12; i++) {
          await sit(EXAM_CAL, (q) => (i % 3 === 0 ? true : i % 3 === 1 ? q === 0 : false), people[i % 3])
        }

        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.question_stats($1,null)', [Q1])
        expect(rows[0].attempts_n).toBe(12)
        expect(rows[0].discrimination).not.toBeNull()
        expect(Number(rows[0].discrimination)).toBeGreaterThan(0)
      })
    })

    /**
     * The reason 0011 exists, expressed as a report.
     *
     * Rewording a question bumps its revision, and the frozen paper records
     * which wording each candidate saw. Statistics must therefore start again
     * — merging them produces a difficulty describing neither wording.
     */
    it('starts the statistics again when a question is reworded', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)

        await actAsOwner()
        await db.query(
          `update public.questions set stem = 'Analytics question one (reworded)',
                                       revision = revision + 1 where id = $1`,
          [Q1],
        )
        // A fresh paper is drawn at publish, so the next attempt records the
        // new revision only if the exam is re-published; simulate the served
        // revision directly instead.
        const attempt = await sit(EXAM_CAL, () => true)
        await actAsOwner()
        await db.query(
          `update public.attempt_questions set question_revision = question_revision + 1
            where attempt_id = $1 and question_id = $2`,
          [attempt, Q1],
        )
        await db.query(
          `update public.attempt_answers set question_revision = question_revision + 1
            where attempt_id = $1 and question_id = $2`,
          [attempt, Q1],
        )

        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.question_stats($1,null)', [Q1])
        // Two wordings, two rows, one response each — not one row of two.
        expect(rows).toHaveLength(2)
        expect(rows.every((r) => r.attempts_n === 1)).toBe(true)
      })
    })

    it('flags a question the author rated far from how it behaves', async () => {
      await scenario(async () => {
        // Q2 is rated 4 (hard). Everybody gets it right, so it behaves like a 1.
        const people2 = [CAND, CAND2, CAND3]
        for (let i = 0; i < 12; i++) await sit(EXAM_CAL, () => true, people2[i % 3])

        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.question_stats($1,null)', [Q2])
        expect(rows[0].author_difficulty).toBe(4)
        expect(rows[0].observed_difficulty).toBe(1)
        expect(rows[0].misrated).toBe(true)
      })
    })

    it('does not flag a misrating before there is evidence for it', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)
        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.question_stats($1,null)', [Q2])
        // Same apparent gap, one data point. Not a finding.
        expect(rows[0].misrated).toBe(false)
      })
    })

    it('is refused to a candidate', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        await expect(
          db.query('select * from public.question_stats(null,null)'),
        ).rejects.toThrow(/forbidden/i)
      })
    })
  })

  // ── Exams ──────────────────────────────────────────────────────────────────

  describe('exam_stats', () => {
    it('summarises attempts, candidates and pass rate', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)
        await sit(EXAM_CAL, () => false)

        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.exam_stats($1)', [EXAM_CAL])
        expect(rows[0].attempts_n).toBe(2)
        expect(rows[0].candidates_n).toBe(1)
        expect(Number(rows[0].pass_rate)).toBe(50)
        expect(Number(rows[0].avg_percent)).toBe(50)
      })
    })

    it('shows an exam nobody has sat with no rate rather than zero', async () => {
      await scenario(async () => {
        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.exam_stats($1)', [EXAM_MANUAL])
        expect(rows[0].attempts_n).toBe(0)
        expect(rows[0].pass_rate).toBeNull()
      })
    })
  })

  // ── Reach ──────────────────────────────────────────────────────────────────

  describe('scope', () => {
    it('lets a candidate see their own record', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)
        await actAs(employee(CAND))
        const { rows } = await db.query('select * from public.candidate_stats($1)', [CAND])
        expect(rows[0].attempts_n).toBe(1)
      })
    })

    it('refuses a candidate looking at somebody else', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        await expect(
          db.query('select * from public.candidate_stats($1)', [QUIET]),
        ).rejects.toThrow(/forbidden/i)
      })
    })

    it('refuses a candidate the team report', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        await expect(db.query('select * from public.team_stats()')).rejects.toThrow(/forbidden/i)
      })
    })

    it('lets a chef read a member of their outlet', async () => {
      await scenario(async () => {
        await sit(EXAM_CAL, () => true)
        await actAs(chef(CHEF))
        const { rows } = await db.query('select * from public.candidate_stats($1)', [CAND])
        expect(rows[0].attempts_n).toBe(1)
      })
    })

    it('never reaches into another company', async () => {
      await scenario(async () => {
        await actAs(hr(HR_USER))
        const { rows } = await db.query('select * from public.team_stats()')
        await actAsOwner()
        const { rows: check } = await db.query(
          `select count(*)::int n from public.profiles
            where id = any($1::uuid[]) and company_id <> $2`,
          [rows.map((r) => r.candidate_id), fixtures.company],
        )
        // A group by is far easier to get wrong than a row policy, so this is
        // asserted over the actual output rather than assumed from the WHERE.
        expect(check[0].n).toBe(0)
      })
    })
  })

  // ── Reachability ───────────────────────────────────────────────────────────

  describe('the shared definition is internal', () => {
    it('analytics_attempts is not readable by a signed-in user', async () => {
      await scenario(async () => {
        await actAs(chef(CHEF))
        await expect(
          db.query('select * from public.analytics_attempts limit 1'),
        ).rejects.toThrow(/permission denied/i)
      })
    })
  })
})
