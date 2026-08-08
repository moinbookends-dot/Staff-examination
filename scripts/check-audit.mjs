/**
 * ═════════════════════════════════════════════════════════════════════════════
 * STABILIZATION AUDIT — adversarial import, export and isolation cases.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE INVARIANT UNDER TEST: A FAILED IMPORT LEAVES THE DATABASE EXACTLY AS  ║
 * ║ IT WAS. Every failure case below is bracketed by a row count of BOTH      ║
 * ║ bank_questions and bank_question_texts, because a partial write could     ║
 * ║ land in either — a parent with no texts is just as broken as a text with  ║
 * ║ no parent, and counting only questions would miss it.                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything it writes is tagged `audit-<timestamp>` and deleted in `finally`.
 * Cross-COMPANY isolation is not exercised here: proving it needs a second
 * tenant, which is what tests/integration/tenancy.test.ts is for. That suite
 * cannot run on this machine (no DATABASE_URL, no local stack), and creating a
 * second company in the production database to test it would be a worse trade.
 *
 *   node scripts/check-audit.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'audit-check-password-1'
const TAG = `audit-${Date.now()}`

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

let fail = 0
const check = (ok, pass, failMsg) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${ok ? pass : (failMsg ?? pass)}`)
  if (!ok) fail += 1
}
const section = (t) => console.log(`\n  ── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`)

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
  const email = `audit-${roleKey}+${Date.now()}@example.com`
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: `Audit ${roleKey}`, locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create ${roleKey}: ${res.status}`)
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
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!session.access_token) throw new Error(`sign-in ${roleKey}`)

  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  const cookie = parts.length === 1
    ? `${name}=${parts[0]}`
    : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')

  return { id, token: session.access_token, cookie }
}

async function rpc(token, brandId, rows) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/bank_import_commit`, {
    method: 'POST',
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_brand_id: brandId, p_rows: rows }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Row counts of BOTH tables — a partial write could land in either. */
async function counts() {
  const q = await db.query(`select count(*)::int n from public.bank_questions`)
  const t = await db.query(`select count(*)::int n from public.bank_question_texts`)
  return { q: q.rows[0].n, t: t.rows[0].n }
}

const same = (a, b) => a.q === b.q && a.t === b.t
const fmt = (c) => `${c.q}q/${c.t}t`

const mcq = (n, topicSlug, over = {}) => ({
  externalId: `${TAG}-${n}`,
  difficulty: 'easy', qtype: 'mcq', status: 'active',
  topicSlug, correctOption: 'C', referenceTitle: null, referencePage: null,
  texts: [{
    locale: 'en', question: `Audit question ${n} ${TAG}`,
    optionA: 'Alpha', optionB: 'Bravo', optionC: 'Charlie', optionD: 'Delta',
    answerText: null, explanation: null,
  }],
  ...over,
})

