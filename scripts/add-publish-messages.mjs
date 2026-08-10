/**
 * Adds the `papers.publish*` keys to all three locale files.
 *
 * Written as a script rather than three hand edits because the three files must
 * gain exactly the same key set — a locale missing one key throws at render in
 * next-intl, and the message-keys test asserts parity. Adding them in one pass
 * from one table makes that structural rather than careful.
 *
 * Flat keys, not `publish.title`: next-intl rejects a dot inside a key, which
 * this project learned the hard way when `reason.malformed` threw INVALID_KEY
 * on every page that touched it.
 *
 *   node scripts/add-publish-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = {
  en: {
    publishTitle: 'Sit this paper online',
    publishSubtitle:
      'Publish this paper as an online exam. The questions and their order stay exactly as printed.',
    publishDefaultTitle: 'Paper {no}',
    publishTitleLabel: 'Exam name',
    publishDuration: 'Time allowed (minutes)',
    publishPassMark: 'Pass mark (%)',
    publishAttempts: 'Attempts allowed',
    publishOpens: 'Opens (optional)',
    publishCloses: 'Closes (optional)',
    publish: 'Publish online',
    publishing: 'Publishing…',
    publishHint:
      "Nobody can see this exam until you choose who sits it. You'll do that on the next screen.",
    publishDone: 'Paper {no} is published. Now choose who sits it.',
    publishRetired: 'This paper has been retired and cannot be published.',
    publishNotPermitted: 'Publishing an exam is done by a chef.',
    publishNeedsTitle: 'Give the exam a name.',
    publishedAs: 'Published',
    publishedNobodyTitle: 'Nobody has been chosen to sit this yet',
    publishedNobodyBody:
      'The exam is published but no staff are assigned to it, so it does not appear for anyone. Choose who sits it to finish.',
    publishedAssigned: 'Assigned to {count, plural, one {# group} other {# groups}} of staff.',
    publishedChooseWho: 'Choose who sits it',
    publishedOpenExam: 'Open the exam',
  },
  hi: {
    publishTitle: 'यह पेपर ऑनलाइन कराएँ',
    publishSubtitle:
      'इस पेपर को ऑनलाइन परीक्षा के रूप में प्रकाशित करें। प्रश्न और उनका क्रम छपे हुए जैसा ही रहेगा।',
    publishDefaultTitle: 'पेपर {no}',
    publishTitleLabel: 'परीक्षा का नाम',
    publishDuration: 'समय (मिनट)',
    publishPassMark: 'उत्तीर्ण अंक (%)',
    publishAttempts: 'कितनी बार दे सकते हैं',
    publishOpens: 'कब खुलेगा (वैकल्पिक)',
    publishCloses: 'कब बंद होगा (वैकल्पिक)',
    publish: 'ऑनलाइन प्रकाशित करें',
    publishing: 'प्रकाशित हो रहा है…',
    publishHint:
      'जब तक आप यह नहीं चुनते कि परीक्षा कौन देगा, तब तक इसे कोई नहीं देख सकता। यह अगली स्क्रीन पर करें।',
    publishDone: 'पेपर {no} प्रकाशित हो गया। अब चुनें कि इसे कौन देगा।',
    publishRetired: 'यह पेपर सेवानिवृत्त हो चुका है और प्रकाशित नहीं किया जा सकता।',
    publishNotPermitted: 'परीक्षा प्रकाशित करने का काम शेफ करते हैं।',
    publishNeedsTitle: 'परीक्षा को एक नाम दें।',
    publishedAs: 'प्रकाशित',
    publishedNobodyTitle: 'अभी तक कोई नहीं चुना गया है',
    publishedNobodyBody:
      'परीक्षा प्रकाशित हो चुकी है, लेकिन इसमें कोई कर्मचारी नहीं जोड़ा गया है, इसलिए यह किसी को नहीं दिखती। पूरा करने के लिए चुनें कि इसे कौन देगा।',
    publishedAssigned: 'स्टाफ़ के {count, plural, one {# समूह} other {# समूहों}} को दी गई है।',
    publishedChooseWho: 'चुनें कि कौन देगा',
    publishedOpenExam: 'परीक्षा खोलें',
  },
  gu: {
    publishTitle: 'આ પેપર ઓનલાઈન લો',
    publishSubtitle:
      'આ પેપરને ઓનલાઈન પરીક્ષા તરીકે પ્રકાશિત કરો. પ્રશ્નો અને તેમનો ક્રમ છપાયેલા જેવો જ રહેશે.',
    publishDefaultTitle: 'પેપર {no}',
    publishTitleLabel: 'પરીક્ષાનું નામ',
    publishDuration: 'સમય (મિનિટ)',
    publishPassMark: 'પાસ ગુણ (%)',
    publishAttempts: 'કેટલી વાર આપી શકાય',
    publishOpens: 'ક્યારે ખૂલશે (વૈકલ્પિક)',
    publishCloses: 'ક્યારે બંધ થશે (વૈકલ્પિક)',
    publish: 'ઓનલાઈન પ્રકાશિત કરો',
    publishing: 'પ્રકાશિત થઈ રહ્યું છે…',
    publishHint:
      'તમે કોણ પરીક્ષા આપશે તે પસંદ ન કરો ત્યાં સુધી કોઈ આ પરીક્ષા જોઈ શકશે નહીં. તે આગલી સ્ક્રીન પર કરો.',
    publishDone: 'પેપર {no} પ્રકાશિત થયું. હવે પસંદ કરો કે તે કોણ આપશે.',
    publishRetired: 'આ પેપર નિવૃત્ત થઈ ગયું છે અને પ્રકાશિત કરી શકાતું નથી.',
    publishNotPermitted: 'પરીક્ષા પ્રકાશિત કરવાનું કામ શેફ કરે છે.',
    publishNeedsTitle: 'પરીક્ષાને નામ આપો.',
    publishedAs: 'પ્રકાશિત',
    publishedNobodyTitle: 'હજી સુધી કોઈને પસંદ કરવામાં આવ્યું નથી',
    publishedNobodyBody:
      'પરીક્ષા પ્રકાશિત થઈ ગઈ છે, પણ તેમાં કોઈ સ્ટાફ ઉમેર્યો નથી, તેથી તે કોઈને દેખાતી નથી. પૂર્ણ કરવા માટે પસંદ કરો કે તે કોણ આપશે.',
    publishedAssigned: 'સ્ટાફના {count, plural, one {# જૂથ} other {# જૂથો}}ને આપવામાં આવી છે.',
    publishedChooseWho: 'કોણ આપશે તે પસંદ કરો',
    publishedOpenExam: 'પરીક્ષા ખોલો',
  },
}

/**
 * The exam-detail screen's replacement for the section builder, shown when the
 * exam delivers a generated paper and there is nothing on screen to edit.
 */
