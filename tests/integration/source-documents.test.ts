import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Source documents, batches and pages — 0048.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE BOTTOM OF EVERY PROVENANCE CHAIN THE PLATFORM WILL HAVE.      │
 * │                                                                           │
 * │ M11c's knowledge units, M12's generated questions and M13's citations all │
 * │ resolve down to a row in these tables. If the scoping is wrong here, a    │
 * │ question can cite a document its reader may not open, or worse, one       │
 * │ belonging to another company.                                             │
 * │                                                                           │
 * │ So every case below is a NEGATIVE with a positive control beside it. A    │
 * │ suite that only proved "the owner can read their own" would pass against  │
 * │ tables with no RLS at all.                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const CHEF = 'aaaabbbb-7777-7777-7777-777777777777'
const CAND = 'aaaabbbb-8888-8888-8888-888888888888'
const DOC = '00000000-0000-0000-0000-00000000d001'
const BATCH = '00000000-0000-0000-0000-00000000d002'
const OTHER_CO = '00000000-0000-0000-0000-00000000d0ff'
const OTHER_DOC = '00000000-0000-0000-0000-00000000d0e1'

const SHA = 'a'.repeat(64)

describeDb('source documents', () => {
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

  async function refused(sql: string, params: unknown[]): Promise<Error> {
    await db.query('savepoint attempt')
    try {
      await db.query(sql, params)
    } catch (error) {
      await db.query('rollback to savepoint attempt')
      return error as Error
    }
    await db.query('release savepoint attempt')
    throw new Error('the statement was allowed, and should not have been')
  }

  async function seed() {
    await actAsOwner()
    for (const [id, email] of [
      [CHEF, 'docchef@test.local'],
      [CAND, 'doccand@test.local'],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`,
        [id, email],
      )
      await db.query(
        `update public.profiles set approval_status='approved', company_id=$2, outlet_id=$3 where id=$1`,
        [id, fixtures.company, fixtures.outletAiko],
      )
    }
    await db.query(
      `insert into public.companies (id, name, slug) values ($1,'Elsewhere','elsewhere-d0ff')
       on conflict (id) do nothing`,
      [OTHER_CO],
    )

    for (const [id, companyId, sha] of [
      [DOC, fixtures.company, SHA],
      [OTHER_DOC, OTHER_CO, 'b'.repeat(64)],
    ] as const) {
      await db.query(
        `insert into public.source_documents
           (id, company_id, kind, original_filename, storage_path, mime_type,
            byte_size, sha256, uploaded_by, title)
         values ($1,$2,'cookbook',$3,$4,'application/pdf',1024,$5,$6,'Probe cookbook')`,
        [id, companyId, `${id}.pdf`, `${companyId}/${id}/probe.pdf`, sha, CHEF],
      )
    }

    await db.query(
      `insert into public.import_batches (id, company_id, source_document_id, kind, started_by)
       values ($1,$2,$3,'ocr',$4)`,
      [BATCH, fixtures.company, DOC, CHEF],
    )
    await db.query(
      `insert into public.document_pages (company_id, source_document_id, page_number)
       select $1, $2, i from generate_series(1, 5) i`,
      [fixtures.company, DOC],
    )
  }

  const visibleDocs = async () =>
    Number((await db.query('select count(*)::int as n from public.source_documents')).rows[0].n)

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  // ── Scoping ────────────────────────────────────────────────────────────────

  it('shows a chef their own company documents and not another company', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      const { rows } = await db.query('select id, company_id from public.source_documents')
      expect(rows.map((r) => r.id)).toContain(DOC)
      // The assertion that matters: the other company's cookbook is invisible,
      // not merely unlisted by an ORDER BY.
      expect(rows.map((r) => r.id)).not.toContain(OTHER_DOC)
      expect(rows.every((r) => r.company_id === fixtures.company)).toBe(true)
    })
  })

  it('hides documents from someone who cannot read the bank', async () => {
    await scenario(async () => {
      await seed()

      // A candidate holds no questions.read. Documents are the source of the
      // questions they sit exams on; they have no business reading them.
      await actAs(employee(CAND))
      expect(await visibleDocs()).toBe(0)

      // Positive control: the same rows are there, for somebody entitled to them.
      await actAs(chef(CHEF))
      expect(await visibleDocs()).toBeGreaterThan(0)
    })
  })

  it('hides pages and batches from a candidate too', async () => {
    await scenario(async () => {
      await seed()
      await actAs(employee(CAND))

      // OCR text is the cookbook's content in plain form. Leaking pages would
      // leak the book even with the document row hidden.
      const pages = await db.query('select count(*)::int as n from public.document_pages')
      const batches = await db.query('select count(*)::int as n from public.import_batches')
      expect(pages.rows[0].n).toBe(0)
      expect(batches.rows[0].n).toBe(0)

      await actAs(chef(CHEF))
      expect(
        Number((await db.query('select count(*)::int as n from public.document_pages')).rows[0].n),
      ).toBe(5)
    })
  })

  // ── Writes ─────────────────────────────────────────────────────────────────

  it('refuses an upload into another company', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      const error = await refused(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','x.pdf','x/y/x.pdf','application/pdf',10,$2,$3)`,
        [OTHER_CO, 'c'.repeat(64), CHEF],
      )
      expect(error.message).toMatch(/row-level security/i)

      // Positive control: their own company is accepted by the same statement.
      await db.query(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','x.pdf','x/y/x.pdf','application/pdf',10,$2,$3)`,
        [fixtures.company, 'c'.repeat(64), CHEF],
      )
    })
  })

  it('refuses an upload attributed to somebody else', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // uploaded_by is provenance. A row claiming a different uploader would
      // make the audit trail a work of fiction from the first insert.
      const error = await refused(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','y.pdf','y/y/y.pdf','application/pdf',10,$2,$3)`,
        [fixtures.company, 'd'.repeat(64), CAND],
      )
      expect(error.message).toMatch(/row-level security/i)
    })
  })

  it('refuses a candidate uploading at all', async () => {
    await scenario(async () => {
      await seed()
      await actAs(employee(CAND))

      await refused(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','z.pdf','z/z/z.pdf','application/pdf',10,$2,$3)`,
        [fixtures.company, 'e'.repeat(64), CAND],
      )
    })
  })

  // ── Deduplication ──────────────────────────────────────────────────────────

  it('refuses the same file twice in one company', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // The same bytes under a different name. Without this the platform would
      // OCR 113 pages again and build a parallel knowledge tree nobody asked for.
      const error = await refused(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','renamed.pdf','a/b/renamed.pdf','application/pdf',1024,$2,$3)`,
        [fixtures.company, SHA, CHEF],
      )
      expect(error.message).toMatch(/duplicate key|unique/i)
    })
  })

  it('allows two companies to hold the same published manual', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()

      // Per company, not global. A vendor manual both restaurants own is
      // ordinary, and neither should learn about the other from a constraint.
      await db.query(
        `insert into public.source_documents
           (company_id, kind, original_filename, storage_path, mime_type, byte_size, sha256, uploaded_by)
         values ($1,'cookbook','shared.pdf','o/s/shared.pdf','application/pdf',1024,$2,$3)`,
        [OTHER_CO, SHA, CHEF],
      )
      const { rows } = await db.query('select count(*)::int as n from public.source_documents where sha256 = $1', [SHA])
      expect(rows[0].n).toBe(2)
    })
  })

  // ── Removal ────────────────────────────────────────────────────────────────

  it('has no delete policy, so a cited document cannot vanish', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // Matches public.questions, which has no DELETE policy anywhere by design
      // (0010). A paper citing a deleted source is unexplainable.
      const { rowCount } = await db.query('delete from public.source_documents where id = $1', [DOC])
      expect(rowCount).toBe(0)

      // Removal is deleted_at, and it is allowed.
      const soft = await db.query(
        'update public.source_documents set deleted_at = now() where id = $1',
        [DOC],
      )
      expect(soft.rowCount).toBe(1)
    })
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ BOTH UPDATE PATHS, BECAUSE THEY FAIL FOR DIFFERENT REASONS.             │
   * │                                                                         │
   * │ An ordinary column update and a soft delete take different routes       │
   * │ through RLS. The first needs only the UPDATE policy; the second ALSO    │
   * │ needs a SELECT policy that matches the resulting row, because an UPDATE │
   * │ that moves a row outside every SELECT policy is refused outright.       │
   * │                                                                         │
   * │ 0048 shipped without source_documents_read_deleted and the soft delete  │
   * │ was rejected with "new row violates row-level security policy" while    │
   * │ `set title` succeeded — which is exactly what this pair pins.           │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('allows an ordinary update and a soft delete, which are different paths', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      const title = await db.query(
        `update public.source_documents set title = 'Renamed' where id = $1`,
        [DOC],
      )
      expect(title.rowCount, 'an ordinary update').toBe(1)

      const removed = await db.query(
        'update public.source_documents set deleted_at = now() where id = $1',
        [DOC],
      )
      expect(removed.rowCount, 'the soft delete').toBe(1)
    })
  })

  it('lets whoever removed a document see it afterwards, and put it back', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      await db.query('update public.source_documents set deleted_at = now() where id = $1', [DOC])

      // Visible through source_documents_read_deleted, not the ordinary read.
      const { rows } = await db.query(
        'select id, deleted_at from public.source_documents where id = $1',
        [DOC],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].deleted_at).not.toBeNull()

      // And the reverse transition works, which is only true because a SELECT
      // policy covers the row at BOTH ends of it.
      const restored = await db.query(
        'update public.source_documents set deleted_at = null where id = $1',
        [DOC],
      )
      expect(restored.rowCount).toBe(1)
    })
  })

  it('does not let a candidate see removed documents either', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))
      await db.query('update public.source_documents set deleted_at = now() where id = $1', [DOC])

      // The new read policy is scoped by questions.import and company, exactly
      // like the live one. Widening visibility to removed rows must not widen
      // it to people who could never see the document in the first place.
      await actAs(employee(CAND))
      expect(await visibleDocs()).toBe(0)

      await actAs(chef(CHEF))
      expect(await visibleDocs()).toBeGreaterThan(0)
    })
  })

  it('keeps cross-company isolation for removed documents', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()
      // Remove the OTHER company's document. A read policy that matched on
      // deleted_at alone would expose it; this one carries the company predicate
      // at both ends.
      await db.query('update public.source_documents set deleted_at = now() where id = $1', [
        OTHER_DOC,
      ])

      await actAs(chef(CHEF))
      const { rows } = await db.query('select id from public.source_documents')
      expect(rows.map((r) => r.id)).not.toContain(OTHER_DOC)
    })
  })

  it('drops pages with the document, so no page outlives its source', async () => {
    await scenario(async () => {
      await seed()
      await actAsOwner()

      await db.query('delete from public.source_documents where id = $1', [DOC])
      const pages = await db.query(
        'select count(*)::int as n from public.document_pages where source_document_id = $1',
        [DOC],
      )
      const batches = await db.query(
        'select count(*)::int as n from public.import_batches where source_document_id = $1',
        [DOC],
      )
      // ON DELETE CASCADE. A page whose document is gone is an orphan citation.
      expect(pages.rows[0].n).toBe(0)
      expect(batches.rows[0].n).toBe(0)
    })
  })

  it('keeps one row per page number', async () => {
    await scenario(async () => {
      await seed()
      await actAs(chef(CHEF))

      // Page number is the citation anchor. Two rows for page 4 would make
      // "which page did this come from" ambiguous at the bottom of every chain.
      const error = await refused(
        `insert into public.document_pages (company_id, source_document_id, page_number)
         values ($1,$2,4)`,
        [fixtures.company, DOC],
      )
      expect(error.message).toMatch(/duplicate key|unique/i)
    })
  })
})
