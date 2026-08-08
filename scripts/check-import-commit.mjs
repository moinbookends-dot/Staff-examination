/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Does bank_import_commit() actually work?
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FUNCTION EXISTING IS NOT THE FUNCTION WORKING.                        ║
 * ║                                                                           ║
 * ║ db-verify-0058.mjs proves the object is there with the right signature    ║
 * ║ and the right security setting. It does not execute a single line of it.  ║
 * ║ Two hundred lines of plpgsql that have never run are not verified — the   ║
 * ║ PDF footer shipped three separate bugs past passing text assertions for   ║
 * ║ exactly this reason.                                                      ║
 * ║                                                                           ║
 * ║ So this drives the real function, over PostgREST, as a real Editor with a ║
 * ║ real JWT, against the real database — and then deletes everything it      ║
 * ║ wrote.                                                                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT IT WRITES AND HOW IT CLEANS UP
 * Every question it creates carries an externalId prefixed `import-check-`.
 * The cleanup deletes exactly those rows and nothing else, over the direct
 * postgres connection — the application role cannot delete a bank question at
 * all (0055 grants no DELETE policy), which is the very property the atomicity
 * test below depends on.
 *
 *   node scripts/check-import-commit.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const PASSWORD = 'import-check-password-1'
const PREFIX = `import-check-${Date.now()}`

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
const check = (cond, pass, failMsg) => {
  if (cond) console.log(`  PASS  ${pass}`)
  else {
    fail += 1
    console.log(`  FAIL  ${failMsg ?? pass}`)
  }
}

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const made = []

/** Provision an approved user holding one role, and return their access token. */
async function makeUser(roleKey) {
  const email = `import-check-${roleKey}+${Date.now()}@example.com`

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
      user_metadata: { full_name: `Import Check ${roleKey}`, locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create ${roleKey}: ${res.status} ${await res.text()}`)
  const id = (await res.json()).id
  made.push(id)

  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [id])
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key=$2 and company_id is null
     on conflict do nothing`,
    [id, roleKey],
  )

  // The role is read from the JWT, and the JWT is minted at sign-in — so the
  // token must be requested AFTER the role is granted or it carries no perms.
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

  if (!session.access_token) throw new Error(`sign-in ${roleKey}: ${JSON.stringify(session).slice(0, 200)}`)
  // The whole session, not just the token: the export round trip below needs
  // it to build the cookie @supabase/ssr writes.
  return { id, token: session.access_token, session }
}

