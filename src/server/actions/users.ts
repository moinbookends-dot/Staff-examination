'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbId } from '@/lib/db/id'

/**
 * Registration approval — the chef's queue.
 *
 * Approving is where a person's data scope is decided: outlet_id and
 * department_id are set HERE, by a chef, not asserted by the user at signup.
 * Everything downstream (which staff they appear among, which exams reach
 * them, which rows RLS returns) follows from those two columns, so they must
 * come from someone with authority.
 */

export interface PendingRegistration {
  id: string
  email: string
  full_name: string
  phone: string | null
  preferred_locale: string
  created_at: string
}

export interface MutationResult {
  ok: boolean
  error?: string
}

/**
 * Pending registrations.
 *
 * Read through the USER's client, not the admin client — the profiles_read_all
 * / profiles_read_team policies then scope the queue to what this chef may see
 * (their own outlet). Using the admin client here would silently show every
 * outlet's pending staff to every chef.
 */
export async function listPendingRegistrations(): Promise<PendingRegistration[]> {
  await requirePermission('users.approve')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, phone, preferred_locale, created_at')
    .eq('approval_status', 'pending')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })

  if (error) return []
  return data as unknown as PendingRegistration[]
}

const approveSchema = z.object({
  userId: dbId(),
  outletId: z.string().uuid('Select an outlet.'),
  departmentId: z.string().uuid('Select a department.'),
  brandId: dbId().optional().nullable(),
})

export async function approveRegistration(input: unknown): Promise<MutationResult> {
  const claims = await requirePermission('users.approve')

  const parsed = approveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  const { userId, outletId, departmentId } = parsed.data

  // Admin client: setting another user's outlet is intentionally not something
  // the profiles_admin_update policy grants a chef — chefs hold users.approve,
  // not users.update. The requirePermission() above is the authorisation check.
  const admin = createAdminClient()

  // Guard against approving out of scope. A chef's queue is already filtered by
  // RLS, but this action takes a userId from the client, so re-verify rather
  // than trusting it.
  const { data: target } = await admin
    .from('profiles')
    .select('id, email, outlet_id, company_id, approval_status')
    .eq('id', userId)
    .single()

  if (!target) return { ok: false, error: 'That registration no longer exists.' }
  if (target.approval_status !== 'pending') {
    return { ok: false, error: 'That registration has already been decided.' }
  }
  if (target.company_id !== claims.company_id) {
    return { ok: false, error: 'That registration belongs to another company.' }
  }

  const { error, count } = await admin
    .from('profiles')
    .update(
      {
        approval_status: 'approved',
        approved_by: claims.userId,
        approved_at: new Date().toISOString(),
        outlet_id: outletId,
        department_id: departmentId,
        rejection_reason: null,
      },
      { count: 'exact' },
    )
    .eq('id', userId)
    // Optimistic guard. Two chefs share one queue; without this, the second
    // click would silently overwrite the first chef's outlet assignment.
    .eq('approval_status', 'pending')

  if (error) return { ok: false, error: 'Could not approve this registration.' }
  if (count === 0) return { ok: false, error: 'Someone else just decided this registration.' }

  await admin.from('notifications').insert({
    user_id: userId,
    kind: 'registration.approved',
    title: 'Your account has been approved',
    body: 'You can now sign in and see your assigned exams.',
    link: '/dashboard',
  })

  // Queued, never sent inline — approving a batch of new starters must not
  // blow the 100/day provider quota (plan §10).
  await admin.from('email_outbox').insert({
    to_email: target.email as string,
    to_user_id: userId,
    subject: 'Your Bookends Learning account is ready',
    template: 'registration-approved',
    priority: 2,
    payload: { dedupe_key: `registration-approved:${userId}` },
  })

  revalidatePath('/approvals')
  return { ok: true }
}

const rejectSchema = z.object({
  userId: dbId(),
  reason: z.string().trim().min(3, 'Give a reason so the person knows why.').max(500),
})

export async function rejectRegistration(input: unknown): Promise<MutationResult> {
  const claims = await requirePermission('users.approve')

  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  const { userId, reason } = parsed.data
  const admin = createAdminClient()

  const { data: target } = await admin
    .from('profiles')
    .select('id, company_id, approval_status')
    .eq('id', userId)
    .single()

  if (!target) return { ok: false, error: 'That registration no longer exists.' }
  if (target.company_id !== claims.company_id) {
    return { ok: false, error: 'That registration belongs to another company.' }
  }

  const { error, count } = await admin
    .from('profiles')
    .update(
      {
        approval_status: 'rejected',
        rejection_reason: reason,
        approved_by: claims.userId,
        approved_at: new Date().toISOString(),
      },
      { count: 'exact' },
    )
    .eq('id', userId)
    .eq('approval_status', 'pending')

  if (error) return { ok: false, error: 'Could not reject this registration.' }
  if (count === 0) return { ok: false, error: 'Someone else just decided this registration.' }

  // The rejected user can still read their own notifications — the
  // notifications_self_read policy has no approval gate precisely so this
  // message reaches them.
  await admin.from('notifications').insert({
    user_id: userId,
    kind: 'registration.rejected',
    title: 'Your registration was not approved',
    body: reason,
  })

  revalidatePath('/approvals')
  return { ok: true }
}
