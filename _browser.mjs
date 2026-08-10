/**
 * What a REAL BROWSER shows on a denied page.
 *
 * error.tsx is a client error boundary, so a plain fetch (which runs no JS)
 * cannot answer this — it would report "blank" whether the boundary works or
 * not. This drives headless Chrome over CDP and reads document.body.innerText
 * AFTER hydration, which is the only measurement that means anything.
 */
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:3006'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const env = {}
for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const S = env.NEXT_PUBLIC_SUPABASE_URL
const A = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(S).hostname.split('.')[0]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function sessionCookies(email) {
  const s = await (await fetch(`${S}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sample-2026!' }),
  })).json()
  if (!s.access_token) throw new Error('sign-in ' + email)
  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(s)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  return parts.length === 1
    ? [{ name, value: parts[0] }]
    : parts.map((p, i) => ({ name: `${name}.${i}`, value: p }))
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const ready = new Promise((res) => ws.addEventListener('open', res))
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
    }
  })
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((res) => {
        const n = ++id
        pending.set(n, res)
        ws.send(JSON.stringify({ id: n, method, params }))
      }),
    close: () => ws.close(),
  }
}

const profile = mkdtempSync(join(tmpdir(), 'bookends-cdp-'))
const port = 9344
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' })

try {
  let version = null
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() }
    catch { await sleep(250) }
  }
  if (!version) throw new Error('Chrome did not expose its debugging port')

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const page = connect(target.webSocketDebuggerUrl)
  await page.ready
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Network.enable')

  const cookies = await sessionCookies(process.env.AS_EMAIL ?? 'sample-employee@example.com')
  await page.send('Network.setCookies', {
    cookies: cookies.map((c) => ({ ...c, domain: 'localhost', path: '/' })),
  })

  const paths = process.argv.slice(2)
  if (!paths.length) paths.push('/en/history', '/en/questions', '/en/my-exams')

  for (const path of paths) {
    await page.send('Page.navigate', { url: `${APP}${path}` })
    await sleep(3500)
    const { result } = await page.send('Runtime.evaluate', {
      expression: 'document.body.innerText.replace(/\\s+/g," ").trim().slice(0,300)',
      returnByValue: true,
    })
    console.log(`\n${path}\n   "${result.value || '(BLANK — nothing rendered)'}"`)
  }
  page.close()
} finally {
  chrome.kill()
}
