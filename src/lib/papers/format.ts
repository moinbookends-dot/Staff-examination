import { COMBINATION_CAP, isEffectivelyUnlimited } from './combinations'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Turning generator internals into something a Chef should see.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ NOTHING ABOUT HASHING, EPOCHS OR RETRY LOOPS REACHES THE SCREEN.          ║
 * ║                                                                           ║
 * ║ The Chef's question is "can I get a fresh paper?", and the answers are    ║
 * ║ yes, not enough questions, or none left. A combination hash, an attempt   ║
 * ║ count and a generation epoch are all implementation, and putting any of   ║
 * ║ them on the screen invites somebody to reason about a mechanism they      ║
 * ║ cannot influence.                                                         ║
 * ║                                                                           ║
 * ║ The one internal number that IS worth surfacing is how many different     ║
 * ║ papers the bank can produce — it is the honest answer to "will this keep  ║
 * ║ working?" — and it is shown rounded, never exact.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type CombinationDisplay =
  | { kind: 'unlimited' }
  | { kind: 'approx'; value: number }
  | { kind: 'exact'; value: number }

/**
 * How to present a combination total.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THREE BANDS, BECAUSE THE NUMBER MEANS THREE DIFFERENT THINGS.             │
 * │                                                                           │
 * │  · At the target bank size the total is ~10⁴⁵. Printing that, or the      │
 * │    10¹⁵ cap standing in for it, would be stating a precise falsehood      │
 * │    about a number the arithmetic deliberately stopped computing. It is    │
 * │    reported as unlimited, which is what it means in practice.             │
 * │  · In the thousands it is real but not worth to-the-digit precision, and  │
 * │    "12,400" invites somebody to watch it tick down. Rounded.              │
 * │  · Under a hundred it is genuinely actionable — "3 papers left" is a      │
 * │    warning, and rounding it away would hide the only case where the       │
 * │    number changes what somebody does.                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function describeCombinations(total: number): CombinationDisplay {
  if (isEffectivelyUnlimited(total)) return { kind: 'unlimited' }
  if (total >= 100) return { kind: 'approx', value: roundDown(total) }
  return { kind: 'exact', value: total }
}

/** 12,438 → 12,000; 1,240 → 1,200; 143 → 140. Never rounds up past the truth. */
function roundDown(value: number): number {
  const magnitude = 10 ** Math.max(1, Math.floor(Math.log10(value)) - 1)
  return Math.floor(value / magnitude) * magnitude
}

/**
 * A compact label — "10k+", "1.2M", "84".
 *
 * Used in the summary tile where the Stitch design has room for a few
 * characters. The full sentence form lives in the message bundle so it can be
 * translated; this is only the numeral.
 */
export function formatCombinationCount(total: number): string {
  const display = describeCombinations(total)
  if (display.kind === 'unlimited') return '∞'

  const n = display.value
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M+`
  if (n >= 1_000) return `${trimZero(n / 1_000)}k+`
  return String(n)
}

function trimZero(value: number): string {
  // 1.0 → "1", 1.2 → "1.2". A trailing ".0" reads as false precision.
  return value.toFixed(1).replace(/\.0$/, '')
}

/**
 * Is the pool thin enough to warn about?
 *
 * Not an error — a paper generates perfectly well from a bank with twenty
 * spare combinations. It is a nudge to add questions before the level locks
 * up, shown while there is still time to act on it.
 */
export const LOW_COMBINATION_WARNING = 25

export function isRunningLow(total: number): boolean {
  return total > 0 && total < LOW_COMBINATION_WARNING && total < COMBINATION_CAP
}
