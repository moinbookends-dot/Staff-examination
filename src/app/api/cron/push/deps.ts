import 'server-only'
import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  drainPushOnce,
  type PushDeps,
  type PushableNotification,
  type Subscription,
} from '@/lib/notifications/push'
import { appUrlOrNull } from '../drain-email/deps'

/**
 * Live wiring for the push drain.
 *
 * COLOCATED WITH ITS ROUTE for the same eslint-enforced reason as the email
 * drain's deps: the admin client is confined to src/app/api/** and
 * src/server/actions/**. The service key is the only legitimate reader of
 * push_subscriptions across users — the endpoint plus its keys is the
 * capability to put words on somebody's lock screen, so no RLS policy exposes
 * another person's rows, ever.
 *
 * Env reads are LAZY (inside functions), for the reason 0081 documents: a
 * module-load throw takes down every importer, and one unset variable must
 * fail this job alone.
 */

function vapid() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const contact = process.env.VAPID_CONTACT ?? 'mailto:reservation.bookends@gmail.com'
  if (!publicKey || !privateKey) {
    throw new Error('VAPID keys are not set. Add NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.')
  }
  return { publicKey, privateKey, contact }
}

export function createPushDeps(): PushDeps {
  const supabase = createAdminClient()

  return {
    async claim(limit) {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, user_id, title, body, link')
        .is('pushed_at', null)
        .order('created_at', { ascending: true })
        .limit(limit)
      if (error) throw new Error(`Could not read notifications: ${error.message}`)
      return (data ?? []) as PushableNotification[]
    },

    async subscriptionsFor(userId) {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', userId)
      if (error) throw new Error(`Could not read subscriptions: ${error.message}`)
      return (data ?? []) as Subscription[]
    },

    async localeFor(userId) {
      const { data } = await supabase
        .from('profiles')
        .select('preferred_locale')
        .eq('id', userId)
        .maybeSingle()
      return (data?.preferred_locale as string | null) ?? 'en'
    },

    async send(sub, payload) {
      const { publicKey, privateKey, contact } = vapid()
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          {
            vapidDetails: { subject: contact, publicKey, privateKey },
            // A notification about an exam is stale within the day.
            TTL: 24 * 60 * 60,
          },
        )
        return { ok: true }
      } catch (cause) {
        const statusCode = (cause as { statusCode?: number }).statusCode
        return {
          ok: false,
          status: statusCode,
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }
    },

    async markPushed(ids) {
      const { error } = await supabase
        .from('notifications')
        .update({ pushed_at: new Date().toISOString() })
        .in('id', ids)
      if (error) throw new Error(`Could not mark pushed: ${error.message}`)
    },

    async markSubscriptionOk(id) {
      await supabase
        .from('push_subscriptions')
        .update({ last_ok_at: new Date().toISOString(), failures: 0 })
        .eq('id', id)
    },

    async deleteSubscription(id) {
      await supabase.from('push_subscriptions').delete().eq('id', id)
    },

    async countFailure(id) {
      // Read-modify-write is fine here: the drain is single-flight (cron
      // concurrency group) and the counter is diagnostic, not authoritative.
      const { data } = await supabase
        .from('push_subscriptions')
        .select('failures')
        .eq('id', id)
        .maybeSingle()
      await supabase
        .from('push_subscriptions')
        .update({ failures: ((data?.failures as number) ?? 0) + 1 })
        .eq('id', id)
    },

    appUrl: appUrlOrNull,
  }
}

/**
 * The inline nudge: called straight after an action that just created
 * notifications (publishing an exam), so the common case reaches the lock
 * screen in seconds — the cron is the safety net, not the primary path.
 * Never throws: push failing must not fail the publish that triggered it.
 */
export async function drainPushSafely(): Promise<void> {
  try {
    await drainPushOnce(createPushDeps())
  } catch (cause) {
    console.error('[push] inline drain failed:', cause instanceof Error ? cause.message : cause)
  }
}
