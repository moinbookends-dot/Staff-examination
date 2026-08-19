import { describe, expect, it } from 'vitest'

import { decodeHtml, encodingFault, latinWords } from '@/lib/bank/paper/decode'
import { detectFormat, parseAnswerKey, parsePaper } from '@/lib/bank/paper/detect'
import { analysePaper, isPaperImportable } from '@/lib/bank/paper/validate'
import { paperBatches, paperCommitRows, PAPER_IMPORT_BATCH_SIZE } from '@/lib/bank/paper/commit'
import type { BankFact, FindingCode, PaperReport } from '@/lib/bank/paper/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Every rule the paper importer enforces, one case at a time.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THESE FIXTURES ARE TINY AND THAT IS THE POINT.                            ║
 * ║                                                                           ║
 * ║ paper-import-fixtures.test.ts proves the parser survives a real           ║
 * ║ 1,030-question document. It cannot prove what happens to a document with  ║
 * ║ a duplicated id, because the real one has none — and a rule that is never ║
 * ║ exercised is a rule nobody can be sure exists.                            ║
 * ║                                                                           ║
 * ║ So each fixture below is built to break exactly one thing, and asserts    ║
 * ║ that the break is REPORTED rather than absorbed. The failure this whole   ║
 * ║ directory is defending against is not a crash; it is a document that      ║
 * ║ imports cleanly and is quietly wrong.                                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

interface QuestionSpec {
  id?: string | null
  n?: number | null
  stem?: string
  options?: Partial<Record<'A' | 'B' | 'C' | 'D', string>> | null
  heading?: string
}

function mcq(spec: QuestionSpec = {}): string {
  const id = spec.id === null ? '' : ` data-id="${spec.id ?? 'q-0001'}"`
  const number = spec.n === null ? '' : `<span class="q-num">Q${spec.n ?? 1}.</span> `
  const options =
    spec.options === null
      ? ''
      : `<div class="opts-grid">${(['A', 'B', 'C', 'D'] as const)
          .filter((letter) => (spec.options ?? {})[letter] !== undefined || spec.options === undefined)
          .map(
            (letter) =>
              `<div class="opt-item"><span class="opt-label">${letter})</span> ${
                (spec.options ?? {})[letter] ?? `option ${letter}`
              }</div>`,
          )
          .join('')}</div>`

  return (
    (spec.heading ? `<div class="topic-header">${spec.heading}</div>` : '') +
    `<div class="q-block"${id}>` +
    `<div class="q-text">${number}${spec.stem ?? 'A question that is long enough.'}</div>` +
    options +
    `</div>`
  )
}

function short(spec: QuestionSpec = {}): string {
  const id = spec.id === null ? '' : ` data-id="${spec.id ?? 'q-1001'}"`
  const number = spec.n === null ? '' : `<span class="q-num">Q${spec.n ?? 1001}.</span> `
  return (
    (spec.heading ? `<div class="topic-header">${spec.heading}</div>` : '') +
    `<div class="q-block sa-block"${id}>` +
    `<div class="q-text">${number}${spec.stem ?? 'Describe the thing in detail.'}</div>` +
    `<div class="sa-answer-space">Write here…</div>` +
    `</div>`
  )
}

function paper(...blocks: string[]): string {
  return `<!DOCTYPE html><html lang="hi"><head><title>t</title></head><body>${blocks.join('')}</body></html>`
}

function grid(rows: { n: number; id: string; letter: string; text?: string; why?: string }[]): string {
  const header = ['Q#', 'ID', 'Answer', 'Correct option', 'Why']
    .map((cell) => `<div class="answer-cell answer-cell-header">${cell}</div>`)
    .join('')

  const body = rows
    .map(
      (row) =>
        `<div class="answer-cell">Q${row.n}</div>` +
        `<div class="answer-cell">${row.id}</div>` +
        `<div class="answer-cell answer-cell-correct">${row.letter}</div>` +
        `<div class="answer-cell">${row.text ?? 'option text'}</div>` +
        `<div class="answer-cell">${row.why ?? 'because'}</div>`,
    )
    .join('')

  return `<div class="answer-grid">${header}${body}</div><div class="section-divider">end</div>`
}

