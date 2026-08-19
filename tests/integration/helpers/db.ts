import { Client } from 'pg'

/**
 * RLS test harness.
 *
 * WHAT THIS TESTS AND WHAT IT DOES NOT (plan §11, two tiers):
 *
 *  Tier 1 — here. Impersonates an authenticated request by setting the
 *  `authenticated` role and `request.jwt.claims`, exactly as Supabase does at
 *  the connection level. Every RLS helper (jwt_app, is_approved, has_perm)
 *  reads auth.jwt() and touches no tables, so policies behave identically to
 *  production. Runs on a bare Postgres container — no Docker needed locally,
 *  no network, fast enough to run on every push.
 *
 *  Tier 2 — manual, once per milestone, against the real project. This harness
 *  FABRICATES the `app` claim. It therefore cannot prove the custom access
 *  token hook is registered and actually minting that claim. If the hook is
 *  misconfigured, every test here passes and the live app shows every user an
 *  empty screen. Verify by decoding a real access token after login.
 *
 * An RLS bug is a data breach and it is silent — nothing errors, the wrong
 * rows simply come back. Hence: every policy gets one allow case and one deny
 * case. The deny case is the one that matters.
 */

const DATABASE_URL = process.env.DATABASE_URL

/** True when a test database is reachable. Suites skip themselves otherwise. */
export const hasDatabase = Boolean(DATABASE_URL)

export interface TestClaims {
  sub: string
  email?: string
  app?: {
    approved?: boolean
    company_id?: string | null
    brand_id?: string | null
    outlet_id?: string | null
    department_id?: string | null
    roles?: string[]
    perms?: string[]
  }
}

export async function connect(): Promise<Client> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set')
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  return client
}

/**
 * Run `fn` as an authenticated user with the given claims.
 *
 * Wrapped in a transaction that is ALWAYS rolled back — tests share one
 * database, and leaked rows from one case produce failures in another that
 * look like policy bugs and are miserable to trace. Rollback also means
 * `set local` reverts automatically.
 */
export async function asUser<T>(
  client: Client,
  claims: TestClaims,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query("set local role authenticated")
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
    return await fn(client)
  } finally {
    await client.query('rollback')
  }
}

/** Run `fn` as an unauthenticated visitor. */
export async function asAnon<T>(
  client: Client,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('set local role anon')
    await client.query('select set_config($1, $2, true)', ['request.jwt.claims', '{}'])
    return await fn(client)
  } finally {
    await client.query('rollback')
  }
}

/**
 * Run `fn` with RLS bypassed, for arranging fixtures. ROLLED BACK.
 *
 * Never assert policy behaviour through this — it is the setup path, not the
 * subject. A test that both arranges and asserts as the owner proves nothing.
 */
export async function asOwner<T>(
  client: Client,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('reset role')
    return await fn(client)
  } finally {
    await client.query('rollback')
  }
}

/**
 * Like asOwner, but COMMITS.
 *
 * Needed when the thing under test is a side effect that must outlive the
 * transaction — a trigger writing to another table, for instance. Under the
 * rolled-back asOwner, the write happens and then vanishes, so the assertion
 * sees nothing and the trigger looks broken when it is fine.
 *
 * Use sparingly and clean up in afterAll: anything written here is visible to
 * every other test in the file.
 */
export async function mutateAsOwner<T>(
  client: Client,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('reset role')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback')
    throw err
  }
}

// ── Claim builders ───────────────────────────────────────────────────────────

const COMPANY = '00000000-0000-0000-0000-00000000c001'
const OUTLET_AIKO = '00000000-0000-0000-0000-00000000a001'
const OUTLET_CAPICHE = '00000000-0000-0000-0000-00000000a002'
const BRAND_AIKO = '00000000-0000-0000-0000-00000000b001'
const BRAND_CAPICHE = '00000000-0000-0000-0000-00000000b002'

export const fixtures = {
  company: COMPANY,
  outletAiko: OUTLET_AIKO,
  outletCapiche: OUTLET_CAPICHE,
  brandAiko: BRAND_AIKO,
  brandCapiche: BRAND_CAPICHE,
} as const

/**
 * The brand a real token carries for a given outlet.
 *
 * Since migration 0023 the auth hook DERIVES brand_id from the user's outlet
 * rather than copying profiles.brand_id, a column nothing writes. These claim
 * builders have to mint the same thing, or they are less capable than reality
 * and every brand-scoped assertion is vacuous — the mirror image of the M1 bug
 * where fixtures were MORE capable than reality and hid a broken policy.
 */
