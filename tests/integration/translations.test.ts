import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, chef, employee, fixtures, type TestClaims } from './helpers/db'

/**
 * Translation authoring.
 *
 * What this file pins down:
 *
 *   · a translation cannot express what is correct — enforced as a CHECK, so it
 *     holds against psql and bulk import, not just against the RPC
 *   · a blanks template cannot lose a placeholder, because that renders fewer
 *     inputs than there are graded blanks and nothing downstream notices
 *   · "published" means a human approved THIS text: editing a published
 *     translation demotes it back to review
 *   · authorship survives a second editor; the reviewer is whoever published
 */

const describeDb = hasDatabase ? describe : describe.skip

// Own block — tests/unit/fixture-ids.test.ts enforces uniqueness across suites.
const AUTHOR = 'aaaa1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a'
const OTHER = 'bbbb1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a'
const CAND = 'cccc1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a'

const CAT = '00000000-0000-0000-0000-00000000ca1a'
const Q_MCQ = '00000000-0000-0000-0000-0000000ee1a1'
const Q_BLANKS = '00000000-0000-0000-0000-0000000ee1a2'

const MCQ_CONTENT = {
  format: 'choice_single',
  choices: [
    { id: 'a', text: 'Seventy four' },
    { id: 'b', text: 'Sixty three' },
  ],
}
const BLANKS_CONTENT = {
  format: 'blanks',
  template: 'Bacteria multiply between {{low}} and {{high}} degrees.',
  blanks: [{ id: 'low' }, { id: 'high' }],
}

