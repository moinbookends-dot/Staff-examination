/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The app's icon set, rendered from one SVG source.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ GENERATED, NOT HAND-EXPORTED, SO THE SIZES CANNOT DRIFT APART.            ║
 * ║                                                                           ║
 * ║ An icon set is the one asset people notice immediately when it is wrong:  ║
 * ║ a home-screen icon that is subtly different from the tab icon reads as a  ║
 * ║ different app. One source, one command, every size.                       ║
 * ║                                                                           ║
 * ║ TWO SHAPES, and the difference is not cosmetic. Android may crop an icon  ║
 * ║ to a circle, a squircle, a teardrop — whatever the launcher uses. A       ║
 * ║ `maskable` icon must therefore keep everything meaningful inside the      ║
 * ║ central 80%, or the mark loses its edges on somebody's phone. The plain   ║
 * ║ icon fills its square, because iOS and the browser tab do not crop.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/make-icons.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const BRAND = '#2563eb'
const OUT = resolve('public/icons')
mkdirSync(OUT, { recursive: true })

/**
 * Two bookends holding a page upright — the product's own name, drawn.
 *
 * @param pad Fraction of the canvas left empty around the mark. The maskable
 *   variant needs room for a launcher to crop into; the plain one does not.
 * @param radius Corner rounding of the tile, as a fraction. iOS applies its own
 *   mask, so the plain icon is drawn square and left to the platform.
 */
const svg = ({ pad, radius, background = BRAND }) => {
  const S = 512
  const inner = S * (1 - pad * 2)
  const x = S * pad

  // The mark, laid out inside `inner` and then offset by the padding.
  const barW = inner * 0.15
  const barH = inner * 0.74
  const top = x + (inner - barH) / 2
  const leftX = x
  const rightX = x + inner - barW

  // The page between them, tilted so the mark is not three identical bars.
  const pageW = inner * 0.34
  const pageH = inner * 0.56
  const pageX = x + (inner - pageW) / 2
  const pageY = x + (inner - pageH) / 2

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="${S * radius}" fill="${background}"/>
  <g fill="#ffffff">
    <rect x="${leftX}" y="${top}" width="${barW}" height="${barH}" rx="${barW * 0.28}"/>
    <rect x="${rightX}" y="${top}" width="${barW}" height="${barH}" rx="${barW * 0.28}"/>
    <g transform="rotate(-8 ${S / 2} ${S / 2})">
      <rect x="${pageX}" y="${pageY}" width="${pageW}" height="${pageH}" rx="${pageW * 0.1}" fill="#ffffff" opacity="0.92"/>
      <rect x="${pageX + pageW * 0.18}" y="${pageY + pageH * 0.26}" width="${pageW * 0.64}" height="${pageH * 0.075}" rx="${pageH * 0.037}" fill="${background}"/>
      <rect x="${pageX + pageW * 0.18}" y="${pageY + pageH * 0.46}" width="${pageW * 0.64}" height="${pageH * 0.075}" rx="${pageH * 0.037}" fill="${background}"/>
      <rect x="${pageX + pageW * 0.18}" y="${pageY + pageH * 0.66}" width="${pageW * 0.4}" height="${pageH * 0.075}" rx="${pageH * 0.037}" fill="${background}"/>
    </g>
  </g>
</svg>`)
}

/** Fills its square. The browser tab and iOS both apply their own shape. */
const plain = svg({ pad: 0.19, radius: 0.18 })

/** Everything meaningful inside the central 80%, for launcher cropping. */
const maskable = svg({ pad: 0.28, radius: 0 })

const targets = [
  { file: 'icon-192.png', size: 192, source: plain },
  { file: 'icon-512.png', size: 512, source: plain },
  { file: 'icon-maskable-192.png', size: 192, source: maskable },
  { file: 'icon-maskable-512.png', size: 512, source: maskable },
  // iOS ignores the manifest and reads this. It also composites onto BLACK if
  // the image has alpha, so it is flattened onto the brand colour instead.
  { file: 'apple-touch-icon.png', size: 180, source: plain, flatten: true },
]

for (const t of targets) {
  let pipeline = sharp(t.source).resize(t.size, t.size)
  if (t.flatten) pipeline = pipeline.flatten({ background: BRAND })
  await pipeline.png({ compressionLevel: 9 }).toFile(resolve(OUT, t.file))
  console.log(`  ${t.file.padEnd(26)} ${t.size}×${t.size}`)
}

// The SVG itself, for anything that prefers to scale it (browser tabs do).
writeFileSync(resolve(OUT, 'icon.svg'), plain)
console.log('  icon.svg                   vector')
console.log(`\n  Wrote ${targets.length + 1} files to public/icons\n`)
