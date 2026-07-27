import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asUser, asOwner, chef, employee, fixtures } from './helpers/db'

/**
 * draw_paper() and exam_health() — the heart of M3.
 *
 * These are the tests that stop the two paper modes diverging and stop a chef
 * publishing a paper that cannot be sat. The one that matters most is the
 * overlapping-pool case: two rules matching the same questions make the second
 * fall short in a way that counting each rule independently cannot see, which
 * is the entire reason exam_health runs the real draw rather than a count.
 */

const describeDb = hasDatabase ? describe : describe.skip

const CHEF = 'aaaa9999-9999-9999-9999-999999999999'
const CAT_A = '00000000-0000-0000-0000-0000000d0a01'
const CAT_B = '00000000-0000-0000-0000-0000000d0b01'
/** An approved employee, used only for the permission-denial cases. */
const EMP_FOR_DENIAL = 'bbbb9999-9999-9999-9999-999999999999'

/** Deterministic ids so assertions can name individual questions. */
const q = (n: number) => `00000000-0000-0000-0000-0000000q${String(n).padStart(4, '0')}`.replace('q', 'e')

describeDb('exam draw and health', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'examchef@test.local'), ($2,'examemp@test.local')
       on conflict (id) do nothing`,
      [CHEF, EMP_FOR_DENIAL],
    )
    await db.query(
      `update public.profiles set approval_status='approved', outlet_id=$2, company_id=$3
        where id = any($1::uuid[])`,
      [[CHEF, EMP_FOR_DENIAL], fixtures.outletAiko, fixtures.company],
    )

    await db.query(
      `insert into public.categories (id, company_id, name, slug) values
         ($1,$3,'Draw Test A','draw-test-a'), ($2,$3,'Draw Test B','draw-test-b')
       on conflict (id) do nothing`,
      [CAT_A, CAT_B, fixtures.company],
    )

    // 10 questions: 5 in category A, 5 in B, difficulties spread 1..5 so the
    // widening behaviour has somewhere to widen to.
    //
    // Inserted as TWO statements rather than twenty. The database is in another
    // region, so a loop of single-row inserts spends most of its time on round
    // trips — enough to push this hook past its timeout when the unit project
    // is running alongside. unnest() keeps it to one round trip per table.
    const ids = Array.from({ length: 10 }, (_, i) => q(i + 1))
    const content = JSON.stringify({
      format: 'choice_single',
      choices: [
        { id: 'a', text: 'Yes' },
        { id: 'b', text: 'No' },
      ],
    })

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by, estimated_seconds)
       select u.id, $2, 'mcq_single', 'choice_single',
              'Draw test question ' || u.ord, $3::jsonb,
              case when u.ord <= 5 then $4::uuid else $5::uuid end,
              ((u.ord - 1) % 5) + 1, 2, 'active', $6, 60
         from unnest($1::uuid[]) with ordinality as u(id, ord)
       on conflict (id) do nothing`,
      [ids, fixtures.company, content, CAT_A, CAT_B, CHEF],
    )

    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       select u.id, '{"format":"choice_single","correct":"a"}'::jsonb
         from unnest($1::uuid[]) as u(id)
       on conflict (question_id) do nothing`,
      [ids],
    )

    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.questions where id = any($1::uuid[])', [
      Array.from({ length: 10 }, (_, i) => q(i + 1)),
    ])
    await db.query('delete from public.categories where id = any($1::uuid[])', [[CAT_A, CAT_B]])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF, EMP_FOR_DENIAL]])
    await db.query('commit')
    await db.end()
  })

  /** Builds an exam with the given rules and returns its id. All rolled back. */
  async function buildExam(
    c: Client,
    rules: {
      category?: string | null
      count: number
      min?: number
      max?: number
      section?: number
    }[],
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const { rows } = await c.query(
      `insert into public.exams (company_id, title, created_by, duration_minutes, paper_mode)
       values ($1,'Draw test exam',$2,$3,$4) returning id`,
      [fixtures.company, CHEF, overrides.duration ?? 30, overrides.paperMode ?? 'fixed'],
    )
    const examId = rows[0].id as string

    const sections = new Map<number, string>()
    for (const rule of rules) {
      const sectionIndex = rule.section ?? 0
      if (!sections.has(sectionIndex)) {
        const { rows: s } = await c.query(
          `insert into public.exam_sections (exam_id, title, sort_order)
           values ($1,$2,$3) returning id`,
          [examId, `Section ${sectionIndex + 1}`, sectionIndex],
        )
        sections.set(sectionIndex, s[0].id)
      }
      await c.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, sort_order)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          sections.get(sectionIndex),
          rule.category ?? null,
          rule.count,
          rule.min ?? 1,
          rule.max ?? 5,
          rules.indexOf(rule),
        ],
      )
    }
    return examId
  }

  const draw = (c: Client, examId: string, seed?: string) =>
    c.query('select * from public.draw_paper($1, $2) order by position', [examId, seed ?? examId])

  const health = (c: Client, examId: string) =>
    c.query('select * from public.exam_health($1)', [examId])

  // ── The draw ───────────────────────────────────────────────────────────────
  //
  // THESE RUN AS OWNER, NOT AS A CHEF, AND THAT IS THE POINT. draw_paper() is an
  // internal helper granted to nobody (migration 0020) — before that fix it was
  // callable by anon over PostgREST, which handed out whole papers. A chef
  // cannot call it directly and should not be able to; only another SECURITY
  // DEFINER function reaches it. Tests that go through the real surface
  // (exam_health, exam_paper, publish_exam, exam_rule_counts) still run as a
  // chef, because those are the granted, permission-checked entry points.

  it('draws exactly what a satisfiable rule asks for', async () => {
    const rows = await asOwner(db, async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 3 }])
      return (await draw(c, examId)).rows
    })

    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.fallback_reason === null)).toBe(true)
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3])
  })

  it('never draws the same question twice across sections', async () => {
    // Both rules point at the same five-question pool and want four each. The
    // exclusion list spans the whole paper, so the second can only get one.
    const rows = await asOwner(db, async (c) => {
      const examId = await buildExam(c, [
        { category: CAT_A, count: 4, section: 0 },
        { category: CAT_A, count: 4, section: 1 },
      ])
      return (await draw(c, examId)).rows
    })

    const ids = rows.map((r) => r.question_id)
    expect(new Set(ids).size, 'a question was drawn twice').toBe(ids.length)
    expect(rows).toHaveLength(5) // the pool, not the 8 requested
  })

  it('reports the shortfall that overlapping rules cause', async () => {
    // THE CASE INDEPENDENT COUNTING MISSES. Each rule alone is satisfiable —
    // the pool holds five and each wants four. Only the real draw reveals that
    // the second rule can be given one.
    const issues = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [
        { category: CAT_A, count: 4, section: 0 },
        { category: CAT_A, count: 4, section: 1 },
      ])
      return (await health(c, examId)).rows
    })

    const short = issues.filter((i) => i.code === 'rule.short')
    expect(short).toHaveLength(1)
    expect(short[0].severity).toBe('blocking')
    expect(short[0].detail).toMatchObject({ requested: 4, drawn: 1, missing: 3 })
  })

  it('prefers adjacent difficulty and says so when it widens', async () => {
    // Category A holds one question per difficulty. Asking for three at
    // difficulty 3 can only be met by reaching to 2 and 4.
    const rows = await asOwner(db, async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 3, min: 3, max: 3 }])
      const drawn = await draw(c, examId)
      const withDifficulty = await c.query(
        `select d.fallback_reason, q.difficulty
           from public.draw_paper($1, $2) d
           join public.questions q on q.id = d.question_id
          order by d.position`,
        [examId, examId],
      )
      return { drawn: drawn.rows, detail: withDifficulty.rows }
    })

    expect(rows.drawn).toHaveLength(3)
    // Exact match first, then the two nearest.
    expect(rows.detail[0]).toMatchObject({ difficulty: 3, fallback_reason: null })
    expect(rows.detail.slice(1).map((r) => r.difficulty).sort()).toEqual([2, 4])
    expect(rows.detail.slice(1).every((r) => r.fallback_reason === 'difficulty_widened')).toBe(true)
  })

  it('never widens across a section boundary', async () => {
    // Section 1 wants more of category A than exists. It must come up short
    // rather than borrowing from category B, which belongs to section 2.
    const rows = await asOwner(db, async (c) => {
      const examId = await buildExam(c, [
        { category: CAT_A, count: 8, section: 0 },
        { category: CAT_B, count: 2, section: 1 },
      ])
      return (
        await c.query(
          `select d.section_id, q.category_id
             from public.draw_paper($1, $2) d
             join public.questions q on q.id = d.question_id`,
          [examId, examId],
        )
      ).rows
    })

    const sections = [...new Set(rows.map((r) => r.section_id))]
    for (const section of sections) {
      const categories = new Set(rows.filter((r) => r.section_id === section).map((r) => r.category_id))
      expect(categories.size, 'a section drew from more than one category').toBe(1)
    }
  })

  it('is reproducible for a seed, and different for another', async () => {
    // Reproducibility is what makes a fixed paper explainable months later, and
    // what lets M4 give each attempt its own paper by passing the attempt id.
    const { a, b, c: other } = await asOwner(db, async (client) => {
      const examId = await buildExam(client, [{ count: 6 }])
      return {
        a: (await draw(client, examId, 'seed-one')).rows.map((r) => r.question_id),
        b: (await draw(client, examId, 'seed-one')).rows.map((r) => r.question_id),
        c: (await draw(client, examId, 'seed-two')).rows.map((r) => r.question_id),
      }
    })

    // Same seed, same paper — this is what makes a fixed paper explainable
    // months later, and what lets a test assert on a draw at all.
    expect(a).toEqual(b)
    // A different seed selects a different SUBSET, not merely a different
    // order: 6 questions out of a pool of 10. That is exactly what gives each
    // per-attempt candidate their own paper once M4 passes the attempt id.
    expect(a).not.toEqual(other)
    expect(new Set([...a, ...other]).size).toBeGreaterThan(a.length)
    expect(other).toHaveLength(6)
  })

  // ── Live counts for the builder ────────────────────────────────────────────

  describe('rule counts', () => {
    it('reports available and drawn separately', async () => {
      // THE WHOLE POINT OF TWO NUMBERS. Both rules match the same 5-question
      // pool and want 4. Each is satisfiable alone — "available: 5" — but the
      // second only gets 1 once the first has taken four. A single number would
      // tell the chef both rules are fine and let publish refuse them later.
      const counts = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [
          { category: CAT_A, count: 4, section: 0 },
          { category: CAT_A, count: 4, section: 1 },
        ])
        const rules = await c.query(
          `select r.id from public.exam_rules r
             join public.exam_sections s on s.id = r.section_id
            where s.exam_id = $1 order by s.sort_order`,
          [examId],
        )
        const result = await c.query('select * from public.exam_rule_counts($1)', [examId])
        return rules.rows.map((r) => result.rows.find((x) => x.rule_id === r.id))
      })

      expect(counts[0]).toMatchObject({ available: 5, drawn: 4 })
      expect(counts[1]).toMatchObject({ available: 5, drawn: 1 })
    })

    it('agrees with the draw for a rule nothing competes with', async () => {
      const counts = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 3 }])
        return (await c.query('select * from public.exam_rule_counts($1)', [examId])).rows
      })
      expect(counts).toHaveLength(1)
      expect(counts[0]).toMatchObject({ available: 5, drawn: 3 })
    })

    it('counts a rule the chef has not saved yet', async () => {
      // preview_rule_count takes parameters rather than a rule id so the
      // builder can answer "how many would this match?" while somebody is still
      // adjusting the difficulty range.
      const n = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 1 }])
        return (
          await c.query(
            `select public.preview_rule_count($1, $2, true, '{}'::uuid[], null, 1::smallint, 5::smallint) as n`,
            [examId, CAT_B],
          )
        ).rows[0].n
      })
      // Category B holds five, and the unsaved rule competes with nothing.
      expect(n).toBe(5)
    })

    it('narrows the preview as the difficulty band narrows', async () => {
      const counts = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 1 }])
        const wide = await c.query(
          `select public.preview_rule_count($1, $2, true, '{}'::uuid[], null, 1::smallint, 5::smallint) as n`,
          [examId, CAT_A],
        )
        const narrow = await c.query(
          `select public.preview_rule_count($1, $2, true, '{}'::uuid[], null, 3::smallint, 3::smallint) as n`,
          [examId, CAT_A],
        )
        return { wide: wide.rows[0].n, narrow: narrow.rows[0].n }
      })
      expect(counts.wide).toBe(5)
      expect(counts.narrow).toBe(1)
    })

    it('refuses a caller without exams.read', async () => {
      // Not nested inside the chef's transaction: asUser opens its own, and an
      // exam created in a rolled-back one would be invisible here regardless.
      // Any id is enough — the permission gate runs before the lookup.
      await expect(
        asUser(db, employee(EMP_FOR_DENIAL), async (c) =>
          c.query('select * from public.exam_rule_counts($1)', [
            '00000000-0000-0000-0000-0000000000ff',
          ]),
        ),
      ).rejects.toThrow(/forbidden/)
    })
  })

  // ── Health ─────────────────────────────────────────────────────────────────

  it('passes a well-formed exam with no blocking issues', async () => {
    const issues = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
      return (await health(c, examId)).rows
    })
    expect(issues.filter((i) => i.severity === 'blocking')).toEqual([])
  })

  it('blocks an exam with no sections', async () => {
    const issues = await asUser(db, chef(CHEF), async (c) => {
      const { rows } = await c.query(
        `insert into public.exams (company_id, title, created_by) values ($1,'Empty',$2) returning id`,
        [fixtures.company, CHEF],
      )
      return (await health(c, rows[0].id)).rows
    })
    expect(issues.some((i) => i.code === 'structure.no_sections' && i.severity === 'blocking')).toBe(true)
  })

  it('blocks a section with no rules', async () => {
    const issues = await asUser(db, chef(CHEF), async (c) => {
      const { rows } = await c.query(
        `insert into public.exams (company_id, title, created_by) values ($1,'No rules',$2) returning id`,
        [fixtures.company, CHEF],
      )
      await c.query(`insert into public.exam_sections (exam_id, title) values ($1,'Lonely')`, [rows[0].id])
      return (await health(c, rows[0].id)).rows
    })
    expect(issues.some((i) => i.code === 'structure.no_rules' && i.severity === 'blocking')).toBe(true)
  })

  it('warns, without blocking, when every question is one difficulty', async () => {
    const issues = await asUser(db, chef(CHEF), async (c) => {
      // Two questions at difficulty 1: one in each category.
      const examId = await buildExam(c, [{ count: 2, min: 1, max: 1 }], { duration: 2 })
      return (await health(c, examId)).rows
    })
    const narrow = issues.find((i) => i.code === 'difficulty.narrow')
    expect(narrow?.severity).toBe('advisory')
    expect(issues.filter((i) => i.severity === 'blocking')).toEqual([])
  })

  it('warns when the clock does not match the paper', async () => {
    const issues = await asUser(db, chef(CHEF), async (c) => {
      // 5 questions × 60s = 5 minutes of work in a 60 minute window.
      const examId = await buildExam(c, [{ category: CAT_A, count: 5 }], { duration: 60 })
      return (await health(c, examId)).rows
    })
    const duration = issues.find((i) => i.code === 'duration.mismatch')
    expect(duration?.severity).toBe('advisory')
    expect(duration?.detail).toMatchObject({ duration_minutes: 60 })
  })

  // ── Publish ────────────────────────────────────────────────────────────────

  it('refuses to publish an exam with a blocking issue', async () => {
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 99 }])
        return c.query('select * from public.publish_exam($1)', [examId])
      }),
    ).rejects.toThrow(/blocking issues/)
  })

  it('names the failing rule in the refusal', async () => {
    // "Publishing failed" alone leaves a chef guessing which of nine rules to
    // loosen; the message carries the count so they can act on it.
    let message = ''
    try {
      await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 99 }])
        return c.query('select * from public.publish_exam($1)', [examId])
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('rule.short')
    expect(message).toContain('"requested": 99')
  })

  it('freezes the paper, stamps the totals and bumps usage_count', async () => {
    const result = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
      const before = await c.query('select usage_count from public.questions where id = $1', [q(1)])
      const published = await c.query('select * from public.publish_exam($1)', [examId])
      const paper = await c.query(
        'select * from public.exam_questions where exam_id = $1 order by position',
        [examId],
      )
      const exam = await c.query(
        'select status, question_count, total_marks, requires_manual_grading, published_at from public.exams where id = $1',
        [examId],
      )
      const usage = await c.query(
        'select sum(usage_count)::int as total from public.questions where id = any($1::uuid[])',
        [paper.rows.map((r) => r.question_id)],
      )
      return {
        published: published.rows[0],
        paper: paper.rows,
        exam: exam.rows[0],
        usageAfter: usage.rows[0].total,
        beforeOne: before.rows[0].usage_count,
      }
    })

    expect(result.paper).toHaveLength(3)
    expect(result.exam.status).toBe('scheduled')
    expect(result.exam.question_count).toBe(3)
    expect(Number(result.exam.total_marks)).toBe(6) // 3 × 2 marks
    expect(result.exam.requires_manual_grading).toBe(false)
    expect(result.exam.published_at).not.toBeNull()
    // M2's outstanding debt: usage_count now actually moves.
    expect(result.usageAfter).toBe(3)
    // Every row carries the revision, or 0011 achieved nothing.
    expect(result.paper.every((r) => r.question_revision >= 1)).toBe(true)
  })

  it('marks an exam manual when it draws a manually-graded format', async () => {
    const manual = await asUser(db, chef(CHEF), async (c) => {
      await c.query(
        `insert into public.questions
           (id, company_id, type, response_format, stem, content, category_id,
            difficulty, marks, status, created_by)
         values ($1,$2,'essay','text_long','Explain HACCP','{"format":"text_long","maxWords":300}'::jsonb,
                 $3,3,10,'active',$4)`,
        ['00000000-0000-0000-0000-0000000eff01', fixtures.company, CAT_B, CHEF],
      )
      const examId = await buildExam(c, [{ category: CAT_B, count: 6 }], { duration: 10 })
      await c.query('select * from public.publish_exam($1)', [examId])
      return (
        await c.query('select requires_manual_grading from public.exams where id = $1', [examId])
      ).rows[0].requires_manual_grading
    })
    expect(manual).toBe(true)
  })

  // ── The snapshot ───────────────────────────────────────────────────────────

  it('NEVER puts an answer key in the snapshot', async () => {
    // The reason question_snapshot() is one function with an explicit column
    // list. If this ever fails, every candidate can read the answers from
    // devtools and every result the platform has produced is suspect.
    const snapshots = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
      await c.query('select * from public.publish_exam($1)', [examId])
      return (
        await c.query('select snapshot from public.exam_questions where exam_id = $1', [examId])
      ).rows.map((r) => r.snapshot)
    })

    expect(snapshots).toHaveLength(3)
    for (const snapshot of snapshots) {
      const text = JSON.stringify(snapshot)
      for (const forbidden of ['correct', 'accept', 'rubric', 'keywords', 'modelAnswer', 'answer_key']) {
        expect(text, `snapshot leaked "${forbidden}"`).not.toContain(forbidden)
      }
      expect(snapshot).toHaveProperty('stem')
      expect(snapshot).toHaveProperty('content')
      expect(snapshot).toHaveProperty('revision')
    }
  })

  // ── exam_paper ─────────────────────────────────────────────────────────────

  describe('exam_paper', () => {
    it('previews an unpublished exam and says that it is a preview', async () => {
      const rows = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
        return (await c.query('select * from public.exam_paper($1)', [examId])).rows
      })

      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.is_preview === true)).toBe(true)
      expect(rows.map((r) => r.paper_position)).toEqual([1, 2, 3])
      expect(rows[0].section_title).toBe('Section 1')
    })

    it('returns the frozen paper once published, and stops calling it a preview', async () => {
      const rows = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
        await c.query('select * from public.publish_exam($1)', [examId])
        return (await c.query('select * from public.exam_paper($1)', [examId])).rows
      })

      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.is_preview === false)).toBe(true)
    })

    it('keeps showing the wording that was frozen, not the current one', async () => {
      // The whole reason snapshots exist. Editing a question after publication
      // must not change what the paper says a candidate was asked.
      const result = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 1, min: 1, max: 1 }], {
          duration: 1,
        })
        await c.query('select * from public.publish_exam($1)', [examId])

        const before = await c.query('select snapshot from public.exam_paper($1)', [examId])
        const drawnId = (
          await c.query('select question_id from public.exam_questions where exam_id = $1', [examId])
        ).rows[0].question_id

        await c.query(`update public.questions set stem = 'Completely rewritten' where id = $1`, [
          drawnId,
        ])

        const after = await c.query('select snapshot, question_revision from public.exam_paper($1)', [
          examId,
        ])
        const live = await c.query('select stem, revision from public.questions where id = $1', [
          drawnId,
        ])
        return { before: before.rows[0], after: after.rows[0], live: live.rows[0] }
      })

      expect(result.live.stem).toBe('Completely rewritten')
      expect(result.after.snapshot.stem).toBe(result.before.snapshot.stem)
      expect(result.after.snapshot.stem).not.toBe('Completely rewritten')
      // And the frozen revision is the OLD one, which is what analytics group by.
      expect(result.after.question_revision).toBeLessThan(result.live.revision)
    })

    it('NEVER includes an answer key, in either branch', async () => {
      // exam_paper is a second route to question content, so it gets the same
      // assertion the frozen snapshot does. A leak here would be just as total.
      const both = await asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 3 }], { duration: 3 })
        const preview = (await c.query('select snapshot from public.exam_paper($1)', [examId])).rows
        await c.query('select * from public.publish_exam($1)', [examId])
        const frozen = (await c.query('select snapshot from public.exam_paper($1)', [examId])).rows
        return { preview, frozen }
      })

      for (const [label, rows] of Object.entries(both)) {
        expect(rows.length, `${label} returned nothing`).toBeGreaterThan(0)
        for (const row of rows) {
          const text = JSON.stringify(row.snapshot)
          for (const forbidden of ['correct', 'accept', 'rubric', 'keywords', 'modelAnswer']) {
            expect(text, `${label} snapshot leaked "${forbidden}"`).not.toContain(forbidden)
          }
        }
      }
    })

    it('refuses a caller without exams.read', async () => {
      await expect(
        asUser(db, employee(EMP_FOR_DENIAL), async (c) =>
          c.query('select * from public.exam_paper($1)', [
            '00000000-0000-0000-0000-0000000000ff',
          ]),
        ),
      ).rejects.toThrow(/forbidden/)
    })
  })

  // ── Immutability ───────────────────────────────────────────────────────────

  it('refuses to change a published exam', async () => {
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
        await c.query('select * from public.publish_exam($1)', [examId])
        return c.query(`update public.exams set title = 'Renamed' where id = $1`, [examId])
      }),
    ).rejects.toThrow(/published/)
  })

  it('refuses to move the OPENING time of a published exam', async () => {
    // The other half of the closes_at rule, and the one nothing asserted until
    // now. Moving when an exam opens changes what candidates were told; moving
    // when it closes does not. The UI narrows its write to match, but the
    // trigger is what makes the rule true.
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
        await c.query('select * from public.publish_exam($1)', [examId])
        return c.query(`update public.exams set opens_at = now() + interval '1 day' where id = $1`, [
          examId,
        ])
      }),
    ).rejects.toThrow(/published/)
  })

  it('refuses to change the timezone of a published exam', async () => {
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
        await c.query('select * from public.publish_exam($1)', [examId])
        return c.query(`update public.exams set timezone = 'UTC' where id = $1`, [examId])
      }),
    ).rejects.toThrow(/published/)
  })

  it('still allows assignments to change after publish', async () => {
    // The lock covers what is asked, not who sits it. Adding an outlet that
    // opened late, or giving one person a retake, must stay possible.
    const count = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
      await c.query('select * from public.publish_exam($1)', [examId])
      await c.query(
        `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
        [examId, fixtures.outletCapiche],
      )
      return (
        await c.query('select count(*)::int n from public.exam_assignments where exam_id = $1', [
          examId,
        ])
      ).rows[0].n
    })
    expect(count).toBe(1)
  })

  it('still allows the closing time to move', async () => {
    // Extending a window because a shift ran late is routine and changes
    // nothing about what was asked.
    const rows = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
      await c.query('select * from public.publish_exam($1)', [examId])
      await c.query(`update public.exams set closes_at = now() + interval '2 days' where id = $1`, [examId])
      return (await c.query('select closes_at from public.exams where id = $1', [examId])).rows
    })
    expect(rows[0].closes_at).not.toBeNull()
  })

  it('refuses to add a question to a published paper', async () => {
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
        await c.query('select * from public.publish_exam($1)', [examId])
        const { rows } = await c.query('select id from public.exam_sections where exam_id = $1', [examId])
        return c.query(
          `insert into public.exam_questions
             (exam_id, section_id, question_id, question_revision, snapshot, position, marks)
           values ($1,$2,$3,1,'{}'::jsonb,99,1)`,
          [examId, rows[0].id, q(9)],
        )
      }),
    ).rejects.toThrow(/published/)
  })

  it('rejects an illegal status transition', async () => {
    await expect(
      asUser(db, chef(CHEF), async (c) => {
        const examId = await buildExam(c, [{ category: CAT_A, count: 2 }], { duration: 2 })
        return c.query(`update public.exams set status = 'completed' where id = $1`, [examId])
      }),
    ).rejects.toThrow(/cannot move an exam from draft to completed/)
  })

  // ── Duplicate ──────────────────────────────────────────────────────────────

  it('duplicates settings, sections and rules into a fresh draft', async () => {
    const result = await asUser(db, chef(CHEF), async (c) => {
      const examId = await buildExam(c, [
        { category: CAT_A, count: 2, section: 0 },
        { category: CAT_B, count: 2, section: 1 },
      ], { duration: 4 })
      await c.query('select * from public.publish_exam($1)', [examId])

      const { rows } = await c.query('select public.duplicate_exam($1) as id', [examId])
      const copyId = rows[0].id
      return {
        copy: (await c.query('select status, title, question_count from public.exams where id = $1', [copyId]))
          .rows[0],
        sections: (await c.query('select count(*)::int n from public.exam_sections where exam_id = $1', [copyId]))
          .rows[0].n,
        rules: (
          await c.query(
            `select count(*)::int n from public.exam_rules r
               join public.exam_sections s on s.id = r.section_id where s.exam_id = $1`,
            [copyId],
          )
        ).rows[0].n,
        paper: (await c.query('select count(*)::int n from public.exam_questions where exam_id = $1', [copyId]))
          .rows[0].n,
        assignments: (
          await c.query('select count(*)::int n from public.exam_assignments where exam_id = $1', [copyId])
        ).rows[0].n,
      }
    })

    expect(result.copy.status).toBe('draft')
    expect(result.copy.title).toContain('(copy)')
    expect(result.sections).toBe(2)
    expect(result.rules).toBe(2)
    // The paper is NOT copied: a draft draws its own at its own publish, or the
    // duplicate would inherit a paper its rules no longer justify.
    expect(result.paper).toBe(0)
    // Nor are assignments — silently re-assigning 300 people to somebody's
    // experiment is the kind of helpfulness nobody wants.
    expect(result.assignments).toBe(0)
  })
})
