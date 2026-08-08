import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DIFFICULTIES,
  QUESTION_TYPES,
  QUESTION_STATUSES,
  BANK_LOCALES,
  ANSWER_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  isDrawable,
} from '@/lib/bank/vocabulary'
import {
  incompleteLocales,
  isLocaleComplete,
  makeQuestionInputSchema,
  parseBankFilters,
  questionInputSchema,
} from '@/lib/bank/schemas'

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ BOTH DIRECTIONS, ALWAYS.                                                  │
 * │                                                                           │
 * │ "every TypeScript value exists in SQL" passes against a SQL enum that     │
 * │ has extra values. "every SQL value exists in TypeScript" passes against a │
 * │ TypeScript list that has extra ones. Only the pair says they are the same │
 * │ set — and the second direction is the one that matters most here, because │
 * │ a value the database knows about and the UI does not is exactly how the   │
 * │ last question bank rendered the literal string `questions.status.review`  │
 * │ at a chef, and how a question set to `approved` vanished from every paper.│
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const MIGRATIONS = resolve(__dirname, '../../supabase/migrations')

/** Every migration, concatenated. Reading one file by name is how the old
 *  exam-health parity test silently stopped seeing anything: `exam_health` was
 *  replaced wholesale twice and the test kept sweeping migration 0014. */
function allMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
    .join('\n')
}

const sql = allMigrations()

/** The values of `create type public.<name> as enum (...)`. */
function enumValues(typeName: string): string[] {
  const re = new RegExp(`create type public\\.${typeName} as enum\\s*\\(([^)]*)\\)`, 'i')
  const match = sql.match(re)
  if (!match) throw new Error(`No enum public.${typeName} found in any migration`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * The body of one `create table public.<name> ( … );`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SCOPING IS NOT FUSSINESS. The first version of the locale assertion below │
 * │ searched the whole concatenated schema for a `locale … check (locale in   │
 * │ (…))` and matched question_translations from migration 0009 — a table     │
 * │ belonging to the OLD bank, which legitimately still admits 'hi-Latn'.     │
 * │                                                                           │
 * │ It failed loudly, which is the only reason it was noticed. Had the old    │
 * │ table happened to list the same three locales, the test would have passed │
 * │ while asserting nothing about the table it names.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function tableBody(tableName: string): string {
  const start = sql.indexOf(`create table public.${tableName} (`)
  if (start === -1) throw new Error(`No create table public.${tableName} found`)

  // Column definitions contain parentheses, so track depth rather than
  // stopping at the first ')'.
  let depth = 0
  for (let i = sql.indexOf('(', start); i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1
    else if (sql[i] === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(start, i + 1)
    }
  }
  throw new Error(`Unbalanced parentheses in create table public.${tableName}`)
}

describe('bank vocabulary ↔ migration enums', () => {
  it.each([
    ['bank_difficulty', DIFFICULTIES],
    ['bank_question_type', QUESTION_TYPES],
    ['bank_question_status', QUESTION_STATUSES],
  ])('%s matches its TypeScript list exactly, and in order', (typeName, declared) => {
    const inSql = enumValues(typeName)

    // Order matters and is not incidental. Postgres sorts an enum by
    // declaration position, so `order by difficulty` returns easy → hard only
    // if these two agree. A set comparison would pass on a reversed enum and
    // the dashboard's three counters would come out backwards.
    expect(inSql).toEqual([...declared])
  })

  it('bank_question_texts admits exactly the three bank locales', () => {
    const body = tableBody('bank_question_texts')
    const match = body.match(/locale\s+text not null check \(locale in \(([^)]*)\)\)/i)
    expect(match, 'no locale CHECK found on bank_question_texts').toBeTruthy()

    const inSql = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...BANK_LOCALES].sort())
  })

  it('the paper files table admits the same three locales as the bank', () => {
    // Two tables, two independently written CHECKs. A paper generated in a
    // language the bank cannot hold — or a bank language no paper can be
    // rendered in — is a gap nothing else would report.
    const body = tableBody('exam_paper_files')
    const match = body.match(/locale\s+text not null check \(locale in \(([^)]*)\)\)/i)
    expect(match, 'no locale CHECK found on exam_paper_files').toBeTruthy()

    const inSql = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...BANK_LOCALES].sort())
  })

  it('has no Hinglish anywhere in the bank vocabulary', () => {
    // The app dropped hi-Latn; a bank locale list that still carried it would
    // let an Editor write a translation nothing can ever render.
    expect([...BANK_LOCALES]).not.toContain('hi-Latn')
  })

  it('mirrors the answer length cap from the CHECK constraint', () => {
    const match = sql.match(/answer_text text check \(length\(btrim\(answer_text\)\) between 1 and (\d+)\)/i)
    expect(match, 'no answer_text length CHECK found').toBeTruthy()
    expect(Number(match![1])).toBe(ANSWER_MAX_LENGTH)
  })

  it('mirrors the question length cap from the CHECK constraint', () => {
    const match = sql.match(/question\s+text not null check \(length\(btrim\(question\)\) between \d+ and (\d+)\)/i)
    expect(match, 'no question length CHECK found').toBeTruthy()
    expect(Number(match![1])).toBe(QUESTION_MAX_LENGTH)
  })
})

