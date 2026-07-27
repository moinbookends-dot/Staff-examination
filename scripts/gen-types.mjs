/**
 * Generates src/lib/db/database.types.ts directly from the live schema.
 *
 * WHY NOT `supabase gen types`: that command shells out to a postgres-meta
 * Docker container. There is no Docker on this machine (plan §1.1), so it
 * cannot run locally. `--linked` would use the Management API instead, but
 * needs a personal access token. This script needs neither — just the database
 * connection we already have.
 *
 *   node scripts/gen-types.mjs
 *
 * Output is intentionally shaped like the official generator's so it can be
 * swapped back at any time.
 */
import { Client } from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
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

// ── Enums ────────────────────────────────────────────────────────────────────
const { rows: enumRows } = await client.query(`
  select t.typname as name, e.enumlabel as label
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
   order by t.typname, e.enumsortorder
`)

const enums = {}
for (const r of enumRows) (enums[r.name] ??= []).push(r.label)

// ── Columns ──────────────────────────────────────────────────────────────────
const { rows: colRows } = await client.query(`
  select c.relname                                as table_name,
         c.relkind                                as kind,           -- r = table, v = view, m = matview
         a.attname                                as column_name,
         a.attnum                                 as ordinal,
         not a.attnotnull                         as is_nullable,
         pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted,
         t.typname                                as type_name,
         t.typcategory                            as type_category,
         coalesce(et.typname, '')                 as element_type,
         (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') as has_default,
         a.attgenerated <> ''                     as is_generated
    from pg_attribute a
    join pg_class c      on c.oid = a.attrelid
    join pg_namespace n  on n.oid = c.relnamespace
    join pg_type t       on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem
   where n.nspname = 'public'
     and c.relkind in ('r','v','m')
     and a.attnum > 0
     and not a.attisdropped
   order by c.relname, a.attnum
`)

/** Postgres type → TypeScript. Mirrors what supabase-js expects at runtime. */
function tsType(row) {
  const { type_name, type_category, element_type } = row

  // Arrays: pg reports them as _typename with category 'A'.
  if (type_category === 'A') {
    const inner = mapScalar(element_type)
    return `${inner}[]`
  }
  return mapScalar(type_name)
}

function mapScalar(name) {
  switch (name) {
    case 'uuid':
    case 'text':
    case 'varchar':
    case 'bpchar':
    case 'name':
    case 'citext':
    case 'inet':
    case 'cidr':
    case 'macaddr':
    case 'date':
    case 'time':
    case 'timetz':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
    case 'tsvector':
    case 'bytea':
      return 'string'

    case 'int2':
    case 'int4':
    case 'float4':
    case 'float8':
    case 'numeric':
      return 'number'

    // int8 exceeds Number.MAX_SAFE_INTEGER. postgres-meta types it as number;
    // we match so the two generators stay swappable. Our only bigint is
    // audit_logs.id, which is display-only.
    case 'int8':
      return 'number'

    case 'bool':
      return 'boolean'

    case 'json':
    case 'jsonb':
      return 'Json'

    default:
      // Enums declared in public become a reference into the Enums block, so
      // renaming a value is a compile error at every use site.
      if (enums[name]) return `Database["public"]["Enums"]["${name}"]`
      return 'unknown'
  }
}

const tables = {}
const views = {}

for (const row of colRows) {
  const bucket = row.kind === 'r' ? tables : views
  const entry = (bucket[row.table_name] ??= [])
  entry.push(row)
}

// ── Functions ────────────────────────────────────────────────────────────────
const { rows: fnRows } = await client.query(`
  select p.proname                                     as name,
         pg_catalog.pg_get_function_arguments(p.oid)   as args,
         pg_catalog.pg_get_function_result(p.oid)      as returns,
         p.proretset                                   as returns_set
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
   order by p.proname
`)

await client.end()

// ── Emit ─────────────────────────────────────────────────────────────────────
const q = (s) => JSON.stringify(s)

function columnLines(rows, mode) {
  return rows
    .map((r) => {
      const type = tsType(r)
      const nullable = r.is_nullable ? ' | null' : ''

      if (mode === 'Row') {
        return `          ${q(r.column_name)}: ${type}${nullable}`
      }
      if (mode === 'Insert') {
        // Optional when the database can supply it: default, identity, generated,
        // or nullable.
        const optional = r.has_default || r.is_nullable || r.is_generated ? '?' : ''
        return `          ${q(r.column_name)}${optional}: ${type}${nullable}`
      }
      // Update: everything optional — that is what a partial update means.
      return `          ${q(r.column_name)}?: ${type}${nullable}`
    })
    .join('\n')
}

let out = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by \`npm run gen:types\` (scripts/gen-types.mjs) from the live
 * schema. Hand edits are lost on regeneration, and CI fails on any drift
 * between this file and the database.
 *
 * Regenerate after every migration.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
`

for (const [name, rows] of Object.entries(tables).sort()) {
  const insertable = rows.filter((r) => !r.is_generated)
  out += `      ${q(name)}: {
        Row: {
${columnLines(rows, 'Row')}
        }
        Insert: {
${columnLines(insertable, 'Insert')}
        }
        Update: {
${columnLines(insertable, 'Update')}
        }
        Relationships: []
      }
`
}

out += `    }
    Views: {
`

if (Object.keys(views).length === 0) {
  out += `      [_ in never]: never
`
} else {
  for (const [name, rows] of Object.entries(views).sort()) {
    out += `      ${q(name)}: {
        Row: {
${columnLines(rows, 'Row')}
        }
        Relationships: []
      }
`
  }
}

out += `    }
    Functions: {
`

if (fnRows.length === 0) {
  out += `      [_ in never]: never
`
} else {
  for (const fn of fnRows) {
    // Args are typed loosely: parsing pg_get_function_arguments into precise
    // per-parameter types is more machinery than it earns here, and every RPC
    // call site passes a Zod-validated object anyway.
    out += `      ${q(fn.name)}: {
        Args: Record<string, unknown>
        Returns: unknown
      }
`
  }
}

out += `    }
    Enums: {
`

if (Object.keys(enums).length === 0) {
  out += `      [_ in never]: never
`
} else {
  for (const [name, labels] of Object.entries(enums).sort()) {
    out += `      ${q(name)}: ${labels.map(q).join(' | ')}\n`
  }
}

out += `    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"]
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"]
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T]
`

writeFileSync(resolve(root, 'src/lib/db/database.types.ts'), out, 'utf-8')

console.log(
  `Generated: ${Object.keys(tables).length} tables, ` +
  `${Object.keys(views).length} views, ` +
  `${Object.keys(enums).length} enums, ` +
  `${fnRows.length} functions`,
)
