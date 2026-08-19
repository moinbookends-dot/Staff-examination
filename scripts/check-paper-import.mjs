/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DRIVE THE REAL PAPER IMPORT SCREEN, IN A REAL BROWSER, WITH THE REAL FILES.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS EXISTS ON TOP OF THE UNIT SUITE AND render-check.mjs.            ║
 * ║                                                                           ║
 * ║ The unit suite proves the parser and the validator against all 1,030      ║
 * ║ questions — but it calls them as functions. render-check.mjs fetches      ║
 * ║ pages and asserts on HTML — but it cannot pick a file, and this entire    ║
 * ║ feature is "pick a file". Between them they would both be green while     ║
 * ║ the screen was unusable: an unwired onChange, a Server Action that throws ║
 * ║ on a 1 MB argument, a Base UI Select that never fires.                    ║
 * ║                                                                           ║
 * ║ So this attaches the actual 1.0 MB paper and 586 KB answer key to the     ║
 * ║ actual file inputs with DOM.setFileInputFiles, reads the numbers off the  ║
 * ║ rendered report, and presses the button.                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Raw CDP over the WebSocket Node already ships, driving the Chrome that is
 * already installed — the same approach as scripts/check-touch.mjs, and for the
 * same reason: no new dependency for a script that runs a handful of times.
 *
 *   npm run dev                              # in one terminal
 *   node scripts/check-paper-import.mjs      # preview only — WRITES NOTHING
 *   node scripts/check-paper-import.mjs --apply   # …and presses Import
 *
 *   --locale hi|gu|en   which language the paper is in (default hi)
 *   --paper <path>      default assets/AIKO_Hard_Paper_Hindi_2.html
 *   --key <path>        default assets/AIKO_Hard_AnswerKey_Hindi_1.html
 *
 * ⚠ DO NOT RUN `next build` WHILE `next dev` IS RUNNING. They share .next and
 *   the build overwrites the dev server's route manifest — every dynamic route
 *   then 404s while the list pages keep working, which looks exactly like a
 *   routing bug in the app.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const APPLY = process.argv.includes('--apply')
const APP = arg('app', 'http://localhost:3000')
const LOCALE = arg('locale', 'hi')
const PAPER = resolve(root, arg('paper', 'assets/AIKO_Hard_Paper_Hindi_2.html'))
const KEY = resolve(root, arg('key', 'assets/AIKO_Hard_AnswerKey_Hindi_1.html'))
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PASSWORD = 'Sample-2026!'

const LOCALE_LABEL = { en: 'English', hi: 'हिन्दी', gu: 'ગુજરાતી' }[LOCALE]

let fails = 0
const check = (label, pass, detail = '') => {
  if (!pass) fails += 1
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

function readEnvLocal() {
  const out = {}
  for (const line of readFileSync(resolve(root, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP
// ─────────────────────────────────────────────────────────────────────────────

let nextId = 1
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else res(msg.result)
    }
  })

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)))
  })

  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Read the page.
 *
 * Deliberately returns DATA and leaves every verdict in Node, where a failure
 * can be printed with its context. A boolean computed in the page tells you
 * nothing about why.
 */
const READ = `(() => {
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null)

  // A StatCard is a .rounded-xl whose first span is the label and whose first
  // <p> is the figure.
  const stat = (label) => {
    for (const span of document.querySelectorAll('span.text-label-caps')) {
      if (text(span) !== label) continue
      const card = span.closest('div.rounded-xl')
      const p = card ? card.querySelector('p') : null
      if (p) return text(p)
    }
    return null
  }

  const body = document.body.innerText

  return JSON.stringify({
    heading: text(document.querySelector('h1')),
    hasPaperTab: /Paper import/.test(body),
    questionsRead: (body.match(/(\\d[\\d,]*) questions read/) || [])[1] || null,
    answersRead: (body.match(/(\\d[\\d,]*) answers read/) || [])[1] || null,
    subtitle: (body.match(/\\d[\\d,]* questions in the paper[^\\n]*/) || [])[0] || null,
    create: stat('New questions'),
    update: stat('Existing updated'),
    skip: stat('Left alone'),
    rejected: stat('Rejected'),
    valid: stat('Ready'),
    warnings: stat('With warnings'),
    errors: stat('With errors'),
    ready: (body.match(/Ready to import [\\d,]+ questions/) || [])[0] || null,
    blocked: (body.match(/[\\d,]+ questions must be fixed[^\\n]*/) || [])[0] || null,
    imported: (body.match(/Imported [\\d,]+ new and updated [\\d,]+ questions\\./) || [])[0] || null,
    importDisabled: (() => {
      for (const b of document.querySelectorAll('button')) {
        if (text(b) === 'Import questions') return b.disabled
      }
      return null
    })(),
    alerts: [...document.querySelectorAll('[role=alert]')].map(text),
    notResolved: /The bank has not been checked yet|Checking the bank/.test(body),
    firstError: (() => {
      for (const li of document.querySelectorAll('li.text-destructive')) return text(li)
      return null
    })(),
    devanagari: /[\\u0900-\\u097F]/.test(body),
    mojibake: /\\uFFFD|Ã[\\u0080-\\u00bf]/.test(body),
    previewIds: [...document.querySelectorAll('span.text-label-caps')]
      .map(text)
      .filter((t) => t && /^aiko-hard-\\d+$/.test(t))
      .slice(0, 3),
  })
})()`

