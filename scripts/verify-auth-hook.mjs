/**
 * Verifies the custom access token hook end to end.
 *
 * WHY THIS IS A SEPARATE, DELIBERATE CHECK (plan §11 tier 2):
 *
 * supabase/config.toml configures the LOCAL stack only. Pushing migrations
 * creates the hook function on the hosted project but does NOT enable it —
 * that is a project-level auth setting.
 *
 * If it is not enabled, nothing errors anywhere. Tokens mint without the `app`
 * claim, has_perm() returns false for every user, every RLS policy denies, and
 * the app renders empty screens with no message in any log. It is the single
 * most confusing failure mode in this design, so it gets an explicit test
 * rather than being inferred from "the app seems to work".
 *
 *   node scripts/verify-auth-hook.mjs
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function readEnvLocal() {
  const raw = readFileSync(resolve(root, '.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = readEnvLocal()
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const PUBLISHABLE = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = env.SUPABASE_SECRET_KEY
const ref = new (globalThis.URL)(URL_).hostname.split('.')[0]

const TEST_EMAIL = `hook-probe-${Date.now()}@bookends-test.local`
const TEST_PASSWORD = 'probe-password-8chars-min'

let fail = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); fail++ }
/** Assert, reporting a distinct message either way. */
const check = (cond, good, notGood) => { if (cond) ok(good); else bad(notGood) }

// ── 1. Does the function exist and run? ──────────────────────────────────────
console.log('\n1. Hook function')

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const { rows: fnExists } = await db.query(`
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'custom_access_token_hook'
`)
check(fnExists.length > 0, 'custom_access_token_hook exists', 'custom_access_token_hook MISSING')

// Unknown user must still produce approved:false rather than erroring —
// failing closed is the required behaviour.
const { rows: hookOut } = await db.query(
  `select public.custom_access_token_hook(
     jsonb_build_object('user_id', gen_random_uuid()::text, 'claims', '{}'::jsonb)
   ) as result`,
)
const unknownClaims = hookOut[0].result?.claims?.app
check(
  Boolean(unknownClaims) && unknownClaims.approved === false,
  'unknown user → approved:false (fails closed)',
  `unknown user produced unexpected claims: ${JSON.stringify(unknownClaims)}`,
)

// ── 2. Create a real user and inspect a real token ───────────────────────────
console.log('\n2. Live token')

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

const createRes = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Hook Probe', locale: 'en' },
  }),
})

if (!createRes.ok) {
  bad(`could not create probe user: ${createRes.status} ${(await createRes.text()).slice(0, 200)}`)
} else {
  const created = await createRes.json()
  ok(`probe user created (${created.id})`)

  // The signup trigger should have made a profile, pending by default.
  const { rows: prof } = await db.query(
    'select approval_status, full_name, company_id from public.profiles where id = $1',
    [created.id],
  )
  if (!prof.length) {
    bad('handle_new_user did NOT create a profile row')
  } else {
    ok(`profile created, status=${prof[0].approval_status}, name="${prof[0].full_name}"`)
    check(
      prof[0].approval_status === 'pending',
      'new user defaults to pending (approval gate intact)',
      `new user status is ${prof[0].approval_status}, expected pending`,
    )
    check(Boolean(prof[0].company_id), 'company assigned by trigger', 'company_id is null')
  }

  const { rows: roleRows } = await db.query(
    `select r.key from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1`,
    [created.id],
  )
  check(
    roleRows.length === 1 && roleRows[0].key === 'employee',
    'default role = employee',
    `unexpected default roles: ${JSON.stringify(roleRows.map((r) => r.key))}`,
  )

  // Sign in to obtain a genuinely minted access token.
  const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  })

  if (!signIn.ok) {
    bad(`sign-in failed: ${signIn.status} ${(await signIn.text()).slice(0, 200)}`)
  } else {
    const { access_token } = await signIn.json()
    ok('signed in, access token issued')

    const payload = JSON.parse(
      Buffer.from(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    )

    console.log(`     claim keys: ${Object.keys(payload).join(', ')}`)

    if (!payload.app) {
      bad('NO `app` CLAIM IN THE TOKEN — the hook is NOT enabled on this project')
      console.log('\n     FIX: Supabase Dashboard → Authentication → Hooks →')
      console.log('          "Customize Access Token (JWT) Claims" → enable →')
      console.log('          choose postgres function `public.custom_access_token_hook`')
      console.log('     config.toml only affects the local stack, never the hosted project.')
    } else {
      ok('`app` claim present — hook IS enabled and minting')
      console.log(`     app = ${JSON.stringify(payload.app)}`)
      check(
        payload.app.approved === false,
        'probe user correctly unapproved in claims',
        'probe user shows approved:true — approval gate is broken',
      )
      check(
        Array.isArray(payload.app.roles) && payload.app.roles.includes('employee'),
        'roles present in claims',
        'roles missing from claims',
      )
    }
  }

  // Cleanup — cascades to profiles and user_roles.
  await fetch(`${URL_}/auth/v1/admin/users/${created.id}`, { method: 'DELETE', headers: adminHeaders })
  console.log('  🧹 probe user deleted')
}

await db.end()

console.log(fail === 0 ? '\nAll checks passed.\n' : `\n${fail} check(s) failed.\n`)
process.exit(fail === 0 ? 0 : 1)