const brandOf = (outlet: string) => (outlet === OUTLET_CAPICHE ? BRAND_CAPICHE : BRAND_AIKO)

/** A user whose registration has not been approved. Should see almost nothing. */
export function pendingUser(id: string): TestClaims {
  return {
    sub: id,
    app: { approved: false, company_id: COMPANY, outlet_id: OUTLET_AIKO, roles: ['employee'], perms: [] },
  }
}

export function employee(id: string, outlet = OUTLET_AIKO): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: COMPANY,
      outlet_id: outlet,
      brand_id: brandOf(outlet),
      roles: ['employee'],
      perms: ['attempts.take', 'attempts.read_own', 'reports.read_own', 'learning.read'],
    },
  }
}

/**
 * Mirrors DEFAULT_ROLE_PERMISSIONS.chef in src/lib/auth/permissions.ts.
 *
 * Keep it complete even for keys no test uses yet. A fixture that grants LESS
 * than the real role turns every allow-case into a false negative that reads
 * like a policy bug; one that grants MORE turns every deny-case into a false
 * pass, which is worse and silent. Cf. the M1 approval-queue bug, where a
 * fixture more convenient than reality hid a policy that filtered out every row.
 */
export function chef(id: string, outlet = OUTLET_AIKO): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: COMPANY,
      outlet_id: outlet,
      brand_id: brandOf(outlet),
      roles: ['chef'],
      perms: [
        'questions.read', 'questions.create', 'questions.update',
        'questions.retire', 'questions.import', 'questions.translate',
        'exams.read', 'exams.create', 'exams.update', 'exams.publish',
        'exams.assign', 'exams.archive',
        'attempts.read_team', 'attempts.read_own',
        'evaluation.evaluate', 'evaluation.verify', 'evaluation.return', 'evaluation.publish',
        'users.read_team', 'users.approve',
        'reports.read_team', 'reports.read_own', 'reports.export',
        'learning.read', 'learning.manage',
      ],
    },
  }
}

export function hr(id: string): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: COMPANY,
      outlet_id: OUTLET_AIKO,
      brand_id: BRAND_AIKO,
      roles: ['hr'],
      perms: ['users.read_all', 'attempts.read_all', 'reports.read_all', 'exams.read', 'learning.read'],
    },
  }
}

/** Super admin holds no explicit perms — has_perm() short-circuits on the role. */
/**
 * Mirrors DEFAULT_ROLE_PERMISSIONS.admin in src/lib/auth/permissions.ts.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE ROLE THAT USED TO BE CALLED `editor`.                         │
 * │                                                                           │
 * │ Migration 0071 renamed `chef` to `admin` and deleted `editor`, folding    │
 * │ the seven bank.* keys into it. So a test that wants "somebody who may     │
 * │ import" wants THIS, and the `chef()` builder above — which grants the     │
 * │ legacy questions.* keys and no bank.* key at all — is now the natural     │
 * │ DENY case rather than a second allow case.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Kept complete for the same reason chef() is: a fixture granting less than
 * the real role turns every allow-case into a false negative, and one granting
 * more turns every deny-case into a silent false pass.
 */
export function admin(id: string, outlet = OUTLET_AIKO): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: COMPANY,
      outlet_id: outlet,
      brand_id: brandOf(outlet),
      roles: ['admin'],
      perms: [
        'bank.read', 'bank.write', 'bank.archive', 'bank.delete',
        'bank.import', 'bank.export', 'bank.read_uuid',
        'papers.generate', 'papers.read_history',
        'questions.read', 'questions.create', 'questions.update',
        'questions.retire', 'questions.import', 'questions.translate',
        'exams.read', 'exams.create', 'exams.update', 'exams.publish',
        'exams.assign', 'exams.archive',
        'attempts.read_team', 'attempts.read_own',
        'evaluation.evaluate', 'evaluation.verify', 'evaluation.return', 'evaluation.publish',
        'users.read_team', 'users.approve',
        'reports.read_team', 'reports.read_own', 'reports.export',
        'settings.manage',
        'learning.read', 'learning.manage',
      ],
    },
  }
}

export function superAdmin(id: string): TestClaims {
  return {
    sub: id,
    app: {
      approved: true,
      company_id: COMPANY,
      outlet_id: OUTLET_AIKO,
      brand_id: BRAND_AIKO,
      roles: ['super_admin'],
      perms: [],
    },
  }
}
