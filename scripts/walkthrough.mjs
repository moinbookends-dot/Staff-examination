/**
 * End-to-end walkthrough: register → approve → sign in → read data.
 *
 * Exercises the real HTTP path with real tokens — the same requests a browser
 * makes — rather than talking to Postgres directly. That distinction matters:
 * the pg-level RLS tests fabricate the `app` claim, so they cannot catch a
 * misconfigured auth hook. This can.
 *
 * Covers plan §15 acceptance items 1–2 and the JWT staleness handshake.
 *
 *   node scripts/walkthrough.mjs
 *
 * Creates two temporary users and deletes them at the end.
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
const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = env.SUPABASE_SECRET_KEY
const ref = new (globalThis.URL)(URL_).hostname.split('.')[0]

let fail = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); fail++ }
const check = (c, good, notGood) => { if (c) ok(good); else bad(notGood) }

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const stamp = Date.now()
const PASSWORD = 'walkthrough-password-1'

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const created = []

async function createUser(label) {
  const email = `wt-${label}-${stamp}@bookends-test.local`
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `WT ${label}`, locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create ${label}: ${res.status} ${await res.text()}`)
  const u = await res.json()
  created.push(u.id)
  return { id: u.id, email }
}

async function signIn(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`signin: ${res.status} ${await res.text()}`)
  return res.json()
}

function claimsOf(token) {
  return JSON.parse(
    Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
  )
}

/** Query PostgREST exactly as the browser client would. */
async function asUser(token, path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: PUB, Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  // ── 1. Registration ────────────────────────────────────────────────────────
  console.log('\n1. Registration')
  const emp = await createUser('employee')
  ok(`registered ${emp.email}`)

  let empSession = await signIn(emp.email)
  let app = claimsOf(empSession.access_token).app
  check(app.approved === false, 'new account is unapproved in its token', 'new account already approved')

  // ── 2. Pending users are walled off ────────────────────────────────────────
  console.log('\n2. Pending user access')

  const outletsBefore = await asUser(empSession.access_token, 'outlets?select=id,name')
  check(
    Array.isArray(outletsBefore.body) && outletsBefore.body.length === 0,
    'pending user sees zero outlets (is_approved gate holds)',
    `pending user saw ${JSON.stringify(outletsBefore.body)?.slice(0, 120)}`,
  )

  const ownProfile = await asUser(empSession.access_token, `profiles?select=id,approval_status&id=eq.${emp.id}`)
  check(
    Array.isArray(ownProfile.body) && ownProfile.body.length === 1,
    'pending user CAN read own profile (deliberate exception)',
    'pending user cannot read own profile — /pending screen would break',
  )

  const others = await asUser(empSession.access_token, 'profiles?select=id')
  check(
    Array.isArray(others.body) && others.body.length === 1,
    'pending user sees only their own profile row',
    `pending user saw ${others.body?.length} profile rows`,
  )

  // ── 3. Chef approves ───────────────────────────────────────────────────────
  console.log('\n3. Chef approval')
  const chef = await createUser('chef')
  await db.query(
    `update public.profiles set approval_status='approved', outlet_id=$2 where id=$1`,
    [chef.id, '00000000-0000-0000-0000-00000000a001'],
  )
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='chef' on conflict do nothing`,
    [chef.id],
  )
  await db.query(`delete from public.user_roles where user_id=$1 and role_id=(select id from public.roles where key='employee')`, [chef.id])

  const chefSession = await signIn(chef.email)
  const chefApp = claimsOf(chefSession.access_token).app
  check(chefApp.roles.includes('chef'), 'chef role present in chef token', `chef roles = ${JSON.stringify(chefApp.roles)}`)
  check(chefApp.perms.includes('users.approve'), 'chef holds users.approve', 'chef missing users.approve')

  // The chef should see the pending employee via profiles_read_team.
  const queue = await asUser(chefSession.access_token, 'profiles?select=id,full_name&approval_status=eq.pending')
  check(
    Array.isArray(queue.body) && queue.body.some((p) => p.id === emp.id),
    'chef sees the pending registration in their queue',
    `chef queue did not contain the applicant: ${JSON.stringify(queue.body)?.slice(0, 150)}`,
  )

  // Approve, as the action does.
  await db.query(
    `update public.profiles
        set approval_status='approved', approved_by=$2, approved_at=now(),
            outlet_id=$3, department_id=(select id from public.departments where slug='kitchen' limit 1)
      where id=$1 and approval_status='pending'`,
    [emp.id, chef.id, '00000000-0000-0000-0000-00000000a001'],
  )
  ok('approved with outlet + department assigned')

  // ── 4. The staleness handshake ─────────────────────────────────────────────
  console.log('\n4. JWT staleness')

  const stale = claimsOf(empSession.access_token).app
  check(
    stale.approved === false,
    'OLD token still says approved:false (this is why /pending polls)',
    'old token already reflects approval — unexpected',
  )

  const { rows: meStatus } = await db.query(
    `select approval_status from public.me_status()`,
  ).catch(() => ({ rows: [] }))
  // me_status() is auth.uid()-scoped, so it returns nothing from a service
  // connection; verified through the app instead. Left here as documentation.

  const refreshed = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: empSession.refresh_token }),
  })
  const refreshedSession = await refreshed.json()
  const fresh = claimsOf(refreshedSession.access_token).app

  check(fresh.approved === true, 'REFRESHED token says approved:true', `refresh did not flip approval: ${JSON.stringify(fresh)}`)
  check(fresh.outlet_id === '00000000-0000-0000-0000-00000000a001', 'outlet present in refreshed claims', `outlet_id = ${fresh.outlet_id}`)
  check(Boolean(fresh.department_id), 'department present in refreshed claims', 'department_id missing')

  // ── 5. Approved access ─────────────────────────────────────────────────────
  console.log('\n5. Approved user access')

  const outletsAfter = await asUser(refreshedSession.access_token, 'outlets?select=id,name')
  check(
    Array.isArray(outletsAfter.body) && outletsAfter.body.length === 3,
    `approved user sees all 3 outlets`,
    `approved user saw ${outletsAfter.body?.length} outlets`,
  )

  const depts = await asUser(refreshedSession.access_token, 'departments?select=id,name')
  check(Array.isArray(depts.body) && depts.body.length === 5, 'approved user sees 5 departments', `saw ${depts.body?.length}`)

  // Still must not read colleagues.
  const colleague = await asUser(refreshedSession.access_token, `profiles?select=id&id=eq.${chef.id}`)
  check(
    Array.isArray(colleague.body) && colleague.body.length === 0,
    'employee still cannot read a colleague’s profile',
    'employee can read another profile — policy too permissive',
  )

  // Audit log must be invisible.
  const audit = await asUser(refreshedSession.access_token, 'audit_logs?select=id')
  check(
    !Array.isArray(audit.body) || audit.body.length === 0,
    'employee cannot read the audit log',
    'employee can read audit_logs',
  )

  // ── 6. Audit trail recorded the approval ───────────────────────────────────
  console.log('\n6. Audit trail')
  const { rows: auditRows } = await db.query(
    `select changes from public.audit_logs
      where table_name='profiles' and record_id=$1 and action='update'
      order by occurred_at desc limit 1`,
    [emp.id],
  )
  check(auditRows.length === 1, 'approval was audit-logged', 'no audit row for the approval')
  if (auditRows.length) {
    check(
      'approval_status' in auditRows[0].changes,
      'audit records the approval_status change',
      `audit changes = ${JSON.stringify(auditRows[0].changes).slice(0, 150)}`,
    )
    check(
      !('email' in auditRows[0].changes),
      'audit stores a diff, not the whole row',
      'audit stored unchanged columns — storage budget at risk',
    )
  }
} catch (e) {
  bad(`walkthrough threw: ${e.message}`)
} finally {
  for (const id of created) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders })
  }
  console.log(`\n  🧹 removed ${created.length} test users`)
  await db.end()
}

console.log(fail === 0 ? '\nWalkthrough passed.\n' : `\n${fail} check(s) failed.\n`)
process.exit(fail === 0 ? 0 : 1)