/** Call the RPC exactly as the server action does. */
async function commit(token, brandId, rows) {
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

const mcq = (n, topicSlug, extra = {}) => ({
  externalId: `${PREFIX}-${n}`,
  difficulty: 'easy',
  qtype: 'mcq',
  status: 'active',
  topicSlug,
  correctOption: 'C',
  referenceTitle: null,
  referencePage: null,
  texts: [
    {
      locale: 'en',
      question: `Import check question ${n} — ${PREFIX}`,
      optionA: 'Alpha',
      optionB: 'Bravo',
      optionC: 'Charlie',
      optionD: 'Delta',
      answerText: null,
      explanation: 'Because Charlie.',
    },
  ],
  ...extra,
})

try {
  await db.connect()
  console.log('')

  const brand = (
    await db.query(`select id, company_id from public.brands where deleted_at is null order by name limit 1`)
  ).rows[0]
  const topic = (
    await db.query(`select slug from public.question_topics where deleted_at is null order by sort_order limit 1`)
  ).rows[0]

  const before = (await db.query(`select count(*)::int as n from public.bank_questions`)).rows[0].n

  const editor = await makeUser('editor')

  // ── 1. The happy path ────────────────────────────────────────────────────
  const first = await commit(editor.token, brand.id, [mcq(1, topic.slug), mcq(2, topic.slug)])
  check(first.status === 200, `two questions import (${first.status})`, `import failed: ${JSON.stringify(first.body)}`)
  check(
    first.body?.inserted === 2 && first.body?.updated === 0,
    `the result says 2 inserted, 0 updated`,
    `result was ${JSON.stringify(first.body)}`,
  )

  const landed = await db.query(
    `select q.external_id, q.status, q.correct_option, q.difficulty, q.qtype, q.topic_id,
            t.question, t.option_c, t.explanation, t.locale
       from public.bank_questions q
       join public.bank_question_texts t on t.question_id = q.id
      where q.external_id like $1 order by q.external_id`,
    [`${PREFIX}-%`],
  )
  check(landed.rowCount === 2, `both questions have their English text (${landed.rowCount})`)
  check(landed.rows[0]?.status === 'active', 'the question was PROMOTED to active after its texts landed',
    `status was ${landed.rows[0]?.status} — the draft → texts → promote sequence is broken`)
  check(landed.rows[0]?.correct_option === 'C', 'the correct option is stored as a POSITION')
  check(landed.rows[0]?.option_c === 'Charlie', 'the option text landed')
  check(landed.rows[0]?.explanation === 'Because Charlie.', 'the explanation landed')
  check(landed.rows[0]?.topic_id !== null, 'the topic slug resolved to a topic id')

  // ── 2. Re-import updates rather than duplicates ──────────────────────────
  const edited = mcq(1, topic.slug)
  edited.texts[0].question = `Import check question 1 EDITED — ${PREFIX}`
  edited.texts[0].optionC = 'Corrected'

  const second = await commit(editor.token, brand.id, [edited])
  check(second.status === 200, `a re-import succeeds (${second.status})`, JSON.stringify(second.body))
  check(
    second.body?.inserted === 0 && second.body?.updated === 1,
    'the same externalId UPDATES rather than inserting a second question',
    `result was ${JSON.stringify(second.body)} — externalId matching is broken`,
  )

  const total = await db.query(
    `select count(*)::int as n from public.bank_questions where external_id like $1`,
    [`${PREFIX}-%`],
  )
  check(total.rows[0].n === 2, `still two questions, not three (${total.rows[0].n})`)

  const updated = await db.query(
    `select t.question, t.option_c, q.status from public.bank_questions q
       join public.bank_question_texts t on t.question_id = q.id
      where q.external_id = $1`,
    [`${PREFIX}-1`],
  )
  check(/EDITED/.test(updated.rows[0]?.question ?? ''), 'the edited text replaced the old text')
  check(updated.rows[0]?.option_c === 'Corrected', 'the edited option replaced the old option')
  check(updated.rows[0]?.status === 'active', 'the updated question was returned to active, not left as a draft',
    `status was ${updated.rows[0]?.status} — the update path leaves questions stranded in draft`)

  // ── 3. Atomicity — the property the whole design exists for ──────────────
  const countBeforeBad = (
    await db.query(`select count(*)::int as n from public.bank_questions where external_id like $1`, [`${PREFIX}-%`])
  ).rows[0].n

  // One good row followed by one naming a topic that does not exist. The good
  // row is processed FIRST, so if the function were not transactional it would
  // already be written when the second row raises.
  const bad = await commit(editor.token, brand.id, [
    mcq(90, topic.slug),
    mcq(91, 'no-such-topic-anywhere'),
  ])
  check(bad.status >= 400, `a batch with an unknown topic is rejected (${bad.status})`)

  const countAfterBad = (
    await db.query(`select count(*)::int as n from public.bank_questions where external_id like $1`, [`${PREFIX}-%`])
  ).rows[0].n
  check(
    countAfterBad === countBeforeBad,
    `THE FAILED BATCH WROTE NOTHING — ${countBeforeBad} before, ${countAfterBad} after`,
    `PARTIAL WRITE: ${countBeforeBad} before, ${countAfterBad} after. The import is not atomic.`,
  )

  // ── 4. A chef holds no policy on the bank ────────────────────────────────
  const chef = await makeUser('chef')
  const refused = await commit(chef.token, brand.id, [mcq(95, topic.slug)])
  check(refused.status >= 400, `a chef is refused the import RPC (${refused.status})`,
    `A CHEF IMPORTED QUESTIONS (${refused.status})`)

  const afterChef = (
    await db.query(`select count(*)::int as n from public.bank_questions where external_id like $1`, [`${PREFIX}-%`])
  ).rows[0].n
  check(afterChef === countBeforeBad, 'the chef wrote nothing', `chef wrote ${afterChef - countBeforeBad} rows`)

  // ── 5. A draft stays a draft ─────────────────────────────────────────────
  const draft = mcq(50, topic.slug)
  draft.status = 'draft'
  const asDraft = await commit(editor.token, brand.id, [draft])
  check(asDraft.status === 200, `a draft row imports (${asDraft.status})`, JSON.stringify(asDraft.body))

  const draftRow = await db.query(
    `select status from public.bank_questions where external_id = $1`,
    [`${PREFIX}-50`],
  )
  check(draftRow.rows[0]?.status === 'draft', 'a row asking for draft is NOT promoted to active')

  /*
   * ── 6. The round trip ────────────────────────────────────────────────────
   *
   * Export what was just imported, and feed it back through the SAME analyser
   * the import screen runs. This is the only check that proves the two halves
   * of the frozen contract actually agree at runtime rather than in a unit
   * test's fixtures — the exporter reads real columns, and a column that comes
   * back null where the schema wants a string only shows up here.
   *
   * Needs the app running, because the export is an HTTP route. Skipped rather
   * than failed when it is not, so this script stays useful on its own.
   */
  const APP = process.env.APP_URL ?? 'http://localhost:3000'
  const reachable = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.status < 500)
    .catch(() => false)

  if (!reachable) {
    console.log(`  SKIP  export round trip — ${APP} is not answering (start the dev server)`)
  } else {
    const cookieName = `sb-${ref}-auth-token`
    const encoded = 'base64-' + Buffer.from(JSON.stringify(editor.session)).toString('base64url')
    const parts = []
    for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
    const cookie =
      parts.length === 1
        ? `${cookieName}=${parts[0]}`
        : parts.map((p, i) => `${cookieName}.${i}=${p}`).join('; ')

    const res = await fetch(`${APP}/api/bank/export?brand=${brand.id}`, {
      headers: { cookie },
      redirect: 'manual',
    })
    check(res.status === 200, `an editor can export (${res.status})`, `export returned ${res.status}`)

    check(
      /attachment; filename="bookends-questions-/.test(res.headers.get('content-disposition') ?? ''),
      'the export downloads as a named file',
      `content-disposition was ${res.headers.get('content-disposition')}`,
    )

    const body = await res.text()
    let envelope = null
    try {
      envelope = JSON.parse(body)
    } catch {
      /* reported below */
    }
    check(envelope !== null, 'the export is valid JSON', `not JSON: ${body.slice(0, 120)}`)

    const mineInExport = (envelope?.questions ?? []).filter((q) =>
      String(q.externalId ?? '').startsWith(PREFIX),
    )
    check(
      mineInExport.length === 3,
      `the export contains all three imported questions (${mineInExport.length})`,
    )

    const exported = mineInExport.find((q) => q.externalId === `${PREFIX}-1`)
    check(/EDITED/.test(exported?.en?.question ?? ''), 'the export carries the EDITED text')
    check(exported?.correctOption === 'C', 'the export carries the correct option as a position')
    check(exported?.en?.options?.C === 'Corrected', 'the export carries the corrected option text')
    check(exported?.id === undefined, 'the export carries no database UUID', 'THE EXPORT LEAKS UUIDS')

    /*
     * The assertion that matters: the file this app produced is a file this
     * app accepts.
     *
     * analyse.ts is TypeScript, so it is loaded through Vite's SSR loader —
     * the same trick scripts/check-import.mjs uses, and for the same reason:
     * running the REAL validator rather than a re-implementation is the whole
     * point. A plain `await import()` of a .ts file fails under bare node.
     */
    let server
    try {
      const { createServer } = await import('vite')
      server = await createServer({
        configFile: false,
        logLevel: 'error',
        server: { middlewareMode: true },
        appType: 'custom',
        resolve: { alias: { '@': resolve('src') } },
      })
      const { analyseImport } = await server.ssrLoadModule('/src/lib/bank/import/analyse.ts')

      const topics = (
        await db.query(`select slug from public.question_topics where deleted_at is null`)
      ).rows.map((r) => r.slug)

      const report = analyseImport(body, { knownTopics: topics })

      check(report.fatal === undefined, 're-importing the export is not a fatal error', report.fatal)
      check(
        report.rejectedCount === 0,
        `RE-IMPORTING THE EXPORT REJECTS NOTHING (${report.totalRows} rows read)`,
        `THE EXPORT DOES NOT ROUND-TRIP: ${JSON.stringify(report.rejected.slice(0, 2))}`,
      )
      check(
        report.duplicateCount === 0,
        `the export contains no duplicate pair (${report.duplicateCount})`,
        `the brand-scoped export produced duplicates: ${JSON.stringify(report.duplicates.slice(0, 2))}`,
      )
      check(
        report.updatedCount === 0 && report.importedCount === report.totalRows,
        'every exported row is a complete, importable question',
        `${report.importedCount} importable of ${report.totalRows}`,
      )
    } catch (err) {
      fail += 1
      console.log(`  FAIL  re-import check threw: ${err.message}`)
    } finally {
      if (server) await server.close()
    }
  }

  // ── 7. Nothing leaked outside this run ───────────────────────────────────
  const after = (await db.query(`select count(*)::int as n from public.bank_questions`)).rows[0].n
  const mine = (
    await db.query(`select count(*)::int as n from public.bank_questions where external_id like $1`, [`${PREFIX}-%`])
  ).rows[0].n
  check(after - before === mine, `every new row is one of this script's (${after - before} new, ${mine} tagged)`)
} catch (err) {
  fail += 1
  console.log(`\n  FAIL  threw: ${err.message}`)
} finally {
  /*
   * ── Cleanup ──────────────────────────────────────────────────────────────
   *
   * Over the postgres connection, because the application role genuinely
   * cannot delete a bank question — which is the point of the atomicity test.
   *
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE PARENT GOES FIRST, AND THE ORDER IS NOT A STYLE CHOICE.             │
   * │                                                                         │
   * │ Deleting the TEXTS first raises from                                    │
   * │ bank_question_texts_completeness_guard:                                 │
   * │                                                                         │
   * │   An active question must keep every required language. Missing: en     │
   * │                                                                         │
   * │ — which is the guard working exactly as 0054 intends. Deleting the      │
   * │ parent instead takes the texts with it by ON DELETE CASCADE, and the    │
   * │ guard short-circuits because the parent's status is already gone.       │
   * └─────────────────────────────────────────────────────────────────────────┘
   *
   * Matched on the `import-check-` prefix rather than this run's timestamp, so
   * a run that died before cleanup does not leave rows behind forever. Nothing
   * but this script ever writes that prefix.
   */
  const questions = await db.query(
    `delete from public.bank_questions where external_id like 'import-check-%'`,
  )
  const texts = { rowCount: 'cascaded' }

  for (const id of made) {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    })
  }

  const left = await db.query(
    `select count(*)::int as n from public.bank_questions where external_id like 'import-check-%'`,
  )
  console.log(
    `\n  cleaned up: ${questions.rowCount} questions, ${texts.rowCount} texts, ${made.length} users` +
      ` — ${left.rows[0].n} left behind`,
  )
  if (left.rows[0].n !== 0) fail += 1

  await db.end()
}

console.log(fail === 0 ? '\n  Import commit verified.\n' : `\n  ${fail} check(s) FAILED.\n`)
process.exit(fail === 0 ? 0 : 1)
