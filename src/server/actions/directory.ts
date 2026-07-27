'use server'

import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'

/**
 * Organisation lookups for AUTHENTICATED screens.
 *
 * Deliberately a separate module from src/server/actions/org.ts. That file
 * holds the only unauthenticated use of the admin client in the codebase — two
 * hard-narrowed functions serving the registration form — and its header warns
 * against ever adding a filter argument to them. Putting authenticated lookups
 * beside them would blur a boundary that is currently unmistakable.
 *
 * Everything here uses the USER's client, so RLS scopes each list to the
 * caller's company. `profiles` in particular is scoped to their team by
 * profiles_read_team, which is exactly right for an assignment picker: a chef
 * assigns an exam to people they manage, not to the whole company.
 */

export interface DirectoryOption {
  id: string
  name: string
}

export interface PersonOption {
  id: string
  name: string
  email: string
}

export async function listOutlets(): Promise<DirectoryOption[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('outlets')
    .select('id, name')
    .is('deleted_at', null)
    .eq('is_active', true)
    .order('name')

  if (error) return []
  return data as DirectoryOption[]
}

export async function listDepartments(): Promise<DirectoryOption[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .is('deleted_at', null)
    .order('sort_order')

  if (error) return []
  return data as DirectoryOption[]
}

export async function listBrands(): Promise<DirectoryOption[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('brands')
    .select('id, name')
    .is('deleted_at', null)
    .order('name')

  if (error) return []
  return data as DirectoryOption[]
}

/**
 * Roles an exam may be targeted at.
 *
 * Returns the role KEY as the id, not the uuid — assignment stores a key so the
 * visibility policy can read it straight from the JWT rather than joining
 * user_roles per candidate row (see migration 0014).
 *
 * super_admin is excluded: assigning an exam to the platform owner is never
 * what somebody meant, and offering it invites a misclick that quietly targets
 * whoever holds that role.
 */
export async function listAssignableRoles(): Promise<DirectoryOption[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('roles')
    .select('key, name')
    .neq('key', 'super_admin')
    .order('sort_order')

  if (error) return []
  return (data ?? []).map((role) => ({ id: role.key, name: role.name }))
}

/**
 * People this chef can assign an exam to individually.
 *
 * Scoped by RLS to their team, and filtered to approved accounts: assigning an
 * exam to somebody still awaiting approval creates a notification they cannot
 * act on, because they cannot sign in.
 */
export async function listTeamMembers(): Promise<PersonOption[]> {
  await requirePermission('exams.assign')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('approval_status', 'approved')
    .is('deleted_at', null)
    .order('full_name')

  if (error) return []
  return (data ?? []).map((person) => ({
    id: person.id,
    name: person.full_name,
    email: person.email,
  }))
}
