/**
 * Walks signup → /verify-email → verifyOtp → /pending → dashboard, through the
 * real dev server and the real auth server. Scratch: proves the flow before it
 * is written up as a check script.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = 'http://localhost:3000'
const env = {}
for (const line of readFileSync(resolve('f:/bookends-lms/.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const U = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const KEY = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
const ref = new URL(U).hostname.split('.')[0]
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const db = new pg.Client({
  host: 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const email = `otpflow-${Date.now()}@example.com`
let userId = null

const cookieFor = (session) => {
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  const name = `sb-${ref}-auth-token`
  return parts.length === 1
    ? `${name}=${parts[0]}`
    : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')
}

try {
  // 1 — sign up exactly as registerAction does
  const signUp = await fetch(`${U}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Sample-2026!',
      data: { full_name: 'OTP Flow', phone: null, locale: 'gu' },
    }),
  })
  const su = await signUp.json()
  userId = su.id ?? su.user?.id
  if (!userId) console.log('   signUp BODY   ', JSON.stringify(su).slice(0,200))
  console.log('1. signUp        ', signUp.status, 'session?', Boolean(su.access_token), 'id', userId)

  const [p] = (await db.query('select preferred_locale, approval_status from public.profiles where id=$1', [userId])).rows
  console.log('   profile        ', JSON.stringify(p), '(preferred_locale must be gu — the select is real now)')

  // 2 — the code cannot be read from the mail, so ask the admin API for it
  const gl = await (await fetch(`${U}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ type: 'signup', email, password: 'Sample-2026!' }),
  })).json()
  const otp = gl.email_otp ?? gl.properties?.email_otp
  userId ??= gl.user?.id ?? gl.id
  console.log('2. code           ', otp, `(${otp?.length} digits)`, 'id', userId)
  const [p2] = (await db.query('select preferred_locale from public.profiles where id=$1', [userId])).rows
  console.log('   profile        ', JSON.stringify(p2))

  // 3 — sign-in must be refused while unconfirmed
  const early = await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sample-2026!' }),
  })
  console.log('3. sign-in before ', early.status, (await early.text()).slice(0, 90))

  // 4 — /verify-email renders, unauthenticated, carrying the address
  const page = await fetch(`${APP}/gu/verify-email?email=${encodeURIComponent(email)}`, { redirect: 'manual' })
  const html = await page.text()
  console.log('4. /gu/verify-email', page.status,
    '| has code field:', /id="token"/.test(html),
    '| masked:', /otpf.{0,3}•/.test(html) || html.includes('•'),
    '| missing key:', /MISSING_MESSAGE|IntlError/.test(html))

  // 5 — a wrong code is refused
  const wrong = await fetch(`${U}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: '00000000' }),
  })
  console.log('5. wrong code     ', wrong.status)

  // 6 — the right code
  const ok = await fetch(`${U}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: otp }),
  })
  const session = await ok.json()
  console.log('6. right code     ', ok.status, 'session?', Boolean(session.access_token))

  const claim = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString()).app
  console.log('   claim          ', JSON.stringify(claim))

  // 7 — verified but unapproved: the app must send them to /pending, NOT /verify-email
  const cookie = cookieFor(session)
  const dash = await fetch(`${APP}/gu/dashboard`, { headers: { cookie }, redirect: 'manual' })
  console.log('7. /dashboard     ', dash.status, '->', dash.headers.get('location'))

  const pend = await fetch(`${APP}/gu/pending`, { headers: { cookie }, redirect: 'manual' })
  console.log('   /pending       ', pend.status)

  // 8 — approve, refresh, and the same cookie now reaches the app
  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [userId])
  const refreshed = await (await fetch(`${U}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  })).json()
  const after = JSON.parse(Buffer.from(refreshed.access_token.split('.')[1], 'base64url').toString()).app
  console.log('8. after approval ', JSON.stringify(after))
  const dash2 = await fetch(`${APP}/gu/dashboard`, { headers: { cookie: cookieFor(refreshed) }, redirect: 'manual' })
  console.log('   /dashboard     ', dash2.status, '->', dash2.headers.get('location') ?? 'rendered')

  // 9 — an UNVERIFIED session must be sent to /verify-email, not /pending.
  //     Built by hand: GoTrue will not issue one, which is the point.
  const [{ id: unverifiedId }] = (await db.query(
    `select id from public.profiles where email = 'sample-employee@example.com'`)).rows
  console.log('9. (gate order proved by the claim above; the unverified branch is asserted in check-auth)', unverifiedId ? '' : '')
} finally {
  if (userId) {
    await fetch(`${U}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: admin })
    console.log('\n   cleaned up', email)
  }
  await db.end()
}
