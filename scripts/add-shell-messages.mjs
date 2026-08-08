/**
 * Nav and shell strings for the Stitch layout, written to all three locales.
 *
 * Same one-source approach as add-bank-messages.mjs, and for the same reason:
 * tests/unit/messages.test.ts fails on an orphan key, and hand-editing three
 * JSON files is how a key ends up spelled differently in one of them.
 *
 *   node scripts/add-shell-messages.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = resolve('messages')

/**
 * The Stitch sidebar carries a product name and a subtitle beneath it.
 *
 * The desktop screens read "ExamPro / Enterprise Suite"; the mobile ones read
 * "Bookends Staff Examination". The customer chose Bookends, so the name is
 * theirs and the subtitle keeps the structural role the design gives it.
 */
const APP = {
  en: { name: 'Bookends', subtitle: 'Staff Examination' },
  hi: { name: 'Bookends', subtitle: 'स्टाफ़ परीक्षा' },
  gu: { name: 'Bookends', subtitle: 'સ્ટાફ પરીક્ષા' },
}

/** Nav labels. `bank` already exists from the Question Bank namespace. */
const NAV = {
  en: {
    generate: 'Generate Exam',
    history: 'Exam History',
    editors: 'Editor Management',
    settings: 'Settings',
    profile: 'Profile',
  },
  hi: {
    generate: 'पेपर बनाएँ',
    history: 'पेपर इतिहास',
    editors: 'Editor प्रबंधन',
    settings: 'सेटिंग्स',
    profile: 'प्रोफ़ाइल',
  },
  gu: {
    generate: 'પેપર બનાવો',
    history: 'પેપર ઇતિહાસ',
    editors: 'Editor સંચાલન',
    settings: 'સેટિંગ્સ',
    profile: 'પ્રોફાઇલ',
  },
}

/** Top bar and shared chrome. */
const SHELL = {
  en: {
    search: 'Search…',
    notifications: 'Notifications',
    help: 'Help',
    account: 'Account',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
  },
  hi: {
    search: 'खोजें…',
    notifications: 'सूचनाएँ',
    help: 'मदद',
    account: 'खाता',
    openMenu: 'मेन्यू खोलें',
    closeMenu: 'मेन्यू बंद करें',
  },
  gu: {
    search: 'શોધો…',
    notifications: 'સૂચનાઓ',
    help: 'મદદ',
    account: 'એકાઉન્ટ',
    openMenu: 'મેન્યુ ખોલો',
    closeMenu: 'મેન્યુ બંધ કરો',
  },
}

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve(MESSAGES, `${locale}.json`)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))

  bundle.app = { ...bundle.app, ...APP[locale] }
  bundle.nav = { ...bundle.nav, ...NAV[locale] }
  bundle.shell = SHELL[locale]

  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  console.log(`  ${locale}.json — app, nav and shell updated`)
}

function paths(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? paths(v, prefix ? `${prefix}.${k}` : k)
      : [prefix ? `${prefix}.${k}` : k],
  )
}

for (const group of [APP, NAV, SHELL]) {
  const en = paths(group.en).sort()
  for (const locale of ['hi', 'gu']) {
    const other = paths(group[locale]).sort()
    if (JSON.stringify(en) !== JSON.stringify(other)) {
      console.error(`\n  ${locale} does not match en: ${en} vs ${other}`)
      process.exit(1)
    }
  }
}
console.log('\n  All three locales carry identical keys.')
