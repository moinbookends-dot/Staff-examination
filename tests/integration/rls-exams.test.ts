import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asUser, asOwner, employee, chef, fixtures } from './helpers/db'

/**
 * RLS for the exam layer.
 *
 * The deny cases are the point. A candidate who can read exam_rules knows what
 * to revise; a candidate who can read exam_questions has the paper before the
 * timer starts. Both tables therefore carry NO candidate policy at all, so RLS
 * refuses by default rather than by a condition somebody could weaken.
 */

const describeDb = hasDatabase ? describe : describe.skip

const CHEF = 'aaaa8888-8888-8888-8888-888888888888'
const EMP_AIKO = 'bbbb8888-8888-8888-8888-888888888888'
const EMP_CAPICHE = 'cccc8888-8888-8888-8888-888888888888'

const EXAM_OUTLET = '00000000-0000-0000-0000-00000000ea01'
const EXAM_OTHER = '00000000-0000-0000-0000-00000000ea02'
const EXAM_DRAFT = '00000000-0000-0000-0000-00000000ea03'
const EXAM_ROLE = '00000000-0000-0000-0000-00000000ea04'
const EXAM_USER = '00000000-0000-0000-0000-00000000ea05'
const SECTION = '00000000-0000-0000-0000-00000000eb01'
const QUESTION = '00000000-0000-0000-0000-00000000ec01'

