'use server'

import { createClient } from '@/lib/supabase/server'

/**
 * Organisation lookups for the registration form.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS USED TO BE THE ONLY UNAUTHENTICATED USE OF THE ADMIN CLIENT.         │
 * │                                                                           │
 * │ It was a considered choice — the note that stood here weighed it against  │
 * │ "a permanent public read grant on the org tree to serve two dropdowns"    │
 * │ and narrowed the queries carefully to compensate.                         │
 * │                                                                           │
 * │ It failed in production anyway, and not through anything the narrowing    │
 * │ could have caught: getSecretKey() THROWS when SUPABASE_SECRET_KEY is      │
 * │ absent, so one unset environment variable on the host turned the public   │
 * │ sign-up page into a 500 while every other auth page served normally.      │
 * │                                                                           │
 * │ Migration 0081 answers the original objection instead of ignoring it.     │
 * │ anon is granted `id` and `name` — the columns these dropdowns render —    │
 * │ and nothing else: not address, city, code, company_id or brand_id. The    │
 * │ deleted/inactive filter lives in the RLS policy rather than in the query  │
 * │ below, so it holds however the request is written.                        │
 * │                                                                           │
 * │ The ordinary server client is therefore enough, and a public page no      │
 * │ longer depends on the one credential that can read every row.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Both functions stay parameterless. If a caller needs a narrower list, do it
 * after authentication — a filter argument here is a filter an anonymous
 * caller controls.
 */

export interface OrgOption {
  id: string
  name: string
}

export async function listOutletsForRegistration(): Promise<OrgOption[]> {
  const supabase = await createClient()

  /*
   * No deleted_at / is_active filter here, deliberately: 0081's policy applies
   * both. Repeating them would also require granting anon SELECT on those two
   * columns — a WHERE clause needs column privileges, a policy does not.
   */
  const { data, error } = await supabase.from('outlets').select('id, name').order('name')

  if (error) return []

  // Remapped rather than returned as-is: if someone later adds a column to the
  // select, this shape stops it reaching an unauthenticated caller.
  return (data ?? []).map((o) => ({ id: o.id as string, name: o.name as string }))
}

export async function listDepartmentsForRegistration(): Promise<OrgOption[]> {
  const supabase = await createClient()

  // sort_order is granted to anon for exactly this: the curated order is the
  // one an Editor set, and alphabetising it would quietly discard that.
  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .order('sort_order')

  if (error) return []

  return (data ?? []).map((d) => ({ id: d.id as string, name: d.name as string }))
}