async function readPage(page) {
  const result = await page.send('Runtime.evaluate', { expression: READ, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return JSON.parse(result.result.value)
}

/** Click the first button, tab or link whose visible text matches exactly. */
async function click(page, label) {
  const expression = `(() => {
    const t = (el) => el.textContent.replace(/\\s+/g, ' ').trim()
    for (const el of document.querySelectorAll('button, [role=tab], a')) {
      if (t(el) !== ${JSON.stringify(label)}) continue
      // A disabled button swallows .click() in silence. Reporting that as a
      // successful press is how a driver "passes" having done nothing — which
      // is exactly what the first run of this script did.
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled'
      el.click()
      return true
    }
    return false
  })()`
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true })
  return result.result.value === true
}

/** Poll until `predicate(state)` holds, or give up. */
async function until(page, label, predicate, timeoutMs = 180_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await readPage(page)
    if (predicate(last)) return last
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}\n    last seen: ${JSON.stringify(last)}`)
}

/** Attach a real file to a real <input type=file>, firing the real events. */
async function attach(page, selector, path) {
  const doc = await page.send('DOM.getDocument', { depth: 1 })
  const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!node.nodeId) throw new Error(`no element matching ${selector}`)
  await page.send('DOM.setFileInputFiles', { files: [path], nodeId: node.nodeId })
}

/** Choose a value in a Base UI Select by clicking its trigger, then the item. */
async function selectOption(page, triggerId, optionLabel) {
  await page.send('Runtime.evaluate', {
    expression: `document.getElementById(${JSON.stringify(triggerId)})?.click()`,
  })
  await sleep(250)
  const picked = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const t = (el) => el.textContent.replace(/\\s+/g, ' ').trim()
      for (const el of document.querySelectorAll('[role=option]')) {
        if (t(el) === ${JSON.stringify(optionLabel)}) { el.click(); return true }
      }
      return false
    })()`,
    returnByValue: true,
  })
  await sleep(250)
  return picked.result.value === true
}

// ─────────────────────────────────────────────────────────────────────────────

let chrome = null
const profile = mkdtempSync(resolve(tmpdir(), 'paper-import-'))

