import { createHash } from 'node:crypto'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The fingerprint of a paper's question set.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A SET, NOT A SEQUENCE. THE IDS ARE SORTED BEFORE HASHING.                 ║
 * ║                                                                           ║
 * ║ "The same paper must never be generated twice" is about WHICH QUESTIONS   ║
 * ║ are on the paper, not what order they were shuffled into. Two papers      ║
 * ║ holding the same twenty questions in different orders are the same paper  ║
 * ║ to anybody sitting them, and the specification says so: "if the exact     ║
 * ║ combination already exists".                                              ║
 * ║                                                                           ║
 * ║ Hashing in draw order instead would make the rule almost useless: for a   ║
 * ║ 20-question paper there are 20! ≈ 2.4 × 10¹⁸ orderings of every single    ║
 * ║ combination, so the generator would cheerfully reissue the same twenty    ║
 * ║ questions for the rest of the company's life and never once collide.      ║
 * ║ It would look like it was working.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATES ARE REFUSED RATHER THAN COLLAPSED.                             │
 * │                                                                           │
 * │ The same id twice in one paper is a bug in the draw, and de-duplicating   │
 * │ here would hide it: the hash would match a legitimate 20-question paper   │
 * │ while the paper itself had 19 questions and a repeat. exam_paper_questions│
 * │ has a UNIQUE constraint for the same reason, and this fails earlier and   │
 * │ more clearly.                                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * sha256 over the sorted question ids, as lowercase hex.
 *
 * Hex rather than a Buffer because this value travels through a server action,
 * gets logged, and is compared in tests. The repository converts it to the
 * `bytea` column at the edge, which is the only place the encoding matters.
 *
 * Newline-separated: uuids are fixed-width so no separator is strictly needed,
 * but concatenating identifiers without one is how two different sets hash the
 * same once somebody changes the id format.
 */
export function combinationHash(questionIds: readonly string[]): string {
  if (questionIds.length === 0) {
    throw new Error('Cannot fingerprint an empty paper.')
  }

  const unique = new Set(questionIds)
  if (unique.size !== questionIds.length) {
    throw new Error(
      `A paper cannot contain the same question twice (${questionIds.length} drawn, ${unique.size} distinct).`,
    )
  }

  // Plain lexicographic sort. The ids are uuids, so this is stable and
  // locale-independent — localeCompare would not be.
  const sorted = [...questionIds].sort()

  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex')
}

/** For the `bytea` column, which stores 32 raw bytes rather than 64 hex chars. */
export function combinationHashBuffer(questionIds: readonly string[]): Buffer {
  return Buffer.from(combinationHash(questionIds), 'hex')
}
