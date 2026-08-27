'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth/guards'

/**
 * Registering this browser for Web Push.
 *
 * Runs under the CALLER'S OWN client on purpose: push_subscriptions carries an
 * owner-only RLS policy (0090), so a person can register and remove devices
 * for themselves and nobody else — the database enforces it whatever this
 * code says. No admin client, nothing here to leak.
 */

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
})

export async function savePushSubscription(input: unknown): Promise<{ ok: boolean }> {
  await requireApproved()

  const parsed = subscriptionSchema.safeParse(input)
  if (!parsed.success) return { ok: false }

  const supabase = await createClient()
  const { data: claims } = await supabase.auth.getClaims()
  const userId = claims?.claims?.sub as string | undefined
  if (!userId) return { ok: false }

  /*
   * Upsert on endpoint: the same browser re-subscribing must refresh its keys
   * in place. The unique index on endpoint makes this race-safe, and RLS's
   * with-check stops the upsert touching a row that belongs to someone else —
   * relevant on a shared kitchen phone where accounts change hands.
   */
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      user_agent: null,
    },
    { onConflict: 'endpoint' },
  )

  return { ok: !error }
}

export async function removePushSubscription(input: unknown): Promise<{ ok: boolean }> {
  await requireApproved()

  const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(input)
  if (!parsed.success) return { ok: false }

  const supabase = await createClient()
  // RLS scopes the delete to the caller's own rows; no user_id filter needed,
  // and adding one would only duplicate what the policy already guarantees.
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', parsed.data.endpoint)

  return { ok: !error }
}
