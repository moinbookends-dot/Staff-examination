/**
 * Rasterise a PDF so a human (or a model) can actually look at it.
 *
 * Spike support only. The shaping question in pdf-spike.mjs cannot be answered
 * by any assertion — an unshaped Indic PDF is structurally valid and renders
 * without error — so the verdict has to come from looking at pixels.
 *
 * Usage: node scripts/pdf-to-png.mjs <input.pdf> [outDir] [scale]
 */

import path from 'node:path'
import fs from 'node:fs'
import { pdf } from 'pdf-to-img'

const input = process.argv[2]
if (!input) {
  console.error('usage: node scripts/pdf-to-png.mjs <input.pdf> [outDir] [scale]')
  process.exit(1)
}

const outDir = path.resolve(process.argv[3] ?? path.join(path.dirname(input), 'png'))
const scale = Number(process.argv[4] ?? 2.5)

fs.mkdirSync(outDir, { recursive: true })

const doc = await pdf(path.resolve(input), { scale })
let n = 0
for await (const page of doc) {
  n += 1
  const out = path.join(outDir, `page-${String(n).padStart(2, '0')}.png`)
  fs.writeFileSync(out, page)
  console.log(`  ${out}  (${fs.statSync(out).size.toLocaleString()} bytes)`)
}
console.log(`\n  ${n} page(s) at scale ${scale}.`)
