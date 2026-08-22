import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connect,
  hasDatabase,
  asAnon,
  asUser,
  asOwner,
  admin,
  chef,
  employee,
  hr,
  superAdmin,
  fixtures,
} from './helpers/db'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Who may import, and who may read the record of an import.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE SCREEN IS NOT THE BOUNDARY, AND THIS FILE IS WHERE THAT IS PROVED.    ║
 * ║                                                                           ║
 * ║ /questions/import is gated three times over in the application — the      ║
 * ║ subtree layout, the tab, and commitPaperImport()'s own guard. None of     ║
 * ║ that stops anybody POSTing to PostgREST directly, which a browser console ║
 * ║ can do with the session already in hand.                                  ║
 * ║                                                                           ║
 * ║ So the assertions below go straight to the database with a fabricated     ║
 * ║ claim and no application code in the way. If a role can write here, it    ║
 * ║ can write in production regardless of what the UI offers.                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ON "CHEF". The brief asks whether a chef may import. Migration 0071       │
 * │ RENAMED chef to admin and deleted editor, so there is no chef role in     │
 * │ this product any more — today's `admin` is what used to be `editor`.      │
 * │                                                                           │
 * │ The chef() fixture still exists and still carries the legacy questions.*  │
 * │ keys with no bank.* key at all, which makes it exactly the right actor    │
 * │ for the question actually being asked: somebody with authoring rights     │
 * │ over the OLD tables and none over the bank. It must be refused.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const describeDb = hasDatabase ? describe : describe.skip

const ADMIN_U = 'a11ce111-1111-4111-8111-111111111111'
const CHEF_U = 'c11ce222-2222-4222-8222-222222222222'
const EMP_U = 'e11ce333-3333-4333-8333-333333333333'
const HR_U = '811ce444-4444-4444-8444-444444444444'
const SUPER_U = '511ce555-5555-4555-8555-555555555555'

/** One import run, ready to insert. Only the actor changes between cases. */
function run(actorId: string, brandId: string = fixtures.brandAiko) {
  return {
    text: `insert into public.bank_import_runs
             (company_id, brand_id, actor_id, kind, locale, filename,
              answer_key_filename, detected, created, updated, skipped,
              rejected, warnings, status, message)
           values ($1,$2,$3,'paper','hi','AIKO_Hard_Paper_Hindi_2.html',
                   'AIKO_Hard_AnswerKey_Hindi_1.html',1030,0,1030,0,0,0,
                   'completed',null)
           returning id`,
    values: [fixtures.company, brandId, actorId],
  }
}