function saKey(rows: { n: number; id: string; answer: string }[]): string {
  return rows
    .map(
      (row) =>
        `<div class="sa-answer-block" data-id="${row.id}">` +
        `<div class="q-text"><span class="q-num">Q${row.n}.</span> stem</div>` +
        `<div class="sa-answer-text">Answer: ${row.answer}</div>` +
        `<div class="sa-explanation">from the book</div>` +
        `</div>`,
    )
    .join('')
}

function keyDoc(...parts: string[]): string {
  return `<!DOCTYPE html><html><head><title>k</title></head><body>${parts.join('')}</body></html>`
}

function fact(over: Partial<BankFact> & { externalId: string }): BankFact {
  return {
    qtype: 'mcq',
    difficulty: 'hard',
    status: 'active',
    correctOption: 'B',
    topicSlug: 'faults-fixes',
    locales: ['en'],
    ...over,
  }
}

/** Run the whole pipeline the way the screen does. */
function report(
  paperHtml: string,
  keyHtml: string | null,
  facts: BankFact[] | undefined,
  over: Partial<Parameters<typeof analysePaper>[2]> = {},
): PaperReport {
  return analysePaper(parsePaper('aiko-html', paperHtml), keyHtml ? parseAnswerKey('aiko-html', keyHtml) : null, {
    locale: 'hi',
    facts,
    duplicateMode: 'update',
    createUnmatched: false,
    createDifficulty: null,
    knownTopics: ['faults-fixes', 'qc-reasoning'],
    ...over,
  })
}

/** Every finding code raised anywhere in a report. */
function codes(result: PaperReport): FindingCode[] {
  return result.questions.flatMap((question) => [
    ...question.errors.map((f) => f.code),
    ...question.warnings.map((f) => f.code),
  ])
}

// ─────────────────────────────────────────────────────────────────────────────

describe('recognising a file', () => {
  it('refuses an empty file', () => {
    expect(detectFormat('paper.html', '')).toEqual({
      fatal: 'This file is empty.',
    })
    expect(detectFormat('paper.html', '   \n  ')).toHaveProperty('fatal')
  })

  it('refuses HTML that is not this format, and says which problem it is', () => {
    const verdict = detectFormat('other.html', '<!doctype html><html><body><p>hello</p></body></html>')

    expect(verdict).toHaveProperty('fatal')
    // Specifically NOT "no questions found": the useful answer is that this is
    // a different kind of HTML, not that this one happens to be empty.
    expect('fatal' in verdict && verdict.fatal).toMatch(/not in the format this importer reads/)
  })

  it('refuses a PDF by name rather than trying to read it', () => {
    const verdict = detectFormat('paper.pdf', '%PDF-1.7 ...')
    expect('fatal' in verdict && verdict.fatal).toMatch(/PDF is not supported/)
    expect('fatal' in verdict && verdict.fatal).toMatch(/Devanagari/)
  })

  it('refuses a Word document', () => {
    expect(detectFormat('paper.docx', 'PK...')).toHaveProperty('fatal')
  })

  it('tells a paper from an answer key', () => {
    expect(detectFormat('a.html', paper(mcq()))).toEqual({ format: 'aiko-html', role: 'paper' })
    expect(
      detectFormat('b.html', keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }]))),
    ).toEqual({ format: 'aiko-html', role: 'answer-key' })
  })

  it('reads plain text with one numbered question per line', () => {
    const text = ['Q1. [q-0001] What is the thing?', 'A) first', 'B) second', 'C) third', 'D) fourth'].join(
      '\n',
    )

    expect(detectFormat('paper.txt', text)).toEqual({ format: 'plain-text', role: null })

    const parsed = parsePaper('plain-text', text)
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0].externalId).toBe('q-0001')
    expect(parsed.questions[0].detectedType).toBe('mcq')
    expect(parsed.questions[0].stem).toBe('What is the thing?')
  })
})

