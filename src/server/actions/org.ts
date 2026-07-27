'use server'

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Organisation lookups for the registration form.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY UNAUTHENTICATED USE OF THE ADMIN CLIENT IN THE CODEBASE.         │
 * │                                                                           │
 * │ The registration form needs outlet and department dropdowns before any    │
 * │ session exists. The alternative — an anon SELECT policy on the org tree — │
 * │ would be a permanent public read grant to serve two dropdowns.            │
 * │                                                                           │
 * │ The trade is acceptable ONLY because these functions are hard-narrowed:   │
 * │   · explicit column lists, never select('*')                              │
 * │   · no parameters, so nothing a caller sends can widen the query          │
 * │   · rows are remapped to {id, name} before returning, so a column added   │
 * │     to the table later cannot silently start leaking                      │
 * │                                                                           │
 * │ Do not add a filter argument to either of these. If a caller needs to     │
 * │ narrow the list, do it after authentication.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export interface OrgOption {
  id: string
  name: string
}

export async function listOutletsForRegistration(): Promise<OrgOption[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('outlets')
    .select('id, name')
    .is('deleted_at', null)
    .eq('is_active', true)
    .order('name')

  if (error) return []

  // Remapped rather than returned as-is: if someone later adds a column to the
  // select, this shape stops it reaching an unauthenticated caller.
  return (data ?? []).map((o) => ({ id: o.id as string, name: o.name as string }))
}

export async function listDepartmentsForRegistration(): Promise<OrgOption[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .is('deleted_at', null)
    .order('sort_order')

  if (error) return []

  return (data ?? []).map((d) => ({ id: d.id as string, name: d.name as string }))
}
