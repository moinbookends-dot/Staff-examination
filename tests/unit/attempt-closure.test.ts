import { describe, it, expect } from 'vitest'
import { isCheating, isAutoSubmitted } from '@/lib/attempts/closure'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * How an attempt closed — one classification, pinned.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ There is no "cheated" column. The verdict is derived from                 ║
 * ║ attempts.submit_reason, which the server writes exactly once and nothing  ║
 * ║ ever updates. These tests pin the derivation, because every surface —     ║
 * ║ the runner's dialog, the monitoring chip, the paper viewer, history, the  ║
 * ║ candidate's own result — reads it through these two functions. The SQL    ║
 * ║ side keeps the same list in exam_participants() (migration 0094); if one  ║
 * ║ list changes, change both.                                                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

describe('closure classification', () => {
  it('only leaving the exam is cheating', () => {
    expect(isCheating('tab_switch')).toBe(true)

    expect(isCheating('user')).toBe(false)
    expect(isCheating('timer')).toBe(false)
    expect(isCheating('sweeper')).toBe(false)
    expect(isCheating('admin')).toBe(false)
  })

  it('an open attempt has no verdict at all', () => {
    expect(isCheating(null)).toBe(false)
    expect(isCheating(undefined)).toBe(false)
    expect(isAutoSubmitted(null)).toBe(false)
    expect(isAutoSubmitted(undefined)).toBe(false)
  })

  it('the clock and the sweeper are auto-submits, never cheating', () => {
    expect(isAutoSubmitted('timer')).toBe(true)
    expect(isAutoSubmitted('sweeper')).toBe(true)
    expect(isCheating('timer')).toBe(false)
    expect(isCheating('sweeper')).toBe(false)
  })

  it('every cheating closure is also an auto-submit', () => {
    // The monitoring table shows ONE chip: the cheating verdict replaces the
    // neutral auto-submitted note precisely because it implies it.
    expect(isAutoSubmitted('tab_switch')).toBe(true)
  })

  it('a pressed Submit is neither', () => {
    expect(isAutoSubmitted('user')).toBe(false)
    expect(isCheating('user')).toBe(false)
  })
})
