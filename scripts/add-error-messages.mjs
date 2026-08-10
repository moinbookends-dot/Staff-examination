/**
 * Two keys the error boundary needs to tell a REFUSAL apart from a CRASH.
 *
 * It previously rendered "Something went wrong" as the headline and "You don't
 * have permission to view this" as the body for every error at once — so a
 * refused page read as a crash, and a real crash told the user they lacked a
 * permission they held.
 *
 *   node scripts/add-error-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = {
  en: {
    forbiddenTitle: 'Not available to you',
    unexpected: 'Something went wrong at our end. Try again in a moment.',
  },
  hi: {
    forbiddenTitle: 'आपके लिए उपलब्ध नहीं',
    unexpected: 'हमारी ओर से कुछ गड़बड़ हुई। थोड़ी देर में फिर कोशिश करें।',
  },
  gu: {
    forbiddenTitle: 'તમારા માટે ઉપલબ્ધ નથી',
    unexpected: 'અમારી બાજુએ કંઈક ખોટું થયું. થોડી વારમાં ફરી પ્રયાસ કરો.',
  },
}

for (const [locale, keys] of Object.entries(MESSAGES)) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))

  json.errors ??= {}
  let added = 0
  for (const [key, value] of Object.entries(keys)) {
    if (json.errors[key] === undefined) added++
    json.errors[key] = value
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log(`  ${locale}: ${added} added, ${Object.keys(keys).length - added} already present`)
}