describe('encoding', () => {
  it('refuses a mis-encoded file instead of repairing it', () => {
    // What a UTF-8 file looks like after being read as Latin-1.
    const damaged = paper(mcq({ stem: 'JalapeÃ±o poppers' }))

    expect(encodingFault(damaged)).toMatch(/not saved as UTF-8/)
    expect(parsePaper('aiko-html', damaged).fatal).toMatch(/not saved as UTF-8/)
    // And it says why it will not fix it, because that is the surprising part.
    expect(encodingFault(damaged)).toMatch(/cannot be told apart from corrupting a file that was correct/)
  })

  it('leaves a correct file alone', () => {
    expect(encodingFault(paper(mcq({ stem: 'एक शेफ के एवो क्रिस्पी राइस' })))).toBeNull()
  })

  it('preserves Devanagari exactly, and decodes the entities around it', () => {
    const stem = 'एक शेफ के एवो क्रिस्पी राइस में &#x27;गीला आधार&#x27; दोष है &amp; ठीक करें'
    const parsed = parsePaper('aiko-html', paper(mcq({ stem })))

    expect(parsed.questions[0].stem).toBe(
      "एक शेफ के एवो क्रिस्पी राइस में 'गीला आधार' दोष है & ठीक करें",
    )
    expect(parsed.questions[0].stem).not.toMatch(/&#x27;|&amp;|�/)
  })

  it('collapses markup whitespace without joining words across a line break', () => {
    expect(decodeHtml('<div>  line one<br>line two  </div>')).toBe('line one line two')
  })

  it('measures residual English without treating short words as words', () => {
    expect(latinWords('पूरी तरह हिन्दी')).toEqual([])
    expect(latinWords('A chef has the fault')).toEqual(['chef', 'has', 'the', 'fault'])
  })
})

describe('a document that is exactly right', () => {
  // Genuinely Hindi, because the locale below is Hindi. English text here would
  // (correctly) raise the residual-English advisory and this case is about what
  // a CLEAN document looks like.
  const html = paper(
    mcq({
      id: 'q-0001',
      n: 1,
      stem: 'एक शेफ के एवो क्रिस्पी राइस में गीला आधार दोष है। समाधान क्या है?',
      options: { A: 'तेज़ आंच पर पलटें', B: 'कसकर रोल करें', C: 'अधिक उबालें', D: 'चावल ठंडा करें' },
    }),
    short({ id: 'q-1001', n: 2, stem: 'दो दोष और उनके समाधान सूचीबद्ध करें।' }),
  )
  const key = keyDoc(
    grid([{ n: 1, id: 'q-0001', letter: 'B' }]),
    saKey([{ n: 2, id: 'q-1001', answer: 'रोल ढीला होने पर कसकर रोल करें।' }]),
  )
  const facts = [
    fact({ externalId: 'q-0001' }),
    fact({ externalId: 'q-1001', qtype: 'short_answer', correctOption: null }),
  ]

  it('is importable, with every question accounted for', () => {
    const result = report(html, key, facts)

    expect(result.detected).toBe(2)
    expect(result.keyEntries).toBe(2)
    expect(result.matched).toBe(2)
    expect(result.updateCount).toBe(2)
    expect(result.errorCount).toBe(0)
    expect(result.blockingCount).toBe(0)
    expect(result.validCount).toBe(2)
    expect(isPaperImportable(result)).toBe(true)
  })

  it('produces one wire row per question, carrying only the new language', () => {
    const rows = paperCommitRows(report(html, key, facts))

    expect(rows.map((row) => row.externalId)).toEqual(['q-0001', 'q-1001'])
    expect(rows[0]).toMatchObject({ action: 'update', optionB: 'कसकर रोल करें', answerText: null })
    // A short answer carries a model answer and no options.
    expect(rows[1]).toMatchObject({ answerText: 'रोल ढीला होने पर कसकर रोल करें।', optionA: null })
    // The shape cannot express another language at all — that is the guard
    // against re-sending a partial locale set and deleting the rest.
    expect(Object.keys(rows[0])).not.toContain('texts')
  })

  it('warns when a "translated" question is still in English', () => {
    const stillEnglish = report(
      paper(mcq({ id: 'q-0001', n: 1, stem: "A chef's rice has the fault." })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
    )

    // The 17 Aug Hard export was 90% English by this measure and was held back
    // because of it. Advisory, never blocking — the bar is a judgement.
    expect(stillEnglish.warningsByCode['residual-english']).toBe(1)
    expect(stillEnglish.questions[0].warnings[0].message).toMatch(/still contains English words/)
    expect(isPaperImportable(stillEnglish)).toBe(true)
  })

  it('raises no such warning on an English import', () => {
    const english = report(
      paper(mcq({ id: 'q-0001', n: 1, stem: "A chef's rice has the fault." })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
      { locale: 'en' },
    )

    expect(english.warningsByCode['residual-english']).toBeUndefined()
    // The only advisory left is that the bank's existing English is about to be
    // replaced, which is exactly what an English re-import does.
    expect(english.warningsByCode['replaces-existing-translation']).toBe(1)
    expect(english.errorCount).toBe(0)
  })
})

describe('problems in the paper', () => {
  it('reports a question with no number', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: null })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
    )

    expect(codes(result)).toContain('missing-question-number')
    // Advisory: a paper without printed numbers is unusual, not unusable.
    expect(result.blockingCount).toBe(0)
  })

  it('reports a question number used twice, and blocks', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 7 }), mcq({ id: 'q-0002', n: 7 })),
      keyDoc(
        grid([
          { n: 7, id: 'q-0001', letter: 'B' },
          { n: 7, id: 'q-0002', letter: 'B' },
        ]),
      ),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0002' })],
    )

    expect(result.duplicateNumbers).toEqual([7])
    expect(result.errorsByCode['duplicate-question-number']).toBe(2)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('lists the question numbers a paper skipped', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 }), mcq({ id: 'q-0004', n: 4 })),
      keyDoc(
        grid([
          { n: 1, id: 'q-0001', letter: 'B' },
          { n: 4, id: 'q-0004', letter: 'B' },
        ]),
      ),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0004' })],
    )

    expect(result.missingNumbers).toEqual([2, 3])
  })

  it('reports an id used twice, and blocks — the second would overwrite the first', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 }), mcq({ id: 'q-0001', n: 2 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
    )

    expect(result.duplicateIds).toEqual(['q-0001'])
    expect(result.errorsByCode['duplicate-external-id']).toBe(1)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports a block with no id, because it can never be matched', () => {
    const result = report(paper(mcq({ id: null, n: 1 })), null, [])
    expect(codes(result)).toContain('missing-external-id')
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports empty question text', () => {
    const result = report(paper(mcq({ id: 'q-0001', stem: '' })), null, [fact({ externalId: 'q-0001' })])
    expect(codes(result)).toContain('missing-stem')
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports text past the length the bank stores', () => {
    const result = report(paper(mcq({ id: 'q-0001', stem: 'x'.repeat(2001) })), null, [
      fact({ externalId: 'q-0001' }),
    ])

    expect(codes(result)).toContain('stem-too-long')
    expect(result.questions[0].errors[0].message).toMatch(/2001 characters/)
  })

  it('does not claim a type for a block with only three options', () => {
    const parsed = parsePaper(
      'aiko-html',
      paper(mcq({ id: 'q-0001', options: { A: 'a', B: 'b', C: 'c' } })),
    )

    // NEITHER mcq nor short_answer. A three-option block must not be able to
    // pass as a valid MCQ anywhere downstream.
    expect(parsed.questions[0].detectedType).toBeNull()
    expect(parsed.questions[0].issues.map((i) => i.code)).toContain('partial-options')
    expect(parsed.questions[0].issues[0].message).toMatch(/Only 3 of 4 options/)

    const result = report(paper(mcq({ id: 'q-0001', options: { A: 'a', B: 'b', C: 'c' } })), null, [
      fact({ externalId: 'q-0001' }),
    ])
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports a blank option', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', options: { A: 'a', B: 'b', C: '', D: 'd' } })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
    )

    expect(codes(result)).toContain('blank-option')
    expect(isPaperImportable(result)).toBe(false)
  })
})