try {
  for (const [label, path] of [
    ['paper', PAPER],
    ['answer key', KEY],
  ]) {
    if (!existsSync(path)) throw new Error(`no ${label} at ${path}`)
  }

  const env = readEnvLocal()
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

  console.log(`\n  ${APPLY ? '*** APPLYING — THIS WRITES TO THE BANK ***' : 'PREVIEW ONLY — nothing is written'}\n`)
  console.log(`  app      ${APP}`)
  console.log(`  locale   ${LOCALE}`)
  console.log(`  paper    ${PAPER.split(/[\\/]/).pop()}  (${(statSync(PAPER).size / 1024 / 1024).toFixed(2)} MB)`)
  console.log(`  key      ${KEY.split(/[\\/]/).pop()}  (${(statSync(KEY).size / 1024).toFixed(0)} KB)\n`)

  const alive = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) throw new Error(`no dev server at ${APP}. Run \`npm run dev\` first.`)

  // ── A real session, exactly as @supabase/ssr writes it ───────────────────
  const sessionFor = async (email) => {
    const session = await (
      await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      })
    ).json()
    if (!session.access_token) throw new Error(`sign-in failed for ${email}`)
    return session
  }

  /*
   * base64URL, not standard base64, and chunked at 3180 characters into
   * `.0`, `.1`, … — this is what @supabase/ssr writes and what src/proxy.ts
   * decodes. Getting either detail wrong produces a session the server
   * silently does not see, which reads as "the app logged me out".
   */
  const cookiesFor = (session) => {
    const name = `sb-${ref}-auth-token`
    const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
    const parts = []
    for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
    return parts.length === 1
      ? [{ name, value: parts[0] }]
      : parts.map((value, i) => ({ name: `${name}.${i}`, value }))
  }

  // ── Chrome ────────────────────────────────────────────────────────────────
  const port = 9336
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let version = null
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('Chrome did not expose its debugging port')

  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  const page = connect(target.webSocketDebuggerUrl)
  await page.ready
  await page.send('Page.enable')
  await page.send('DOM.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')

  const host = new URL(APP).hostname
  const signInAs = async (email) => {
    await page.send('Network.clearBrowserCookies')
    for (const cookie of cookiesFor(await sessionFor(email))) {
      await page.send('Network.setCookie', { ...cookie, domain: host, path: '/' })
    }
  }

  const goto = async (path) => {
    await page.send('Page.navigate', { url: `${APP}${path}` })
    await sleep(1500)
    for (let i = 0; i < 40; i++) {
      const state = await page.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      })
      if (state.result.value === 'complete') break
      await sleep(250)
    }
    await sleep(500)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('  Authorisation\n')

  await signInAs('sample-employee@example.com')
  await goto('/en/questions/import')
  const asEmployee = await readPage(page)
  check(
    'an employee cannot open the import screen',
    !asEmployee.hasPaperTab,
    asEmployee.heading ?? '(no heading)',
  )

  await signInAs('sample-hr@example.com')
  await goto('/en/questions/import')
  const asHr = await readPage(page)
  check('HR cannot open the import screen', !asHr.hasPaperTab, asHr.heading ?? '(no heading)')

  await signInAs('sample-chef@example.com')
  await goto('/en/questions/import')
  const asAdmin = await readPage(page)
  check('an administrator can', asAdmin.hasPaperTab, asAdmin.heading ?? '(no heading)')
  if (!asAdmin.hasPaperTab) throw new Error('cannot continue without the import screen')

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  Reading the files\n')

  check('the Paper import tab opens', (await click(page, 'Paper import')) === true)
  await sleep(400)

  check(`the language is set to ${LOCALE_LABEL}`, await selectOption(page, 'paper-locale', LOCALE_LABEL))

  await attach(page, '#paper-file', PAPER)
  await attach(page, '#key-file', KEY)
  await sleep(1500)

  /*
   * The KEY first, and the order matters.
   *
   * Reading the paper also asks the bank about the thousand ids it names, and
   * every control on the panel is disabled while that is in flight — so a
   * driver that presses "Analyse paper" and then immediately presses "Analyse
   * answer key" presses a disabled button. The key parse is local and instant;
   * doing it first removes the race entirely.
   */
  check('Analyse answer key is pressed', (await click(page, 'Analyse answer key')) === true)
  const withKey = await until(page, 'the key to be read', (s) => s.answersRead !== null)
  console.log(`        ${withKey.answersRead} answers read from the key`)

  check('Analyse paper is pressed', (await click(page, 'Analyse paper')) === true)
  const analysed = await until(page, 'the paper to be read', (s) => s.questionsRead !== null)
  console.log(`        ${analysed.questionsRead} questions read from the paper`)

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  The report, as the screen renders it\n')

  /*
   * Not merely "the report rendered" — it renders immediately, saying the bank
   * has not been checked. And not merely "the lookup came back" either: React
   * keeps the transition pending for a moment after the state lands, and every
   * control stays disabled for that moment. Waiting for the button to be
   * usable is the only condition that means what it says.
   */
  const report = await until(
    page,
    'the bank lookup and the screen to settle',
    (s) => s.errors !== null && !s.notResolved && s.importDisabled === false,
  )

  console.log(`        ${report.subtitle ?? '(no summary line)'}`)
  console.log(`        new ${report.create} · updated ${report.update} · left alone ${report.skip} · rejected ${report.rejected}`)
  console.log(`        ready ${report.valid} · warnings ${report.warnings} · errors ${report.errors}`)

  const n = (v) => Number(String(v ?? '').replace(/[^\d]/g, ''))

  if (report.firstError) console.log(`        first error: ${report.firstError}`)
  check('every error count is zero', n(report.errors) === 0, `errors ${report.errors}`)
  check('nothing is rejected', n(report.rejected) === 0, `rejected ${report.rejected}`)
  check('nothing is silently skipped', n(report.skip) === 0, `skipped ${report.skip}`)
  check('the screen says it is ready to import', Boolean(report.ready), report.ready ?? report.blocked ?? '')
  check('the Import button is enabled', report.importDisabled === false)
  check('the Hindi renders as Devanagari', report.devanagari)
  check('there is no mojibake anywhere on the page', !report.mojibake)
  check(
    'the preview shows real question ids',
    report.previewIds.length > 0,
    report.previewIds.join(', '),
  )
  check('no error banner is showing', report.alerts.length === 0, report.alerts.join(' | '))

  // ═══════════════════════════════════════════════════════════════════════════
  if (!APPLY) {
    console.log('\n  Nothing written. Re-run with --apply to press Import.\n')
  } else {
    console.log('\n  Importing\n')

    check('Import questions is pressed', (await click(page, 'Import questions')) === true)

    const finished = await until(
      page,
      'the import to finish',
      (s) => s.imported !== null || s.alerts.length > 0,
      600_000,
    )

    if (finished.alerts.length > 0 && !finished.imported) {
      check('the import succeeded', false, finished.alerts.join(' | '))
    } else {
      console.log(`        ${finished.imported}`)
      check('the import reported a result', Boolean(finished.imported))
      check('no failure banner appeared', finished.alerts.length === 0, finished.alerts.join(' | '))
    }

    // The history panel is server-rendered, so it needs a fresh request.
    await goto('/en/questions/import')
    const history = await page.send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    })
    const recorded = /Recent imports[\s\S]*AIKO_Hard_Paper/.test(history.result.value)
    check('the run was recorded in the import history', recorded)
  }

  page.close()
} catch (error) {
  console.error(`\n  ${error.message}\n`)
  fails += 1
} finally {
  if (chrome) chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* the profile is in tmp; a lingering one is harmless */
  }
}

console.log(`\n  ${fails === 0 ? 'All checks passed.' : `${fails} check(s) failed.`}\n`)
process.exit(fails === 0 ? 0 : 1)
