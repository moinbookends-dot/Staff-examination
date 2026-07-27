import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asUser, asOwner, fixtures, type TestClaims } from './helpers/db'

/**
 * CROSS-COMPANY ISOLATION.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE EXISTS.                                                     │
 * │                                                                           │
 * │ Every other suite runs inside ONE seeded company, so every tenancy gate   │
 * │ in the codebase was unexercised. `company_id = public.my_company()`       │
 * │ appears in a dozen policies and in the guard of every SECURITY DEFINER    │
 * │ entry point — and a predicate nothing tests is a predicate that can be    │
 * │ deleted without a single test going red.                                  │
 * │                                                                           │
 * │ It matters most for the definer functions. They bypass RLS by             │
 * │ construction; the company check inside them is the ONLY thing standing    │
 * │ between a chef and another company's exam. RLS would not save them.       │
 * │                                                                           │
 * │ M4 makes this worse: attempts, grading and reporting all join across      │
 * │ these tables, so an isolation hole would leak results rather than         │
 * │ configuration.                                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Company B — a second tenant that must never see company A's anything.
const CO_B = '00000000-0000-0000-0000-0000000c0b02'
const BRAND_B = '00000000-0000-0000-0000-0000000b0b02'
const OUTLET_B = '00000000-0000-0000-0000-0000000a0b02'
const CHEF_A = 'aaaa7777-7777-7777-7777-777777777777'
const CHEF_B = 'bbbb7777-7777-7777-7777-777777777777'

const EXAM_A = '00000000-0000-0000-0000-0000000e0a77'
const QUESTION_A = '00000000-0000-0000-0000-0000000q0a77'.replace('q', 'e')

/** A chef in whichever company, with the full chef permission set. */
function chefOf(id: string, companyId: string, outletId: string, brandId: string): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: companyId,
      outlet_id: outletId,
      brand_id: brandId,
      roles: ['chef'],
      perms: [
        'questions.read', 'questions.create', 'questions.update', 'questions.retire',
        'exams.read', 'exams.create', 'exams.update', 'exams.publish',
        'exams.assign', 'exams.archive',
      ],
    },
  }
}

const chefA = () => chefOf(CHEF_A, fixtures.company, fixtures.outletAiko, fixtures.brandAiko)
const chefB = () => chefOf(CHEF_B, CO_B, OUTLET_B, BRAND_B)

