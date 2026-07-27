import 'server-only'
import { getAppClaims, can, type AppClaims } from './claims'
import type { Permission } from './permissions'

/**
 * Authorisation guards for server actions and route handlers.
 *
 * THE RULE: every function that touches the admin client (which bypasses RLS)
 * begins with one of these. RLS is the coarse blast-door; these are the
 * fine-grained gate. Skipping the guard on an admin-client path means no
 * authorisation check happens at all.
 *
 * They throw rather than return a result so that forgetting to check the
 * return value cannot silently grant access — the failure mode of a boolean
 * helper is "author forgot the `if`", and that failure is invisible in review.
 */

export class AuthorizationError extends Error {
  readonly status = 403
  constructor(
    message: string,
    readonly permission?: Permission,
  ) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export class AuthenticationError extends Error {
  readonly status = 401
  constructor(message = 'Not signed in.') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class ApprovalPendingError extends Error {
  readonly status = 403
  constructor(message = 'Your account is awaiting approval.') {
    super(message)
    this.name = 'ApprovalPendingError'
  }
}

/**
 * Assert the caller holds `permission`. Returns their claims so callers can
 * scope queries by outlet or company without a second round trip.
 *
 * Distinguishes the three failure modes because they need different responses:
 * not signed in → redirect to login; pending → redirect to /pending; lacking
 * the permission → 403.
 */
export async function requirePermission(permission: Permission): Promise<AppClaims> {
  const claims = await getAppClaims()

  if (claims.roles.length === 0 && !claims.approved && !claims.company_id) {
    throw new AuthenticationError()
  }
  if (!claims.approved) {
    throw new ApprovalPendingError()
  }
  if (!can(claims, permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}`, permission)
  }

  return claims
}

/** Approval alone, no specific permission — for routes any approved user may see. */
export async function requireApproved(): Promise<AppClaims> {
  const claims = await getAppClaims()
  if (!claims.approved) throw new ApprovalPendingError()
  return claims
}

/**
 * Assert ANY of the given permissions. For screens reachable by several roles
 * through different grants — a report a chef sees via reports.read_team and HR
 * sees via reports.read_all.
 */
export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AppClaims> {
  const claims = await getAppClaims()

  if (!claims.approved) throw new ApprovalPendingError()
  if (!permissions.some((p) => can(claims, p))) {
    throw new AuthorizationError(
      `Missing all of the required permissions: ${permissions.join(', ')}`,
    )
  }

  return claims
}
