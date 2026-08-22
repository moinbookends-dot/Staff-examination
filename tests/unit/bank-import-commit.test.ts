import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { analyseImport } from '@/lib/bank/import/analyse'
import { importQuestionSchema } from '@/lib/bank/import/format'
import { batchRows, toCommitRow, IMPORT_BATCH_SIZE } from '@/lib/bank/import/commit'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The commit shape.
 *
 * bank_import_commit() (0058) reads exactly these key names out of JSON. SQL
 * cannot typecheck against TypeScript, so a rename on either side fails at
 * runtime, mid-import, holding a 3,000-row file — these tests are the only
 * thing joining the two.
 *
 * Neutral scaffolding content, same as bank-import.test.ts: the point is the
 * shape, not the subject matter.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const parse = (raw: unknown) => importQuestionSchema.parse(raw)

const MCQ = {
  externalId: 'e-0001',
  difficulty: 'easy',
  type: 'mcq',
  topic: 'Food Safety',
  correctOption: 'C',
  en: {
    question: 'First question',
    options: { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta' },
    explanation: 'Because Charlie.',
  },
  hi: {
    question: 'पहला प्रश्न',
    options: { A: 'अ', B: 'ब', C: 'स', D: 'द' },
  },
}

const SHORT = {
  difficulty: 'hard',
  type: 'short_answer',
  en: { question: 'Second question', answer: 'An answer' },
}

describe('toCommitRow — the key names bank_import_commit() reads', () => {
  it('carries every top-level field the function looks up', () => {
    const row = toCommitRow(parse(MCQ))

    // Each of these is a `v_row->>'…'` in 0058. A rename here is a silent
    // null there.
    expect(Object.keys(row).sort()).toEqual(
      [
        'correctOption',
        'difficulty',
        'externalId',
        'qtype',
        'referencePage',
        'referenceTitle',
        'status',
        'texts',
        'topicSlug',
      ].sort(),
    )
  })

  it('carries every text field the function looks up', () => {
    const row = toCommitRow(parse(MCQ))

    expect(Object.keys(row.texts[0]).sort()).toEqual(
      [
        'answerText',
        'explanation',
        'locale',
        'optionA',
        'optionB',
        'optionC',
        'optionD',
        'question',
      ].sort(),
    )
  })

  it('renames the contract\'s `type` to the column\'s `qtype`', () => {
    expect(toCommitRow(parse(MCQ)).qtype).toBe('mcq')
    expect(toCommitRow(parse(SHORT)).qtype).toBe('short_answer')
  })

  it('slugifies the topic with the shared function, so the dry run and the commit agree', () => {
    // "Food Safety" was accepted by the report against the slug list; it has to
    // match the same way here or a validated import aborts at commit.
    expect(toCommitRow(parse(MCQ)).topicSlug).toBe('food-safety')
  })

  it('transposes named language keys into one row per language', () => {
    const row = toCommitRow(parse(MCQ))

    expect(row.texts.map((t) => t.locale)).toEqual(['en', 'hi'])
    expect(row.texts[1].question).toBe('पहला प्रश्न')
    expect(row.texts[1].optionC).toBe('स')
  })

  it('omits a language that is absent rather than emitting a blank row', () => {
    const row = toCommitRow(parse(MCQ))
    expect(row.texts.some((t) => t.locale === 'gu')).toBe(false)
  })

  it('nulls the fields the other question type must not carry', () => {
    const mcq = toCommitRow(parse(MCQ)).texts[0]
    expect(mcq.answerText).toBeNull()
    expect(mcq.optionA).toBe('Alpha')

    const short = toCommitRow(parse(SHORT)).texts[0]
    expect(short.optionA).toBeNull()
    expect(short.optionB).toBeNull()
    expect(short.optionC).toBeNull()
    expect(short.optionD).toBeNull()
    expect(short.answerText).toBe('An answer')
  })

  it('nulls correctOption for a short answer and keeps the POSITION for an MCQ', () => {
    // The position, never the option text — a translation must not be able to
    // change what is correct.
    expect(toCommitRow(parse(MCQ)).correctOption).toBe('C')
    expect(toCommitRow(parse(SHORT)).correctOption).toBeNull()
  })

  it('nulls an absent externalId rather than inventing one', () => {
    expect(toCommitRow(parse(SHORT)).externalId).toBeNull()
    expect(toCommitRow(parse(MCQ)).externalId).toBe('e-0001')
  })

  it('carries the explanation per language, and null where there is none', () => {
    const row = toCommitRow(parse(MCQ))
    expect(row.texts[0].explanation).toBe('Because Charlie.')
    expect(row.texts[1].explanation).toBeNull()
  })

  it('defaults status to active, matching the contract', () => {
    expect(toCommitRow(parse(MCQ)).status).toBe('active')
  })

  it('preserves the draft downgrade the report applied', () => {
    // A row asking for active while missing a REQUIRED language is held back as
    // a draft by analyse.ts. The commit must not undo that: the completeness
    // trigger would refuse it and abort the whole batch.
    const report = analyseImport(JSON.stringify({ questions: [MCQ] }), {
      requiredLocales: ['en', 'hi', 'gu'],
    })

    expect(report.downgradedToDraftCount).toBe(1)
    expect(toCommitRow(report.toImport[0]).status).toBe('draft')
  })

  it('nulls a reference that was never given', () => {
    const row = toCommitRow(parse(SHORT))
    expect(row.referenceTitle).toBeNull()
    expect(row.referencePage).toBeNull()
  })

  it('carries a reference through when one was given', () => {
    const row = toCommitRow(
      parse({ ...SHORT, reference: { document: 'The Cookbook', page: 42 } }),
    )
    expect(row.referenceTitle).toBe('The Cookbook')
    expect(row.referencePage).toBe(42)
  })

  it('survives JSON round-tripping, which is how it actually reaches the function', () => {
    const row = toCommitRow(parse(MCQ))
    expect(JSON.parse(JSON.stringify(row))).toEqual(row)
  })
})

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE JOIN BETWEEN TYPESCRIPT AND SQL, WHICH NOTHING ELSE CHECKS.           ║
 * ║                                                                           ║
 * ║ bank_import_commit() pulls its values out of JSON by string key. Rename a ║
 * ║ field in CommitRow and TypeScript is perfectly happy; the function then   ║
 * ║ reads null for it and writes a row with a missing question, or aborts a   ║
 * ║ 3,000-row import on a NOT NULL violation nobody can trace back.           ║
 * ║                                                                           ║
 * ║ So the assertion reads the migration itself. If this fails, the two sides ║
 * ║ have drifted — fix whichever one moved, do not relax the test.            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
describe('the SQL function and CommitRow agree on every key', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../supabase/migrations/20260808110000_0058_bank_import.sql'),
    'utf8',
  )

  const keysRead = (variable: string) =>
    new Set(
      [...sql.matchAll(new RegExp(`${variable}->>'([a-zA-Z]+)'`, 'g'))].map((m) => m[1]),
    )

  it('reads exactly the top-level keys toCommitRow emits', () => {
    const emitted = new Set(Object.keys(toCommitRow(parse(MCQ))))
    emitted.delete('texts') // read with -> as an array, not ->> as a scalar

    for (const key of keysRead('v_row')) {
      expect(emitted, `SQL reads v_row->>'${key}' which toCommitRow never emits`).toContain(key)
    }
    // The reverse direction is deliberately not asserted: emitting a field the
    // function ignores is harmless, and the row shape may gain fields before
    // the SQL uses them.
  })

  it('reads exactly the text keys toCommitRow emits', () => {
    const emitted = new Set(Object.keys(toCommitRow(parse(MCQ)).texts[0]))

    for (const key of keysRead('v_text')) {
      expect(emitted, `SQL reads v_text->>'${key}' which toCommitRow never emits`).toContain(key)
    }
  })

  it('iterates the texts array under the name toCommitRow gives it', () => {
    expect(sql).toContain("jsonb_array_elements(v_row->'texts')")
  })

  it('is SECURITY INVOKER — atomicity must not come with elevation', () => {
    // 0057 is definer because it deliberately reads past RLS. This one writes,
    // and every write must stay subject to the caller's own policies.
    const body = sql.slice(sql.indexOf('create or replace function public.bank_import_commit'))
    expect(body).not.toMatch(/security\s+definer/i)
  })
})

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE REPORT MUST NOT PROMISE MORE THAN THE COMMIT DELIVERS.                ║
 * ║                                                                           ║
 * ║ Regression lock for a stabilization-audit finding: a file carrying the     ║
 * ║ same externalId on two DIFFERENT questions passed the dry run as "2 new"   ║
 * ║ and stored 1, because bank_import_commit() matches on externalId and the   ║
 * ║ second row updated the first. Silent loss of a question, with no rejection ║
 * ║ and no duplicate reported.                                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