describeDb('RLS — exams', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'examrlschef@test.local'), ($2,'examrlsaiko@test.local'), ($3,'examrlscap@test.local')
       on conflict (id) do nothing`,
      [CHEF, EMP_AIKO, EMP_CAPICHE],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3
        where id = any($1::uuid[])`,
      [[CHEF, EMP_AIKO], fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3
        where id = $1`,
      [EMP_CAPICHE, fixtures.company, fixtures.outletCapiche],
    )

    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, difficulty, marks, status, created_by)
       values ($1,$2,'mcq_single','choice_single','Exam RLS question',
               '{"format":"choice_single","choices":[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]}'::jsonb,
               3,2,'active',$3)
       on conflict (id) do nothing`,
      [QUESTION, fixtures.company, CHEF],
    )

    // Four exams: assigned to Aiko, assigned to Capiche, an unpublished draft
    // assigned to Aiko, and one assigned by ROLE.
    for (const [id, status] of [
      [EXAM_OUTLET, 'scheduled'],
      [EXAM_OTHER, 'scheduled'],
      [EXAM_DRAFT, 'draft'],
      [EXAM_ROLE, 'scheduled'],
      [EXAM_USER, 'scheduled'],
    ] as const) {
      // Always created as a draft, then promoted below. The 0016 lock refuses
      // to attach sections or questions to anything that is not a draft — which
      // is the trigger doing its job, and means fixtures must follow the same
      // order the application does.
      await db.query(
        `insert into public.exams (id, company_id, title, status, created_by)
         values ($1,$2,$3,'draft',$4)
         on conflict (id) do nothing`,
        [id, fixtures.company, `Exam ${id.slice(-4)}`, CHEF],
      )
      void status
    }

    await db.query(
      `insert into public.exam_sections (id, exam_id, title) values ($1,$2,'Section One')
       on conflict (id) do nothing`,
      [SECTION, EXAM_OUTLET],
    )
    await db.query(
      `insert into public.exam_rules (section_id, question_count, sort_order) values ($1,1,0)`,
      [SECTION],
    )
    await db.query(
      `insert into public.exam_questions
         (exam_id, section_id, question_id, question_revision, snapshot, position, marks)
       values ($1,$2,$3,1,'{"stem":"Exam RLS question"}'::jsonb,1,2)
       on conflict do nothing`,
      [EXAM_OUTLET, SECTION, QUESTION],
    )

    await db.query(
      `insert into public.exam_assignments (exam_id, target_kind, target_id) values
         ($1,'outlet',$4), ($2,'outlet',$5), ($3,'outlet',$4)`,
      [EXAM_OUTLET, EXAM_OTHER, EXAM_DRAFT, fixtures.outletAiko, fixtures.outletCapiche],
    )
    await db.query(
      `insert into public.exam_assignments (exam_id, target_kind, target_role) values ($1,'role','employee')`,
      [EXAM_ROLE],
    )
    // Individual targeting: the Aiko employee only. The Capiche employee shares
    // no outlet, department or role assignment with this exam.
    await db.query(
      `insert into public.exam_assignments (exam_id, target_kind, target_user_id) values ($1,'user',$2)`,
      [EXAM_USER, EMP_AIKO],
    )

    // Promote everything except EXAM_DRAFT, now that their content exists. This
    // is the order publish_exam() uses too: build while draft, freeze, flip.
    await db.query(
      `update public.exams
          set status = 'scheduled', published_at = now(), published_by = $2,
              question_count = 1, total_marks = 2
        where id = any($1::uuid[])`,
      [[EXAM_OUTLET, EXAM_OTHER, EXAM_ROLE, EXAM_USER], CHEF],
    )

    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.exams where id = any($1::uuid[])', [
      [EXAM_OUTLET, EXAM_OTHER, EXAM_DRAFT, EXAM_ROLE, EXAM_USER],
    ])
    await db.query('delete from public.questions where id = $1', [QUESTION])
    await db.query('delete from auth.users where id = any($1::uuid[])', [
      [CHEF, EMP_AIKO, EMP_CAPICHE],
    ])
    await db.query('commit')
    await db.end()
  })

  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id)

  // ── What a candidate MAY see ───────────────────────────────────────────────

  describe('exam visibility', () => {
    it('a chef sees every exam in their company, including drafts', async () => {
      const rows = await asUser(db, chef(CHEF), async (c) =>
        (await c.query('select id from public.exams where id = any($1::uuid[])', [
          [EXAM_OUTLET, EXAM_OTHER, EXAM_DRAFT, EXAM_ROLE, EXAM_USER],
        ])).rows,
      )
      expect(rows).toHaveLength(5)
    })

    it('an employee sees an exam assigned to their outlet', async () => {
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_OUTLET])).rows,
      )
      expect(idsOf(rows)).toEqual([EXAM_OUTLET])
    })

    it('an employee does NOT see an exam assigned to another outlet', async () => {
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_OTHER])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('an employee does NOT see a draft, even one assigned to them', async () => {
      // A draft is a chef's working document. Showing it would advertise an
      // exam that may never run, in a shape that may still change completely.
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_DRAFT])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('role targeting reaches an employee', async () => {
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_ROLE])).rows,
      )
      expect(idsOf(rows)).toEqual([EXAM_ROLE])
    })

    it('individual targeting reaches exactly that person', async () => {
      // The retake case. Nobody else is assigned by outlet, department or role,
      // so this exam must be visible to one employee and invisible to the other
      // — even though both are approved, in the same company, and hold the same
      // role. If the second sees it, "give one person another go" is impossible.
      const mine = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_USER])).rows,
      )
      expect(idsOf(mine)).toEqual([EXAM_USER])

      const theirs = await asUser(db, employee(EMP_CAPICHE, fixtures.outletCapiche), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_USER])).rows,
      )
      expect(theirs, 'an individual assignment leaked to another employee').toHaveLength(0)
    })

    it('an individual assignment reaches exactly one person in the audience', async () => {
      // exam_audience drives the notification and the queued email. If it
      // returned the whole outlet, a retake for one person would tell everybody
      // they had a new exam — visible in the UI or not.
      // As OWNER: exam_audience returns email addresses and is granted to
      // nobody (migration 0020). It used to be callable by anon over PostgREST.
      const audience = await asOwner(db, async (c) =>
        (await c.query('select id from public.exam_audience($1)', [EXAM_USER])).rows,
      )
      expect(audience.map((r) => r.id)).toEqual([EMP_AIKO])
    })

    it('an individual assignment cannot reach outside the company', async () => {
      // An id is not authorisation. exam_audience still filters on company_id,
      // so an assignment naming somebody else's employee reaches nobody.
      //
      // Run as OWNER, and deliberately so: a chef cannot update another
      // profile, so doing this through asUser would silently update no rows and
      // the assertion would pass for the wrong reason. Arranging as owner and
      // asserting on the definer function is the honest shape here.
      const audience = await asOwner(db, async (c) => {
        await c.query(`update public.profiles set company_id = null where id = $1`, [EMP_AIKO])
        return (await c.query('select id from public.exam_audience($1)', [EXAM_USER])).rows
      })
      expect(audience).toHaveLength(0)
    })

    it('an employee may read the section titles of an assigned exam', async () => {
      // Needed to navigate the paper; reveals nothing the paper will not.
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exam_sections where exam_id = $1', [EXAM_OUTLET])).rows,
      )
      expect(rows).toHaveLength(1)
    })
  })

  // ── What a candidate MAY NOT see. These are the ones that matter. ──────────

  describe('candidate denial', () => {
    it('an employee CANNOT read exam_rules for an exam assigned to them', async () => {
      // The rules say "12 from Food Safety at difficulty 4–5" — that is what to
      // revise and roughly what will be asked.
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query(
          'select r.id from public.exam_rules r join public.exam_sections s on s.id = r.section_id where s.exam_id = $1',
          [EXAM_OUTLET],
        )).rows,
      )
      expect(rows, 'EMPLOYEE CAN READ EXAM RULES — the paper shape is exposed').toHaveLength(0)
    })

    it('an employee CANNOT read exam_questions', async () => {
      // The one that would end the exam entirely: the whole paper, before the
      // timer starts. M4 serves questions through a definer route gated on an
      // in-progress attempt.
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select question_id from public.exam_questions where exam_id = $1', [EXAM_OUTLET]))
          .rows,
      )
      expect(rows, 'EMPLOYEE CAN READ THE PAPER BEFORE SITTING IT').toHaveLength(0)
    })

    it('an employee CANNOT read who else was assigned', async () => {
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.exam_assignments where exam_id = $1', [EXAM_OUTLET])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('an employee still cannot reach the question bank through an exam', async () => {
      // 0010 gives employees no policy on `questions`, and M3 must not have
      // added a way round it.
      const rows = await asUser(db, employee(EMP_AIKO), async (c) =>
        (await c.query('select id from public.questions where id = $1', [QUESTION])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('an employee cannot create an exam', async () => {
      await expect(
        asUser(db, employee(EMP_AIKO), async (c) =>
          c.query(
            `insert into public.exams (company_id, title, created_by) values ($1,'Mine now',$2)`,
            [fixtures.company, EMP_AIKO],
          ),
        ),
      ).rejects.toThrow()
    })

    it('an employee cannot destroy the frozen paper', async () => {
      // NOTE THE SHAPE OF THIS ASSERTION. A DELETE under RLS does not error
      // when no policy grants it — the rows are simply invisible, so it matches
      // nothing and reports 0. (An INSERT differs: a failed WITH CHECK raises.)
      // Asserting `.rejects.toThrow()` here would have passed for the wrong
      // reason had a policy ever been added, so assert the row survives.
      const result = await asUser(db, employee(EMP_AIKO), async (c) => {
        const deleted = await c.query('delete from public.exam_questions where exam_id = $1', [
          EXAM_OUTLET,
        ])
        return deleted.rowCount
      })
      expect(result).toBe(0)

      const survives = await asUser(db, chef(CHEF), async (c) =>
        (await c.query('select question_id from public.exam_questions where exam_id = $1', [EXAM_OUTLET]))
          .rows,
      )
      expect(survives).toHaveLength(1)
    })

    it('an employee cannot assign an exam to themselves', async () => {
      await expect(
        asUser(db, employee(EMP_AIKO), async (c) =>
          c.query(
            `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
            [EXAM_OTHER, fixtures.outletAiko],
          ),
        ),
      ).rejects.toThrow()
    })

    it('an employee in another outlet sees nothing at all', async () => {
      const rows = await asUser(db, employee(EMP_CAPICHE, fixtures.outletCapiche), async (c) =>
        (await c.query('select id from public.exams where id = any($1::uuid[])', [
          [EXAM_OUTLET, EXAM_DRAFT],
        ])).rows,
      )
      expect(rows).toHaveLength(0)
    })
  })

  // ── The health check is not a back door ───────────────────────────────────

  describe('exam_health authorisation', () => {
    it('refuses a caller without exams.update', async () => {
      // It returns question ids and stems in its detail payload, so it is as
      // sensitive as the paper itself.
      await expect(
        asUser(db, employee(EMP_AIKO), async (c) =>
          c.query('select * from public.exam_health($1)', [EXAM_OUTLET]),
        ),
      ).rejects.toThrow(/exam not found|forbidden/)
    })

    it('runs for a chef', async () => {
      const rows = await asUser(db, chef(CHEF), async (c) =>
        (await c.query('select * from public.exam_health($1)', [EXAM_OUTLET])).rows,
      )
      expect(Array.isArray(rows)).toBe(true)
    })
  })
})