describe('problems in the answer key', () => {
  it('reports a question the key never mentions', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 }), mcq({ id: 'q-0002', n: 2 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0002' })],
    )

    expect(result.errorsByCode['missing-answer-key']).toBe(1)
    expect(result.questions[1].errors[0].message).toMatch(/no entry for "q-0002"/)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports a key entry for a question the paper does not contain', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(
        grid([
          { n: 1, id: 'q-0001', letter: 'B' },
          { n: 2, id: 'q-9999', letter: 'C' },
        ]),
      ),
      [fact({ externalId: 'q-0001' })],
    )

    expect(result.extraKeyIds).toEqual(['q-9999'])
    // Advisory rather than blocking: a key covering more than this paper is
    // odd, but it takes nothing away from the questions that DID match.
    expect(isPaperImportable(result)).toBe(true)
  })

  it('reports an answer letter that is not one of the options', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'E' }])),
      [fact({ externalId: 'q-0001' })],
    )

    // The brief's exact example: available options are named, not just refused.
    const message = result.questions[0].errors.map((f) => f.message).join(' ')
    expect(message).toMatch(/"E", which is not one of A, B, C or D|No correct answer/)
    expect(isPaperImportable(result)).toBe(false)
  })

  it("blocks when the key disagrees with the bank's own answer", () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'C' }])),
      [fact({ externalId: 'q-0001', correctOption: 'B' })],
    )

    expect(result.errorsByCode['answer-disagrees-with-bank']).toBe(1)
    expect(result.questions[0].errors[0].message).toMatch(
      /bank's answer for "q-0001" is B, but this answer key says C/,
    )
    // The failure this check exists for reaches a person as a wrong mark, so it
    // can never be a warning.
    expect(isPaperImportable(result)).toBe(false)
  })

  it('accepts a key that agrees with the bank', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001', correctOption: 'B' })],
    )
    expect(isPaperImportable(result)).toBe(true)
  })

  it('reports a short answer whose key gives a letter instead of an answer', () => {
    const result = report(
      paper(short({ id: 'q-1001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-1001', letter: 'B' }])),
      [fact({ externalId: 'q-1001', qtype: 'short_answer', correctOption: null })],
    )

    expect(codes(result)).toContain('unexpected-answer-letter')
    expect(codes(result)).toContain('missing-model-answer')
  })

  it('reports a model answer past the bank’s limit', () => {
    const result = report(
      paper(short({ id: 'q-1001', n: 1 })),
      keyDoc(saKey([{ n: 1, id: 'q-1001', answer: 'x'.repeat(401) }])),
      [fact({ externalId: 'q-1001', qtype: 'short_answer', correctOption: null })],
    )

    expect(codes(result)).toContain('model-answer-too-long')
  })

  it('reports an answer grid whose cells do not divide into rows', () => {
    const broken = keyDoc(
      `<div class="answer-grid">${['Q#', 'ID', 'A', 'T', 'W']
        .map((c) => `<div class="answer-cell answer-cell-header">${c}</div>`)
        .join('')}<div class="answer-cell">Q1</div><div class="answer-cell">q-0001</div></div><div class="section-divider">e</div>`,
    )

    const parsed = parseAnswerKey('aiko-html', broken)
    expect(parsed.entries[0].issues[0].code).toBe('grid-not-multiple-of-five')
    // Reported rather than silently truncated — a key one cell short shifts
    // every answer after it, which is undetectable by eye.
    expect(parsed.entries[0].issues[0].message).toMatch(/may be shifted/)
  })

  it('reads an empty key document as a fatal error, not as zero answers', () => {
    expect(parseAnswerKey('aiko-html', keyDoc()).fatal).toMatch(/No answers were found/)
  })
})

