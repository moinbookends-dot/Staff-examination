/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Empty and remove the `source-documents` bucket.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS EXISTS BECAUSE SQL CANNOT DO IT, NOT BECAUSE A SCRIPT IS TIDIER.     ║
 * ║                                                                           ║
 * ║ Migration 0068 originally ended with `delete from storage.objects` and    ║
 * ║ Supabase refused the whole transaction:                                   ║
 * ║                                                                           ║
 * ║   ERROR: Direct deletion from storage tables is not allowed.              ║
 * ║          Use the Storage API instead. (SQLSTATE 42501)                    ║
 * ║                                                                           ║
 * ║ The guard is correct — those rows index objects the storage service owns, ║
 * ║ and removing them in SQL orphans the bytes instead of freeing them.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * DESTRUCTIVE. It deletes every file in the bucket and then the bucket. Run it
 * after 0068 has applied.
 *
 *   node scripts/drop-guide-storage.mjs           # list what would go
 *   node scripts/drop-guide-storage.mjs --apply   # actually remove it
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BUCKET = 'source-documents'
const apply = process.argv.includes('--apply')

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) {
  console.error(
    '\n  No service key in .env.local (SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY).\n' +
      '  Removing a bucket is an admin operation; the anon key cannot do it.\n',
  )
  process.exit(2)
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

/** Every object in the bucket, paged — list() caps at 100 by default. */
async function listAll() {
  const found = []
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${URL_}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix: '', limit: 100, offset }),
    })
    if (!res.ok) {
      // A bucket that is already gone is success, not failure — this script
      // has to be safe to run twice.
      if (res.status === 404) return null
      throw new Error(`list failed: ${res.status} ${(await res.text()).slice(0, 160)}`)
    }
    const page = await res.json()
    if (!Array.isArray(page) || page.length === 0) break
    found.push(...page)
    if (page.length < 100) break
  }
  return found
}

/*
 * The list endpoint only returns one directory level, and the path convention
 * is <company>/<document>/<file> — so a flat list returns folders, not files.
 * Walking is the only way to reach the objects themselves.
 */
async function walk(prefix = '') {
  const res = await fetch(`${URL_}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prefix, limit: 100, offset: 0 }),
  })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`list failed: ${res.status} ${(await res.text()).slice(0, 160)}`)
  }

  const entries = await res.json()
  const files = []
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    // A folder has no id; a real object does.
    if (entry.id === null || entry.id === undefined) files.push(...(await walk(path)))
    else files.push(path)
  }
  return files
}

const exists = await listAll()
if (exists === null) {
  console.log(`\n  Bucket "${BUCKET}" does not exist — nothing to do.\n`)
  process.exit(0)
}

const files = await walk()
console.log(`\n  Bucket "${BUCKET}" holds ${files.length} file(s):`)
for (const f of files) console.log(`    ${f}`)

if (!apply) {
  console.log('\n  DRY RUN — re-run with --apply to delete these and the bucket.\n')
  process.exit(0)
}

if (files.length > 0) {
  const res = await fetch(`${URL_}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ prefixes: files }),
  })
  if (!res.ok) {
    console.error(`\n  Deleting the files failed: ${res.status} ${(await res.text()).slice(0, 200)}\n`)
    process.exit(1)
  }
  console.log(`\n  ${files.length} file(s) deleted`)
}

const removed = await fetch(`${URL_}/storage/v1/bucket/${BUCKET}`, { method: 'DELETE', headers })
if (!removed.ok) {
  console.error(`\n  Removing the bucket failed: ${removed.status} ${(await removed.text()).slice(0, 200)}\n`)
  process.exit(1)
}

console.log(`  Bucket "${BUCKET}" removed.\n`)
