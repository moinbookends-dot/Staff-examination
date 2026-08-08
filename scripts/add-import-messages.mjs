/**
 * Strings for the JSON import screen, written to all three locales.
 *
 * Same one-source approach as add-shell-messages.mjs — see that file for why.
 *
 *   node scripts/add-import-messages.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = resolve('messages')

/**
 * The eight rejection categories are keyed by their contract slug, so
 * REJECTION_REASONS can be mapped straight to a label without a lookup table
 * that could fall out of step with the frozen list.
 */
const IMPORT = {
  en: {
    title: 'Import questions',
    subtitle: 'Load a curated question file into the bank. Nothing is written until you review the report.',

    chooseFile: 'Choose a file',
    fileHint: 'JSON — an array of questions, an object with a "questions" array, or one question per line.',
    chooseBrand: 'Import into brand',
    reading: 'Reading the file…',
    analysing: 'Checking the file…',
    clear: 'Start over',

    reportTitle: 'What this file would do',
    willImport: 'New questions',
    willUpdate: 'Existing questions updated',
    willReject: 'Rejected',
    willSkip: 'Duplicates skipped',
    totalRows: '{count} rows read',

    commit: 'Import {count} questions',
    committing: 'Importing…',
    committed: 'Imported {inserted} new and updated {updated} questions.',
    nothingToImport: 'There is nothing in this file that can be imported.',

    rejectionsTitle: 'Why rows were rejected',
    rejectionsHint: 'Fix the largest category first — one change to the source usually recovers most of a file.',
    duplicatesTitle: 'Duplicates within the file',
    duplicatesHint: 'The first occurrence is kept. Row {row} repeats row {first}.',
    missingTitle: 'Missing translations',
    missingHint: 'Imported as drafts. Add the translation and re-import the same file to activate them.',
    unknownTopicsTitle: 'Unknown topics',
    unknownTopicsHint: 'Add these in Topic Management first, or correct the spelling in the file.',
    balanceTitle: 'Balance by level',

    row: 'Row {row}',
    downgraded: 'Held as draft',

    // The eight frozen categories.
    'reason.malformed': 'Not shaped like a question',
    'reason.invalid-difficulty': 'Invalid difficulty',
    'reason.invalid-type': 'Invalid question type',
    'reason.invalid-status': 'Invalid status',
    'reason.missing-english': 'Missing English',
    'reason.invalid-option-structure': 'Invalid options',
    'reason.invalid-answer': 'Invalid answer',
    'reason.unknown-topic': 'Unknown topic',
    'reason.invalid-reference': 'Invalid reference',

    failed: 'The import failed and nothing was written.',
    partial: 'The import stopped after {done} of {total} batches. Re-run the same file to finish — questions that already landed will be updated, not duplicated.',
  },
  hi: {
    title: 'प्रश्न आयात करें',
    subtitle: 'तैयार प्रश्न फ़ाइल बैंक में लोड करें। रिपोर्ट देखने तक कुछ भी सहेजा नहीं जाता।',

    chooseFile: 'फ़ाइल चुनें',
    fileHint: 'JSON — प्रश्नों की सूची, "questions" कुंजी वाला ऑब्जेक्ट, या प्रति पंक्ति एक प्रश्न।',
    chooseBrand: 'इस ब्रांड में आयात करें',
    reading: 'फ़ाइल पढ़ी जा रही है…',
    analysing: 'फ़ाइल जाँची जा रही है…',
    clear: 'फिर से शुरू करें',

    reportTitle: 'यह फ़ाइल क्या करेगी',
    willImport: 'नए प्रश्न',
    willUpdate: 'अपडेट होने वाले प्रश्न',
    willReject: 'अस्वीकृत',
    willSkip: 'दोहराव छोड़े गए',
    totalRows: '{count} पंक्तियाँ पढ़ी गईं',

    commit: '{count} प्रश्न आयात करें',
    committing: 'आयात हो रहा है…',
    committed: '{inserted} नए आयात हुए और {updated} अपडेट हुए।',
    nothingToImport: 'इस फ़ाइल में आयात करने योग्य कुछ नहीं है।',

    rejectionsTitle: 'पंक्तियाँ क्यों अस्वीकृत हुईं',
    rejectionsHint: 'सबसे बड़ी श्रेणी पहले ठीक करें — स्रोत में एक बदलाव अक्सर अधिकांश फ़ाइल ठीक कर देता है।',
    duplicatesTitle: 'फ़ाइल के भीतर दोहराव',
    duplicatesHint: 'पहली प्रविष्टि रखी जाती है। पंक्ति {row} पंक्ति {first} को दोहराती है।',
    missingTitle: 'अनुपलब्ध अनुवाद',
    missingHint: 'ड्राफ़्ट के रूप में आयात हुए। अनुवाद जोड़कर वही फ़ाइल दोबारा आयात करें।',
    unknownTopicsTitle: 'अज्ञात विषय',
    unknownTopicsHint: 'पहले टॉपिक प्रबंधन में जोड़ें, या फ़ाइल में वर्तनी ठीक करें।',
    balanceTitle: 'स्तर के अनुसार संतुलन',

    row: 'पंक्ति {row}',
    downgraded: 'ड्राफ़्ट रखा गया',

    'reason.malformed': 'प्रश्न जैसा नहीं है',
    'reason.invalid-difficulty': 'अमान्य कठिनाई',
    'reason.invalid-type': 'अमान्य प्रश्न प्रकार',
    'reason.invalid-status': 'अमान्य स्थिति',
    'reason.missing-english': 'अंग्रेज़ी अनुपलब्ध',
    'reason.invalid-option-structure': 'अमान्य विकल्प',
    'reason.invalid-answer': 'अमान्य उत्तर',
    'reason.unknown-topic': 'अज्ञात विषय',
    'reason.invalid-reference': 'अमान्य संदर्भ',

    failed: 'आयात विफल रहा और कुछ भी सहेजा नहीं गया।',
    partial: '{total} में से {done} बैच के बाद आयात रुक गया। वही फ़ाइल दोबारा चलाएँ — पहले से सहेजे प्रश्न अपडेट होंगे, दोहराए नहीं जाएँगे।',
  },
  gu: {
    title: 'પ્રશ્નો આયાત કરો',
    subtitle: 'તૈયાર પ્રશ્ન ફાઇલ બેંકમાં લોડ કરો. રિપોર્ટ જોયા વિના કંઈ સાચવાતું નથી.',

    chooseFile: 'ફાઇલ પસંદ કરો',
    fileHint: 'JSON — પ્રશ્નોની યાદી, "questions" કી ધરાવતો ઑબ્જેક્ટ, અથવા લાઇન દીઠ એક પ્રશ્ન.',
    chooseBrand: 'આ બ્રાન્ડમાં આયાત કરો',
    reading: 'ફાઇલ વંચાઈ રહી છે…',
    analysing: 'ફાઇલ તપાસાઈ રહી છે…',
    clear: 'ફરી શરૂ કરો',

    reportTitle: 'આ ફાઇલ શું કરશે',
    willImport: 'નવા પ્રશ્નો',
    willUpdate: 'અપડેટ થનારા પ્રશ્નો',
    willReject: 'નકારેલા',
    willSkip: 'ડુપ્લિકેટ છોડ્યા',
    totalRows: '{count} પંક્તિઓ વંચાઈ',

    commit: '{count} પ્રશ્નો આયાત કરો',
    committing: 'આયાત થઈ રહ્યું છે…',
    committed: '{inserted} નવા આયાત થયા અને {updated} અપડેટ થયા.',
    nothingToImport: 'આ ફાઇલમાં આયાત કરવા જેવું કંઈ નથી.',

    rejectionsTitle: 'પંક્તિઓ કેમ નકારાઈ',
    rejectionsHint: 'સૌથી મોટી શ્રેણી પહેલાં સુધારો — સ્રોતમાં એક ફેરફાર સામાન્ય રીતે મોટા ભાગની ફાઇલ સુધારે છે.',
    duplicatesTitle: 'ફાઇલની અંદર ડુપ્લિકેટ',
    duplicatesHint: 'પહેલી નોંધ રખાય છે. પંક્તિ {row} પંક્તિ {first} નું પુનરાવર્તન છે.',
    missingTitle: 'ગુમ અનુવાદ',
    missingHint: 'ડ્રાફ્ટ તરીકે આયાત થયા. અનુવાદ ઉમેરી એ જ ફાઇલ ફરી આયાત કરો.',
    unknownTopicsTitle: 'અજાણ્યા વિષયો',
    unknownTopicsHint: 'પહેલાં ટોપિક સંચાલનમાં ઉમેરો, અથવા ફાઇલમાં જોડણી સુધારો.',
    balanceTitle: 'સ્તર પ્રમાણે સંતુલન',

    row: 'પંક્તિ {row}',
    downgraded: 'ડ્રાફ્ટ રખાયો',

    'reason.malformed': 'પ્રશ્ન જેવું નથી',
    'reason.invalid-difficulty': 'અમાન્ય મુશ્કેલી',
    'reason.invalid-type': 'અમાન્ય પ્રશ્ન પ્રકાર',
    'reason.invalid-status': 'અમાન્ય સ્થિતિ',
    'reason.missing-english': 'અંગ્રેજી ગુમ',
    'reason.invalid-option-structure': 'અમાન્ય વિકલ્પો',
    'reason.invalid-answer': 'અમાન્ય જવાબ',
    'reason.unknown-topic': 'અજાણ્યો વિષય',
    'reason.invalid-reference': 'અમાન્ય સંદર્ભ',

    failed: 'આયાત નિષ્ફળ ગયું અને કંઈ સાચવાયું નથી.',
    partial: '{total} માંથી {done} બેચ પછી આયાત અટક્યું. એ જ ફાઇલ ફરી ચલાવો — પહેલેથી સચવાયેલા પ્રશ્નો અપડેટ થશે, ડુપ્લિકેટ નહીં.',
  },
}

/** The nav entry for the screen. */
const NAV = {
  en: { import: 'Import' },
  hi: { import: 'आयात' },
  gu: { import: 'આયાત' },
}

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve(MESSAGES, `${locale}.json`)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))

  bundle.import = { ...bundle.import, ...IMPORT[locale] }
  bundle.nav = { ...bundle.nav, ...NAV[locale] }

  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  console.log(`  ${locale}.json — import (${Object.keys(IMPORT[locale]).length} keys) and nav.import`)
}

for (const group of [IMPORT, NAV]) {
  const en = Object.keys(group.en).sort()
  for (const locale of ['hi', 'gu']) {
    const other = Object.keys(group[locale]).sort()
    if (JSON.stringify(en) !== JSON.stringify(other)) {
      const missing = en.filter((k) => !other.includes(k))
      const extra = other.filter((k) => !en.includes(k))
      console.error(`\n  ${locale} does not match en. missing: ${missing}  extra: ${extra}`)
      process.exit(1)
    }
  }
}
console.log('\n  All three locales carry identical keys.')
