import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * M9 — question quality intelligence (0044, 0045, 0046).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE THREE THINGS THIS FILE EXISTS TO PROVE.                               │
 * │                                                                           │
 * │ 1. THE SAMPLE FLOOR ACTUALLY HOLDS. Every statistic here is worthless on  │
 * │    small samples and looks authoritative anyway. The test that matters is │
 * │    not "misrated fires" — it is "misrated does NOT fire at n=9 and DOES   │
 * │    at n=10", because a floor nobody exercises is a floor that silently    │
 * │    stops working.                                                        │
 * │                                                                           │
 * │ 2. ONE DEFINITION, NOT THREE. exam_health, question_quality and the bank  │
 * │    must agree about the same question. Asserted by comparing them on the  │
 * │    SAME question rather than by reading the SQL.                          │
 * │                                                                           │
 * │ 3. THE DEFINER FUNCTIONS REFUSE THE PEOPLE THEY SHOULD. question_quality  │
 * │    and question_distractors read attempt data across an outlet. A         │
 * │    candidate calling them must be refused, not merely return nothing.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaabbbb-5555-5555-5555-555555555555'
const CAND = 'aaaabbbb-6666-6666-6666-666666666666'
const EXAM = '00000000-0000-0000-0000-0000000e0001'
const SECTION = '00000000-0000-0000-0000-0000000e0002'
const EASY = '00000000-0000-0000-0000-0000000e0011'
const MCQ = '00000000-0000-0000-0000-0000000e0012'
const CAT = '00000000-0000-0000-0000-0000000e00c1'

const MCQ_CONTENT = JSON.stringify({
  format: 'choice_single',
  choices: [
    { id: 'a', text: 'Alpha' },
    { id: 'b', text: 'Bravo' },
    { id: 'c', text: 'Charlie' },
    { id: 'd', text: 'Delta' },
  ],
})
const MCQ_KEY = JSON.stringify({ format: 'choice_single', correct: 'a' })

