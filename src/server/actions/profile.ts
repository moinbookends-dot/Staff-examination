'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth/guards'
import { routing } from '@/lib/i18n/routing'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A person's own details.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE WHITELIST HERE IS THE ONE MIGRATION 0069 ALREADY ENFORCES.            ║
 * ║                                                                           ║
 * ║ 0005's profiles_self_update policy scopes the ROW (`id = auth.uid()`) and ║
 * ║ says of itself: "Column restrictions … cannot be expressed in RLS … The   ║
 * ║ server action is the enforcement point: it accepts a whitelist of         ║
 * ║ editable fields only."                                                    ║
 * ║                                                                           ║
 * ║ THAT SERVER ACTION NEVER EXISTED. This is it — but it is deliberately     ║
 * ║ NOT the security boundary, because relying on one was how a live          ║
 * ║ privilege escalation shipped. 0069 revoked UPDATE on the table and        ║
 * ║ re-granted it on exactly five columns:                                    ║
 * ║                                                                           ║
 * ║   full_name, phone, preferred_locale, avatar_path, email_opt_in           ║
 * ║                                                                           ║
 * ║ plus a BEFORE UPDATE trigger that refuses a self-edit touching approval,  ║
 * ║ tenancy, email or HR fields. So this list matching that grant is a        ║
 * ║ courtesy to the caller — a clear message instead of a 42501 — and the     ║
 * ║ database refuses regardless of what reaches it.                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT IS READ-ONLY AND WHY: email is synced from the sign-in and letting it
 * drift would break the link to auth.users; role, outlet, department and
 * approval are administrative facts about a person, set by somebody else.
 * They are SHOWN, because "what am I in this system" is the main question this
 * screen answers, and withholding it would make it useless.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface MyProfile {
  fullName: string
  email: string
  phone: string | null
  preferredLocale: string
  roles: string[]
  outletName: string | null
  departmentName: string | null
  brandName: string | null
  companyName: string | null
  employeeCode: string | null
  approvalStatus: string
  joinedAt: string | null
  createdAt: string
}

export async function loadMyProfile(): Promise<MyProfile | null> {
  const claims = await requireApproved()
  if (!claims.userId) return null

  const supabase = await createClient()

  /*
   * Separate queries rather than embeds: gen-types.mjs emits
   * `Relationships: []`, so an embedded select cannot be typed. Four small
   * lookups run together — one round-trip window, not four.
   */
  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'full_name, email, phone, preferred_locale, employee_code, approval_status, joined_at, created_at, outlet_id, department_id, brand_id, company_id',
    )
    .eq('id', claims.userId)
    .maybeSingle()

  if (!profile) return null

  const [outlet, department, brand, company, roles] = await Promise.all([
    profile.outlet_id
      ? supabase.from('outlets').select('name').eq('id', profile.outlet_id).maybeSingle()
      : Promise.resolve({ data: null }),
    profile.department_id
      ? supabase.from('departments').select('name').eq('id', profile.department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    profile.brand_id
      ? supabase.from('brands').select('name').eq('id', profile.brand_id).maybeSingle()
      : Promise.resolve({ data: null }),
    profile.company_id
      ? supabase.from('companies').select('name').eq('id', profile.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('user_roles').select('roles!inner(name)').eq('user_id', claims.userId),
  ])

  return {
    fullName: profile.full_name,
    email: profile.email,
    phone: profile.phone,
    preferredLocale: profile.preferred_locale,
    roles: ((roles.data ?? []) as unknown as Array<{ roles: { name: string } }>)
      .map((r) => r.roles?.name)
      .filter(Boolean),
    outletName: outlet.data?.name ?? null,
    departmentName: department.data?.name ?? null,
    brandName: brand.data?.name ?? null,
    companyName: company.data?.name ?? null,
    employeeCode: profile.employee_code,
    approvalStatus: profile.approval_status,
    joinedAt: profile.joined_at,
    createdAt: profile.created_at,
  }
}

const profileInput = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  // Optional and allowed to be cleared — somebody removing a wrong number
  // must not be forced to invent one.
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  preferredLocale: z.enum(routing.locales),
})

export type ProfileResult = { ok: true } | { ok: false; message: string }

export async function updateMyProfile(raw: unknown): Promise<ProfileResult> {
  const claims = await requireApproved()
  if (!claims.userId) return { ok: false, message: 'You are not signed in.' }

  const parsed = profileInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const supabase = await createClient()

  /*
   * The caller's own client, so RLS decides. profiles_self_update scopes this
   * to `id = auth.uid()`; the .eq() below is belt and braces, not the control.
   */
  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone === '' ? null : parsed.data.phone,
      preferred_locale: parsed.data.preferredLocale,
    })
    .eq('id', claims.userId)

  if (error) {
    // 42501 is 0069's column grant refusing — it means this action tried to
    // write something outside the five permitted columns, which would be a bug
    // here rather than something the user did.
    return {
      ok: false,
      message:
        error.code === '42501'
          ? 'That change is not yours to make.'
          : 'Your details could not be saved.',
    }
  }

  revalidatePath('/settings')
  return { ok: true }
}