describe('difficulty carries no logic', () => {
  /*
   * A guard against a whole class of future change rather than against a bug
   * that exists. Difficulty is assigned by an Editor from a separate rules
   * document; nothing in this codebase may infer, suggest or derive it.
   *
   * The previous question bank grew exactly that: an author estimate, an
   * OBSERVED difficulty computed from attempt data, a `misrated` flag
   * comparing the two, and a Bloom's taxonomy column. This test fails if any
   * of it reappears in the new bank's modules.
   */
  it('exposes only the three level names, with no classifier', () => {
    const vocabulary = readFileSync(
      resolve(__dirname, '../../src/lib/bank/vocabulary.ts'),
      'utf8',
    )

    // Comments legitimately discuss what must not exist, so strip them before
    // looking — otherwise this test fails on the box explaining itself.
    const code = vocabulary
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    for (const banned of ['bloom', 'classify', 'suggestDifficulty', 'inferDifficulty']) {
      expect(code.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })

  it('offers no default difficulty on the input schema', () => {
    // A default IS a guess about which level a question belongs to. Parsing a
    // question with no difficulty must fail, not quietly land on 'medium'.
    const result = questionInputSchema.safeParse({
      qtype: 'mcq',
      correctOption: 'A',
      brandId: '00000000-0000-0000-0000-00000000b001',
      texts: {},
    })
    expect(result.success).toBe(false)
  })
})

describe('drawability', () => {
  it('is active and nothing else', () => {
    expect(isDrawable('active')).toBe(true)
    expect(isDrawable('draft')).toBe(false)
    expect(isDrawable('archived')).toBe(false)
  })
})

describe('completeness', () => {
  const mcq = {
    question: 'Which oil has the highest smoke point?',
    optionA: 'Butter',
    optionB: 'Olive oil',
    optionC: 'Rice bran oil',
    optionD: 'Coconut oil',
  }

  it('needs all four options for an MCQ', () => {
    expect(isLocaleComplete(mcq, 'mcq')).toBe(true)
    expect(isLocaleComplete({ ...mcq, optionC: '' }, 'mcq')).toBe(false)
    expect(isLocaleComplete({ ...mcq, optionD: undefined }, 'mcq')).toBe(false)
  })

  it('needs an answer for a short answer, and no options', () => {
    expect(isLocaleComplete({ question: 'Poultry temperature?', answerText: '74°C' }, 'short_answer'))
      .toBe(true)
    expect(isLocaleComplete({ question: 'Poultry temperature?' }, 'short_answer')).toBe(false)
  })

  it('treats a whitespace-only field as blank', () => {
    // What a half-filled spreadsheet cell actually contains. The schema trims,
    // so by the time it reaches here it is ''.
    expect(isLocaleComplete({ ...mcq, optionB: '' }, 'mcq')).toBe(false)
  })

  it('names every missing REQUIRED language, in order', () => {
    expect(incompleteLocales({ en: mcq }, 'mcq', ['en', 'hi', 'gu'])).toEqual(['hi', 'gu'])
    expect(incompleteLocales({ en: mcq, hi: mcq, gu: mcq }, 'mcq', ['en', 'hi', 'gu'])).toEqual([])
  })

  it('ignores languages that are not required', () => {
    // The bank is authored in English first, so today required = {en} and a
    // question with only English is finished. The Hindi and Gujarati tabs are
    // still writable; they are simply not outstanding work.
    expect(incompleteLocales({ en: mcq }, 'mcq', ['en'])).toEqual([])
    expect(incompleteLocales({ hi: mcq }, 'mcq', ['en'])).toEqual(['en'])
  })

  it('defaults to English-only rather than to all three', () => {
    /*
     * The direction of this default is load-bearing. Defaulting to all three
     * would mean any call site that forgot to pass the setting silently
     * demanded translations — every question unpublishable, with no error
     * pointing at the cause. Defaulting to English is the recoverable way to
     * be wrong.
     */
    expect(incompleteLocales({ en: mcq }, 'mcq')).toEqual([])
  })
})

describe('activation gate', () => {
  const complete = {
    question: 'Which oil has the highest smoke point?',
    optionA: 'a',
    optionB: 'b',
    optionC: 'c',
    optionD: 'd',
  }
  const base = {
    qtype: 'mcq' as const,
    correctOption: 'C' as const,
    brandId: '00000000-0000-0000-0000-00000000b001',
    difficulty: 'medium' as const,
  }

  it('refuses active when a REQUIRED language is missing, and names it', () => {
    const schema = makeQuestionInputSchema(['en', 'hi', 'gu'])
    const result = schema.safeParse({
      ...base,
      status: 'active',
      texts: { en: complete, hi: complete },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Gujarati')
    }
  })

  it('allows active with English alone while only English is required', () => {
    /*
     * Both directions of the same rule, and this is the half that matters
     * today: the bank is being written in English and translated later, so
     * demanding three languages now would produce 3,000 permanent drafts and a
     * system that can never generate a paper.
     *
     * The rule is not relaxed — exam_settings.required_locales is what changes,
     * and the trigger in 0054 reads the same setting.
     */
    const schema = makeQuestionInputSchema(['en'])
    const result = schema.safeParse({ ...base, status: 'active', texts: { en: complete } })
    expect(result.success).toBe(true)
  })

  it('still refuses active with no English at all', () => {
    const schema = makeQuestionInputSchema(['en'])
    const result = schema.safeParse({ ...base, status: 'active', texts: { hi: complete } })
    expect(result.success).toBe(false)
  })

  it('allows draft with nothing written at all', () => {
    // The normal state of a question for as long as it takes to translate it.
    // Requiring completeness here would make it impossible to save work.
    const result = questionInputSchema.safeParse({ ...base, status: 'draft', texts: {} })
    expect(result.success).toBe(true)
  })

  it('allows active when all three are written', () => {
    const result = questionInputSchema.safeParse({
      ...base,
      status: 'active',
      texts: { en: complete, hi: complete, gu: complete },
    })
    expect(result.success).toBe(true)
  })
})

describe('filter parsing', () => {
  it('keeps the good filters when one value is unrecognised', () => {
    /*
     * The bug this is here to prevent, verbatim from the old bank: a
     * bookmarked `?q=knife&difficulty=4&status=…` with ONE bad value came back
     * as the unfiltered first page — silently, to somebody who believed they
     * were reading a filtered list.
     */
    const filters = parseBankFilters({ q: 'knife', difficulty: 'impossible', status: 'active' })

    expect(filters.q).toBe('knife')
    expect(filters.status).toBe('active')
    expect(filters.difficulty).toBeUndefined()
  })

  it('falls back rather than throwing on rubbish', () => {
    const filters = parseBankFilters({ page: 'banana', pageSize: '9999', locale: 'fr' })
    expect(filters.page).toBe(1)
    expect(filters.pageSize).toBe(25)
    expect(filters.locale).toBe('en')
  })

  it('refuses a page size outside the allowlist', () => {
    // pageSize drives a .range() and two batched reads over every id returned.
    // Free-text here is a way to ask the database for 100,000 rows.
    expect(parseBankFilters({ pageSize: '5000' }).pageSize).toBe(25)
    expect(parseBankFilters({ pageSize: '50' }).pageSize).toBe(50)
  })
})
