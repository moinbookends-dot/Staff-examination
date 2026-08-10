/**
 * ═════════════════════════════════════════════════════════════════════════════
 * BUILD AN ISOLATED POSTGRES AND RUN THE RLS SUITE AGAINST IT.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS WILL NOT TOUCH THE HOSTED PROJECT, AND IT CHECKS RATHER THAN         ║
 * ║ TRUSTING.                                                                 ║
 * ║                                                                           ║
 * ║ The suite replays every migration from empty and then writes fixtures. If ║
 * ║ DATABASE_URL pointed at the real project it would rewrite the schema and  ║
 * ║ seed test users into production data. So this script REFUSES any host     ║
 * ║ that is not local, and refuses the project ref from .env.local outright — ║
 * ║ a guard that costs nothing and removes the one catastrophic mistake       ║
 * ║ available here.                                                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *
 *   node scripts/rls-test-db.mjs up      # start the container, build the schema
 *   node scripts/rls-test-db.mjs test    # up, then run the rls project
 *   node scripts/rls-test-db.mjs down    # remove the container
 *
 * Requires Docker. Nothing else — psql is run INSIDE the container, so no local
 * client install is needed.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const NAME = 'bookends-rls-test'
const PORT = process.env.RLS_TEST_PORT ?? '55432'
const IMAGE = 'postgres:17'
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })

const capture = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })

function requireDocker() {
  const v = capture('docker', ['version', '--format', '{{.Server.Version}}'])
  if (v.status !== 0) {
    console.error(
      '\n  Docker is not available.\n\n' +
        '  This script needs it to run an isolated Postgres. Install Docker Desktop and\n' +
        '  start it, then re-run. The RLS suite cannot be pointed at the hosted project:\n' +
        '  it replays every migration from empty and would rewrite the schema.\n',
    )
    process.exit(2)
  }
  return v.stdout.trim()
}

/**
 * The guard. Local hosts only, and never the hosted project ref.
 *
 * Checked here rather than trusted from the caller because `test` passes
 * DATABASE_URL into vitest, and an env var inherited from a shell is exactly
 * how the wrong database gets used.
 */
function assertIsolated(url) {
  const { hostname } = new URL(url)
  const local = ['127.0.0.1', 'localhost', '::1', 'host.docker.internal']
  if (!local.includes(hostname)) {
    console.error(`\n  REFUSING: ${hostname} is not a local host.\n`)
    process.exit(2)
  }

  const envLocal = resolve('.env.local')
  if (existsSync(envLocal)) {
    const raw = readFileSync(envLocal, 'utf8')
    const m = raw.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*(\S+)/)
    if (m) {
      const ref = new URL(m[1]).hostname.split('.')[0]
      if (url.includes(ref)) {
        console.error(`\n  REFUSING: that URL names the hosted project (${ref}).\n`)
        process.exit(2)
      }
    }
  }
}

/** psql inside the container, so no local client is required. */
function psql(args, input) {
  return spawnSync(
    'docker',
    ['exec', '-i', NAME, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', ...args],
    { encoding: 'utf8', input, shell: process.platform === 'win32' },
  )
}

function waitForPostgres() {
  for (let i = 0; i < 60; i++) {
    const r = capture('docker', ['exec', NAME, 'pg_isready', '-U', 'postgres'])
    if (r.status === 0) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  return false
}

function up() {
  requireDocker()
  assertIsolated(DATABASE_URL)

  const existing = capture('docker', ['ps', '-aq', '-f', `name=^${NAME}$`]).stdout.trim()
  if (existing) {
    console.log(`  removing the previous ${NAME} container`)
    run('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  }

  console.log(`  starting ${IMAGE} on port ${PORT}`)
  const started = run('docker', [
    'run', '-d', '--name', NAME,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=postgres',
    '-p', `${PORT}:5432`,
    IMAGE,
  ])
  if (started.status !== 0) process.exit(started.status ?? 1)

  if (!waitForPostgres()) {
    console.error('  Postgres did not become ready')
    process.exit(1)
  }

  console.log('  applying supabase/tests/bootstrap.sql')
  const boot = psql(['-f', '-'], readFileSync('supabase/tests/bootstrap.sql', 'utf8'))
  if (boot.status !== 0) {
    console.error(boot.stderr)
    process.exit(1)
  }

  /*
   * Replayed in filename order, which is the order supabase db push uses. A
   * failure stops here rather than continuing: a half-applied schema produces
   * policy failures that look like policy bugs.
   */
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
  console.log(`  replaying ${files.length} migrations`)
  for (const f of files) {
    const r = psql(['-f', '-'], readFileSync(`supabase/migrations/${f}`, 'utf8'))
    if (r.status !== 0) {
      console.error(`\n  FAILED on ${f}:\n${r.stderr}`)
      process.exit(1)
    }
  }

  /*
   * Table and sequence grants, mirroring .github/workflows/ci.yml.
   *
   * FUNCTIONS AND VIEWS ARE DELIBERATELY EXCLUDED. A blanket function grant
   * re-grants the internal SECURITY DEFINER helpers that 0020 revokes, and CI
   * then disagrees with production about who may call what — which is how an
   * anon-callable draw_paper() passed CI for six commits. Views are worse: a
   * view runs with its owner's rights, so re-granting one bypasses RLS
   * entirely rather than merely skipping a policy.
   */
  const grants = psql([
    '-Atc',
    `select format('grant all on public.%I to anon, authenticated, service_role;', c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')`,
  ])
  if (grants.status !== 0) {
    console.error(grants.stderr)
    process.exit(1)
  }
  psql(['-f', '-'], grants.stdout)
  psql(['-c', 'grant all on all sequences in schema public to anon, authenticated, service_role;'])

  const counts = psql([
    '-Atc',
    `select (select count(*) from pg_tables where schemaname='public')
       || ' tables, ' ||
            (select count(*) from pg_policies where schemaname='public') || ' policies'`,
  ])
  console.log(`  ready — ${counts.stdout.trim()}`)
  console.log(`\n  DATABASE_URL=${DATABASE_URL}\n`)
}

function test() {
  up()
  assertIsolated(DATABASE_URL)
  const r = run('npx', ['vitest', 'run', '--project', 'rls'], {
    env: { ...process.env, DATABASE_URL },
  })
  process.exit(r.status ?? 1)
}

function down() {
  requireDocker()
  run('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  console.log(`  ${NAME} removed`)
}

const command = process.argv[2] ?? 'test'
if (command === 'up') up()
else if (command === 'down') down()
else if (command === 'test') test()
else {
  console.error(`  unknown command "${command}" — use up, test or down`)
  process.exit(2)
}