try {
  await db.connect()

  const brands = (
    await db.query(`select id, name from public.brands where deleted_at is null order by name`)
  ).rows
  const topic = (
    await db.query(`select slug from public.question_topics where deleted_at is null order by sort_order limit 1`)
  ).rows[0].slug

  const editor = await makeUser('editor')
  const chef = await makeUser('chef')
  const superAdmin = await makeUser('super_admin')

  // ═══ 5. JSON IMPORT ═══════════════════════════════════════════════════════
  section('5. IMPORT')

  // A. Valid small import
  let before = await counts()
  const A = await rpc(editor.token, brands[0].id, [mcq(1, topic), mcq(2, topic)])
  check(A.status === 200 && A.body?.inserted === 2, 'A. valid small import (2 inserted)',
    `A. got ${A.status} ${JSON.stringify(A.body)}`)

  // B. Valid larger import — one full batch
  const bulk = Array.from({ length: 200 }, (_, i) => mcq(100 + i, topic))
  const t0 = Date.now()
  const B = await rpc(editor.token, brands[0].id, bulk)
  const ms = Date.now() - t0
  check(B.status === 200 && B.body?.inserted === 200, `B. full 200-row batch imports (${ms}ms)`,
    `B. got ${B.status} ${JSON.stringify(B.body)}`)

  // N. Empty import
  const N = await rpc(editor.token, brands[0].id, [])
  check(N.status === 200 && N.body?.total === 0, 'N. empty array is a no-op, not an error',
    `N. got ${N.status} ${JSON.stringify(N.body)}`)

  // C. Invalid payload shape (not an array)
  before = await counts()
  const C = await rpc(editor.token, brands[0].id, { nope: true })
  check(C.status >= 400, `C. non-array payload rejected (${C.status})`)
  check(same(await counts(), before), 'C. wrote nothing')

  // D. Missing required field (no texts)
  before = await counts()
  const D = await rpc(editor.token, brands[0].id, [{ ...mcq(300, topic), texts: [] }])
  check(D.status >= 400, `D. row with no texts rejected (${D.status})`,
    `D. A QUESTION WITH NO TEXT WAS ACCEPTED (${D.status})`)
  check(same(await counts(), before), 'D. wrote nothing')

  // E. Invalid language
  before = await counts()
  const E = await rpc(editor.token, brands[0].id, [
    mcq(301, topic, { texts: [{ ...mcq(301, topic).texts[0], locale: 'fr' }] }),
  ])
  check(E.status >= 400, `E. invalid locale rejected (${E.status})`)
  check(same(await counts(), before), 'E. wrote nothing')

  // F. Invalid difficulty
  before = await counts()
  const F = await rpc(editor.token, brands[0].id, [mcq(302, topic, { difficulty: 'impossible' })])
  check(F.status >= 400, `F. invalid difficulty rejected (${F.status})`)
  check(same(await counts(), before), 'F. wrote nothing')

  // G. Invalid topic
  before = await counts()
  const G = await rpc(editor.token, brands[0].id, [mcq(303, 'no-such-topic')])
  check(G.status >= 400, `G. unknown topic rejected (${G.status})`)
  check(same(await counts(), before), 'G. wrote nothing')

  /*
   * H. Duplicate externalId within one file.
   *
   * Asserted at the DRY RUN, which is where the fix lives and where the real
   * screen catches it. bank_import_commit() walks rows in order and would let
   * the second silently update the first — so the guarantee is that such a
   * file never reaches it. Checked directly in
   * tests/unit/bank-import-commit.test.ts; here we confirm the raw RPC's
   * behaviour is what the dry run is protecting against.
   */
  before = await counts()
  const H = await rpc(editor.token, brands[0].id, [mcq(400, topic), mcq(400, topic)])
  check(H.status === 200 && H.body?.inserted === 1 && H.body?.updated === 1,
    'H. raw RPC collapses a repeated externalId (1 inserted + 1 updated) — the dry run is what prevents this reaching it',
    `H. unexpected raw-RPC behaviour: ${H.status} ${JSON.stringify(H.body)}`)

  // I. Re-import the same file
  const I = await rpc(editor.token, brands[0].id, [mcq(1, topic), mcq(2, topic)])
  check(I.status === 200 && I.body?.updated === 2 && I.body?.inserted === 0,
    'I. re-import updates, does not duplicate', `I. got ${JSON.stringify(I.body)}`)

  // K. Partial batch failure — good row FIRST, bad row second
  before = await counts()
  const K = await rpc(editor.token, brands[0].id, [mcq(500, topic), mcq(501, 'no-such-topic')])
  check(K.status >= 400, `K. batch with a late bad row is rejected (${K.status})`)
  const afterK = await counts()
  check(same(afterK, before),
    `K. THE GOOD ROW BEFORE THE BAD ONE WAS NOT WRITTEN (${fmt(before)} → ${fmt(afterK)})`,
    `K. PARTIAL WRITE: ${fmt(before)} → ${fmt(afterK)} — THE IMPORT IS NOT ATOMIC`)

  // L. Unauthorized import (chef)
  before = await counts()
  const L = await rpc(chef.token, brands[0].id, [mcq(600, topic)])
  check(L.status >= 400, `L. chef refused (${L.status})`)
  check(same(await counts(), before), 'L. chef wrote nothing')

  /*
   * L2. The Super Admin lockout, pinned as the APPLICATION boundary it is.
   *
   * has_perm() short-circuits on is_super_admin(), so RLS admits them and the
   * raw RPC succeeds. Every ROUTE refuses them — asserted below and in
   * check-authz.mjs. This is a separation-of-duties boundary, not containment:
   * a Super Admin administers roles and can grant themselves `editor`.
   * See the box on canOpenQuestionBank in src/lib/auth/bank-access.ts.
   *
   * If the lockout is ever enforced in SQL, this assertion flips and the
   * comment above is the place to start reading.
   */
  const L2 = await rpc(superAdmin.token, brands[0].id, [mcq(601, topic)])
  check(L2.status === 200,
    'L2. raw RPC admits a super admin — RLS cannot express the lockout (documented, by decision)',
    `L2. super admin RPC returned ${L2.status}; the DB may now enforce the lockout — update the docs`)
  await db.query(`delete from public.bank_questions where external_id like 'audit-%-601'`)

  // M. Signed-out import. Counts re-read here: L2 legitimately wrote a row.
  before = await counts()
  const M = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/bank_import_commit`, {
    method: 'POST',
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_brand_id: brands[0].id, p_rows: [mcq(700, topic)] }),
  })
  check(M.status >= 400, `M. signed-out refused (${M.status})`)
  check(same(await counts(), before), 'M. signed-out wrote nothing')

  // O. Extremely long text — the DB cap is 2000 on `question`
  before = await counts()
  const O = await rpc(editor.token, brands[0].id, [
    mcq(800, topic, { texts: [{ ...mcq(800, topic).texts[0], question: 'x'.repeat(5000) }] }),
  ])
  check(O.status >= 400, `O. over-long question rejected by the CHECK (${O.status})`,
    `O. A 5000-CHAR QUESTION WAS STORED (${O.status})`)
  check(same(await counts(), before), 'O. wrote nothing')

  // P. Special characters, RTL, emoji, quotes, and a SQL-injection-shaped string
  const nasty = `Ünïcødé "quoted" 'single' \\backslash\\ ;DROP TABLE bank_questions;-- 😀 עברית ${TAG}`
  const P = await rpc(editor.token, brands[0].id, [
    mcq(900, topic, { texts: [{ ...mcq(900, topic).texts[0], question: nasty }] }),
  ])
  check(P.status === 200, `P. special characters accepted (${P.status})`, JSON.stringify(P.body))
  const stored = await db.query(
    `select t.question from public.bank_questions q join public.bank_question_texts t on t.question_id=q.id
      where q.external_id = $1`, [`${TAG}-900`])
  check(stored.rows[0]?.question === nasty, 'P. stored byte-for-byte, no injection, no mangling',
    `P. stored as: ${stored.rows[0]?.question}`)
  check(
    (await db.query(`select to_regclass('public.bank_questions') is not null as ok`)).rows[0].ok,
    'P. bank_questions still exists (injection string was data, not SQL)',
  )

  // J. Cross-brand externalId — the SAME id in a different brand must be allowed
  const J = await rpc(editor.token, brands[1].id, [mcq(1, topic)])
  check(J.status === 200 && J.body?.inserted === 1,
    'J. the same externalId in another brand is a NEW question, not a clash',
    `J. got ${J.status} ${JSON.stringify(J.body)} — brand-scoped uniqueness is wrong`)

  // ═══ 6 + 9. EXPORT ════════════════════════════════════════════════════════
  section('6+9. EXPORT')

  const exportAs = async (cookie, query) =>
    fetch(`${APP}/api/bank/export${query}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })

  const okRes = await exportAs(editor.cookie, `?brand=${brands[0].id}`)
  const okBody = await okRes.text()
  check(okRes.status === 200, `editor export allowed (${okRes.status})`)

  let envelope = null
  try { envelope = JSON.parse(okBody) } catch { /* below */ }
  check(envelope?.formatVersion === 1, 'export is the canonical envelope (formatVersion 1)')
  check(Array.isArray(envelope?.questions), 'export has a questions array')
  check(typeof envelope?.brand === 'string', 'export names its brand')

  // Cross-brand isolation: brand[1] holds exactly one of our questions.
  const b1 = await exportAs(editor.cookie, `?brand=${brands[1].id}`)
  const b1Body = JSON.parse(await b1.text())
  const b1Mine = b1Body.questions.filter((q) => String(q.externalId ?? '').startsWith(TAG))
  const b0Mine = envelope.questions.filter((q) => String(q.externalId ?? '').startsWith(TAG))
  check(b1Mine.length === 1, `brand B export contains only brand B's question (${b1Mine.length})`)
  check(b0Mine.length > 1, `brand A export contains brand A's questions (${b0Mine.length})`)
  check(
    !b1Body.questions.some((q) => q.en?.question?.includes('Audit question 100')),
    'NO CROSS-BRAND LEAKAGE — brand B export excludes brand A questions',
    'CROSS-BRAND LEAK: brand B export contains brand A questions',
  )

  const denials = [
    ['chef', chef.cookie, `?brand=${brands[0].id}`, 403],
    ['super admin', superAdmin.cookie, `?brand=${brands[0].id}`, 403],
    ['signed out', null, `?brand=${brands[0].id}`, 403],
    ['nonexistent brand', editor.cookie, '?brand=00000000-0000-0000-0000-0000000000ff', 403],
    ['missing brand', editor.cookie, '', 400],
    ['malformed uuid', editor.cookie, '?brand=not-a-uuid', null],
    ['sql-ish brand', editor.cookie, `?brand=${encodeURIComponent("' or 1=1--")}`, null],
    ['empty brand', editor.cookie, '?brand=', 400],
  ]

  for (const [label, cookie, query, expected] of denials) {
    const res = await exportAs(cookie, query)
    const body = await res.text()
    check(res.status !== 200, `export denied — ${label} (${res.status})`,
      `EXPORT ALLOWED FOR ${label} (${res.status})`)
    if (expected !== null) {
      check(res.status === expected, `  ${label} → ${expected}`, `  ${label} → ${res.status}, expected ${expected}`)
    }
    check(!/"questions"\s*:/.test(body), `  ${label} response carries no question data`,
      `  ${label} RESPONSE LEAKED QUESTION DATA`)
  }

  // ═══ EXPORT → IMPORT → EXPORT ════════════════════════════════════════════
  section('EXPORT → IMPORT → EXPORT')

  let server
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: false, logLevel: 'error',
      server: { middlewareMode: true }, appType: 'custom',
      resolve: { alias: { '@': resolve('src') } },
    })
    const { analyseImport } = await server.ssrLoadModule('/src/lib/bank/import/analyse.ts')
    const { toCommitRow } = await server.ssrLoadModule('/src/lib/bank/import/commit.ts')

    const topics = (await db.query(`select slug from public.question_topics where deleted_at is null`))
      .rows.map((r) => r.slug)

    const first = analyseImport(okBody, { knownTopics: topics })
    check(first.fatal === undefined, 'export 1 re-imports without a fatal error', first.fatal)
    check(first.rejectedCount === 0, `export 1 rejects nothing (${first.totalRows} rows)`,
      `ROUND TRIP BROKEN: ${JSON.stringify(first.rejected.slice(0, 2))}`)

    // Re-commit it, then export again and compare semantically.
    const rows = [...first.toImport, ...first.toUpdate].map(toCommitRow)
    const recommit = await rpc(editor.token, brands[0].id, rows.slice(0, 200))
    check(recommit.status === 200, `re-importing the export succeeds (${recommit.status})`,
      JSON.stringify(recommit.body))
    check(recommit.body?.inserted === 0,
      're-import inserted nothing new — every row matched by externalId',
      `re-import INSERTED ${recommit.body?.inserted} rows, so the round trip duplicates`)

    const second = await exportAs(editor.cookie, `?brand=${brands[0].id}`)
    const secondBody = await second.text()
    const e2 = JSON.parse(secondBody)

    const key = (q) => JSON.stringify({
      x: q.externalId ?? null, d: q.difficulty, t: q.type, s: q.status,
      topic: q.topic ?? null, c: q.correctOption ?? null,
      en: q.en, hi: q.hi ?? null, gu: q.gu ?? null,
    })
    const set1 = new Set(envelope.questions.map(key)).size
    const a = envelope.questions.map(key).sort()
    const b = e2.questions.map(key).sort()

    check(a.length === b.length, `export 1 and export 3 hold the same count (${a.length} vs ${b.length})`)
    check(JSON.stringify(a) === JSON.stringify(b),
      'EXPORT → IMPORT → EXPORT is semantically identical',
      'the second export differs from the first')
    check(set1 === envelope.questions.length, 'no duplicate questions within one export')
  } catch (err) {
    fail += 1
    console.log(`  FAIL  round trip threw: ${err.message}`)
  } finally {
    if (server) await server.close()
  }

  // ═══ 13. DATA INTEGRITY ═══════════════════════════════════════════════════
  section('13. DATA INTEGRITY')

  const orphanTexts = await db.query(
    `select count(*)::int n from public.bank_question_texts t
      where not exists (select 1 from public.bank_questions q where q.id = t.question_id)`)
  check(orphanTexts.rows[0].n === 0, 'no orphan text rows', `${orphanTexts.rows[0].n} orphan texts`)

  const childless = await db.query(
    `select count(*)::int n from public.bank_questions q
      where q.status = 'active'
        and not exists (select 1 from public.bank_question_texts t where t.question_id = q.id)`)
  check(childless.rows[0].n === 0, 'no ACTIVE question without any text',
    `${childless.rows[0].n} active questions have no text at all`)

  const dupExternal = await db.query(
    `select count(*)::int n from (
       select company_id, brand_id, external_id from public.bank_questions
        where external_id is not null
        group by 1,2,3 having count(*) > 1) x`)
  check(dupExternal.rows[0].n === 0, 'externalId is unique per (company, brand)',
    `${dupExternal.rows[0].n} duplicated externalIds`)

  const dupText = await db.query(
    `select count(*)::int n from (
       select brand_id, difficulty, lower(btrim(question)) q from public.bank_question_texts
        where locale='en' group by 1,2,3 having count(*) > 1) x`)
  check(dupText.rows[0].n === 0, 'no duplicate English question within a brand and level',
    `${dupText.rows[0].n} duplicate question texts`)

  const mismatch = await db.query(
    `select count(*)::int n from public.bank_question_texts t
       join public.bank_questions q on q.id = t.question_id
      where t.brand_id <> q.brand_id or t.difficulty <> q.difficulty or t.qtype <> q.qtype`)
  check(mismatch.rows[0].n === 0, 'every text row agrees with its parent (composite FK holds)',
    `${mismatch.rows[0].n} text rows disagree with their parent`)

  const badTopic = await db.query(
    `select count(*)::int n from public.bank_questions q
      where q.topic_id is not null
        and not exists (select 1 from public.question_topics t where t.id = q.topic_id)`)
  check(badTopic.rows[0].n === 0, 'every topic_id resolves', `${badTopic.rows[0].n} dangling topics`)

  const shape = await db.query(
    `select count(*)::int n from public.bank_questions
      where (qtype='mcq') <> (correct_option is not null)`)
  check(shape.rows[0].n === 0, 'every MCQ has a correct option and no short answer does')
} catch (err) {
  fail += 1
  console.log(`\n  FAIL  threw: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`)
} finally {
  section('CLEANUP')
  // Parent first: deleting texts from an active question trips the
  // completeness guard. ON DELETE CASCADE takes the texts with the parent.
  const del = await db.query(`delete from public.bank_questions where external_id like 'audit-%'`)
  for (const id of made) {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    })
  }
  const left = await db.query(
    `select count(*)::int n from public.bank_questions where external_id like 'audit-%'`)
  const finalCounts = await counts()
  check(left.rows[0].n === 0, `cleaned up ${del.rowCount} questions, ${made.length} users`,
    `${left.rows[0].n} audit rows left behind`)
  console.log(`  final state: ${fmt(finalCounts)}`)
  await db.end()
}

console.log(fail === 0 ? '\n  Audit checks passed.\n' : `\n  ${fail} check(s) FAILED.\n`)
process.exit(fail === 0 ? 0 : 1)
