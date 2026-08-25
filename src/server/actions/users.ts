'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'

/**
 * Registration approval — the chef's queue.
 *
 * Approving is where a person's data scope is decided: outlet_id and
 * department_id are set HERE, by a chef, not asserted by the user at signup.
 * Everything downstream (which staff they appear among, which exams reach
 * them, which rows RLS returns) follows from those two columns, so they must
 * come from someone with authority.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO ADMIN CLIENT IN THIS FILE ANY MORE — and that is the whole point.      │
 * │                                                                           │
 * │ Both decisions used to run through createAdminClient(), because a chef    │
 * │ holds users.approve but NOT users.update, so profiles_admin_update would  │
 * │ refuse to let them write another person's outlet. RLS was genuinely in    │
 * │ the way and the service key was a reasonable way through it.              │
 * │                                                                           │
 * │ It also meant getSecretKey() ran on every click, and that THROWS when     │
 * │ SUPABASE_SECRET_KEY is unset. On a host missing the variable, pressing    │
 * │ Accept did not show an error — the action threw and the screen fell into  │
 * │ the error boundary, so the queue looked broken with no way to approve     │
 * │ anybody. Exactly the failure 0081 removed from registration.              │
 * │                                                                           │
 * │ 0085/0086 replaced it with approve_registration() and                     │
 * │ reject_registration(): SECURITY DEFINER, gated on has_perm('users.approve')│
 * │ and scoped to the caller's own company, doing the update, the notification│
 * │ and the queued email in ONE transaction. Narrow privilege for one         │
 * │ operation, instead of a key that reads every row in the database.         │
 * └───────────────────────────────────────────────────────────────────────────┘
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
  /*
   * dbId(), NOT z.string().uuid() — and this one actually bit. Zod 4's uuid()
   * enforces RFC 4122 version/variant nibbles; the seeded outlet ids
   * (00000000-…-00000000a001) have both nibbles zero, so selecting a real
   * outlet failed validation and the chef was told "Select an outlet." while
   * looking at their selection. The warning predicting exactly this sits in
   * src/lib/db/id.ts. Departments happen to be v4 today, but they are read
   * from a uuid column, so the same contract applies.
   */
  outletId: dbId('Select an outlet.'),
  departmentId: dbId('Select a department.'),
  brandId: dbId().optional().nullable(),
})

export async function approveRegistration(input: unknown): Promise<MutationResult> {
  await requirePermission('users.approve')

  const parsed = approveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  const { userId, outletId, departmentId } = parsed.data
  const supabase = await createClient()

  /*
   * One call. The function re-verifies the applicant is this company's, that
   * the outlet and department are live and ours, and that the row is still
   * pending — none of which can be trusted from the client, and all of which
   * used to be three separate round trips here.
   */
  const { data, error } = await supabase.rpc('approve_registration', {
    p_user_id: userId,
    p_outlet_id: outletId,
    p_department_id: departmentId,
  })

  if (error) {
    // The function raises named errors; map them to something a chef can act
    // on rather than showing a Postgres message.
    if (/already decided/i.test(error.message)) {
      return { ok: false, error: 'That registration has already been decided.' }
    }
    if (/registration not found/i.test(error.message)) {
      return { ok: false, error: 'That registration no longer exists.' }
    }
    if (/unknown outlet/i.test(error.message)) {
      return { ok: false, error: 'That outlet is no longer available. Pick another.' }
    }
    if (/unknown department/i.test(error.message)) {
      return { ok: false, error: 'That department is no longer available. Pick another.' }
    }
    if (/forbidden/i.test(error.message)) {
      return { ok: false, error: 'You do not have permission to approve registrations.' }
    }
    return { ok: false, error: 'Could not approve this registration.' }
  }

  const approved = Array.isArray(data) ? (data[0]?.approved ?? 0) : 0
  if (approved === 0) {
    return { ok: false, error: 'Someone else just decided this registration.' }
  }

  revalidatePath('/approvals')
  return { ok: true }
}

const rejectSchema = z.object({
  userId: dbId(),
  reason: z.string().trim().min(3, 'Give a reason so the person knows why.').max(500),
})

export async function rejectRegistration(input: unknown): Promise<MutationResult> {
  await requirePermission('users.approve')

  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  const { userId, reason } = parsed.data
  const supabase = await createClient()

  const { data, error } = await supabase.rpc('reject_registration', {
    p_user_id: userId,
    p_reason: reason,
  })

  if (error) {
    if (/already decided/i.test(error.message)) {
      return { ok: false, error: 'That registration has already been decided.' }
    }
    if (/registration not found/i.test(error.message)) {
      return { ok: false, error: 'That registration no longer exists.' }
    }
    if (/forbidden/i.test(error.message)) {
      return { ok: false, error: 'You do not have permission to decide registrations.' }
    }
    return { ok: false, error: 'Could not reject this registration.' }
  }

  const rejected = Array.isArray(data) ? (data[0]?.rejected ?? 0) : 0
  if (rejected === 0) {
    return { ok: false, error: 'Someone else just decided this registration.' }
  }

  revalidatePath('/approvals')
  return { ok: true }
}