describe('matching against the bank', () => {
  it('refuses to create a question from a Hindi document, and says why', () => {
    const result = report(paper(mcq({ id: 'q-0001', n: 1 })), null, [], {
      locale: 'hi',
      createUnmatched: true,
      createDifficulty: 'hard',
    })

    expect(result.errorsByCode['cannot-create-without-english']).toBe(1)
    expect(result.questions[0].errors[0].message).toMatch(
      /can only add a translation to a question that already exists/,
    )
    expect(isPaperImportable(result)).toBe(false)
  })

  it('reports an unmatched English question when creating is switched off', () => {
    const result = report(paper(mcq({ id: 'q-0001', n: 1 })), null, [], {
      locale: 'en',
      createUnmatched: false,
    })

    expect(result.errorsByCode['unknown-question']).toBe(1)
  })

  it('creates an unmatched English question when asked, given a topic', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1, heading: 'Faults and fixes' })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [],
      {
        locale: 'en',
        createUnmatched: true,
        createDifficulty: 'hard',
        headingTopics: { 'Faults and fixes': 'faults-fixes' },
      },
    )

    expect(result.createCount).toBe(1)
    expect(result.newCount).toBe(1)
    expect(result.questions[0].topicSlug).toBe('faults-fixes')
    expect(result.questions[0].difficulty).toBe('hard')
    expect(isPaperImportable(result)).toBe(true)
    expect(paperCommitRows(result)[0].action).toBe('create')
  })

  it('never turns a heading into a topic on its own', () => {
    const result = report(paper(mcq({ id: 'q-0001', n: 1, heading: 'दोष और समाधान' })), null, [], {
      locale: 'en',
      createUnmatched: true,
      createDifficulty: 'hard',
    })

    // topicSlug('दोष और समाधान') is the EMPTY STRING, so an automatic match
    // would collapse every Devanagari heading onto one topic.
    expect(result.errorsByCode['unknown-topic']).toBe(1)
    expect(result.questions[0].errors[0].message).toMatch(/No topic has been chosen/)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('refuses a topic that does not exist', () => {
    const result = report(paper(mcq({ id: 'q-0001', n: 1, heading: 'Nonsense' })), null, [], {
      locale: 'en',
      createUnmatched: true,
      createDifficulty: 'hard',
      headingTopics: { Nonsense: 'not-a-real-topic' },
    })

    expect(result.errorsByCode['unknown-topic']).toBe(1)
  })

  it('blocks when the document and the bank disagree about the type', () => {
    const result = report(paper(short({ id: 'q-0001', n: 1 })), null, [
      fact({ externalId: 'q-0001', qtype: 'mcq' }),
    ])

    expect(result.errorsByCode['type-disagrees-with-bank']).toBe(1)
  })

  it('warns when a translation already there is about to be replaced', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001', locales: ['en', 'hi'] })],
    )

    expect(result.warningsByCode['replaces-existing-translation']).toBe(1)
    // A warning, not a block: replacing a translation is the ordinary case for
    // a corrected re-export.
    expect(isPaperImportable(result)).toBe(true)
  })

  it('imports nothing at all until the bank has been checked', () => {
    const result = report(paper(mcq({ id: 'q-0001', n: 1 })), null, undefined)

    expect(result.matched).toBe(0)
    expect(result.skipCount).toBe(1)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('does not treat "not looked up yet" as "this question is new"', () => {
    /*
     * Found by driving the real screen. Before the lookup returns, `existing`
     * is false for every question — because nobody has asked, not because the
     * bank lacks them. Running the create-path rules against that state showed
     * a blocking "no topic has been chosen" against all 1,030 questions of a
     * document whose questions all already exist and all already have topics.
     */
    const unresolved = report(
      paper(mcq({ id: 'q-0001', n: 1, heading: 'दोष और समाधान (200 प्रश्न)' })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      undefined,
      { createUnmatched: true, createDifficulty: null },
    )

    expect(unresolved.errorsByCode['unknown-topic']).toBeUndefined()
    expect(unresolved.errorsByCode['missing-difficulty']).toBeUndefined()
    expect(unresolved.errorsByCode['cannot-create-without-english']).toBeUndefined()
    expect(unresolved.errorCount).toBe(0)
    // Still not importable — "no errors" and "ready" are different claims.
    expect(isPaperImportable(unresolved)).toBe(false)
  })

  it('leaves existing questions alone when asked to skip them', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
      { duplicateMode: 'skip' },
    )

    expect(result.skipCount).toBe(1)
    expect(result.updateCount).toBe(0)
    expect(paperCommitRows(result)).toEqual([])
    expect(isPaperImportable(result)).toBe(false)
  })

  it("does not let a deliberately skipped row's problems block the rest", () => {
    const result = report(
      // q-0002 is broken, but the person has chosen to skip existing questions.
      paper(mcq({ id: 'q-0001', n: 1 }), mcq({ id: 'q-0002', n: 2, stem: '' })),
      keyDoc(
        grid([
          { n: 1, id: 'q-0001', letter: 'B' },
          { n: 2, id: 'q-0002', letter: 'B' },
        ]),
      ),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0002' })],
      { duplicateMode: 'skip' },
    )

    expect(result.errorCount).toBe(1)
    expect(result.blockingCount).toBe(0)
  })
})

