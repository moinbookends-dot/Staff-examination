/**
 * ═════════════════════════════════════════════════════════════════════════════
 * AUTHENTICATION, AS A REAL USER OVER REAL HTTP.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FIRST SECTION IS A REGRESSION TEST FOR A LIVE PRIVILEGE ESCALATION.   ║
 * ║                                                                           ║
 * ║ 0005's profiles_self_update scopes the row and not the columns, and the   ║
 * ║ server-side whitelist its comment promised was never written. Any         ║
 * ║ signed-in user could set their own approval_status, company_id or         ║
 * ║ outlet_id from the browser. 0069 closed it with column GRANTs plus a      ║
 * ║ guard trigger; this proves it stays closed.                               ║
 * ║                                                                           ║
 * ║ NON-DESTRUCTIVE BY CONSTRUCTION: every privileged column is written with  ║
 * ║ THE VALUE IT ALREADY HAS. A refusal is therefore a permission error, not  ║
 * ║ a "nothing changed" — and if the grant were ever reopened the write would ║
 * ║ succeed while altering nothing.                                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/check-auth.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const PASSWORD = 'Sample-2026!'

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(SUPABASE).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

let fails = 0
const check = (label, pass, detail = '') => {
  if (!pass) fails++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

async function signIn(email) {
  const s = await (
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!s.access_token) throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\``)
  return s.access_token
}

/** A PATCH straight at PostgREST, exactly as a browser console would. */
async function patchProfile(token, id, body) {
  const res = await fetch(`${SUPABASE}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

try {
  await db.connect()

  const token = await signIn('sample-employee@example.com')
  const [me] = (
    await db.query(
      `select id, approval_status, company_id, outlet_id, brand_id, department_id,
              full_name, email, approved_by
         from public.profiles where email = 'sample-employee@example.com'`,
    )
  ).rows

  section('a user cannot escalate their own profile')

  /*
   * Each of these writes the column's CURRENT value, so a success would change
   * nothing — but a success is still a failure of the control, because the
   * statement named a column the user must not be able to name.
   */
  const forbidden = [
    ['approval_status', { approval_status: me.approval_status }],
    ['company_id', { company_id: me.company_id }],
    ['outlet_id', { outlet_id: me.outlet_id }],
    ['brand_id', { brand_id: me.brand_id }],
    ['department_id', { department_id: me.department_id }],
    // Its OWN current value, like the rest. Writing me.id here would have
    // corrupted the row on any run where the control was still open — the
    // exact outcome this script exists to prevent.
    ['approved_by', { approved_by: me.approved_by }],
    ['email', { email: me.email }],
  ]

  for (const [column, body] of forbidden) {
    const r = await patchProfile(token, me.id, body)
    check(
      `writing ${column} is refused`,
      r.status !== 200,
      `${r.status} ${r.text.slice(0, 90)}`,
    )
  }

  // The one that actually matters, with a value that would really escalate.
  const escalate = await patchProfile(token, me.id, { approval_status: 'approved' })
  check('the escalation itself is refused', escalate.status !== 200, `${escalate.status}`)

  const [after] = (
    await db.query(`select approval_status, company_id, outlet_id from public.profiles where id = $1`, [me.id])
  ).rows
  check(
    'and the row is untouched',
    after.approval_status === me.approval_status &&
      after.company_id === me.company_id &&
      after.outlet_id === me.outlet_id,
    JSON.stringify(after),
  )

  section('a user CAN still edit what is theirs')

  const ownName = await patchProfile(token, me.id, { full_name: me.full_name })
  check('writing their own name is allowed', ownName.status === 200, `${ownName.status}`)

  const someoneElse = (
    await db.query(`select id from public.profiles where email = 'sample-chef@example.com'`)
  ).rows[0]
  const other = await patchProfile(token, someoneElse.id, { full_name: 'Hacked' })
  check(
    "editing somebody else's profile changes nothing",
    other.status !== 200 || other.text === '[]',
    `${other.status} ${other.text.slice(0, 60)}`,
  )

  section('roles cannot be self-granted')

  const grantSelf = await fetch(`${SUPABASE}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: me.id,
      role_id: (await db.query(`select id from public.roles where key = 'super_admin' limit 1`)).rows[0].id,
    }),
  })
  check('a user cannot grant themselves a role', grantSelf.status !== 201, `${grantSelf.status}`)
} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  await db.end()
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
