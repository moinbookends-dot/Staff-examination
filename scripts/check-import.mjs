/**
 * Validate a question dataset before importing it. Writes nothing, anywhere.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS A SCRIPT AND NOT ONLY A SCREEN.                               │
 * │                                                                           │
 * │ The 3,000 questions are generated outside this application, so the person │
 * │ generating them needs to check a file WITHOUT signing in, without the     │
 * │ database existing, and ideally inside the loop that produces it.          │
 * │                                                                           │
 * │ It runs the same analyseImport() the import screen runs, so a file that   │
 * │ passes here passes there. Nothing is duplicated between the two.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/check-import.mjs questions.json
 *   node scripts/check-import.mjs questions.json --topics=food-safety,storage
 *
 * Exit code 0 when every row is valid, 1 otherwise — so it can gate a pipeline.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))

if (!file) {
  console.error('usage: node scripts/check-import.mjs <file.json> [--topics=a,b,c]')
  process.exit(2)
}

const topicsArg = args.find((a) => a.startsWith('--topics='))
const knownTopics = topicsArg ? topicsArg.slice('--topics='.length).split(',') : []

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LOADED THROUGH VITE RATHER THAN REIMPLEMENTED IN JAVASCRIPT.              │
 * │                                                                           │
 * │ The analyser is TypeScript and this script has no build step. Node 24     │
 * │ strips types natively, but ESM still demands explicit file extensions, so │
 * │ the extensionless relative imports inside src/ do not resolve — and the   │
 * │ '@/…' alias never would.                                                  │
 * │                                                                           │
 * │ vite is already a dependency (vitest brings it) and resolves both. It     │
 * │ costs about a second of startup and keeps ONE implementation of the       │
 * │ import rules. A hand-written JavaScript copy would be a second set of     │
 * │ rules that drifts from the real one — which is the exact failure this     │
 * │ validator exists to prevent in the dataset it checks.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
let analyseImport
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
  const mod = await server.ssrLoadModule('/src/lib/bank/import/analyse.ts')
  analyseImport = mod.analyseImport
} catch (err) {
  console.error(`Could not load the validator: ${err.message}`)
  if (server) await server.close()
  process.exit(2)
}

const requiredArg = args.find((a) => a.startsWith('--required='))
const requiredLocales = requiredArg
  ? requiredArg.slice('--required='.length).split(',')
  : ['en']

const report = analyseImport(readFileSync(resolve(file), 'utf8'), {
  knownTopics,
  requiredLocales,
})

/*
 * No ANSI colour, deliberately.
 *
 * This output is read in a terminal, piped into a log, and pasted into a
 * message to whoever generated the file. Escape codes survive none of those
 * three well, and the first version emitted them literally — `[1m  4 rows` —
 * which is worse than plain text everywhere. Alignment and indentation carry
 * the structure instead.
 */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

console.log('')

if (report.fatal) {
  console.log(`  FAILED  ${report.fatal}`)
  await server.close()
  process.exit(1)
}

const accepted = report.importedCount + report.updatedCount

console.log(`  ${file}`)
console.log(`  ${plural(report.totalRows, 'row')}`)
console.log('')
console.log('  Outcome')
console.log(`    imported     ${String(report.importedCount).padStart(6)}`)
console.log(`    updated      ${String(report.updatedCount).padStart(6)}`)
console.log(`    rejected     ${String(report.rejectedCount).padStart(6)}`)
console.log(`    duplicate    ${String(report.duplicateCount).padStart(6)}`)

if (report.rejectedCount) {
  console.log('')
  console.log('  Rejected by cause')
  for (const [reason, n] of Object.entries(report.rejectionsByReason)) {
    if (n > 0) console.log(`    ${reason.padEnd(26)}${String(n).padStart(6)}`)
  }
}

console.log('')
console.log('  Difficulty')
for (const level of ['easy', 'medium', 'hard']) {
  console.log(`    ${level.padEnd(13)}${String(report.countsByDifficulty[level]).padStart(6)}`)
}

console.log('')
console.log('  Type')
console.log(`    mcq          ${String(report.countsByType.mcq).padStart(6)}`)
console.log(`    short_answer ${String(report.countsByType.short_answer).padStart(6)}`)

console.log('')
console.log('  Status')
for (const status of ['active', 'draft', 'archived']) {
  console.log(`    ${status.padEnd(13)}${String(report.countsByStatus[status]).padStart(6)}`)
}
if (report.downgradedToDraftCount) {
  console.log(
    `    ${report.downgradedToDraftCount} asked for active and were held as drafts — a required language is missing`,
  )
}

console.log('')
console.log(`  Languages    (of the ${accepted} accepted rows; required: ${requiredLocales.join(', ')})`)
for (const locale of ['en', 'hi', 'gu']) {
  const n = report.localeCoverage[locale]
  const missing = accepted - n
  console.log(
    `    ${locale.padEnd(13)}${String(n).padStart(6)}` + (missing > 0 ? `   ${missing} without it` : ''),
  )
}

if (report.unknownTopics.length) {
  console.log('')
  console.log(`  Unknown topics   ${report.unknownTopics.join(', ')}`)
}

if (report.topics.length) {
  console.log('')
  console.log(`  Topics       ${report.topics.join(', ')}`)
}

if (report.duplicates.length) {
  console.log('')
  console.log(`  ${plural(report.duplicates.length, 'duplicate row')} — the first one is kept`)
  for (const d of report.duplicates.slice(0, 20)) {
    console.log(`    row ${d.row} repeats row ${d.firstSeenAtRow}: ${truncate(d.question)}`)
  }
  if (report.duplicates.length > 20) {
    console.log(`    ...and ${report.duplicates.length - 20} more`)
  }
}

if (report.rejectedCount) {
  console.log('')
  console.log(`  ${plural(report.rejectedCount, 'rejected row')}`)
  for (const e of report.rejected.slice(0, 30)) {
    console.log(`    row ${e.row}${e.externalId ? `  (${e.externalId})` : ''}`)
    for (const issue of e.issues) console.log(`      - ${issue}`)
  }
  if (report.rejected.length > 30) {
    console.log(`    ...and ${report.rejected.length - 30} more rows`)
  }
}

console.log('')
await server.close()
process.exit(report.rejectedCount === 0 ? 0 : 1)

function truncate(s, n = 60) {
  return s.length > n ? `${s.slice(0, n)}...` : s
}