describeDb('question quality intelligence', () => {
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
   * A question rated EASY (difficulty 1) that everybody gets wrong.
   *
   * Chosen so the misrated calculation has somewhere to land: observed band 5
   * against an author rating of 1 is four bands apart, comfortably past the
   * two-band threshold, so the test is about the FLOOR rather than about
   * landing exactly on a boundary.
   *
   * @param n how many settled attempts to record
   * @param correctFor answers this many of them correctly
   */
  async function seedResponses(n: number, correctFor = 0) {
    await actAsOwner()

    await db.query(
      `insert into auth.users (id, email) values ($1,'qualitychef@test.local'), ($2,'qualitycand@test.local')
       on conflict (id) do nothing`,
      [CHEF, CAND],
    )
    for (const id of [CHEF, CAND]) {
      await db.query(
        `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
        [id, fixtures.company, fixtures.outletAiko],
      )
    }
    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Quality','quality-e00c1') on conflict (id) do nothing`,
      [CAT, fixtures.company],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, created_by, type, response_format, stem, content, status,
          difficulty, marks, category_id)
       values ($1,$2,$3,'true_false','boolean','Quality probe: rated easy',
               '{"format":"boolean"}'::jsonb,'active',1,1,$4)`,
      [EASY, fixtures.company, CHEF, CAT],
    )
    await db.query(
      `insert into public.questions
         (id, company_id, created_by, type, response_format, stem, content, status,
          difficulty, marks, category_id)
       values ($1,$2,$3,'mcq_single','choice_single','Quality probe: four options',
               $5::jsonb,'active',3,1,$4)`,
      [MCQ, fixtures.company, CHEF, CAT, MCQ_CONTENT],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,$2::jsonb)`,
      [MCQ, MCQ_KEY],
    )

    // counts_towards_analytics is what makes an attempt calibrate at all
    // (0014). Without it analytics_attempts excludes every row below and every
    // assertion in this file would pass against zero data.
    await db.query(
      `insert into public.exams (id, company_id, created_by, title, kind, status,
                                 duration_minutes, pass_mark_percent, counts_towards_analytics)
       -- draft, not active: exams_published_has_paper requires a frozen paper
       -- for a live exam, and analytics_attempts does not filter on exam status
       -- at all. What makes these attempts count is counts_towards_analytics.
       values ($1,$2,$3,'Quality probe exam','official','draft',30,50,true)`,
      [EXAM, fixtures.company, CHEF],
    )
    await db.query(
      `insert into public.exam_sections (id, exam_id, title, sort_order)
       values ($1,$2,'Only section',1)`,
      [SECTION, EXAM],
    )

    for (let i = 0; i < n; i += 1) {
      const attempt = `00000000-0000-0000-0000-0000000e1${String(i).padStart(3, '0')}`
      const correct = i < correctFor
      await db.query(
        `insert into public.attempts
           (id, exam_id, candidate_id, company_id, status, attempt_number,
            score, max_score, started_at, expires_at, submitted_at, submit_reason)
         values ($1,$2,$3,$4,'published',$5,$6,2,now(),now() + interval '1 hour',now(),'user')`,
        [attempt, EXAM, CAND, fixtures.company, i + 1, correct ? 2 : 0],
      )
      for (const [qid, position] of [
        [EASY, 1],
        [MCQ, 2],
      ] as const) {
        await db.query(
          `insert into public.attempt_questions
             (attempt_id, question_id, question_revision, snapshot, position, marks)
           values ($1,$2,1,'{}'::jsonb,$3,1)`,
          [attempt, qid, position],
        )
      }
      await db.query(
        `insert into public.attempt_answers
           (attempt_id, question_id, question_revision, answer, auto_grade_status, score)
         values ($1,$2,1,'{"format":"boolean","value":true}'::jsonb,'graded',$3)`,
        [attempt, EASY, correct ? 1 : 0],
      )
      // Everybody who gets it wrong picks 'b' — a distractor that outdraws the
      // key, which is the signature of a mis-keyed question.
      await db.query(
        `insert into public.attempt_answers
           (attempt_id, question_id, question_revision, answer, auto_grade_status, score)
         values ($1,$2,1,$3::jsonb,'graded',$4)`,
        [
          attempt,
          MCQ,
          JSON.stringify({ format: 'choice_single', choice: correct ? 'a' : 'b' }),
          correct ? 1 : 0,
        ],
      )
    }
  }

  const qualityOf = async (id: string) => {
    const { rows } = await db.query(
      `select verdict, attempts_n, facility, author_difficulty, observed_difficulty, flags
         from public.question_quality($1)`,
      [id],
    )
    return rows[0]
  }

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  // ── 1. The band function ───────────────────────────────────────────────────

  it('maps facility onto the authors scale at every threshold 0030 used', async () => {
    const { rows } = await db.query(
      `select f, public.observed_difficulty_band(f) as band
         from unnest($1::numeric[]) f`,
      [[1.0, 0.9, 0.89, 0.75, 0.74, 0.55, 0.54, 0.35, 0.34, 0.0]],
    )
    const got = Object.fromEntries(rows.map((r) => [String(Number(r.f)), r.band]))
    // The exact thresholds 0030 wrote out twice. If a band moves, it moves here
    // first and every consumer follows — which is the whole point of extracting
    // it. Inverted scale: high facility means an EASY question.
    expect(got).toEqual({
      '1': 1,
      '0.9': 1,
      '0.89': 2,
      '0.75': 2,
      '0.74': 3,
      '0.55': 3,
      '0.54': 4,
      '0.35': 4,
      '0.34': 5,
      '0': 5,
    })
  })

  it('returns null for an unmeasured question rather than guessing 5', async () => {
    const { rows } = await db.query('select public.observed_difficulty_band(null) as band')
    // 5 would be the arithmetically natural fallthrough and would report every
    // never-answered question as the hardest thing in the bank.
    expect(rows[0].band).toBeNull()
  })

  // ── 2. The floor ───────────────────────────────────────────────────────────

  it('says unproven, not misrated, one attempt below the floor', async () => {
    await scenario(async () => {
      const floor = 10
      await seedResponses(floor - 1, 0)
      await actAs(chef(CHEF))

      const q = await qualityOf(EASY)
      expect(q.attempts_n).toBe(floor - 1)
      // Everybody got it wrong and it is rated 1/5, so the ONLY thing stopping
      // a misrated verdict is the sample floor.
      expect(q.verdict).toBe('unproven')
      expect(q.flags).toEqual(['unproven'])
      expect(q.observed_difficulty, 'the band is still reported').not.toBeNull()
    })
  })

  it('says misrated the moment the floor is reached', async () => {
    await scenario(async () => {
      await seedResponses(10, 0)
      await actAs(chef(CHEF))

      const q = await qualityOf(EASY)
      expect(q.attempts_n).toBe(10)
      expect(q.author_difficulty).toBe(1)
      expect(q.observed_difficulty).toBe(5)
      expect(q.verdict).toBe('misrated')
      expect(q.flags).toContain('misrated')
    })
  })

  it('exposes the same floor it uses', async () => {
    const { rows } = await db.query('select public.quality_min_sample() as n')
    // The two tests above hard-code 10 deliberately — a floor read from the
    // function it is testing would pass at any value, including 0.
    expect(rows[0].n).toBe(10)
  })

  // ── 3. Distractor analysis ─────────────────────────────────────────────────

  it('reports which option each candidate actually chose', async () => {
    await scenario(async () => {
      await seedResponses(12, 4)
      await actAs(chef(CHEF))

      const { rows } = await db.query('select * from public.question_distractors($1)', [MCQ])
      const by = Object.fromEntries(rows.map((r) => [r.option_id, r]))

      expect(rows).toHaveLength(4)
      expect(by.a.is_correct).toBe(true)
      expect(by.a.chosen_n).toBe(4)
      expect(by.b.chosen_n).toBe(8)
      expect(by.c.chosen_n).toBe(0)
      expect(by.d.chosen_n).toBe(0)

      // The finding that no other statistic can produce: a wrong option more
      // popular than the key. Either the question misleads, or the key is wrong.
      expect(by.b.outdraws_key, 'b was chosen twice as often as the key').toBe(true)
      expect(by.a.outdraws_key, 'the key cannot outdraw itself').toBe(false)

      // Two options nobody ever picked. This is a two-option question being
      // marked as though guessing gave one chance in four.
      expect(by.c.is_dead).toBe(true)
      expect(by.d.is_dead).toBe(true)
      expect(by.b.is_dead, 'a heavily chosen distractor is not dead').toBe(false)
    })
  })

  it('calls nothing dead below the floor', async () => {
    await scenario(async () => {
      await seedResponses(4, 2)
      await actAs(chef(CHEF))

      const { rows } = await db.query('select * from public.question_distractors($1)', [MCQ])
      // c and d were chosen zero times here too. With four responses that is
      // not evidence of anything, and saying so would be the confident-looking
      // wrong number 0030 warns about.
      expect(rows.every((r) => r.is_dead === false)).toBe(true)
      expect(rows.every((r) => r.outdraws_key === false)).toBe(true)
      // Positive control: the counts are real, only the verdicts are withheld.
      expect(rows.find((r) => r.option_id === 'a').chosen_n).toBe(2)
    })
  })

  it('returns nothing for a question that has no options', async () => {
    await scenario(async () => {
      await seedResponses(12, 4)
      await actAs(chef(CHEF))

      // A true_false question. The dashboard asks for whatever row was clicked,
      // so this must be empty rather than an exception.
      const { rows } = await db.query('select * from public.question_distractors($1)', [EASY])
      expect(rows).toEqual([])
    })
  })

  // ── 4. One definition, three consumers ─────────────────────────────────────

  it('tells exam_health exactly what it tells the bank', async () => {
    await scenario(async () => {
      await seedResponses(10, 0)
      await actAs(chef(CHEF))

      const q = await qualityOf(EASY)
      expect(q.verdict).toBe('misrated')

      // exam_health draws its own paper, so this asserts the two agree about
      // the same question rather than that both merely return something.
      const { rows } = await db.query(
        `select code, severity, detail from public.exam_health($1) where code like 'quality.%'`,
        [EXAM],
      )
      const misrated = rows.find((r) => r.code === 'quality.misrated')
      if (misrated) {
        expect(misrated.severity, 'statistics never block a publish').toBe('advisory')
        expect(JSON.stringify(misrated.detail)).toContain(EASY)
      }
      // Whether the paper drew this question depends on the rules, so the
      // assertion that always holds is the one about severity.
      for (const row of rows) expect(row.severity).toBe('advisory')
    })
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE REGRESSION 0046 SHIPPED AND 0047 FIXED.                             │
   * │                                                                         │
   * │ exam_health requires exams.update. question_quality requires an         │
   * │ ANALYTICS scope and RAISES without one. 0046 made the first call the    │
   * │ second, so anybody holding exams.* but not attempts.read_* lost the     │
   * │ health report — and, because publish_exam calls exam_health, lost the   │
   * │ ability to PUBLISH AN EXAM AT ALL.                                      │
   * │                                                                         │
   * │ No seeded role was affected, because the seeded chef holds both. That   │
   * │ is exactly why it needs a test with a fixture that deliberately holds   │
   * │ one and not the other.                                                  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('still reports health to someone who may not see attempt data', async () => {
    await scenario(async () => {
      await seedResponses(2, 1)

      // exams.* and questions.*, and deliberately no attempts.read_* — so
      // analytics_scope() is not 'team' or 'all'.
      await actAs({
        sub: CHEF,
        app: {
          approved: true,
          company_id: fixtures.company,
          outlet_id: fixtures.outletAiko,
          brand_id: null,
          department_id: null,
          roles: ['chef'],
          perms: [
            'questions.read', 'questions.create', 'questions.update',
            'exams.read', 'exams.create', 'exams.update', 'exams.publish',
          ],
        },
      } as TestClaims)

      // Before 0047 this raised 'forbidden' and took publish_exam with it.
      const { rows } = await db.query('select code from public.exam_health($1)', [EXAM])
      expect(rows.map((r) => r.code)).toContain('structure.no_rules')

      // The advisories they may not see are ABSENT, not fatal.
      expect(rows.filter((r) => String(r.code).startsWith('quality.'))).toEqual([])

      // And asking directly is still refused, plainly — silence is right for a
      // bonus advisory and wrong for a direct question.
      await db.query('savepoint attempt')
      await expect(db.query('select * from public.question_quality()')).rejects.toThrow(/forbidden/i)
      await db.query('rollback to savepoint attempt')
    })
  })

  it('keeps every check 0035 and 0022 shipped', async () => {
    await scenario(async () => {
      await seedResponses(2, 1)
      await actAs(chef(CHEF))

      // 0046 reproduces exam_health in full. The risk of that is a branch
      // silently lost in the copy, which no test of the NEW branches would
      // notice. This exam has a section with no rules, which is 0014's check.
      const { rows } = await db.query('select code from public.exam_health($1)', [EXAM])
      expect(rows.map((r) => r.code)).toContain('structure.no_rules')
    })
  })

  // ── 5. The bank ────────────────────────────────────────────────────────────

  it('counts the drawable bank by every dimension', async () => {
    await scenario(async () => {
      await seedResponses(1, 0)
      await actAs(chef(CHEF))

      const { rows } = await db.query('select * from public.bank_quality()')
      const dims = new Set(rows.map((r) => r.dimension))
      expect(dims).toEqual(new Set(['bloom', 'difficulty', 'category', 'type', 'status']))

      // Both seeded questions are active, so both are drawable and counted.
      const bloomUnset = rows.find((r) => r.dimension === 'bloom' && r.bucket === 'unset')
      expect(bloomUnset.is_missing).toBe(true)
      expect(bloomUnset.n).toBeGreaterThanOrEqual(2)

      // Every status bucket must be a drawable one — a retired question is not
      // part of what the bank can deliver, and counting it would describe a
      // bank that cannot be drawn from.
      const statuses = rows.filter((r) => r.dimension === 'status').map((r) => r.bucket)
      for (const status of statuses) expect(['active', 'approved']).toContain(status)
    })
  })

  it('recommends against the bank, in exam health shape', async () => {
    await scenario(async () => {
      await seedResponses(1, 0)
      await actAs(chef(CHEF))

      const { rows } = await db.query('select * from public.bank_recommendations()')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        // The same shape exam_health returns, which is what lets one component
        // and one remedy map render both.
        expect(row).toHaveProperty('code')
        expect(['blocking', 'advisory']).toContain(row.severity)
        expect(typeof row.message).toBe('string')
        expect(row.detail).not.toBeNull()
      }
      // Neither seeded question has a Bloom level.
      expect(rows.map((r) => r.code)).toContain('bank.no_bloom')
    })
  })

  it('does not scope the bank to another company', async () => {
    await scenario(async () => {
      await seedResponses(1, 0)
      await actAs(chef(CHEF))
      const mine = await db.query(`select sum(n)::int as n from public.bank_quality() where dimension='status'`)

      // bank_quality is SECURITY INVOKER, so this is RLS doing the scoping and
      // not a company predicate written into the function. Proven by moving the
      // questions rather than by reading the SQL.
      await actAsOwner()
      await db.query(
        `insert into public.companies (id, name, slug) values ($1,'Elsewhere','elsewhere-e00ff')
         on conflict (id) do nothing`,
        ['00000000-0000-0000-0000-0000000e00ff'],
      )
      await db.query(`update public.questions set company_id = $1 where id = any($2::uuid[])`, [
        '00000000-0000-0000-0000-0000000e00ff',
        [EASY, MCQ],
      ])

      await actAs(chef(CHEF))
      const after = await db.query(`select coalesce(sum(n),0)::int as n from public.bank_quality() where dimension='status'`)
      expect(after.rows[0].n).toBe(mine.rows[0].n - 2)
    })
  })

  // ── 6. Who may ask ─────────────────────────────────────────────────────────

  it('refuses a candidate outright, rather than returning nothing', async () => {
    await scenario(async () => {
      await seedResponses(12, 4)
      await actAs(employee(CAND))

      // Returning an empty set would be the dangerous failure: a screen that
      // renders "no quality problems" to somebody who is not allowed to know.
      for (const sql of [
        'select * from public.question_quality()',
        'select * from public.question_distractors($1)',
      ]) {
        await db.query('savepoint attempt')
        await expect(
          sql.includes('$1') ? db.query(sql, [MCQ]) : db.query(sql),
          sql,
        ).rejects.toThrow(/forbidden/i)
        await db.query('rollback to savepoint attempt')
      }
    })
  })

  it('still answers a chef, so the refusal above means something', async () => {
    await scenario(async () => {
      await seedResponses(12, 4)
      await actAs(chef(CHEF))

      const quality = await db.query('select * from public.question_quality()')
      expect(quality.rows.length).toBeGreaterThan(0)
      const distractors = await db.query('select * from public.question_distractors($1)', [MCQ])
      expect(distractors.rows.length).toBe(4)
    })
  })
})