const EXAM_MESSAGES = {
  en: {
    fromPaperTitle: 'Questions come from a generated paper',
    fromPaperBody:
      'This exam delivers a paper drawn from the Question Bank. Its questions and their order were fixed when the paper was generated and cannot be changed here.',
    fromPaperLink: 'View the paper',
  },
  hi: {
    fromPaperTitle: 'प्रश्न एक तैयार पेपर से आते हैं',
    fromPaperBody:
      'यह परीक्षा प्रश्न बैंक से बने पेपर पर आधारित है। पेपर बनते समय ही प्रश्न और उनका क्रम तय हो गया था, और यहाँ बदला नहीं जा सकता।',
    fromPaperLink: 'पेपर देखें',
  },
  gu: {
    fromPaperTitle: 'પ્રશ્નો તૈયાર થયેલા પેપરમાંથી આવે છે',
    fromPaperBody:
      'આ પરીક્ષા પ્રશ્ન બેંકમાંથી બનેલા પેપર પર આધારિત છે. પેપર બન્યું ત્યારે જ પ્રશ્નો અને તેમનો ક્રમ નક્કી થઈ ગયો હતો, અને અહીં બદલી શકાતો નથી.',
    fromPaperLink: 'પેપર જુઓ',
  },
}

for (const [locale, keys] of Object.entries(MESSAGES)) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))

  json.papers ??= {}
  let added = 0
  for (const [key, value] of Object.entries(keys)) {
    if (json.papers[key] === undefined) added++
    json.papers[key] = value
  }

  json.exams ??= {}
  for (const [key, value] of Object.entries(EXAM_MESSAGES[locale])) {
    if (json.exams[key] === undefined) added++
    json.exams[key] = value
  }

  // utf8 with no BOM, trailing newline — matching what is already on disk.
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  const total = Object.keys(keys).length + Object.keys(EXAM_MESSAGES[locale]).length
  console.log(`  ${locale}: ${added} added, ${total - added} already present`)
}
