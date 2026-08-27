import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { drainPushOnce } from '@/lib/notifications/push'
import { createPushDeps } from './deps'
import { getCronSecret } from '@/lib/env'

/**
 * Drains unpushed notifications to Web Push. Called by the same scheduler as
 * the email drain, guarded by the same secret, with the same timing-safe
 * comparison — see /api/cron/drain-email for the reasoning on both.
 *
 * POST-only for the same reason too: a GET would be spent by link previewers.
 */
export const dynamic = 'force-dynamic'

function authorised(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''

  let expected: string
  try {
    expected = getCronSecret()
  } catch {
    return false
  }

  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const outcome = await drainPushOnce(createPushDeps())
    return NextResponse.json(outcome, { status: 200 })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error('[push] drain failed:', message)
    return NextResponse.json({ error: 'Push drain failed', detail: message }, { status: 500 })
  }
}
