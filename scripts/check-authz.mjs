/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE AUTHORIZATION MATRIX.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A HIDDEN LINK IS NOT SECURITY. THIS SCRIPT NEVER LOOKS AT THE NAV.        ║
 * ║                                                                           ║
 * ║ Every route is fetched by DIRECT URL as each role, with a real session     ║
 * ║ cookie, and judged on the status code and the body. Whether a link was     ║
 * ║ rendered is irrelevant — the question is what happens when somebody types  ║
 * ║ the address.                                                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Two of the probed paths have NO page behind them
 * (/questions/[id]/translations, /questions/quality). They are probed anyway:
 * the subtree layout runs BEFORE route resolution, so a caller who may not
 * open the bank must not be able to tell which editor routes exist.
 *
 * Writes nothing except its own temporary users, which are deleted in `finally`.
 *
 *   node scripts/check-authz.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'authz-check-password-1'

function readEnvLocal() {
  const raw = readFileSync(resolve('.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const made = []

async function makeUser(roleKey) {
  const email = `authz-${roleKey}+${Date.now()}@example.com`
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `Authz ${roleKey}`, locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create ${roleKey}: ${res.status} ${await res.text()}`)
  const id = (await res.json()).id
  made.push(id)

  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [id])
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key=$2 and company_id is null on conflict do nothing`,
    [id, roleKey],
  )

  const session = await (
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!session.access_token) throw new Error(`sign-in ${roleKey}`)

  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  return parts.length === 1
    ? `${name}=${parts[0]}`
    : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')
}

/**
 * ALLOW means the route actually served the thing.
 *
 * 404 counts as DENY-ish only for paths with no page; for a real page a 404
 * would be a bug. Both are reported verbatim so nothing is hidden behind a
 * label.
 */
function verdict(status) {
  if (status === 200) return 'ALLOW'
  if (status === 307 || status === 302) return 'REDIRECT'
  if (status === 403) return 'DENY(403)'
  if (status === 500) return 'DENY(500)'
  if (status === 404) return 'NOTFOUND'
  return `OTHER(${status})`
}

const ROUTES = [
  ['/en/dashboard', 'page'],
  ['/en/papers/generate', 'page'],
  ['/en/history', 'page'],
  ['/en/history/00000000-0000-0000-0000-0000000000ff', 'page'],
  ['/en/questions', 'page'],
  ['/en/questions/new', 'page'],
  ['/en/questions/00000000-0000-0000-0000-0000000000ff', 'page'],
  ['/en/questions/00000000-0000-0000-0000-0000000000ff/translations', 'no-page'],
  ['/en/questions/quality', 'no-page'],
  ['/en/questions/topics', 'page'],
  ['/en/questions/import', 'page'],
  ['/en/settings', 'page'],
  ['/api/bank/export?brand=00000000-0000-0000-0000-00000000b001', 'api'],
  ['/api/bank/export', 'api'],
]

/** Body markers that would mean question data escaped. */
const LEAK = /"questions"\s*:|"correctOption"|"externalId"|bank_question/

let leaks = 0

try {
  await db.connect()

  const cookies = {
    super_admin: await makeUser('super_admin'),
    editor: await makeUser('editor'),
    chef: await makeUser('chef'),
    'signed-out': null,
  }

  const results = {}

  for (const [path, kind] of ROUTES) {
    results[path] = { kind }
    for (const [role, cookie] of Object.entries(cookies)) {
      const res = await fetch(`${APP}${path}`, {
        headers: cookie ? { cookie } : {},
        redirect: 'manual',
      })
      const body = await res.text()

      results[path][role] = verdict(res.status)

      // The assertion that matters more than the status: no denied response
      // may contain question data.
      if (res.status !== 200 && LEAK.test(body)) {
        leaks += 1
        console.log(`  LEAK  ${role} ${path} → ${res.status} but body contains question data`)
      }
    }
  }

  // ── Print the matrix ─────────────────────────────────────────────────────
  const roles = ['super_admin', 'editor', 'chef', 'signed-out']
  const pad = (s, n) => String(s).padEnd(n)

  console.log('')
  console.log(
    `  ${pad('ROUTE', 58)}${roles.map((r) => pad(r, 13)).join('')}`,
  )
  console.log(`  ${'─'.repeat(58 + 13 * roles.length)}`)
  for (const [path] of ROUTES) {
    console.log(
      `  ${pad(path, 58)}${roles.map((r) => pad(results[path][r], 13)).join('')}`,
    )
  }

  console.log('')
  console.log(leaks === 0 ? '  No denied response leaked question data.' : `  ${leaks} LEAK(S).`)
} catch (err) {
  console.log(`\n  threw: ${err.message}`)
  leaks += 1
} finally {
  for (const id of made) {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    })
  }
  console.log(`  cleaned up ${made.length} users\n`)
  await db.end()
}

process.exit(leaks === 0 ? 0 : 1)
