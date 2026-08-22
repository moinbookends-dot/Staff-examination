/**
 * The `nav.topics` label, written to all three locales.
 *
 * Same one-source approach as add-shell-messages.mjs: tests/unit/messages.test.ts
 * fails on a key present in one bundle and absent from another, and the way that
 * happens is somebody hand-editing three JSON files and missing one.
 *
 * Every other bank.* string the Topic Management screen needs already exists —
 * this is the single key the nav entry added.
 *
 *   node scripts/add-topics-nav-message.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = resolve('messages')

/**
 * Short, because it renders inside a sidebar rail and under a mobile tab icon.
 * "Topic management" is the page's own heading (bank.topicsTitle); the nav
 * label only has to name the destination.
 */
const NAV = {
  en: { topics: 'Topics' },
  hi: { topics: 'विषय' },
  gu: { topics: 'વિષયો' },
}

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve(MESSAGES, `${locale}.json`)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))

  bundle.nav = { ...bundle.nav, ...NAV[locale] }

  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  console.log(`  ${locale}.json — nav.topics = ${NAV[locale].topics}`)
}

const en = Object.keys(NAV.en).sort()
for (const locale of ['hi', 'gu']) {
  const other = Object.keys(NAV[locale]).sort()
  if (JSON.stringify(en) !== JSON.stringify(other)) {
    console.error(`\n  ${locale} does not match en: ${en} vs ${other}`)
    process.exit(1)
  }
}
console.log('\n  All three locales carry identical keys.')
