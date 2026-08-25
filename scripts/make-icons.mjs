/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The app's icon set, rendered from the Performix mark.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ GENERATED, NOT HAND-EXPORTED, SO THE SIZES CANNOT DRIFT APART.            ║
 * ║                                                                           ║
 * ║ Source of truth: assets/brand/performix-logo.png (the delivered art) —    ║
 * ║ public/brand/performix-mark.png is the knocked-out P-mark derived from    ║
 * ║ it. This script consumes the mark and emits every raster size the         ║
 * ║ platform surfaces need. One source, one command, every size.              ║
 * ║                                                                           ║
 * ║ TWO SHAPES, and the difference is not cosmetic. Android may crop an icon  ║
 * ║ to a circle, a squircle, a teardrop — whatever the launcher uses. A       ║
 * ║ `maskable` icon must keep everything meaningful inside the central 80%,   ║
 * ║ or the mark loses its edges on somebody's phone. The plain icon fills     ║
 * ║ more of its square, because iOS and the browser tab do not crop.          ║
 * ║                                                                           ║
 * ║ WHITE TILE, NOT NAVY. The mark is two-thirds deep navy; on a navy tile    ║
 * ║ it disappears. White is also what the lockup itself was designed on.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/make-icons.mjs      (npm run make:icons)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const MARK = resolve('public/brand/performix-mark.png')
const OUT = resolve('public/icons')
mkdirSync(OUT, { recursive: true })

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

/**
 * One square icon: white tile, mark centred at `fill` of the side.
 * plain → 0.78 (fills the tile); maskable → 0.56 (inside the 80% safe zone
 * with margin, because launchers crop hard).
 */
async function tile(size, fill) {
  const inner = Math.round(size * fill)
  const mark = await sharp(MARK).resize(inner, inner, { fit: 'contain' }).toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const targets = [
  { file: 'icon-192.png', size: 192, fill: 0.78 },
  { file: 'icon-512.png', size: 512, fill: 0.78 },
  { file: 'icon-maskable-192.png', size: 192, fill: 0.56 },
  { file: 'icon-maskable-512.png', size: 512, fill: 0.56 },
  // iOS composites its own rounding; 180 is the current @3x size.
  { file: 'apple-touch-icon.png', size: 180, fill: 0.78 },
]

for (const t of targets) {
  writeFileSync(resolve(OUT, t.file), await tile(t.size, t.fill))
  console.log(`  ${t.file.padEnd(26)} ${t.size}x${t.size}`)
}

/*
 * favicon.ico — a modern ICO is allowed to carry a PNG payload (Vista+), and
 * every browser this app supports reads it. Hand-assembled header because no
 * dependency should exist for 22 bytes of structure.
 */
const png32 = await tile(32, 0.9)
const ico = Buffer.concat([
  Buffer.from([0, 0, 1, 0, 1, 0]),                       // ICONDIR: 1 image
  Buffer.from([32, 32, 0, 0, 1, 0, 32, 0]),              // 32x32, 1 plane, 32bpp
  (() => { const b = Buffer.alloc(8); b.writeUInt32LE(png32.length, 0); b.writeUInt32LE(22, 4); return b })(),
  png32,
])
writeFileSync(resolve('src/app/favicon.ico'), ico)
console.log('  src/app/favicon.ico        32x32 (PNG-in-ICO)')

console.log(`\n  Wrote ${targets.length + 1} files\n`)
