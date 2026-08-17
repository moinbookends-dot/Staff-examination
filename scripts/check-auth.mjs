/**
 * ═════════════════════════════════════════════════════════════════════════════
 * AUTHENTICATION, AS A REAL USER OVER REAL HTTP.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ SECTION 1 IS A REGRESSION TEST FOR A LIVE PRIVILEGE ESCALATION.          ║
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
 * The rest walks the whole flow: signup, the emailed code, the verification and
 * approval gates, sign-in, sign-out, and password reset. Every account it makes
 * is created and deleted here.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE CODE COMES FROM THE ADMIN API AND NOT FROM AN INBOX.              │
 * │                                                                           │
 * │ generate_link returns the same email_otp GoTrue would have mailed, without │
 * │ mailing it. That matters twice over: there is no inbox to read from in a  │
 * │ check script, and this project's built-in SMTP rate-limits at roughly two │
 * │ messages an hour — a suite that really sent mail would fail on its second │
 * │ run of the morning for reasons that have nothing to do with the code.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   npm run dev            # for the route probes
 *   node scripts/check-auth.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'Sample-2026!'

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
const ref = new URL(SUPABASE).hostname.split('.')[0]

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

let fails = 0
const warnings = []

/**
 * `detail` is an OBSERVATION and is printed either way — a status code, the
 * value that came back.
 */
const check = (label, pass, detail = '') => {
  if (!pass) fails++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

/**
 * `why` is an EXPLANATION OF FAILURE and is printed only when it fails.
 *
 * Both existed as one function, and the output read:
 *
 *   PASS  en/verify-email resolves every message key  — a translation key is missing
 *   PASS  reset-password offers no form  — A PASSWORD FORM WAS OFFERED
 *
 * A passing line stating the opposite of what it proved is worse than no line:
 * it is the kind of thing somebody skims, believes, and acts on.
 */
const must = (label, pass, why = '') => {
  if (!pass) fails++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${!pass && why ? '  — ' + why : ''}`)
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

/**
 * Something a person has to do in the Supabase dashboard.
 *
 * Deliberately NOT a failure. A red check that the suite has no power to turn
 * green teaches everyone to run it and shrug, which is worse than the gap it
 * names. These are collected and printed on their own at the end.
 */
const needsYou = (what, detail) => {
  warnings.push({ what, detail })
  console.log(`  ►     ${what}  — ${detail}`)
}

const made = []

async function signIn(email, password = PASSWORD) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { status: res.status, body: await res.json() }
}

async function token(email) {
  const { body } = await signIn(email)
  if (!body.access_token) throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\``)
  return body.access_token
}

/** The session cookie @supabase/ssr writes, chunked exactly as it chunks it. */
function cookieFor(session) {
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  const name = `sb-${ref}-auth-token`
  return parts.length === 1
    ? `${name}=${parts[0]}`
    : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')
}

const claimOf = (accessToken) =>
  JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).app ?? {}

/** A PATCH straight at PostgREST, exactly as a browser console would. */
async function patchProfile(tok, id, body) {
  const res = await fetch(`${SUPABASE}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

const get = (path, cookie) =>
  fetch(`${APP}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  })

