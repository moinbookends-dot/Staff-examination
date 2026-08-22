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

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `digest` IS HOW THE ERROR BOUNDARY TELLS A REFUSAL FROM A CRASH, AND IT   │
 * │ IS THE ONLY THING THAT SURVIVES THE TRIP.                                 │
 * │                                                                           │
 * │ In a production build Next replaces a server error's `message` and `name` │
 * │ before it reaches the client — the boundary receives a bare Error whose    │
 * │ message is "An error occurred in the Server Components render". Matching   │
 * │ on `name` therefore worked in dev and silently failed in production,      │
 * │ which is exactly how it was found: a denied page rendered "Something went │
 * │ wrong at our end. Try again in a moment."                                 │
 * │                                                                           │
 * │ `digest` is passed through verbatim when it is already set, because Next  │
 * │ only generates one for errors that lack it. So these three carry a stable │
 * │ marker and src/app/[locale]/(app)/error.tsx reads it.                     │
 * │                                                                           │
 * │ It leaks nothing: "FORBIDDEN" is the fact the user is about to be told in │
 * │ words. The permission KEY stays in `permission`, server-side, and is      │
 * │ never serialised.                                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const REFUSAL_DIGEST = 'FORBIDDEN'

export class AuthorizationError extends Error {
  readonly status = 403
  readonly digest = REFUSAL_DIGEST
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
  readonly digest = REFUSAL_DIGEST
  constructor(message = 'Not signed in.') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class ApprovalPendingError extends Error {
  readonly status = 403
  readonly digest = REFUSAL_DIGEST
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
