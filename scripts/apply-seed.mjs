/**
 * Applies supabase/seed.sql to the linked project.
 *
 * `supabase db push` does not run seeds against a remote database — seeds are
 * a local-stack concept. With no Docker here, this script covers the gap.
 * seed.sql is written idempotently (every insert ON CONFLICT DO NOTHING), so
 * re-running is safe.
 *
 *   node scripts/apply-seed.mjs
 *
 * Reads connection details from .env.local.
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
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const client = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

await client.connect()

const sql = readFileSync(resolve(root, 'supabase/seed.sql'), 'utf-8')
await client.query(sql)

const checks = {
  companies: 'select count(*)::int n from public.companies',
  brands: 'select count(*)::int n from public.brands',
  outlets: 'select count(*)::int n from public.outlets',
  departments: 'select count(*)::int n from public.departments',
  roles: 'select count(*)::int n from public.roles',
  permissions: 'select count(*)::int n from public.permissions',
  role_permissions: 'select count(*)::int n from public.role_permissions',
}

console.log('Seeded:')
for (const [label, q] of Object.entries(checks)) {
  const { rows } = await client.query(q)
  console.log(`  ${label.padEnd(18)} ${rows[0].n}`)
}

await client.end()
