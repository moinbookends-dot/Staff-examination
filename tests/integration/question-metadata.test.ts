import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, fixtures } from './helpers/db'

/**
 * Question metadata — bloom_level, source, imported_from.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ PROVENANCE IS THE POINT OF THIS FILE.                                     │
 * │                                                                           │
 * │ `source` and `imported_from` say where a question CAME FROM. The editor    │
 * │ sends neither, and save_question (0039) coalesces a missing value to the   │
 * │ stored one — so an edit cannot overwrite them. That is a structural        │
 * │ guarantee rather than a rule, and this is what holds it structural: if     │
 * │ somebody later "tidies" the defaults back to `default 'manual'`, or wires  │
 * │ p_source into saveQuestion, these tests go red.                            │
 * │                                                                           │
 * │ It matters because nothing else in the schema remembers where a question   │
 * │ came from. Once overwritten it is not recoverable from anywhere.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const QUESTION = '00000000-0000-0000-0000-0000000abb01'

const CONTENT =
  '{"format":"choice_single","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'
const KEY = '{"format":"choice_single","correct":"a"}'

describeDb('question metadata', () => {
  let db: Client

  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('begin')
    try {
      return await fn()
    } finally {
      await db.query('rollback')
    }
  }

  async function anAuthor(): Promise<string> {
    const { rows } = await db.query(
      'select id from public.profiles where company_id = $1 limit 1',
      [fixtures.company],
    )
    return rows[0].id as string
  }

  /** Acts as the author, since save_question is SECURITY INVOKER. */
  async function actAsAuthor(id: string) {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        sub: id,
        role: 'authenticated',
        app: {
          approved: true,
          company_id: fixtures.company,
          roles: ['chef'],
          perms: ['questions.create', 'questions.update', 'questions.read'],
        },
      }),
    ])
  }

  /** Exactly the arguments saveQuestion() sends — no provenance among them. */
  async function editAsTheUiWould(id: string, stem: string) {
    await db.query(
      `select * from public.save_question(
         p_id := $1, p_type := 'mcq_single', p_response_format := 'choice_single',
         p_stem := $2, p_content := $3::jsonb, p_answer_key := $4::jsonb)`,
      [id, stem, CONTENT, KEY],
    )
  }

  beforeAll(async () => {
    db = await connect()
  })
  afterAll(async () => {
    await db.end()
  })

  it('records an imported question with its origin', async () => {
    await scenario(async () => {
      const author = await anAuthor()
      await actAsAuthor(author)

      const { rows } = await db.query(
        `select * from public.save_question(
           p_id := null, p_type := 'mcq_single', p_response_format := 'choice_single',
           p_stem := 'Imported probe', p_content := $1::jsonb, p_answer_key := $2::jsonb,
           p_source := 'import', p_imported_from := 'moodle_xml',
           p_bloom_level := 'analyze')`,
        [CONTENT, KEY],
      )

      const { rows: [q] } = await db.query(
        'select source, imported_from, bloom_level from public.questions where id = $1',
        [rows[0].id],
      )
      expect(q.source).toBe('import')
      expect(q.imported_from).toBe('moodle_xml')
      expect(q.bloom_level).toBe('analyze')
    })
  })

  it('preserves source and imported_from through an ordinary edit', async () => {
    await scenario(async () => {
      const author = await anAuthor()
      await db.query(
        `insert into public.questions (id, company_id, created_by, type, response_format, stem, content, source, imported_from)
         values ($1, $2, $3, 'mcq_single', 'choice_single', 'Provenance probe', $4::jsonb, 'import', 'moodle_xml')`,
        [QUESTION, fixtures.company, author, CONTENT],
      )
      await actAsAuthor(author)

      await editAsTheUiWould(QUESTION, 'Provenance probe, reworded by a chef')

      const { rows: [q] } = await db.query(
        'select stem, source, imported_from from public.questions where id = $1',
        [QUESTION],
      )
      // The edit landed…
      expect(q.stem).toBe('Provenance probe, reworded by a chef')
      // …and the origin did not move with it.
      expect(q.source).toBe('import')
      expect(q.imported_from).toBe('moodle_xml')
    })
  })

  it('preserves an AI origin the same way', async () => {
    await scenario(async () => {
      const author = await anAuthor()
      await db.query(
        `insert into public.questions (id, company_id, created_by, type, response_format, stem, content, source)
         values ($1, $2, $3, 'mcq_single', 'choice_single', 'AI probe', $4::jsonb, 'ai')`,
        [QUESTION, fixtures.company, author, CONTENT],
      )
      await actAsAuthor(author)

      await editAsTheUiWould(QUESTION, 'AI probe, edited')

      const { rows: [q] } = await db.query(
        'select source from public.questions where id = $1',
        [QUESTION],
      )
      expect(q.source).toBe('ai')
    })
  })

  it('defaults a question nobody described to manual, rather than to null', async () => {
    await scenario(async () => {
      await actAsAuthor(await anAuthor())
      const { rows } = await db.query(
        `select * from public.save_question(
           p_id := null, p_type := 'mcq_single', p_response_format := 'choice_single',
           p_stem := 'Plain probe', p_content := $1::jsonb, p_answer_key := $2::jsonb)`,
        [CONTENT, KEY],
      )
      const { rows: [q] } = await db.query(
        'select source, bloom_level from public.questions where id = $1',
        [rows[0].id],
      )
      expect(q.source).toBe('manual')
      // Bloom genuinely is unknown until somebody sets it, and null is the
      // honest answer — M9's distribution check has to distinguish "not
      // classified" from "classified as remember".
      expect(q.bloom_level).toBeNull()
    })
  })

  it('lets an importer set an origin explicitly, so the coalesce is not a wall', async () => {
    await scenario(async () => {
      const author = await anAuthor()
      await db.query(
        `insert into public.questions (id, company_id, created_by, type, response_format, stem, content)
         values ($1, $2, $3, 'mcq_single', 'choice_single', 'Was manual', $4::jsonb)`,
        [QUESTION, fixtures.company, author, CONTENT],
      )
      await actAsAuthor(author)

      await db.query(
        `select * from public.save_question(
           p_id := $1, p_type := 'mcq_single', p_response_format := 'choice_single',
           p_stem := 'Now attributed', p_content := $2::jsonb, p_answer_key := $3::jsonb,
           p_source := 'ai')`,
        [QUESTION, CONTENT, KEY],
      )

      const { rows: [q] } = await db.query(
        'select source from public.questions where id = $1',
        [QUESTION],
      )
      expect(q.source).toBe('ai')
    })
  })

  it('rejects a source outside the vocabulary the column allows', async () => {
    await scenario(async () => {
      await actAsAuthor(await anAuthor())
      await expect(
        db.query(
          `select * from public.save_question(
             p_id := null, p_type := 'mcq_single', p_response_format := 'choice_single',
             p_stem := 'Bad source', p_content := $1::jsonb, p_answer_key := $2::jsonb,
             p_source := 'gemini')`,
          [CONTENT, KEY],
        ),
      ).rejects.toThrow()
    })
  })

  it('round-trips every Bloom level the enum defines', async () => {
    await scenario(async () => {
      await actAsAuthor(await anAuthor())
      const { rows: levels } = await db.query(
        `select unnest(enum_range(null::public.bloom_taxonomy))::text as level`,
      )
      expect(levels.length).toBe(6)

      for (const { level } of levels) {
        const { rows } = await db.query(
          `select * from public.save_question(
             p_id := null, p_type := 'mcq_single', p_response_format := 'choice_single',
             p_stem := $3, p_content := $1::jsonb, p_answer_key := $2::jsonb,
             p_bloom_level := $4::public.bloom_taxonomy)`,
          [CONTENT, KEY, `Bloom probe ${level}`, level],
        )
        const { rows: [q] } = await db.query(
          'select bloom_level from public.questions where id = $1',
          [rows[0].id],
        )
        expect(q.bloom_level, level).toBe(level)
      }
    })
  })
})
