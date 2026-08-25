import 'server-only'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { getEmailFrom, getResendApiKey } from '@/lib/env'
import { MAX_ATTEMPTS, type DrainDeps, type OutboxRow, type Recipient } from '@/lib/notifications/drain'

/**
 * The live wiring behind DrainDeps.
 *
 * COLOCATED WITH THE ROUTE ON PURPOSE: eslint confines @/lib/supabase/admin to
 * src/app/api/** and src/server/actions/**. That rule is the first line of
 * defence against the admin client spreading into arbitrary lib modules, so the
 * file moved to satisfy it rather than the rule being suppressed. The endpoint
 * that owns this reader now sits beside it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE ADMIN CLIENT IS CORRECT HERE, HAVING JUST REMOVED IT ELSEWHERE.   │
 * │                                                                           │
 * │ 0081 took the service key out of the registration path because a PUBLIC   │
 * │ page must not depend on the one credential that reads everything.         │
 * │ email_outbox is the opposite case: 0007 gives it NO policy at all —       │
 * │ "contains other people's email addresses and must never be               │
 * │ client-readable" — so there is no user whose RLS grants access, by        │
 * │ design. A background job holding the service key is the intended reader.  │
 * │                                                                           │
 * │ The key is read lazily inside these functions, so a missing variable      │
 * │ fails this job alone.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** APP_URL is optional: a missing one omits the button rather than linking nowhere. */
export function appUrlOrNull(): string | null {
  const url = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  return url && /^https?:\/\//.test(url) ? url : null
}

export function createOutboxDeps(): DrainDeps {
  const supabase = createAdminClient()
  let resend: Resend | null = null

  return {
    async claim(limit) {
      /*
       * Column order matches email_outbox_queue_idx (priority, scheduled_for)
       * with the same partial predicate, so this reads straight off the index
       * 0007 created for exactly this query.
       */
      const { data, error } = await supabase
        .from('email_outbox')
        .select('id, to_email, to_user_id, subject, template, payload, priority, scheduled_for, attempts')
        .is('sent_at', null)
        .is('failed_at', null)
        .lt('attempts', MAX_ATTEMPTS)
        .lte('scheduled_for', new Date().toISOString())
        .order('priority', { ascending: true })
        .order('scheduled_for', { ascending: true })
        .limit(limit)

      if (error) throw new Error(`Could not read email_outbox: ${error.message}`)
      return (data ?? []) as unknown as OutboxRow[]
    },

    async sentToday() {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      const { count, error } = await supabase
        .from('email_outbox')
        .select('id', { count: 'exact', head: true })
        .gte('sent_at', midnight.toISOString())

      if (error) throw new Error(`Could not count today's sends: ${error.message}`)
      return count ?? 0
    },

    async recipient(userId): Promise<Recipient> {
      if (!userId) return { locale: 'en', name: null }
      const { data } = await supabase
        .from('profiles')
        .select('full_name, preferred_locale')
        .eq('id', userId)
        .maybeSingle()

      return {
        locale: (data?.preferred_locale as string | null) ?? 'en',
        name: (data?.full_name as string | null) ?? null,
      }
    },

    async send({ to, subject, html, text }) {
      try {
        resend ??= new Resend(getResendApiKey())
        const { error } = await resend.emails.send({
          from: getEmailFrom(),
          to,
          subject,
          html,
          text,
        })
        // The SDK reports refusals in `error` rather than throwing, and an
        // unverified sender or unauthorised recipient arrives this way.
        return error ? { ok: false, error: `${error.name}: ${error.message}` } : { ok: true }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    },

    async markSent(id) {
      const { error } = await supabase
        .from('email_outbox')
        .update({ sent_at: new Date().toISOString(), last_error: null })
        .eq('id', id)
      if (error) throw new Error(`Could not mark ${id} sent: ${error.message}`)
    },

    async markFailed(id, attempts, message) {
      /*
       * failed_at is stamped ONLY at the give-up boundary. Before that the row
       * stays eligible and will be retried on the next tick — which is what
       * makes a provider blip survivable without anyone intervening.
       */
      const exhausted = attempts >= MAX_ATTEMPTS
      const { error } = await supabase
        .from('email_outbox')
        .update({
          attempts,
          last_error: message.slice(0, 1000),
          ...(exhausted ? { failed_at: new Date().toISOString() } : {}),
        })
        .eq('id', id)
      if (error) throw new Error(`Could not record failure for ${id}: ${error.message}`)
    },

    appUrl: appUrlOrNull,
  }
}