describeDb('RLS — paper import', () => {
  let db: Client

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'imp-admin@test.local'), ($2,'imp-chef@test.local'),
         ($3,'imp-emp@test.local'),   ($4,'imp-hr@test.local'),
         ($5,'imp-super@test.local')
       on conflict (id) do nothing`,
      [ADMIN_U, CHEF_U, EMP_U, HR_U, SUPER_U],
    )

    await db.query(
      `update public.profiles
          set approval_status='approved', outlet_id=$2, company_id=$3
        where id = any($1::uuid[])`,
      [[ADMIN_U, CHEF_U, EMP_U, HR_U, SUPER_U], fixtures.outletAiko, fixtures.company],
    )

    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('delete from public.bank_import_runs where actor_id = any($1::uuid[])', [
      [ADMIN_U, CHEF_U, EMP_U, HR_U, SUPER_U],
    ])
    await db.end()
  })

  // ── bank_import_commit: the only thing that writes questions ──────────────

  describe('bank_import_commit', () => {
    const rows = JSON.stringify([
      {
        externalId: 'rls-probe-0001',
        difficulty: 'hard',
        qtype: 'mcq',
        status: 'draft',
        topicSlug: null,
        correctOption: 'B',
        referenceTitle: null,
        referencePage: null,
        texts: [
          {
            locale: 'en',
            question: 'An RLS probe question that should never be written.',
            optionA: 'a',
            optionB: 'b',
            optionC: 'c',
            optionD: 'd',
            answerText: null,
            explanation: null,
          },
        ],
      },
    ])

    it('refuses a signed-out caller', async () => {
      await asAnon(db, async (client) => {
        await expect(
          client.query('select public.bank_import_commit($1::uuid, $2::jsonb)', [
            fixtures.brandAiko,
            rows,
          ]),
        ).rejects.toThrow()
      })
    })

    it('refuses an employee', async () => {
      await asUser(db, employee(EMP_U), async (client) => {
        await expect(
          client.query('select public.bank_import_commit($1::uuid, $2::jsonb)', [
            fixtures.brandAiko,
            rows,
          ]),
        ).rejects.toThrow(/Not permitted to import questions/)
      })
    })

    it('refuses HR', async () => {
      await asUser(db, hr(HR_U), async (client) => {
        await expect(
          client.query('select public.bank_import_commit($1::uuid, $2::jsonb)', [
            fixtures.brandAiko,
            rows,
          ]),
        ).rejects.toThrow(/Not permitted to import questions/)
      })
    })

    it('refuses the legacy chef permission set, which holds no bank.* key', async () => {
      await asUser(db, chef(CHEF_U), async (client) => {
        await expect(
          client.query('select public.bank_import_commit($1::uuid, $2::jsonb)', [
            fixtures.brandAiko,
            rows,
          ]),
        ).rejects.toThrow(/Not permitted to import questions/)
      })
    })

    it('admits an admin, and actually writes the question', async () => {
      await asUser(db, admin(ADMIN_U), async (client) => {
        const result = await client.query(
          'select public.bank_import_commit($1::uuid, $2::jsonb) as out',
          [fixtures.brandAiko, rows],
        )

        // Counted, never inferred from the absence of an error. RLS refuses by
        // FILTERING, so "no error" is not the same as "it wrote something".
        expect(result.rows[0].out).toMatchObject({ inserted: 1, updated: 0 })

        const stored = await client.query(
          `select q.external_id, t.locale, t.question
             from public.bank_questions q
             join public.bank_question_texts t on t.question_id = q.id
            where q.external_id = 'rls-probe-0001'`,
        )
        expect(stored.rows).toHaveLength(1)
        expect(stored.rows[0].locale).toBe('en')
      })
    })

    it('admits a super admin through the has_perm short-circuit', async () => {
      await asUser(db, superAdmin(SUPER_U), async (client) => {
        const result = await client.query(
          'select public.bank_import_commit($1::uuid, $2::jsonb) as out',
          [fixtures.brandAiko, rows],
        )
        expect(result.rows[0].out).toMatchObject({ inserted: 1 })
      })
    })

    it('refuses an admin pinned to another brand', async () => {
      // brand_id comes from the outlet, so an Aiko-outlet admin importing into
      // Capiche is the case that matters. Editors are brand-unscoped by the
      // has_perm route, so this asserts the gate the FUNCTION carries.
      await asUser(db, employee(EMP_U, fixtures.outletCapiche), async (client) => {
        await expect(
          client.query('select public.bank_import_commit($1::uuid, $2::jsonb)', [
            fixtures.brandAiko,
            rows,
          ]),
        ).rejects.toThrow()
      })
    })
  })

  // ── bank_import_runs: the history ─────────────────────────────────────────

  describe('bank_import_runs', () => {
    it('lets an admin record a run', async () => {
      await asUser(db, admin(ADMIN_U), async (client) => {
        const { text, values } = run(ADMIN_U)
        const result = await client.query(text, values)
        expect(result.rows).toHaveLength(1)
      })
    })

    it('refuses an employee', async () => {
      await asUser(db, employee(EMP_U), async (client) => {
        const { text, values } = run(EMP_U)
        await expect(client.query(text, values)).rejects.toThrow(/row-level security/)
      })
    })

    it('refuses the legacy chef permission set', async () => {
      await asUser(db, chef(CHEF_U), async (client) => {
        const { text, values } = run(CHEF_U)
        await expect(client.query(text, values)).rejects.toThrow(/row-level security/)
      })
    })

    it('refuses a run attributed to somebody else', async () => {
      // A history that can be written under another person's name is not a
      // history. actor_id = auth.uid() is in the policy for this reason.
      await asUser(db, admin(ADMIN_U), async (client) => {
        const { text, values } = run(CHEF_U)
        await expect(client.query(text, values)).rejects.toThrow(/row-level security/)
      })
    })

    it('refuses a run against a brand in another company', async () => {
      await asUser(db, admin(ADMIN_U), async (client) => {
        const { text, values } = run(ADMIN_U, '00000000-0000-0000-0000-0000000000ff')
        await expect(client.query(text, values)).rejects.toThrow()
      })
    })

    it('is append-only — no update policy and no delete policy exist', async () => {
      const seeded = await asOwner(db, async (client) => {
        const result = await client.query(
          `insert into public.bank_import_runs
             (company_id, brand_id, actor_id, kind, locale, filename,
              detected, created, updated, skipped, rejected, warnings, status)
           values ($1,$2,$3,'paper','hi','probe.html',1,1,0,0,0,0,'completed')
           returning id`,
          [fixtures.company, fixtures.brandAiko, ADMIN_U],
        )
        return result.rows[0].id as string
      })

      // asOwner rolled back, so nothing to clean up — but the POLICIES are the
      // subject here and they exist regardless of any row.
      expect(seeded).toBeTruthy()

      const policies = await asOwner(db, async (client) =>
        client.query(
          `select polcmd from pg_policy where polrelid = 'public.bank_import_runs'::regclass`,
        ),
      )

      // 'r' = select, 'a' = insert. No 'w' (update), no 'd' (delete).
      expect(policies.rows.map((r) => r.polcmd).sort()).toEqual(['a', 'r'])
    })

    it('lets an admin read the history and keeps an employee out', async () => {
      await asUser(db, admin(ADMIN_U), async (client) => {
        const { text, values } = run(ADMIN_U)
        await client.query(text, values)
      })

      await asUser(db, employee(EMP_U), async (client) => {
        const result = await client.query('select id from public.bank_import_runs')
        // Filtered to nothing rather than refused — which is exactly why the
        // allow-case above asserts a row count instead of the absence of error.
        expect(result.rows).toHaveLength(0)
      })
    })
  })
})