describe('English re-imports and the dedupe index', () => {
  it('blocks two questions in one file claiming the same English sentence', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1, stem: 'The same sentence.' }), mcq({ id: 'q-0002', n: 2, stem: 'The same sentence.' })),
      keyDoc(
        grid([
          { n: 1, id: 'q-0001', letter: 'B' },
          { n: 2, id: 'q-0002', letter: 'B' },
        ]),
      ),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0002' })],
      { locale: 'en' },
    )

    // The partial unique index is evaluated after every statement inside
    // bank_import_commit's transaction, so this would abort the whole batch.
    expect(result.errorsByCode['duplicate-question-text']).toBe(1)
    expect(isPaperImportable(result)).toBe(false)
  })

  it('does not apply that rule to a translation, because the index is English-only', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1, stem: 'एक जैसा वाक्य।' }), mcq({ id: 'q-0002', n: 2, stem: 'एक जैसा वाक्य।' })),
      keyDoc(
        grid([
          { n: 1, id: 'q-0001', letter: 'B' },
          { n: 2, id: 'q-0002', letter: 'B' },
        ]),
      ),
      [fact({ externalId: 'q-0001' }), fact({ externalId: 'q-0002' })],
      { locale: 'hi' },
    )

    expect(result.errorsByCode['duplicate-question-text']).toBeUndefined()
    expect(isPaperImportable(result)).toBe(true)
  })
})

