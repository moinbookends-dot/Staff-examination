/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Message keys for /verify-email, and the register form's confirm-password.
 *
 * Written as a script rather than three hand edits for the reason every other
 * add-*-messages.mjs in this folder exists: en.json, hi.json and gu.json must
 * agree key-for-key, and hand-editing three files in three scripts is how a
 * Gujarati reader ends up looking at an English label. It writes all three from
 * one table, so a missing translation is impossible by construction.
 *
 *   node scripts/add-verify-email-messages.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** [key, en, hi, gu] */
const VERIFY_EMAIL = [
  ['title', 'Confirm your email', 'अपना ईमेल पक्का करें', 'તમારું ઈમેલ ખાતરી કરો'],
  [
    'body',
    'We sent you a code. Enter it below to confirm this address is yours.',
    'हमने आपको एक कोड भेजा है। यह पता आपका है, यह पक्का करने के लिए नीचे डालें।',
    'અમે તમને એક કોડ મોકલ્યો છે. આ સરનામું તમારું છે તે ખાતરી કરવા નીચે લખો.',
  ],
  ['sentTo', 'Sent to', 'भेजा गया', 'મોકલ્યો'],
  ['codeLabel', 'Code from the email', 'ईमेल का कोड', 'ઈમેલનો કોડ'],
  [
    'codeHint',
    'Only the numbers. It may take a minute to arrive — check your spam folder too.',
    'सिर्फ़ अंक। आने में एक मिनट लग सकता है — स्पैम फ़ोल्डर भी देखें।',
    'ફક્ત આંકડા. આવવામાં એક મિનિટ લાગી શકે — સ્પામ ફોલ્ડર પણ જુઓ.',
  ],
  ['submit', 'Confirm', 'पक्का करें', 'ખાતરી કરો'],
  ['resend', 'Send a new code', 'नया कोड भेजें', 'નવો કોડ મોકલો'],
  ['resendIn', 'Send a new code in {seconds}s', '{seconds} सेकंड में नया कोड', '{seconds} સેકંડમાં નવો કોડ'],
  ['wrongAddress', 'Wrong address? Register again', 'ग़लत पता? फिर से रजिस्टर करें', 'ખોટું સરનામું? ફરી નોંધણી કરો'],
  ['backToSignIn', 'Back to sign in', 'साइन इन पर वापस', 'સાઇન ઇન પર પાછા'],
  ['emailLabel', 'Email', 'ईमेल', 'ઈમેલ'],
  ['continue', 'Continue', 'आगे बढ़ें', 'આગળ વધો'],
  [
    'noAddress',
    'Enter the address you registered with and we will send a new code.',
    'जिस पते से रजिस्टर किया था वह डालें, हम नया कोड भेज देंगे।',
    'જે સરનામાથી નોંધણી કરી હતી તે લખો, અમે નવો કોડ મોકલીશું.',
  ],
  [
    'linkExpired',
    'That link has already been used or has expired. Ask for a new code below.',
    'वह लिंक पहले इस्तेमाल हो चुका है या उसकी मियाद ख़त्म हो गई है। नीचे से नया कोड माँगें।',
    'એ લિંક પહેલાં વપરાઈ ગઈ છે અથવા તેની મુદત પૂરી થઈ છે. નીચેથી નવો કોડ માગો.',
  ],
]

/** Added to auth.register. */
const REGISTER = [
  ['confirmPassword', 'Confirm password', 'पासवर्ड दोबारा', 'પાસવર્ડ ફરીથી'],
  [
    'mismatch',
    'Those passwords do not match.',
    'ये पासवर्ड मेल नहीं खाते।',
    'આ પાસવર્ડ મેળ ખાતા નથી.',
  ],
]

const LOCALES = ['en', 'hi', 'gu']

for (const [index, locale] of LOCALES.entries()) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf-8'))

  json.auth ??= {}
  json.auth.verifyEmail = Object.fromEntries(
    VERIFY_EMAIL.map(([key, ...values]) => [key, values[index]]),
  )
  for (const [key, ...values] of REGISTER) {
    json.auth.register[key] = values[index]
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf-8')
  console.log(
    `  ${locale}: auth.verifyEmail (${VERIFY_EMAIL.length} keys), ` +
      `auth.register +${REGISTER.length}`,
  )
}
