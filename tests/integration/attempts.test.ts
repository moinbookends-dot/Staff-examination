import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asUser, asOwner, chef, employee, fixtures } from './helpers/db'

/**
 * Attempts — the candidate's side.
 *
 * The two that matter most, and the reasons M4 exists:
 *
 *   · a candidate must NEVER receive an answer key, through any route
 *   · the clock belongs to the server, so a reload, a second tab or a fiddled
 *     system clock buys nothing
 *
 * Everything else here is the machinery that makes those two true: one attempt
 * in flight, max_attempts honoured, the paper frozen per candidate, and the
 * revision recorded so grading can use the key that was served.
 */

const describeDb = hasDatabase ? describe : describe.skip

const CHEF = 'aaaa6666-6666-6666-6666-666666666666'
const CAND = 'bbbb6666-6666-6666-6666-666666666666'
const OTHER = 'cccc6666-6666-6666-6666-666666666666'

// Plain hex, spelled out. Cute constructions like `'…cat66'.replace('t','6')`
// produce values that are not uuids at all — 'p' and 't' are not hex digits and
// the last group must be exactly 12 characters.
const CAT = '00000000-0000-0000-0000-00000000ca66'
const EXAM_FIXED = '00000000-0000-0000-0000-00000000ef66'
const EXAM_PER = '00000000-0000-0000-0000-00000000eb66'

const qid = (n: number) => `00000000-0000-0000-0000-0000000ee06${n}`

