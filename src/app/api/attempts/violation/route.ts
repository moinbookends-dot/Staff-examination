import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'

/**
 * POST /api/attempts/violation — the armoured path for cheating finalization.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY A ROUTE HANDLER AND NOT THE submitAttempt SERVER ACTION.              │
 * │                                                                           │
 * │ A violation fires at the exact moment Android is freezing the page —      │
 * │ split-screen entry, an app switch, a lock. A Server Action is a plain     │
 * │ fetch with no delivery guarantee at that moment, and one real test died   │
 * │ exactly there: the UI declared the exam submitted while the request       │
 * │ never left the device, and the attempt later closed as an ordinary        │
 * │ 'user' submit. A route lets the runner send with `keepalive: true`,       │
 * │ which the browser is contractually allowed to deliver AFTER the page is   │
 * │ frozen or gone. Server Actions cannot be sent keepalive.                  │
 * │                                                                           │
 * │ Only the two violation reasons are accepted here — a candidate cannot     │
 * │ use the armoured path to press Submit, and everything else (ownership,   │
 * │ idempotency, first-closer-wins, the permanent reason) is enforced by      │
 * │ submit_attempt() in the database exactly as on every other path.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const schema = z.object({
  attemptId: dbId(),
  reason: z.enum(['tab_switch', 'focus_loss']),
})

export async function POST(request: Request) {
  try {
    await requirePermission('attempts.take')
  } catch {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('submit_attempt', {
    p_attempt_id: parsed.data.attemptId,
    p_reason: parsed.data.reason,
  })

  if (error) {
    // 'attempt not found' (not yours) and 'invalid submit reason' both land
    // here; neither is retriable and neither leaks anything the caller does
    // not already know.
    return NextResponse.json({ ok: false, error: 'refused' }, { status: 400 })
  }

  const row = (data as unknown as Array<{ status: string }> | null)?.[0]
  if (!row) return NextResponse.json({ ok: false, error: 'refused' }, { status: 400 })

  // The authoritative answer the dialog may finally believe.
  return NextResponse.json({ ok: true, status: row.status })
}
