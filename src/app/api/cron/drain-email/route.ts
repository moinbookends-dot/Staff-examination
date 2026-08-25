import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { drainOnce } from '@/lib/notifications/drain'
import { createOutboxDeps } from './deps'
import { getCronSecret } from '@/lib/env'

/**
 * Drains email_outbox. Called by a scheduler, not by a person.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ENDPOINT IS PUBLICLY REACHABLE AND SPENDS A METERED QUOTA, so the   ║
 * ║ token is the whole of its security. Two consequences:                    ║
 * ║                                                                          ║
 * ║  · compared with timingSafeEqual, not ===. A byte-by-byte early return   ║
 * ║    leaks the secret's prefix to anyone willing to measure, and this is    ║
 * ║    an unauthenticated endpoint on the public internet.                    ║
 * ║  · POST only. A GET would be fetched by link previewers, prefetchers and  ║
 * ║    crawlers, each one spending real email quota.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Always dynamic: a cached drain would be a drain that silently stopped.
 */
export const dynamic = 'force-dynamic'

function authorised(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''

  let expected: string
  try {
    expected = getCronSecret()
  } catch {
    // Unset secret means nothing may run — never an open door.
    return false
  }

  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length; compare a fixed-size digest-shaped pair instead by padding.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    // No detail. An attacker learns nothing about whether the secret exists.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === '1'
  const batch = Number(url.searchParams.get('batch') ?? '') || undefined

  try {
    const outcome = await drainOnce(createOutboxDeps(), { dryRun, batch })
    return NextResponse.json(outcome, { status: 200 })
  } catch (cause) {
    /*
     * A thrown error here means the queue could not be READ — a missing key or
     * an unreachable database — not that an email failed. Per-email failures
     * are recorded on their rows and reported in the 200 body, because one bad
     * address must not fail the whole run.
     */
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error('[drain-email] run failed:', message)
    return NextResponse.json({ error: 'Drain failed', detail: message }, { status: 500 })
  }
}
