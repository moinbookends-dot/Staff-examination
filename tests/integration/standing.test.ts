import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, employee, chef, fixtures, type TestClaims } from './helpers/db'

/**
 * my_standing() — 0036.
 *
 * A candidate holds reports.read_own and nothing else, so "how am I doing
 * compared to everyone" has no answer they are allowed to compute: team_stats()
 * raises for scope 'own', and it would hand them full_name if it did not.
 * my_standing() answers the question without naming anybody.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE POINT OF THIS FILE IS THE SUPPRESSION, NOT THE RANK.                  │
 * │                                                                           │
 * │ A rank is trivially easy to compute and trivially easy to test. What is   │
 * │ hard is proving it is WITHHELD when withholding it is what matters — a    │
 * │ rank of 3 of 4 is correct, and its correctness is the harm: it is the     │
 * │ exact statement that two named colleagues scored above the reader.        │
 * │                                                                           │
 * │ So the floor is asserted from BOTH sides, on the same data, one person    │
 * │ apart. Nine participants must yield nulls; ten must yield a number. A     │
 * │ one-sided test would pass against a function that suppressed everything,  │
 * │ or against one that suppressed nothing, depending which side you wrote.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaadddd-dddd-dddd-dddd-dddddddddddd'
const ME = 'bbbbdddd-dddd-dddd-dddd-dddddddddddd'
const PEERS = Array.from(
  { length: 11 },
  (_, i) => `ccccdddd-dddd-dddd-dddd-dddddddd${String(70 + i).padStart(4, '0')}`,
)

const EXAM = '00000000-0000-0000-0000-0000000add01'
const EXAM_PRACTICE = '00000000-0000-0000-0000-0000000add02'

describeDb('my_standing', () => {
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
   * The cohort is the whole company, and this database is not empty — it
   * carries the demo and render-check data, which already contributes
   * candidates with published attempts.
   *
   * So the fixture seeds a number of peers RELATIVE to what is already there,
   * to reach an exact total. Asserting an absolute `cohort_n` was the first
   * version and it failed correctly: it expected 10 and got 11, because one
   * real candidate was already in the cohort. Hard-coding 11 would have made
   * the test pass and made it a hostage to whatever the demo seed does next.
   */
  async function baselineCohort(): Promise<number> {
    const { rows } = await db.query(
      `select count(distinct aa.candidate_id)::int as n
         from public.analytics_attempts aa
         join public.attempts a on a.id = aa.attempt_id and a.status = 'published'
        where aa.company_id = $1 and aa.percent is not null`,
      [fixtures.company],
    )
    return rows[0].n
  }

  async function standingWith(
    targetCohort: number,
    opts: { myPercent?: number; published?: boolean; practice?: boolean } = {},
  ) {
    const { myPercent = 50, published = true, practice = false } = opts
    const examId = practice ? EXAM_PRACTICE : EXAM

    await actAsOwner()

    // ME counts as one of the target, and only when their attempt is published
    // and on a calibrating exam — the two negative cases seed peers only.
    const baseline = await baselineCohort()
    const mine = published && !practice ? 1 : 0
    const peerCount = Math.max(0, targetCohort - baseline - mine)
    expect(peerCount, 'the existing cohort already exceeds the target').toBeGreaterThanOrEqual(0)

    // No questions, no paper, no sections. analytics_attempts joins exams and
    // profiles only, so a rank needs an exam, some people and some attempts —
    // nothing else. Left `draft` on purpose: `active` trips
    // exams_published_has_paper, and the view does not read exam status.
    const people = [ME, ...PEERS.slice(0, peerCount)]
    const everyone = [CHEF, ...people]

    // auth.users, not profiles directly — handle_new_user() owns profile
    // creation, and profiles.email is NOT NULL with no default. Inserting the
    // profile by hand means reimplementing that trigger in a test, which is how
    // a fixture ends up more capable, or less, than the real signup path.
    await db.query(
      `insert into auth.users (id, email)
       select u.id, 'standing-' || u.ord || '@test.local'
         from unnest($1::uuid[]) with ordinality as u(id, ord)`,
      [everyone],
    )
    await db.query(
      `update public.profiles
          set approval_status = 'approved', company_id = $2, outlet_id = $3
        where id = any($1::uuid[])`,
      [everyone, fixtures.company, fixtures.outletAiko],
    )

    await db.query(
      `insert into public.exams (id, company_id, title, kind, status, duration_minutes,
                                 pass_mark_percent, counts_towards_analytics, created_by)
       values ($1, $2, 'Standing exam', 'official', 'draft', 30, 50, $3, $4)
       on conflict (id) do update set counts_towards_analytics = excluded.counts_towards_analytics`,
      [examId, fixtures.company, !practice, CHEF],
    )

    for (const [i, person] of people.entries()) {
      const percent = person === ME ? myPercent : 10 + i * 5
      await db.query(
        `insert into public.attempts
           (company_id, exam_id, candidate_id, attempt_number, status, started_at, submitted_at,
            expires_at, score, max_score, passed, submit_reason)
         -- $5 is cast on every use. Referenced once as a score and once in a
         -- comparison, Postgres cannot deduce one type for it and fails with
         -- "inconsistent types deduced for parameter $5".
         values ($1, $2, $3, 1, $4, now() - interval '2 hours', now() - interval '1 hour',
                 now() + interval '1 hour', $5::numeric, 100, $5::numeric >= 50, 'user')`,
        [fixtures.company, examId, person, published ? 'published' : 'evaluated', percent],
      )
    }

    await actAs(employee(ME))
    const { rows } = await db.query('select * from public.my_standing()')
    return rows[0]
  }

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  it('refuses a caller who does not hold reports.read_own', async () => {
    await scenario(async () => {
      await actAs({
        sub: ME,
        app: {
          approved: true,
          company_id: fixtures.company,
          outlet_id: fixtures.outletAiko,
          brand_id: null,
          roles: [],
          perms: ['attempts.take'],
        },
      })
      await expect(db.query('select * from public.my_standing()')).rejects.toThrow(/forbidden/)
    })
  })

  // The pair. Nine and ten, same data, one person apart — so neither direction
  // can pass against a function that always suppresses or never does.
  it('withholds rank, percentile AND cohort size below ten participants', async () => {
    await scenario(async () => {
      const row = await standingWith(9) // one under the floor
      expect(row.suppressed).toBe(true)
      expect(row.rank_position).toBeNull()
      expect(row.percentile).toBeNull()
      // The population itself, not only the position in it: a bare count polled
      // over time is a publication tracker.
      expect(row.cohort_n).toBeNull()
      // Their own score is still theirs to see.
      expect(Number(row.best_percent)).toBe(50)
    })
  })

  it('reports a rank once there are ten participants', async () => {
    await scenario(async () => {
      const row = await standingWith(10) // exactly the floor
      expect(row.suppressed).toBe(false)
      expect(row.cohort_n).toBe(10)
      expect(row.rank_position).toBeGreaterThanOrEqual(1)
      expect(row.rank_position).toBeLessThanOrEqual(row.cohort_n)
      expect(row.percentile).toBeGreaterThanOrEqual(0)
      expect(row.percentile).toBeLessThanOrEqual(100)
    })
  })

  it('ranks the top scorer first', async () => {
    await scenario(async () => {
      // Peers run 15, 20, 25 … well under 100.
      const row = await standingWith(10, { myPercent: 100 })
      expect(row.rank_position).toBe(1)
      expect(row.percentile).toBe(100)
    })
  })

  /**
   * The bug this catches was in the first draft of the function: without an
   * explicit null check, `count(*) where best_percent > NULL` is 0, so rank
   * came out as 1. The system would have told somebody who had sat nothing
   * that they were top of the company.
   */
  it('gives somebody with nothing published no rank, rather than first place', async () => {
    await scenario(async () => {
      await actAsOwner()
      await db.query(`insert into auth.users (id, email) values ($1, 'standing-none@test.local')`, [
        ME,
      ])
      await db.query(
        `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3
          where id = $1`,
        [ME, fixtures.company, fixtures.outletAiko],
      )
      await actAs(employee(ME))
      const { rows } = await db.query('select * from public.my_standing()')
      expect(rows[0].best_percent).toBeNull()
      expect(rows[0].rank_position).toBeNull()
      expect(rows[0].suppressed).toBe(false)
    })
  })

  /**
   * The release gate. This is where my_standing() deliberately diverges from
   * analytics_attempts, which admits evaluated and verified rows so a chef's
   * report reflects marking that has happened. A candidate must not learn their
   * own mark before publication — and a rank that appeared the moment their
   * paper was marked would disclose it by inference.
   */
  it('counts only published attempts, so a held mark cannot be inferred', async () => {
    await scenario(async () => {
      const row = await standingWith(10, { published: false })
      expect(row.best_percent).toBeNull()
      expect(row.rank_position).toBeNull()
    })
  })

  it('ignores a practice paper, which must never rank', async () => {
    await scenario(async () => {
      const row = await standingWith(10, { practice: true })
      expect(row.best_percent).toBeNull()
    })
  })

  it('never reaches into another company', async () => {
    await scenario(async () => {
      await standingWith(10)
      // Same person, same data, a claim pointing at a different tenant.
      await actAs({
        ...employee(ME),
        app: { ...employee(ME).app, company_id: '00000000-0000-0000-0000-0000000000ff' },
      })
      const { rows } = await db.query('select * from public.my_standing()')
      expect(rows[0].best_percent).toBeNull()
      expect(rows[0].cohort_n).toBeNull()
    })
  })

  /**
   * The negative that makes the whole feature safe: a candidate still cannot
   * reach the function that would name their colleagues. If this ever passes,
   * my_standing() has become decoration on top of a leak.
   */
  it('does not give a candidate the team report as a side effect', async () => {
    await scenario(async () => {
      await actAs(employee(ME))
      await expect(db.query('select * from public.team_stats()')).rejects.toThrow(/forbidden/)
    })
  })

  it('still serves the team report to a chef', async () => {
    // Positive control. Without it the assertion above would pass against a
    // team_stats() that was simply broken for everybody.
    await scenario(async () => {
      await actAs(chef(CHEF))
      const { rows } = await db.query('select * from public.team_stats()')
      expect(Array.isArray(rows)).toBe(true)
    })
  })
})