describe('editing in the preview', () => {
  const html = paper(mcq({ id: 'q-0001', n: 1, stem: '' }))
  const key = keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }]))
  const facts = [fact({ externalId: 'q-0001' })]

  it('clears an error once the field is corrected', () => {
    const before = report(html, key, facts)
    expect(before.errorsByCode['missing-stem']).toBe(1)
    expect(isPaperImportable(before)).toBe(false)

    const after = report(html, key, facts, {
      edits: { 'row-0': { stem: 'A corrected question.' } },
    })

    expect(after.errorCount).toBe(0)
    expect(after.questions[0].stem).toBe('A corrected question.')
    expect(after.questions[0].edited).toBe(true)
    expect(isPaperImportable(after)).toBe(true)
    // …and the edit is what actually gets written.
    expect(paperCommitRows(after)[0].question).toBe('A corrected question.')
  })

  it('lets a wrong answer letter be corrected', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'C' }])),
      [fact({ externalId: 'q-0001', correctOption: 'B' })],
      { edits: { 'row-0': { correctOption: 'B' } } },
    )

    expect(result.errorCount).toBe(0)
    expect(result.questions[0].correctOption).toBe('B')
  })

  it('ignores an edit that is not a value the vocabulary allows', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1 })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
      { edits: { 'row-0': { difficulty: 'impossible', qtype: 'essay' } } },
    )

    // Falls back to the bank rather than accepting a value no enum contains.
    expect(result.questions[0].difficulty).toBe('hard')
    expect(result.questions[0].qtype).toBe('mcq')
  })
})