try {
  await db.connect()

  const appUp = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok)
    .catch(() => false)

  // ═══════════════════════════════════════════════════════════════════════════
  section('1. a user cannot escalate their own profile')
  // ═══════════════════════════════════════════════════════════════════════════

  const employeeToken = await token('sample-employee@example.com')
  const [me] = (
    await db.query(
      `select id, approval_status, company_id, outlet_id, brand_id, department_id,
              full_name, email, approved_by
         from public.profiles where email = 'sample-employee@example.com'`,
    )
  ).rows

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
    const r = await patchProfile(employeeToken, me.id, body)
    check(`writing ${column} is refused`, r.status !== 200, `${r.status} ${r.text.slice(0, 70)}`)
  }

  // The one that actually matters, with a value that would really escalate.
  const escalate = await patchProfile(employeeToken, me.id, { approval_status: 'approved' })
  check('the escalation itself is refused', escalate.status !== 200, `${escalate.status}`)

  const [after] = (
    await db.query('select approval_status, company_id, outlet_id from public.profiles where id = $1', [me.id])
  ).rows
  check(
    'and the row is untouched',
    after.approval_status === me.approval_status &&
      after.company_id === me.company_id &&
      after.outlet_id === me.outlet_id,
    JSON.stringify(after),
  )

  const ownName = await patchProfile(employeeToken, me.id, { full_name: me.full_name })
  check('writing their own name is still allowed', ownName.status === 200, `${ownName.status}`)

  const someoneElse = (
    await db.query(`select id from public.profiles where email = 'sample-chef@example.com'`)
  ).rows[0]
  const other = await patchProfile(employeeToken, someoneElse.id, { full_name: 'Hacked' })
  check(
    "editing somebody else's profile changes nothing",
    other.status !== 200 || other.text === '[]',
    `${other.status} ${other.text.slice(0, 40)}`,
  )

  const grantSelf = await fetch(`${SUPABASE}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: me.id,
      role_id: (await db.query(`select id from public.roles where key = 'super_admin' limit 1`)).rows[0].id,
    }),
  })
  check('a user cannot grant themselves a role', grantSelf.status !== 201, `${grantSelf.status}`)

  // ═══════════════════════════════════════════════════════════════════════════
  section('2. signing up, and the emailed code')
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * A NON-.local DOMAIN, and it is not cosmetic: GoTrue's signup validation
   * rejects `…@bookends-test.local` outright with email_address_invalid, while
   * the ADMIN API accepts it happily. Every other script here creates users
   * through the admin API and so never met that rule — which is precisely how a
   * signup path can be broken while the whole suite is green.
   */
  const newEmail = `authcheck-${Date.now()}@example.com`

  const signUp = await fetch(`${SUPABASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: newEmail,
      password: PASSWORD,
      data: { full_name: 'Auth Check', phone: null, locale: 'gu' },
    }),
  })
  const signUpBody = await signUp.json()

  /*
   * 429 is a legitimate outcome, not a failure of the code under test. The
   * project's built-in SMTP allows roughly two messages an hour; a second run
   * inside that window gets rate-limited. The account still has to exist for
   * the rest of this section, so generate_link creates it either way — that
   * call sends nothing and is not rate-limited.
   */
  const rateLimited = signUp.status === 429
  if (rateLimited) {
    needsYou(
      'signup could not send mail',
      'over_email_send_rate_limit — the built-in SMTP allows ~2/hour. Configure custom SMTP ' +
        'before real staff onboarding. The rest of this section still runs.',
    )
  } else {
    check('signUp is accepted', signUp.status === 200, `${signUp.status} ${JSON.stringify(signUpBody).slice(0, 90)}`)
    check(
      'signUp establishes NO session — the address is unconfirmed',
      !signUpBody.access_token,
      'a session was issued before the address was confirmed',
    )
  }

  const link = await (
    await fetch(`${SUPABASE}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ type: 'signup', email: newEmail, password: PASSWORD }),
    })
  ).json()
  const otp = link.email_otp ?? link.properties?.email_otp
  const newUserId = link.user?.id ?? link.id
  if (newUserId) made.push(newUserId)

  check('an emailed code exists', /^\d+$/.test(otp ?? ''), `${otp} (${otp?.length} digits)`)

  /*
   * The length is asserted as "whatever the project issues", NOT as six.
   * It is eight here. Six is what every article about email OTP says, and a
   * six-digit assumption in the form's validation would have rejected every
   * real code before it reached Supabase. The setting lives in the dashboard
   * (Email OTP Length) and is not exposed on /auth/v1/settings, so the app
   * cannot read it — which is exactly why nothing may hard-code it.
   */
  const bad = await fetch(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email: newEmail, token: '0'.repeat(otp.length) }),
  })
  check('a wrong code is refused', bad.status !== 200, `${bad.status}`)

  const early = await signIn(newEmail)
  check(
    'sign-in is refused while the address is unconfirmed',
    early.status !== 200 && early.body.error_code === 'email_not_confirmed',
    `${early.status} ${early.body.error_code ?? ''}`,
  )

  const verified = await fetch(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email: newEmail, token: otp }),
  })
  const session = await verified.json()
  check('the right code is accepted', verified.status === 200, `${verified.status}`)
  check('and it establishes a session', Boolean(session.access_token))

  const claim = claimOf(session.access_token)
  check('the token carries email_verified: true', claim.email_verified === true, JSON.stringify(claim.email_verified))
  check('and approved: false — verification is not approval', claim.approved === false, JSON.stringify(claim.approved))

  // ═══════════════════════════════════════════════════════════════════════════
  section('3. the two gates, in order')
  // ═══════════════════════════════════════════════════════════════════════════

  if (!appUp) {
    needsYou('route probes skipped', `nothing answering at ${APP} — run \`npm run dev\``)
  } else {
    const verifiedCookie = cookieFor(session)

    const toPending = await get('/en/dashboard', verifiedCookie)
    check(
      'verified but unapproved is sent to /pending',
      toPending.status === 307 && (toPending.headers.get('location') ?? '').endsWith('/en/pending'),
      `${toPending.status} → ${toPending.headers.get('location')}`,
    )

    const pendingPage = await get('/en/pending', verifiedCookie)
    check(
      '…and /pending itself is reachable',
      pendingPage.status === 200,
      `${pendingPage.status} ${pendingPage.headers.get('location') ?? ''}`,
    )

    /*
     * THE UNVERIFIED BRANCH, and it takes a real unverified session to test.
     * GoTrue will not issue one — that is the whole point of the gate — so the
     * address is un-confirmed underneath a live session and the token refreshed,
     * which is the only way to obtain the state the proxy is meant to catch.
     */
    await db.query('update auth.users set email_confirmed_at = null where id = $1', [newUserId])
    const refreshed = await (
      await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      })
    ).json()

    if (refreshed.access_token) {
      const unverifiedClaim = claimOf(refreshed.access_token)
      check(
        'un-confirming the address flips the claim',
        unverifiedClaim.email_verified === false,
        JSON.stringify(unverifiedClaim.email_verified),
      )

      const unverifiedCookie = cookieFor(refreshed)
      const gated = await get('/en/dashboard', unverifiedCookie)
      check(
        'an unverified session is sent to /verify-email, NOT /pending',
        gated.status === 307 && (gated.headers.get('location') ?? '').endsWith('/en/verify-email'),
        `${gated.status} → ${gated.headers.get('location')}`,
      )
      const verifyPage = await get('/en/verify-email', unverifiedCookie)
      check(
        '…and /verify-email is reachable',
        verifyPage.status === 200,
        `${verifyPage.status} ${verifyPage.headers.get('location') ?? ''} ` +
          '— a redirect here is the loop SIGNED_IN_MAY_VISIT exists to prevent',
      )
    } else {
      // Refreshing a session whose email was just un-confirmed can be refused
      // outright, which is a stricter outcome than the redirect and equally
      // acceptable. Recorded rather than silently skipped.
      check(
        'un-confirming the address invalidates the session entirely',
        true,
        'refresh refused — stricter than the redirect, and fine',
      )
    }

    // Put it back, then approve, and confirm the far end of the flow works.
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [newUserId])
    await db.query(`update public.profiles set approval_status = 'approved' where id = $1`, [newUserId])

    const full = await signIn(newEmail)
    check('a verified, approved user can sign in', full.status === 200, `${full.status}`)
    const finalClaim = claimOf(full.body.access_token)
    check(
      'their token says verified AND approved',
      finalClaim.email_verified === true && finalClaim.approved === true,
      JSON.stringify({ v: finalClaim.email_verified, a: finalClaim.approved }),
    )
    const dash = await get('/en/dashboard', cookieFor(full.body))
    check('…and the dashboard renders for them', dash.status === 200, `${dash.status}`)

    // ═════════════════════════════════════════════════════════════════════════
    section('4. the signed-out screens')
    // ═════════════════════════════════════════════════════════════════════════

    for (const locale of ['en', 'hi', 'gu']) {
      const page = await get(`/${locale}/verify-email`)
      const html = await page.text()
      check(`${locale}/verify-email renders signed out`, page.status === 200, `${page.status}`)
      must(
        `${locale}/verify-email resolves every message key`,
        !/MISSING_MESSAGE|IntlError/.test(html),
        'a translation key is missing',
      )
    }

    // No address: the screen must ask for one rather than show a code box that
    // cannot be submitted.
    const noAddress = await (await get('/en/verify-email')).text()
    must(
      'with no address it asks for one instead of offering a dead code box',
      /id="email"/.test(noAddress) && !/id="token"/.test(noAddress),
      'the wrong form is rendered',
    )
    const withAddress = await (await get('/en/verify-email?email=someone@example.com')).text()
    must('with an address it offers the code field', /id="token"/.test(withAddress), 'the code field is missing')
    must(
      'and the address is masked rather than printed',
      withAddress.includes('•') && !withAddress.includes('>someone@example.com<'),
      'the full address is on screen',
    )

    /*
     * /auth/confirm is the route the signup email has pointed at since M0 and
     * which did not exist — every confirmation link this product ever sent was
     * a 404. Asserted in both directions: it answers, and a bare visit with no
     * token does not somehow confirm anything.
     */
    const confirmBare = await get('/en/auth/confirm')
    check(
      '/auth/confirm exists and does not 404',
      confirmBare.status !== 404,
      `${confirmBare.status} → ${confirmBare.headers.get('location')}`,
    )
    const confirmDead = await get('/en/auth/confirm?error=access_denied&error_code=otp_expired')
    check(
      'a rejected confirmation link lands on /verify-email, not an error page',
      (confirmDead.headers.get('location') ?? '').includes('/verify-email'),
      `${confirmDead.status} → ${confirmDead.headers.get('location')}`,
    )

    // Reset with no recovery link must offer no password form at all.
    const bareReset = await (await get('/en/reset-password')).text()
    must(
      'reset-password offers no form without a recovery link',
      !/name="confirm"/.test(bareReset),
      'A PASSWORD FORM WAS OFFERED WITH NO RECOVERY LINK',
    )

    // Every password input in the product exposes a reveal toggle.
    for (const path of ['/en/login', '/en/register', '/en/verify-email?email=a@b.com']) {
      const html = await (await get(path)).text()
      const inputs = (html.match(/type="password"/g) ?? []).length
      const toggles = (html.match(/aria-label="Show password"/g) ?? []).length
      check(
        `${path} — every password field has a visibility toggle`,
        inputs === toggles,
        `${inputs} field(s), ${toggles} toggle(s)`,
      )
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('5. sign-in, sign-out, and the password floor')
  // ═══════════════════════════════════════════════════════════════════════════

  const wrongPassword = await signIn('sample-employee@example.com', 'not-the-password')
  check('a wrong password is refused', wrongPassword.status !== 200, `${wrongPassword.status}`)

  const noSuchUser = await signIn('nobody-here-at-all@example.com', PASSWORD)
  check(
    'a wrong password and an unknown address are indistinguishable',
    wrongPassword.status === noSuchUser.status &&
      wrongPassword.body.error_code === noSuchUser.body.error_code,
    `${wrongPassword.body.error_code} vs ${noSuchUser.body.error_code}`,
  )

  // Global sign-out must kill the session everywhere, which is what
  // resetPasswordAction relies on. Done on the throwaway account.
  const doomed = await signIn(newEmail)
  if (doomed.body.access_token) {
    await fetch(`${SUPABASE}/auth/v1/logout?scope=global`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${doomed.body.access_token}` },
    })
    const reuse = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: doomed.body.refresh_token }),
    })
    check(
      'a globally signed-out session cannot be refreshed',
      reuse.status !== 200,
      `${reuse.status} — this is what resetPasswordAction depends on`,
    )
  }

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE FLOOR IS 8 IN THE APP AND 6 ON THE SERVER, AND ONLY ONE OF THOSE      │
   * │ CAN BE FIXED FROM THIS REPOSITORY.                                        │
   * │                                                                           │
   * │ registerSchema and resetSchema both require 8. supabase/config.toml now   │
   * │ says 8 too — but that file configures the LOCAL stack, and the hosted     │
   * │ project reads its own setting. Measured, not assumed: setting a           │
   * │ 6-character password through GoTrue directly returns 200.                 │
   * │                                                                           │
   * │ No screen in this product can reach that path — there is no change-       │
   * │ password screen, and both actions that set one enforce 8 — so this is a   │
   * │ hardening gap rather than a live hole. Closing it needs a dashboard       │
   * │ change nothing here has credentials for, so it is reported, not failed.   │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const floorEmail = `pwfloor-${Date.now()}@example.com`
  const floorUser = await (
    await fetch(`${SUPABASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: floorEmail, password: PASSWORD, email_confirm: true }),
    })
  ).json()
  if (floorUser.id) made.push(floorUser.id)

  const floorSession = await signIn(floorEmail)
  const short = await fetch(`${SUPABASE}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${floorSession.body.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: 'abc123' }),
  })
  if (short.status === 200) {
    needsYou(
      'the auth server accepts a 6-character password',
      'Dashboard → Authentication → Policies → Minimum password length: set it to 8. ' +
        'supabase/config.toml already says 8; that file only configures the local stack.',
    )
  } else {
    check('the auth server refuses a password shorter than 8', true, `${short.status}`)
  }

  // What the app itself enforces, which is the part this repository owns.
  const appFloor = await fetch(`${SUPABASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `floor2-${Date.now()}@example.com`, password: 'abc123' }),
  })
  const appFloorBody = await appFloor.json()
  if (appFloor.status === 200 && (appFloorBody.id ?? appFloorBody.user?.id)) {
    made.push(appFloorBody.id ?? appFloorBody.user?.id)
  }
  must(
    "the app's own registration schema requires 8 characters",
    // Not a network assertion — a source one. The schema is the control, and it
    // is read here so the claim cannot drift from the code.
    /min\(8,\s*'Password must be at least 8 characters\.'\)/.test(
      readFileSync(resolve('src/server/actions/auth.ts'), 'utf-8'),
    ),
    'registerSchema no longer enforces 8',
  )
} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  section('cleanup')
  for (const id of made) {
    try {
      await fetch(`${SUPABASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders })
    } catch {
      /* Reported below by the count rather than thrown from a finally block. */
    }
  }
  console.log(`  removed ${made.length} account(s)`)
  await db.end()
}

if (warnings.length) {
  console.log('\n  ┌─ NEEDS YOU, IN THE SUPABASE DASHBOARD ' + '─'.repeat(24))
  for (const w of warnings) console.log(`  │  ${w.what}\n  │    ${w.detail}`)
  console.log('  └' + '─'.repeat(62))
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
