/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Draining notifications to Web Push.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE SOURCE OF TRUTH, TWO SURFACES. This does not compose its own          ║
 * ║ messages: it delivers rows from `notifications` — the same rows the       ║
 * ║ in-app bell shows — to the OS shade, and stamps pushed_at as its          ║
 * ║ high-water mark. The bell and the lock screen can never disagree,         ║
 * ║ because they are reading the same sentence.                               ║
 * ║                                                                           ║
 * ║ pushed_at MEANS "SETTLED", NOT "DELIVERED". A row is stamped once its     ║
 * ║ delivery was attempted to every subscription the person had — including   ║
 * ║ the case of having none. Leaving no-subscription rows unstamped would     ║
 * ║ re-scan them on every tick forever, and stamping them is honest: there    ║
 * ║ was nothing to deliver to.                                                ║
 * ║                                                                           ║
 * ║ A 404/410 FROM THE PUSH SERVICE MEANS THE SUBSCRIPTION IS DEAD — the      ║
 * ║ person cleared site data or the browser rotated it. The row is deleted,   ║
 * ║ not retried: the push service itself has said it will never work again.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PushableNotification {
  id: string
  user_id: string
  title: string
  body: string | null
  link: string | null
}

export interface Subscription {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface SendOutcome {
  ok: boolean
  /** HTTP status from the push service, when it answered. */
  status?: number
  error?: string
}

export interface PushDeps {
  /** Unpushed notification rows, oldest first, bounded. */
  claim(limit: number): Promise<PushableNotification[]>
  subscriptionsFor(userId: string): Promise<Subscription[]>
  /** The recipient's locale, for building the tap-through link. */
  localeFor(userId: string): Promise<string>
  send(sub: Subscription, payload: string): Promise<SendOutcome>
  markPushed(ids: string[]): Promise<void>
  markSubscriptionOk(id: string): Promise<void>
  deleteSubscription(id: string): Promise<void>
  countFailure(id: string): Promise<void>
  appUrl(): string | null
}

export interface PushOutcome {
  settled: number
  delivered: number
  failed: number
  deadSubscriptionsRemoved: number
  usersWithNoDevice: number
}

/** Statuses the push service uses to say "this endpoint no longer exists". */
const GONE = new Set([404, 410])

export const DEFAULT_PUSH_BATCH = 100

export function buildPayload(
  n: PushableNotification,
  locale: string,
  appUrl: string | null,
): string {
  // The link opens inside the recipient's own language — the stored link is
  // locale-less because the bell renders inside an already-localised page.
  const path = n.link ? `/${locale}${n.link.startsWith('/') ? '' : '/'}${n.link}` : `/${locale}/dashboard`
  return JSON.stringify({
    title: n.title,
    body: n.body ?? '',
    link: appUrl ? new URL(path, appUrl).href : path,
    // One tag per notification row: a re-send replaces, unrelated rows stack.
    tag: `n-${n.id}`,
  })
}

export async function drainPushOnce(
  deps: PushDeps,
  batch = DEFAULT_PUSH_BATCH,
): Promise<PushOutcome> {
  const outcome: PushOutcome = {
    settled: 0,
    delivered: 0,
    failed: 0,
    deadSubscriptionsRemoved: 0,
    usersWithNoDevice: 0,
  }

  const rows = await deps.claim(batch)
  if (rows.length === 0) return outcome

  const settledIds: string[] = []

  // Per-user caches: one drain often carries many rows for one person, and
  // asking for their devices once per ROW would be quadratic in the common
  // "results published to the whole team" case.
  const subsCache = new Map<string, Subscription[]>()
  const localeCache = new Map<string, string>()

  for (const row of rows) {
    let subs = subsCache.get(row.user_id)
    if (!subs) {
      subs = await deps.subscriptionsFor(row.user_id)
      subsCache.set(row.user_id, subs)
    }
    let locale = localeCache.get(row.user_id)
    if (!locale) {
      locale = await deps.localeFor(row.user_id)
      localeCache.set(row.user_id, locale)
    }

    if (subs.length === 0) {
      outcome.usersWithNoDevice += 1
      settledIds.push(row.id)
      continue
    }

    const payload = buildPayload(row, locale, deps.appUrl())

    for (const sub of subs) {
      const result = await deps.send(sub, payload)
      if (result.ok) {
        outcome.delivered += 1
        await deps.markSubscriptionOk(sub.id)
      } else if (result.status !== undefined && GONE.has(result.status)) {
        outcome.deadSubscriptionsRemoved += 1
        await deps.deleteSubscription(sub.id)
        // Drop it from the cache so later rows for this user skip it too.
        subsCache.set(row.user_id, subsCache.get(row.user_id)!.filter((s) => s.id !== sub.id))
      } else {
        outcome.failed += 1
        await deps.countFailure(sub.id)
      }
    }

    /*
     * Settled even when a send failed: push is best-effort by nature (the
     * device may be off for a week), the in-app bell still holds the message,
     * and retrying rows against flaky endpoints forever would wedge the queue
     * exactly the way the email outbox was built NOT to.
     */
    settledIds.push(row.id)
  }

  if (settledIds.length > 0) await deps.markPushed(settledIds)
  outcome.settled = settledIds.length
  return outcome
}