describe('duplicate externalId within one file', () => {
  const twice = (a: string, b: string) =>
    JSON.stringify({
      questions: [
        {
          externalId: 'dup-1', difficulty: 'easy', type: 'mcq', correctOption: 'A',
          en: { question: a, options: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        },
        {
          externalId: 'dup-1', difficulty: 'easy', type: 'mcq', correctOption: 'B',
          en: { question: b, options: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        },
      ],
    })

  it('reports the second occurrence instead of silently dropping it', () => {
    const report = analyseImport(twice('First distinct question', 'Second distinct question'))

    expect(report.duplicateCount).toBe(1)
    expect(report.duplicates[0]).toMatchObject({ row: 2, firstSeenAtRow: 1 })
  })

  it('promises exactly what the commit will store', () => {
    // The whole point: report total === rows the database ends up with.
    const report = analyseImport(twice('First distinct question', 'Second distinct question'))
    expect(report.importedCount + report.updatedCount).toBe(1)
  })

  it('keeps the FIRST occurrence, matching how repeated text is handled', () => {
    const report = analyseImport(twice('First distinct question', 'Second distinct question'))
    expect(report.toImport[0].en.question).toBe('First distinct question')
  })

  it('still allows the same externalId across separate imports', () => {
    // Re-importing a file is an UPDATE, not a duplicate — that is the whole
    // reason externalId is permanent.
    const single = JSON.stringify({
      questions: [{
        externalId: 'dup-1', difficulty: 'easy', type: 'mcq', correctOption: 'A',
        en: { question: 'Only question', options: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      }],
    })

    const report = analyseImport(single, { existingExternalIds: ['dup-1'] })
    expect(report.updatedCount).toBe(1)
    expect(report.duplicateCount).toBe(0)
  })

  it('does not treat rows WITHOUT an externalId as duplicates of each other', () => {
    // Absent ids are not a shared identity — two anonymous questions with
    // different text are two questions.
    const anon = JSON.stringify({
      questions: [
        { difficulty: 'easy', type: 'short_answer', en: { question: 'Question one', answer: 'a' } },
        { difficulty: 'easy', type: 'short_answer', en: { question: 'Question two', answer: 'b' } },
      ],
    })

    const report = analyseImport(anon)
    expect(report.duplicateCount).toBe(0)
    expect(report.importedCount).toBe(2)
  })
})

describe('batchRows', () => {
  it('keeps every row exactly once', () => {
    const rows = Array.from({ length: 450 }, (_, i) => i)
    const batches = batchRows(rows, 200)

    expect(batches.map((b) => b.length)).toEqual([200, 200, 50])
    expect(batches.flat()).toEqual(rows)
  })

  it('never splits a question across two batches', () => {
    // Each element is a whole question, so a batch boundary can only fall
    // between questions — which is what makes a failed batch describable.
    const rows = [toCommitRow(parse(MCQ)), toCommitRow(parse(SHORT))]
    const batches = batchRows(rows, 1)

    expect(batches).toHaveLength(2)
    expect(batches[0][0].texts).toHaveLength(2)
    expect(batches[1][0].texts).toHaveLength(1)
  })

  it('returns nothing for an empty list rather than one empty batch', () => {
    expect(batchRows([], 200)).toEqual([])
  })

  it('refuses a zero batch size instead of looping forever', () => {
    expect(() => batchRows([1, 2, 3], 0)).toThrow()
  })

  it('has a default batch size well under any plausible request limit', () => {
    expect(IMPORT_BATCH_SIZE).toBeGreaterThan(0)
    expect(IMPORT_BATCH_SIZE).toBeLessThanOrEqual(500)
  })
})