describeDb('question translations', () => {
  let db: Client

  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('begin')
    try {
      return await fn()
    } finally {
      await db.query('rollback')
    }
  }

  async function actAs(claims: TestClaims) {
    await db.query('set local role authenticated')
    await db.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify(claims)])
  }
  const actAsOwner = () => db.query('reset role')

  /** The chef claim set, plus questions.translate. */
  function translator(id: string): TestClaims {
    const base = chef(id)
    return { ...base, app: { ...base.app!, perms: [...(base.app!.perms ?? []), 'questions.translate'] } }
  }

  function save(
    questionId: string,
    locale: string,
    stem: string,
    content: unknown,
    status = 'draft',
  ) {
    return db.query(
      'select * from public.save_question_translation($1,$2,$3,$4::jsonb,null,$5)',
      [questionId, locale, stem, JSON.stringify(content), status],
    )
  }

  async function rowFor(questionId: string, locale: string) {
    const who = await db.query('select current_user as u')
    await actAsOwner()
    const { rows } = await db.query(
      `select status, translated_by, reviewed_by, base_revision, stem, content
         from public.question_translations where question_id=$1 and locale=$2`,
      [questionId, locale],
    )
    if (who.rows[0].u === 'authenticated') await db.query('set local role authenticated')
    return rows[0]
  }

  beforeAll(async () => {
    db = await connect()
    await db.query('begin')

    await db.query('delete from public.questions where id = any($1::uuid[])', [[Q_MCQ, Q_BLANKS]])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[AUTHOR, OTHER, CAND]])
    await db.query('delete from public.categories where id = $1', [CAT])

    await db.query(
      `insert into auth.users (id, email) values
         ($1,'trauthor@test.local'), ($2,'trother@test.local'), ($3,'trcand@test.local')`,
      [AUTHOR, OTHER, CAND],
    )
    await db.query(
      `update public.profiles
          set approval_status='approved', company_id=$2, outlet_id=$3,
              department_id=(select id from public.departments where slug='kitchen' limit 1)
        where id = any($1::uuid[])`,
      [[AUTHOR, OTHER, CAND], fixtures.company, fixtures.outletAiko],
    )
    await db.query(
      `insert into public.categories (id, company_id, name, slug)
       values ($1,$2,'Translation Test','translation-test')`,
      [CAT, fixtures.company],
    )

    for (const [id, fmt, type, content] of [
      [Q_MCQ, 'choice_single', 'mcq_single', MCQ_CONTENT],
      [Q_BLANKS, 'blanks', 'fill_blank', BLANKS_CONTENT],
    ] as const) {
      await db.query(
        `insert into public.questions
           (id, company_id, type, response_format, stem, content, category_id,
            difficulty, marks, status, created_by)
         values ($1,$2,$3,$4,'What is the danger zone?',$5::jsonb,$6,3,2,'active',$7)`,
        [id, fixtures.company, type, fmt, JSON.stringify(content), CAT, AUTHOR],
      )
    }
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key) values
         ($1,'{"format":"choice_single","correct":"a"}'::jsonb),
         ($2,$3::jsonb)`,
      [
        Q_MCQ, Q_BLANKS,
        JSON.stringify({
          format: 'blanks',
          partialCredit: true,
          blanks: [
            { id: 'low', accept: ['5'], match: 'ci' },
            { id: 'high', accept: ['63'], match: 'ci' },
          ],
        }),
      ],
    )
    await db.query('commit')
  })

  afterAll(async () => {
    await db.query('begin')
    await db.query('reset role')
    await db.query('delete from public.questions where id = any($1::uuid[])', [[Q_MCQ, Q_BLANKS]])
    await db.query('delete from public.categories where id = $1', [CAT])
    await db.query('delete from auth.users where id = any($1::uuid[])', [[AUTHOR, OTHER, CAND]])
    await db.query('commit')
    await db.end()
  })

  // ── The presentation-only invariant ────────────────────────────────────────

  describe('a translation cannot express what is correct', () => {
    /**
     * Run as the OWNER, with RLS off and the RPC bypassed entirely — because
     * the RPC is not the only writer. psql, a seed, a bulk import and an AI
     * generation pass all reach this table directly, which is why 0009's rule
     * had to become a CHECK rather than a validation step.
     */
    it.each([
      ['a top-level correct key', { choices: { a: 'सही' }, correct: 'a' }],
      ['an accept list', { choices: { a: 'सही' }, accept: ['74'] }],
      ['a nested object', { choices: { a: { text: 'सही', correct: true } } }],
      ['a boolean leaf', { choices: { a: true } }],
      ['an array leaf', { choices: { a: ['सही'] } }],
    ])('refuses %s, even as the table owner', async (_label, content) => {
      await scenario(async () => {
        await actAsOwner()
        await expect(
          db.query(
            `insert into public.question_translations (question_id, locale, stem, content)
             values ($1,'hi','x',$2::jsonb)`,
            [Q_MCQ, JSON.stringify(content)],
          ),
        ).rejects.toThrow(/presentation_only/i)
      })
    })

    /**
     * The CHECK guarantees SHAPE, not that ids are meaningful — and it cannot
     * do more. `{choices: {correct: "…"}}` is a display string keyed by an id
     * that happens to be spelled "correct", which is indistinguishable from a
     * legitimate id at the structural level. It is also harmless: grading never
     * reads translation content, so an id the base lacks simply renders
     * nothing. Catching it is tier two's job, against the base row.
     */
    it('leaves an unknown id to the base-row check rather than the constraint', async () => {
      await scenario(async () => {
        await actAsOwner()
        await db.query(
          `insert into public.question_translations (question_id, locale, stem, content)
           values ($1,'hi','x','{"choices":{"correct":"क"}}'::jsonb)`,
          [Q_MCQ],
        )
        // Structurally fine. The RPC is what refuses it.
        await actAs(translator(AUTHOR))
        await expect(
          save(Q_MCQ, 'gu', 'x', { choices: { correct: 'ક' } }),
        ).rejects.toThrow(/no "correct" in the question/i)
      })
    })

    it('accepts a translation that is only display strings', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'खतरे का क्षेत्र क्या है?', { choices: { a: 'चौहत्तर', b: 'तिरसठ' } })
        expect((await rowFor(Q_MCQ, 'hi')).stem).toBe('खतरे का क्षेत्र क्या है?')
      })
    })

    it('holds a format with nothing to translate to an empty object', async () => {
      await scenario(async () => {
        await actAsOwner()
        // choice_single has no `items` key; only `choices` is legal for it.
        await expect(
          db.query(
            `insert into public.question_translations (question_id, locale, stem, content)
             values ($1,'hi','x','{"items":{"a":"x"}}'::jsonb)`,
            [Q_MCQ],
          ),
        ).rejects.toThrow(/presentation_only/i)
      })
    })
  })

  // ── Agreement with the base row ────────────────────────────────────────────

  describe('agreement with the question', () => {
    it('refuses an id the question does not have', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await expect(
          save(Q_MCQ, 'hi', 'x', { choices: { a: 'सही', zz: 'भूत' } }),
        ).rejects.toThrow(/no "zz" in the question/i)
      })
    })

    /**
     * The highest-value check in the slice. A template that loses {{high}}
     * renders one input where the key grades two: the candidate cannot answer
     * a blank they are marked on, and 0027 scores it wrong in silence.
     */
    it('refuses a blanks template that drops a placeholder', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await expect(
          save(Q_BLANKS, 'hi', 'x', { template: 'बैक्टीरिया {{low}} डिग्री पर बढ़ते हैं।' }),
        ).rejects.toThrow(/blanks must match the question/i)
      })
    })

    it('refuses a blanks template that invents a placeholder', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await expect(
          save(Q_BLANKS, 'hi', 'x', {
            template: '{{low}} से {{high}} और {{extra}} डिग्री।',
          }),
        ).rejects.toThrow(/blanks must match the question/i)
      })
    })

    it('accepts a template carrying exactly the same placeholders', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_BLANKS, 'hi', 'x', {
          template: 'बैक्टीरिया {{low}} से {{high}} डिग्री के बीच बढ़ते हैं।',
        })
        expect((await rowFor(Q_BLANKS, 'hi')).content.template).toContain('{{high}}')
      })
    })
  })

  // ── The review workflow ────────────────────────────────────────────────────

  describe('the review workflow', () => {
    it('refuses to create a translation already published', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await expect(
          save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'published'),
        ).rejects.toThrow(/cannot start published/i)
      })
    })

    it('refuses to publish a draft without review', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'draft')
        await expect(
          save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'published'),
        ).rejects.toThrow(/must be reviewed/i)
      })
    })

    it('publishes from review and stamps the reviewer', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'review')

        await actAs(translator(OTHER))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'published')

        const row = await rowFor(Q_MCQ, 'hi')
        expect(row.status).toBe('published')
        // Authorship stays with whoever wrote it first.
        expect(row.translated_by).toBe(AUTHOR)
        expect(row.reviewed_by).toBe(OTHER)
      })
    })

    /**
     * Without this, "published" is decoration: a reviewer approves text, the
     * translator rewrites it, and the row stays green while candidates read
     * strings nobody approved.
     */
    it('demotes a published translation when its text is edited', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'review')
        await actAs(translator(OTHER))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } }, 'published')

        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'rewritten', { choices: { a: 'ख' } }, 'published')

        const row = await rowFor(Q_MCQ, 'hi')
        expect(row.status).toBe('review')
        expect(row.reviewed_by).toBeNull()
      })
    })

    it('leaves a published translation alone when only the status is re-sent', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'same', { choices: { a: 'क' } }, 'review')
        await actAs(translator(OTHER))
        await save(Q_MCQ, 'hi', 'same', { choices: { a: 'क' } }, 'published')
        await save(Q_MCQ, 'hi', 'same', { choices: { a: 'क' } }, 'published')

        expect((await rowFor(Q_MCQ, 'hi')).status).toBe('published')
      })
    })
  })

  // ── Staleness ──────────────────────────────────────────────────────────────

  describe('base_revision', () => {
    it('records the wording the translation was made from', async () => {
      await scenario(async () => {
        await actAsOwner()
        const { rows: q } = await db.query('select revision from public.questions where id=$1', [
          Q_MCQ,
        ])

        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } })
        expect((await rowFor(Q_MCQ, 'hi')).base_revision).toBe(q[0].revision)
      })
    })

    it('leaves the stamp behind when the question is reworded', async () => {
      await scenario(async () => {
        await actAs(translator(AUTHOR))
        await save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } })
        const before = (await rowFor(Q_MCQ, 'hi')).base_revision

        await actAsOwner()
        await db.query(
          'update public.questions set stem = $2, revision = revision + 1 where id = $1',
          [Q_MCQ, 'Reworded stem'],
        )
        const { rows: q } = await db.query('select revision from public.questions where id=$1', [
          Q_MCQ,
        ])

        // The translation now describes wording that no longer exists, and the
        // gap is visible rather than silent.
        expect(before).toBeLessThan(q[0].revision)
        expect((await rowFor(Q_MCQ, 'hi')).base_revision).toBe(before)
      })
    })
  })

  // ── Permission ─────────────────────────────────────────────────────────────

  describe('permission', () => {
    it('refuses a candidate', async () => {
      await scenario(async () => {
        await actAs(employee(CAND))
        await expect(save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } })).rejects.toThrow()
      })
    })

    /**
     * The real chef role HOLDS questions.translate, so the fixture has to strip
     * it deliberately. Reading the question is still allowed — which is the
     * asymmetry worth proving: someone can review the bank without being able
     * to change what it says in another language.
     */
    it('refuses somebody who can read questions but not translate them', async () => {
      await scenario(async () => {
        const base = chef(AUTHOR)
        await actAs({
          ...base,
          app: { ...base.app!, perms: (base.app!.perms ?? []).filter((p) => p !== 'questions.translate') },
        })

        const { rows } = await db.query('select id from public.questions where id=$1', [Q_MCQ])
        expect(rows).toHaveLength(1) // reading is fine

        await expect(save(Q_MCQ, 'hi', 'x', { choices: { a: 'क' } })).rejects.toThrow()
      })
    })
  })
})