describe('batching, failure and resumption', () => {
  /** 250 questions, all valid, all already in the bank. */
  function bulk(count: number) {
    const blocks: string[] = []
    const rows: { n: number; id: string; letter: string }[] = []
    const facts: BankFact[] = []

    for (let n = 1; n <= count; n += 1) {
      const id = `q-${String(n).padStart(4, '0')}`
      blocks.push(mcq({ id, n, stem: `Question number ${n} of the paper.` }))
      rows.push({ n, id, letter: 'B' })
      facts.push(fact({ externalId: id }))
    }
    return { html: paper(...blocks), key: keyDoc(grid(rows)), facts }
  }

  it('handles a large document, counting every question', () => {
    const { html, key, facts } = bulk(1000)
    const result = report(html, key, facts)

    expect(result.detected).toBe(1000)
    expect(result.keyEntries).toBe(1000)
    expect(result.updateCount).toBe(1000)
    expect(result.errorCount).toBe(0)
    expect(result.duplicateIds).toEqual([])
    expect(result.missingNumbers).toEqual([])
  })

  it('splits into batches that cover every row exactly once', () => {
    const { html, key, facts } = bulk(250)
    const rows = paperCommitRows(report(html, key, facts))
    const batches = paperBatches(rows)

    expect(PAPER_IMPORT_BATCH_SIZE).toBe(100)
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50])
    expect(new Set(batches.flat().map((row) => row.externalId)).size).toBe(250)
  })

  it('a resumed run re-sends only the batches that had not committed', () => {
    const { html, key, facts } = bulk(250)
    const batches = paperBatches(paperCommitRows(report(html, key, facts)))

    // Batch 0 committed, batch 1 failed. Resuming from index 1 re-sends 1 and 2
    // — and re-sending 1 is safe because every row is keyed by externalId, so
    // applying it twice is an update rather than a duplicate.
    const resumed = batches.slice(1)
    expect(resumed.flat()).toHaveLength(150)
    expect(resumed.flat()[0].externalId).toBe('q-0101')
  })

  it('refuses a batch size that would loop forever', () => {
    expect(() => paperBatches([1, 2, 3], 0)).toThrow(/at least 1/)
  })

  it('importing the same document twice asks for the same updates, not duplicates', () => {
    const { html, key, facts } = bulk(10)

    const first = report(html, key, facts)
    // After the first run the bank holds Hindi as well; nothing else changed.
    const second = report(
      html,
      key,
      facts.map((f) => ({ ...f, locales: ['en', 'hi'] as BankFact['locales'] })),
    )

    expect(first.createCount).toBe(0)
    expect(second.createCount).toBe(0)
    expect(second.updateCount).toBe(first.updateCount)
    expect(paperCommitRows(second).map((r) => r.externalId)).toEqual(
      paperCommitRows(first).map((r) => r.externalId),
    )
    // The only difference is an advisory that the existing translation is being
    // replaced. Still importable, still ten rows, still no new questions.
    expect(second.warningsByCode['replaces-existing-translation']).toBe(10)
    expect(isPaperImportable(second)).toBe(true)
  })
})

describe('marks', () => {
  it('reports a printed mark value without storing it', () => {
    const result = report(
      paper(mcq({ id: 'q-0001', n: 1, stem: 'A question worth more (2 marks)' })),
      keyDoc(grid([{ n: 1, id: 'q-0001', letter: 'B' }])),
      [fact({ externalId: 'q-0001' })],
    )

    expect(result.questions[0].marks).toBe(2)
    expect(codes(result)).toContain('marks-not-stored')
    // There is no marks field on a wire row, because there is no marks column.
    expect(paperCommitRows(result)[0]).not.toHaveProperty('marks')
    expect(isPaperImportable(result)).toBe(true)
  })
})
