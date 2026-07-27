import type { AnswerKey, AnswerPayload, QuestionContent, ResponseFormat } from './schemas'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE AUTO-GRADING ENGINE.                                                 ║
 * ║                                                                           ║
 * ║  Pure functions, no I/O. This is the highest-value test target in the     ║
 * ║  codebase and the only place held to full branch coverage: it is fast and ║
 * ║  cheap to test, and a bug here silently produces wrong scores that a      ║
 * ║  human will trust and act on. Nobody audits a number that looks           ║
 * ║  plausible.                                                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * SERVER-SIDE ONLY. Grading needs the answer key, which never reaches a
 * browser. Nothing here may be imported into a client component.
 */

export type AutoGradeStatus = 'not_applicable' | 'pending' | 'graded' | 'needs_review'

export interface GradeResult {
  /** Awarded marks. May be negative when negative marking applies. */
  score: number
  status: AutoGradeStatus
  /**
   * Per-part breakdown, shown to the evaluator and (after publication) to the
   * candidate. Turns "you scored 2/5" into "these three blanks were wrong",
   * which is the difference between a mark and a learning moment.
   */
  detail?: unknown
}

export interface GradeOptions {
  maxScore: number
  negativeMarks?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Text comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalisation applied before every non-exact comparison.
 *
 * NFKC first: Devanagari and Gujarati have multiple valid encodings for the
 * same visible character, so "same word typed on a different keyboard" would
 * otherwise compare unequal. Then case-fold, collapse internal whitespace, and
 * trim. Trailing-space answers are the single most common false negative in
 * any fill-in-the-blank system.
 */
function normalise(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Levenshtein distance, iterative two-row. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[b.length]
}

type BlankMatch = 'exact' | 'ci' | 'fuzzy' | 'regex'

interface BlankOutcome {
  correct: boolean
  /** Fuzzy near-miss: scored correct, but flagged for a human to confirm. */
  review: boolean
}

function matchBlank(
  submitted: string,
  accept: string[],
  mode: BlankMatch,
  tolerance: number | undefined,
): BlankOutcome {
  const raw = submitted ?? ''

  if (raw.trim() === '') return { correct: false, review: false }

  switch (mode) {
    case 'exact':
      return { correct: accept.includes(raw), review: false }

    case 'ci': {
      const n = normalise(raw)
      return { correct: accept.some((a) => normalise(a) === n), review: false }
    }

    case 'regex': {
      for (const pattern of accept) {
        try {
          // Anchored: an unanchored /180/ would accept "not 180", which is the
          // opposite of the intended answer.
          if (new RegExp(`^(?:${pattern})$`, 'iu').test(raw.trim())) {
            return { correct: true, review: false }
          }
        } catch {
          // Invalid pattern: cannot mark the candidate wrong for an authoring
          // error, so send it to a human.
          return { correct: false, review: true }
        }
      }
      return { correct: false, review: false }
    }

    case 'fuzzy': {
      const n = normalise(raw)
      const limit = tolerance ?? 1

      for (const a of accept) {
        const target = normalise(a)
        if (target === n) return { correct: true, review: false }

        // Guard against short words: distance 1 from "rib" reaches "rub" and
        // "ribs", which are different answers. Only allow fuzziness when the
        // word is long enough for a typo to be the likelier explanation.
        if (target.length >= 4 && editDistance(n, target) <= limit) {
          return { correct: true, review: true }
        }
      }
      return { correct: false, review: false }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grades one answer.
 *
 * Contract:
 *   · An unanswered question scores 0 and NEVER incurs negative marks. Penalising
 *     a skip would make guessing strictly better than admitting ignorance, which
 *     inverts what the assessment is trying to measure.
 *   · Manual formats return 'not_applicable' with score 0 — a human decides.
 *   · A mismatch between key and answer format returns 'needs_review' rather
 *     than 0, because that is an authoring or data fault and must not be
 *     charged to the candidate.
 */
export function gradeAnswer(
  content: QuestionContent,
  key: AnswerKey,
  answer: AnswerPayload | null,
  options: GradeOptions,
): GradeResult {
  const max = options.maxScore

  /**
   * The score for a wrong answer.
   *
   * Guarded rather than written as `-negativeMarks` inline: negating 0 yields
   * -0, which survives into JSON detail blobs and compares unequal to 0 under
   * Object.is. Harmless in Postgres numeric, quietly confusing everywhere else.
   */
  const negative = options.negativeMarks ?? 0
  const penalty = negative > 0 ? -negative : 0

  if (!isAutoGradableFormat(key.format)) {
    return { score: 0, status: 'not_applicable' }
  }

  if (answer === null) {
    return { score: 0, status: 'graded', detail: { answered: false } }
  }

  if (answer.format !== key.format || content.format !== key.format) {
    return {
      score: 0,
      status: 'needs_review',
      detail: { reason: 'format mismatch between question, key and answer' },
    }
  }

  switch (key.format) {
    // ── Single choice ────────────────────────────────────────────────────────
    case 'choice_single': {
      const a = answer as Extract<AnswerPayload, { format: 'choice_single' }>
      if (a.choice === null) return { score: 0, status: 'graded', detail: { answered: false } }

      const correct = a.choice === key.correct
      return {
        score: correct ? max : penalty,
        status: 'graded',
        detail: { correct, selected: a.choice },
      }
    }

    // ── Multiple choice ──────────────────────────────────────────────────────
    case 'choice_multi': {
      const a = answer as Extract<AnswerPayload, { format: 'choice_multi' }>
      const c = content as Extract<QuestionContent, { format: 'choice_multi' }>

      if (a.choices.length === 0) return { score: 0, status: 'graded', detail: { answered: false } }

      const correctSet = new Set(key.correct)
      const chosen = new Set(a.choices)

      const hits = [...chosen].filter((id) => correctSet.has(id)).length
      const misses = [...chosen].filter((id) => !correctSet.has(id)).length
      const allCorrect = hits === correctSet.size && misses === 0

      if (!key.partialCredit) {
        return {
          score: allCorrect ? max : penalty,
          status: 'graded',
          detail: { correct: allCorrect, hits, misses },
        }
      }

      // Proportional, penalising wrong selections at the same weight as right
      // ones. Without the penalty, selecting every option would score full
      // marks and the question would measure nothing.
      const incorrectAvailable = c.choices.length - correctSet.size
      const gained = hits / correctSet.size
      const lost = incorrectAvailable > 0 ? misses / incorrectAvailable : 0
      const ratio = Math.max(0, gained - lost)

      return {
        score: round2(ratio * max),
        status: 'graded',
        detail: { hits, misses, ratio: round2(ratio), correct: allCorrect },
      }
    }

    // ── True / false ─────────────────────────────────────────────────────────
    case 'boolean': {
      const a = answer as Extract<AnswerPayload, { format: 'boolean' }>
      if (a.value === null) return { score: 0, status: 'graded', detail: { answered: false } }

      const correct = a.value === key.correct
      return { score: correct ? max : penalty, status: 'graded', detail: { correct } }
    }

    // ── Fill in the blanks ───────────────────────────────────────────────────
    case 'blanks': {
      const a = answer as Extract<AnswerPayload, { format: 'blanks' }>

      const outcomes = key.blanks.map((b) => {
        const submitted = a.values[b.id] ?? ''
        const { correct, review } = matchBlank(submitted, b.accept, b.match, b.tolerance)
        return { id: b.id, submitted, correct, review }
      })

      const answeredAny = outcomes.some((o) => o.submitted.trim() !== '')
      if (!answeredAny) return { score: 0, status: 'graded', detail: { answered: false } }

      const correctCount = outcomes.filter((o) => o.correct).length
      const needsReview = outcomes.some((o) => o.review)
      const allCorrect = correctCount === outcomes.length

      const score = key.partialCredit
        ? round2((correctCount / outcomes.length) * max)
        : allCorrect
          ? max
          : penalty

      return {
        // A fuzzy near-miss is credited but flagged. Across four languages a
        // near-match is far more often a spelling variant than a wrong answer,
        // and silently failing it would be both unfair and invisible.
        status: needsReview ? 'needs_review' : 'graded',
        score,
        detail: { blanks: outcomes, correctCount, total: outcomes.length },
      }
    }

    // ── Match the following ──────────────────────────────────────────────────
    case 'pairs': {
      const a = answer as Extract<AnswerPayload, { format: 'pairs' }>
      const entries = Object.entries(key.correct)

      if (Object.keys(a.mapping).length === 0) {
        return { score: 0, status: 'graded', detail: { answered: false } }
      }

      const outcomes = entries.map(([left, right]) => ({
        left,
        expected: right,
        submitted: a.mapping[left] ?? null,
        correct: a.mapping[left] === right,
      }))

      const correctCount = outcomes.filter((o) => o.correct).length
      const allCorrect = correctCount === entries.length

      const score = key.partialCredit
        ? round2((correctCount / entries.length) * max)
        : allCorrect
          ? max
          : penalty

      return { score, status: 'graded', detail: { pairs: outcomes, correctCount, total: entries.length } }
    }

    // ── Sequence / ordering ──────────────────────────────────────────────────
    case 'order': {
      const a = answer as Extract<AnswerPayload, { format: 'order' }>
      if (a.order.length === 0) return { score: 0, status: 'graded', detail: { answered: false } }

      const expected = key.correct
      const exact =
        a.order.length === expected.length && a.order.every((id, i) => id === expected[i])

      if (key.scoring === 'exact') {
        return {
          score: exact ? max : penalty,
          status: 'graded',
          detail: { correct: exact, scoring: 'exact' },
        }
      }

      if (key.scoring === 'adjacent') {
        // Credit per correctly-ordered adjacent pair. Right for procedures:
        // getting the first steps of a recipe in order is worth something even
        // if two later steps are swapped.
        const pairs = expected.length - 1
        let hits = 0
        for (let i = 0; i < a.order.length - 1; i++) {
          const x = expected.indexOf(a.order[i])
          const y = expected.indexOf(a.order[i + 1])
          if (x !== -1 && y !== -1 && y === x + 1) hits++
        }
        const ratio = pairs > 0 ? hits / pairs : 0
        return {
          score: round2(ratio * max),
          status: 'graded',
          detail: { scoring: 'adjacent', adjacentCorrect: hits, adjacentTotal: pairs, correct: exact },
        }
      }

      // Kendall tau: proportion of item pairs in the correct relative order.
      // Rewards broadly-right sequences that exact matching scores zero.
      const positions = new Map(a.order.map((id, i) => [id, i]))
      let concordant = 0
      let total = 0
      for (let i = 0; i < expected.length; i++) {
        for (let j = i + 1; j < expected.length; j++) {
          const pi = positions.get(expected[i])
          const pj = positions.get(expected[j])
          if (pi === undefined || pj === undefined) continue
          total++
          if (pi < pj) concordant++
        }
      }
      const ratio = total > 0 ? concordant / total : 0
      return {
        score: round2(ratio * max),
        status: 'graded',
        detail: { scoring: 'kendall', concordant, total, correct: exact },
      }
    }

    default:
      // Unreachable: manual formats returned above. Present so adding a format
      // without a grader fails loudly rather than scoring zero.
      return { score: 0, status: 'needs_review', detail: { reason: 'no grader for this format' } }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function isAutoGradableFormat(format: ResponseFormat): boolean {
  return !['text_short', 'text_long', 'evaluator_only'].includes(format)
}