describeDb('cross-company isolation', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    // CLEAN FIRST, and this is not belt-and-braces. The fixture publishes
    // EXAM_A, and a run interrupted before afterAll leaves it behind PUBLISHED
    // — at which point `on conflict do nothing` keeps the stale row and the
    // 0016 trigger refuses to attach a section to it, so every later run fails
    // in setup for a reason that has nothing to do with what changed.
    // Order matters: profiles reference outlets, so the users go first or the
    // outlet delete trips profiles_outlet_id_fkey. Same order as afterAll.
    await db.query('delete from public.exams where id = $1', [EXAM_A])
    await db.query('delete from public.questions where id = $1', [QUESTION_A])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF_A, CHEF_B]])
    await db.query('delete from public.outlets where id = $1', [OUTLET_B])
    await db.query('delete from public.brands where id = $1', [BRAND_B])
    // The audit trigger logged company B's profile updates, and audit_logs
    // references companies. Nothing else in the suite touches it, so it has to
    // be cleared here or the company is undeletable.
    await db.query('delete from public.audit_logs where company_id = $1', [CO_B])
    await db.query('delete from public.companies where id = $1', [CO_B])

    await db.query(
      `insert into public.companies (id, name, slug) values ($1,'Rival Hospitality','rival-test')
       on conflict (id) do nothing`,
      [CO_B],
    )
    await db.query(
      `insert into public.brands (id, company_id, name, slug) values ($1,$2,'Rival Brand','rival-brand-test')
       on conflict (id) do nothing`,
      [BRAND_B, CO_B],
    )
    await db.query(
      `insert into public.outlets (id, company_id, brand_id, name, code, state)
       values ($1,$2,$3,'Rival Outlet','RIVAL-01','Gujarat')
       on conflict (id) do nothing`,
      [OUTLET_B, CO_B, BRAND_B],
    )

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'tenancy-a@test.local'), ($2,'tenancy-b@test.local')
       on conflict (id) do nothing`,
      [CHEF_A, CHEF_B],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
      [CHEF_A, fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
      [CHEF_B, CO_B, OUTLET_B],
    )

    // One question and one published exam, both belonging to company A.
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, difficulty, marks, status, created_by)
       values ($1,$2,'mcq_single','choice_single','Company A secret question',
               '{"format":"choice_single","choices":[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]}'::jsonb,
               3,2,'active',$3)
       on conflict (id) do nothing`,
      [QUESTION_A, fixtures.company, CHEF_A],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,'{"format":"choice_single","correct":"a"}'::jsonb)
       on conflict (question_id) do nothing`,
      [QUESTION_A],
    )

    await db.query(
      `insert into public.exams (id, company_id, title, created_by, duration_minutes)
       values ($1,$2,'Company A exam',$3,10) on conflict (id) do nothing`,
      [EXAM_A, fixtures.company, CHEF_A],
    )
    const { rows: sec } = await db.query(
      `insert into public.exam_sections (exam_id, title) values ($1,'A') returning id`,
      [EXAM_A],
    )
    await db.query(
      `insert into public.exam_rules (section_id, question_count, difficulty_min, difficulty_max)
       values ($1,1,1,5)`,
      [sec[0].id],
    )
    await db.query('commit')

    // Publish it as chef A, through the real function, so there is a frozen
    // paper for company B to fail to reach.
    await db.query('begin')
    await db.query('reset role')
    await db.query('select set_config($1,$2,true)', [
      'request.jwt.claims',
      JSON.stringify(chefA()),
    ])
    await db.query('select * from public.publish_exam($1)', [EXAM_A])
    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('delete from public.exams where id = $1', [EXAM_A])
    await db.query('delete from public.questions where id = $1', [QUESTION_A])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[CHEF_A, CHEF_B]])
    await db.query('delete from public.outlets where id = $1', [OUTLET_B])
    await db.query('delete from public.brands where id = $1', [BRAND_B])
    // The audit trigger logged company B's profile updates, and audit_logs
    // references companies. Nothing else in the suite touches it, so it has to
    // be cleared here or the company is undeletable.
    await db.query('delete from public.audit_logs where company_id = $1', [CO_B])
    await db.query('delete from public.companies where id = $1', [CO_B])
    await db.query('commit')
    await db.end()
  })

  // ── RLS-protected tables ───────────────────────────────────────────────────

  describe('policies scope by company', () => {
    it('company B cannot see company A exams', async () => {
      const rows = await asUser(db, chefB(), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_A])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('company A can see its own', async () => {
      // The allow case, so the deny case above cannot pass because everything
      // is broken for everybody.
      const rows = await asUser(db, chefA(), async (c) =>
        (await c.query('select id from public.exams where id = $1', [EXAM_A])).rows,
      )
      expect(rows).toHaveLength(1)
    })

    it('company B cannot see company A questions', async () => {
      const rows = await asUser(db, chefB(), async (c) =>
        (await c.query('select id from public.questions where id = $1', [QUESTION_A])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('company B cannot see company A answer keys', async () => {
      const rows = await asUser(db, chefB(), async (c) =>
        (await c.query('select answer_key from public.question_answer_keys where question_id = $1', [
          QUESTION_A,
        ])).rows,
      )
      expect(rows).toHaveLength(0)
    })

    it('company B cannot see company A sections, rules or paper', async () => {
      const counts = await asUser(db, chefB(), async (c) => ({
        sections: (await c.query('select id from public.exam_sections where exam_id = $1', [EXAM_A]))
          .rows.length,
        rules: (
          await c.query(
            `select r.id from public.exam_rules r
               join public.exam_sections s on s.id = r.section_id where s.exam_id = $1`,
            [EXAM_A],
          )
        ).rows.length,
        paper: (await c.query('select question_id from public.exam_questions where exam_id = $1', [
          EXAM_A,
        ])).rows.length,
      }))
      expect(counts).toEqual({ sections: 0, rules: 0, paper: 0 })
    })

    it('company B cannot write into company A', async () => {
      await expect(
        asUser(db, chefB(), async (c) =>
          c.query(
            `insert into public.exam_sections (exam_id, title) values ($1,'Injected')`,
            [EXAM_A],
          ),
        ),
      ).rejects.toThrow()
    })

    it('a company B exam is created in company B, whatever it claims', async () => {
      // exams_insert forces company_id = my_company(); a client asserting
      // another company's id must not be believed.
      await expect(
        asUser(db, chefB(), async (c) =>
          c.query(
            `insert into public.exams (company_id, title, created_by) values ($1,'Cuckoo',$2)`,
            [fixtures.company, CHEF_B],
          ),
        ),
      ).rejects.toThrow()
    })
  })

  // ── SECURITY DEFINER entry points ──────────────────────────────────────────
  //
  // These bypass RLS by construction. The company check inside each of them is
  // the only barrier, and it is what this block exists to exercise.

  describe('definer entry points check company for themselves', () => {
    const refuses = (sql: string, params: unknown[]) =>
      expect(
        asUser(db, chefB(), async (c) => c.query(sql, params)),
      ).rejects.toThrow(/exam not found|forbidden/)

    it('exam_paper refuses another company exam', () =>
      refuses('select * from public.exam_paper($1, null)', [EXAM_A]))

    it('exam_health refuses another company exam', () =>
      refuses('select * from public.exam_health($1)', [EXAM_A]))

    it('exam_rule_counts refuses another company exam', () =>
      refuses('select * from public.exam_rule_counts($1)', [EXAM_A]))

    it('preview_rule_count refuses another company exam', () =>
      refuses(
        `select public.preview_rule_count($1, null, true, '{}'::uuid[], null, 1::smallint, 5::smallint)`,
        [EXAM_A],
      ))

    it('publish_exam refuses another company exam', () =>
      refuses('select * from public.publish_exam($1)', [EXAM_A]))

    it('duplicate_exam refuses another company exam', () =>
      refuses('select public.duplicate_exam($1, null)', [EXAM_A]))

    it('exam_paper serves the owning company, so the refusals mean something', async () => {
      const rows = await asUser(db, chefA(), async (c) =>
        (await c.query('select question_id from public.exam_paper($1, null)', [EXAM_A])).rows,
      )
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  // ── Audience ───────────────────────────────────────────────────────────────

  it('an assignment naming another company reaches nobody', async () => {
    // exam_audience filters on p.company_id = e.company_id. Without it, an
    // assignment could be pointed at a rival's outlet and would email them.
    const audience = await asOwner(db, async (c) => {
      await c.query(
        `insert into public.exam_assignments (exam_id, target_kind, target_id) values ($1,'outlet',$2)`,
        [EXAM_A, OUTLET_B],
      )
      return (await c.query('select id from public.exam_audience($1)', [EXAM_A])).rows
    })
    expect(audience.map((r) => r.id)).not.toContain(CHEF_B)
    expect(audience).toHaveLength(0)
  })

  it('question_pool never crosses companies', async () => {
    // The exam belongs to company A, so its pool is company A's questions. A
    // company B exam must not be able to draw them.
    const rows = await asOwner(db, async (c) => {
      const { rows: made } = await c.query(
        `insert into public.exams (company_id, title, created_by) values ($1,'B exam',$2) returning id`,
        [CO_B, CHEF_B],
      )
      return (
        await c.query(
          `select question_id from public.question_pool($1, null, true, '{}'::uuid[], null, 1::smallint, 5::smallint)`,
          [made[0].id],
        )
      ).rows
    })
    expect(rows.map((r) => r.question_id)).not.toContain(QUESTION_A)
  })
})
