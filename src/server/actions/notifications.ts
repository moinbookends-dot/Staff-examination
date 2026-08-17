'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth/guards'
import { dbId } from '@/lib/db/id'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The bell.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THERE IS NO PERMISSION HERE, AND NONE IS NEEDED.                          ║
 * ║                                                                           ║
 * ║ `notifications` carries a `notifications_self_read` policy scoped to      ║
 * ║ auth.uid() (0007). Every read below goes through the CALLER'S client, so  ║
 * ║ the database returns that person's rows and nobody else's — a bug in this ║
 * ║ file cannot widen it, because there is no query here that could name      ║
 * ║ another user and be answered.                                             ║
 * ║                                                                           ║
 * ║ The .eq('user_id', …) on the update is belt and braces, not the control.  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Notifications are WRITTEN by the database, never by this file — 0074's
 * trigger on exam_assignments and 0075's notify_exam_audience() decide who
 * hears about an exam. Keeping the writer in SQL is what makes "assigned" and
 * "notified" impossible to disagree: both derive from exam_audience().
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface AppNotification {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  readAt: string | null
  createdAt: string
}

/** The most recent notifications, newest first, plus how many are unread. */
export async function loadMyNotifications(
  limit = 10,
): Promise<{ items: AppNotification[]; unread: number }> {
  const claims = await requireApproved()
  if (!claims.userId) return { items: [], unread: 0 }

  const supabase = await createClient()

  const [list, unread] = await Promise.all([
    supabase
      .from('notifications')
      .select('id, kind, title, body, link, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    // head:true — a count with no rows on the wire. The bell needs the number,
    // not the records, and this runs on every page render.
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null),
  ])

  return {
    items: (list.data ?? []).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.read_at,
      createdAt: n.created_at,
    })),
    unread: unread.count ?? 0,
  }
}

const markInput = z.object({ id: dbId().optional() })

/**
 * Marks one notification read, or all of them when no id is given.
 *
 * Idempotent and deliberately not optimistic: the badge is a small claim about
 * state, and getting it wrong in the cheerful direction ("you have read this")
 * is how somebody misses an exam.
 */
export async function markNotificationsRead(raw: unknown = {}): Promise<{ ok: boolean }> {
  const claims = await requireApproved()
  if (!claims.userId) return { ok: false }

  const parsed = markInput.safeParse(raw)
  if (!parsed.success) return { ok: false }

  const supabase = await createClient()

  let query = supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', claims.userId)
    .is('read_at', null)

  if (parsed.data.id) query = query.eq('id', parsed.data.id)

  const { error } = await query
  if (error) return { ok: false }

  // The bell is rendered by the (app) layout, so every authenticated route
  // shows a stale count until its segment is revalidated.
  revalidatePath('/', 'layout')
  return { ok: true }
}