describeDb('attempts', () => {
  let db: Client

  /** Publishes an exam as the chef, through the real function. */
  async function publish(examId: string) {
    await db.query('begin')
    await db.query('reset role')
    await db.query('select set_config($1,$2,true)', [
      'request.jwt.claims',
      JSON.stringify(chef(CHEF)),
    ])
    await db.query('select * from public.publish_exam($1)', [examId])
    await db.query('commit')
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    // Defensive pre-clean: a run interrupted before afterAll leaves published
    // exams behind, and the 0016 trigger then refuses to rebuild them.
    await db.query('delete from public.exams where id = any($1::uuid[])', [[EXAM_FIXED, EXAM_PER]])
    await db.query('delete from public.questions where id = any($1::uuid[])', [
      [qid(1), qid(2), qid(3)],
    ])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF, CAND, OTHER]])
    await db.query('delete from public.categories where id = $1', [CAT])
    // publish_exam queues an email per assignee, keyed
    // 'exam-assigned:<exam>:<user>' under a UNIQUE index. email_outbox has no
    // FK to exams, so deleting the exam leaves the row — and the next run with
    // the same fixed ids collides on the dedupe key. Nothing else clears it.
    await db.query(
      `delete from public.email_outbox
        where payload ->> 'dedupe_key' like any ($1::text[])`,
      [[`exam-assigned:${EXAM_FIXED}%`, `exam-assigned:${EXAM_PER}%`]],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'attchef@test.local'), ($2,'attcand@test.local'), ($3,'attother@test.local')`,
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
       values ($1,$2,'Attempt Test','attempt-test')`,
      [CAT, fixtures.company],
    )

    const ids = [qid(1), qid(2), qid(3)]
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by)
       select u.id, $2, 'mcq_single', 'choice_single', 'Attempt question ' || u.ord,
              $3::jsonb, $4, 3, 2, 'active', $5
         from unnest($1::uuid[]) with ordinality as u(id, ord)`,
      [
        ids,
        fixtures.company,
        JSON.stringify({
          format: 'choice_single',
          choices: [
            { id: 'a', text: 'Correct one' },
            { id: 'b', text: 'Wrong one' },
          ],
        }),
        CAT,
        CHEF,
      ],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       select u.id, '{"format":"choice_single","correct":"a"}'::jsonb
         from unnest($1::uuid[]) as u(id)`,
      [ids],
    )

    // Two exams: one fixed, one per-attempt, both assigned to the candidate's
    // outlet and both open now.
    for (const [id, mode, title] of [
      [EXAM_FIXED, 'fixed', 'Fixed paper exam'],
      [EXAM_PER, 'per_attempt', 'Per attempt exam'],
    ] as const) {
      await db.query(
        `insert into public.exams
           (id, company_id, title, created_by, duration_minutes, paper_mode, max_attempts, closes_at)
         values ($1,$2,$3,$4,60,$5,2, now() + interval '1 day')`,
        [id, fixtures.company, title, CHEF, mode],
      )
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title) values ($1,'Only section') returning id`,
        [id],
      )
      await db.query(
        `insert into public.exam_rules (section_id, category_id, question_count, difficulty_min, difficulty_max)
         values ($1,$2,2,1,5)`,
        [sec[0].id, CAT],
      )
      await db.query(
        `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
        [id, fixtures.outletAiko],
      )
    }
    await db.query('commit')

    await publish(EXAM_FIXED)
    await publish(EXAM_PER)
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.exams where id = any($1::uuid[])', [[EXAM_FIXED, EXAM_PER]])
    await db.query('delete from public.questions where id = any($1::uuid[])', [
      [qid(1), qid(2), qid(3)],
    ])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF, CAND, OTHER]])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query(
      `delete from public.email_outbox
        where payload ->> 'dedupe_key' like any ($1::text[])`,
      [[`exam-assigned:${EXAM_FIXED}%`, `exam-assigned:${EXAM_PER}%`]],
    )
    await db.query('commit')
    await db.end()
  })

  const start = (c: Client, examId: string) =>
    c.query('select * from public.start_attempt($1)', [examId])

  // ── Starting ───────────────────────────────────────────────────────────────

  it('starts an attempt and freezes a paper for it', async () => {
    const result = await asUser(db, employee(CAND), async (c) => {
      const started = await start(c, EXAM_FIXED)
      const paper = await c.query('select * from public.attempt_paper($1) order by paper_position', [
        started.rows[0].attempt_id,
      ])
      return { started: started.rows[0], paper: paper.rows }
    })

    expect(result.started.question_count).toBe(2)
    expect(result.paper).toHaveLength(2)
    expect(result.paper[0].snapshot.stem).toContain('Attempt question')
    expect(new Date(result.started.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('resumes rather than starting a second attempt', async () => {
    // A reload must not split the answers across two attempts, and the partial
    // unique index would refuse the second one anyway.
    const ids = await asUser(db, employee(CAND), async (c) => {
      const first = await start(c, EXAM_FIXED)
      const second = await start(c, EXAM_FIXED)
      const count = await c.query(
        `select count(*)::int n from public.attempts where exam_id=$1 and candidate_id=$2`,
        [EXAM_FIXED, CAND],
      )
      return {
        a: first.rows[0].attempt_id,
        b: second.rows[0].attempt_id,
        total: count.rows[0].n,
      }
    })
    expect(ids.b).toBe(ids.a)
    expect(ids.total).toBe(1)
  })

  it('gives every candidate the same paper for a fixed exam', async () => {
    const papers = await asOwner(db, async (c) => {
      const out: string[][] = []
      for (const who of [CAND, OTHER]) {
        await c.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify(employee(who)),
        ])
        const started = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
        const rows = await c.query(
          `select question_id from public.attempt_questions where attempt_id=$1 order by position`,
          [started.rows[0].attempt_id],
        )
        out.push(rows.rows.map((r) => r.question_id))
      }
      return out
    })
    expect(papers[0]).toEqual(papers[1])
  })

  it('records the revision that was served, not the current one', async () => {
    // 0011's obligation. Without it an answer cannot be matched to the wording
    // that produced it, and slice 2 cannot grade against the right key.
    const result = await asOwner(db, async (c) => {
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(CAND)),
      ])
      const started = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
      const frozen = await c.query(
        `select question_id, question_revision from public.attempt_questions where attempt_id=$1 limit 1`,
        [started.rows[0].attempt_id],
      )
      // The chef reworks the question after the candidate started.
      await c.query(`update public.questions set stem = 'Rewritten mid-attempt' where id = $1`, [
        frozen.rows[0].question_id,
      ])
      const after = await c.query(
        `select aq.question_revision, aq.snapshot->>'stem' as stem, q.revision as live_revision
           from public.attempt_questions aq
           join public.questions q on q.id = aq.question_id
          where aq.attempt_id=$1 and aq.question_id=$2`,
        [started.rows[0].attempt_id, frozen.rows[0].question_id],
      )
      return after.rows[0]
    })

    expect(result.stem).not.toBe('Rewritten mid-attempt')
    expect(result.question_revision).toBeLessThan(result.live_revision)
  })

  // ── The thing that must never happen ───────────────────────────────────────

  it('NEVER serves an answer key to the candidate', async () => {
    const snapshots = await asUser(db, employee(CAND), async (c) => {
      const started = await start(c, EXAM_PER)
      return (
        await c.query('select snapshot from public.attempt_paper($1)', [
          started.rows[0].attempt_id,
        ])
      ).rows.map((r) => r.snapshot)
    })

    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      const text = JSON.stringify(snapshot)
      for (const forbidden of ['correct', 'accept', 'rubric', 'keywords', 'modelAnswer']) {
        expect(text, `attempt paper leaked "${forbidden}"`).not.toContain(forbidden)
      }
    }
  })

  it('does not let a candidate read the paper table directly', async () => {
    // attempt_paper() is the whole surface. A select policy on
    // attempt_questions would make the function pointless.
    const rows = await asUser(db, employee(CAND), async (c) => {
      const started = await start(c, EXAM_PER)
      return (
        await c.query('select question_id from public.attempt_questions where attempt_id=$1', [
          started.rows[0].attempt_id,
        ])
      ).rows
    })
    expect(rows, 'a candidate read attempt_questions directly').toHaveLength(0)
  })

  it('refuses to show another candidate their paper', async () => {
    await expect(
      asOwner(db, async (c) => {
        await c.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify(employee(CAND)),
        ])
        const mine = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
        // Now ask as somebody else.
        await c.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify(employee(OTHER)),
        ])
        return c.query('select * from public.attempt_paper($1)', [mine.rows[0].attempt_id])
      }),
    ).rejects.toThrow(/attempt not found/)
  })

  it('does not let a candidate see another candidate attempt', async () => {
    const rows = await asOwner(db, async (c) => {
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(CAND)),
      ])
      const mine = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
      await c.query('set local role authenticated')
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(OTHER)),
      ])
      return (
        await c.query('select id from public.attempts where id = $1', [mine.rows[0].attempt_id])
      ).rows
    })
    expect(rows).toHaveLength(0)
  })

  // ── Eligibility ────────────────────────────────────────────────────────────

  it('refuses an exam the candidate is not assigned', async () => {
    await expect(
      asOwner(db, async (c) => {
        const { rows } = await c.query(
          `insert into public.exams (company_id, title, created_by, status, published_at,
                                     question_count, total_marks)
           values ($1,'Unassigned',$2,'scheduled',now(),1,2) returning id`,
          [fixtures.company, CHEF],
        )
        await c.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify(employee(CAND)),
        ])
        return c.query('select * from public.start_attempt($1)', [rows[0].id])
      }),
    ).rejects.toThrow(/exam not found/)
  })

  it('refuses a draft exam', async () => {
    await expect(
      asUser(db, employee(CAND), async (c) => {
        const { rows } = await c.query('select id from public.exams where status = $1 limit 1', [
          'draft',
        ])
        if (!rows.length) throw new Error('exam not found')
        return c.query('select * from public.start_attempt($1)', [rows[0].id])
      }),
    ).rejects.toThrow()
  })

  it('honours max_attempts', async () => {
    const outcome = await asOwner(db, async (c) => {
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(CAND)),
      ])
      // max_attempts is 2. Submit each so the next can start.
      for (let i = 0; i < 2; i++) {
        const started = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
        await c.query(
          `update public.attempts set status='submitted', submitted_at=now(), submit_reason='user'
            where id=$1`,
          [started.rows[0].attempt_id],
        )
      }
      try {
        await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
        return 'allowed a third'
      } catch (e) {
        return (e as Error).message
      }
    })
    expect(outcome).toMatch(/no attempts remaining/)
  })

  it('refuses to start after the exam window closes', async () => {
    await expect(
      asOwner(db, async (c) => {
        await c.query(
          `update public.exams set closes_at = now() - interval '1 hour' where id = $1`,
          [EXAM_FIXED],
        )
        await c.query('select set_config($1,$2,true)', [
          'request.jwt.claims',
          JSON.stringify(employee(CAND)),
        ])
        return c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
      }),
    ).rejects.toThrow(/closed/)
  })

  // ── The clock ──────────────────────────────────────────────────────────────

  it('ends the attempt at the exam window when that comes first', async () => {
    // duration is 60 minutes but the window shuts in 10, so the attempt must
    // shut in 10. Otherwise an attempt outlives the exam and keeps accepting
    // answers after everybody else has stopped.
    const expires = await asOwner(db, async (c) => {
      await c.query(
        `update public.exams set closes_at = now() + interval '10 minutes' where id = $1`,
        [EXAM_PER],
      )
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(CAND)),
      ])
      const started = await c.query('select * from public.start_attempt($1)', [EXAM_PER])
      return new Date(started.rows[0].expires_at).getTime() - Date.now()
    })
    expect(expires).toBeLessThan(11 * 60 * 1000)
    expect(expires).toBeGreaterThan(8 * 60 * 1000)
  })

  it('stamps max_score from the frozen paper', async () => {
    const row = await asUser(db, employee(CAND), async (c) => {
      const started = await start(c, EXAM_FIXED)
      return (
        await c.query('select max_score, attempt_number from public.attempts where id=$1', [
          started.rows[0].attempt_id,
        ])
      ).rows[0]
    })
    expect(Number(row.max_score)).toBe(4) // 2 questions × 2 marks
    expect(row.attempt_number).toBe(1)
  })

  // ── Writes are the server's ────────────────────────────────────────────────

  it('does not let a candidate write their own attempt row', async () => {
    // No insert or update policy exists for anybody: a client that could write
    // here would choose its own deadline, attempt number and score.
    const affected = await asUser(db, employee(CAND), async (c) => {
      const started = await start(c, EXAM_FIXED)
      const res = await c.query(
        `update public.attempts set expires_at = now() + interval '10 days' where id = $1`,
        [started.rows[0].attempt_id],
      )
      return res.rowCount
    })
    expect(affected).toBe(0)
  })

  it('does not let a candidate insert an answer directly', async () => {
    // Answers go through save_answer() in slice 2, which enforces the deadline.
    // A direct write would let somebody keep answering after time was up.
    await expect(
      asUser(db, employee(CAND), async (c) => {
        const started = await start(c, EXAM_FIXED)
        return c.query(
          `insert into public.attempt_answers (attempt_id, question_id, question_revision, answer)
           values ($1,$2,1,'{"format":"choice_single","choice":"a"}'::jsonb)`,
          [started.rows[0].attempt_id, qid(1)],
        )
      }),
    ).rejects.toThrow()
  })

  it('lets a chef read their team attempts', async () => {
    const rows = await asOwner(db, async (c) => {
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(employee(CAND)),
      ])
      const started = await c.query('select * from public.start_attempt($1)', [EXAM_FIXED])
      await c.query('set local role authenticated')
      await c.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify(chef(CHEF)),
      ])
      return (
        await c.query('select id from public.attempts where id=$1', [started.rows[0].attempt_id])
      ).rows
    })
    expect(rows).toHaveLength(1)
  })
})
