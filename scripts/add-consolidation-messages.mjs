/**
 * Messages for the consolidated navigation, the exam lifecycle control and the
 * audience step in the publish form.
 *
 * `nav.papers` is a new label for a section that did not exist: Generate and
 * Exam History are one sidebar item now, with tabs. `nav.questions` already
 * existed as an unused duplicate of `nav.bank` and is reused as the tab label,
 * so the section and its first tab can differ ("Question Bank" / "Questions").
 *
 *   node scripts/add-consolidation-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NAV = {
  en: { papers: 'Papers' },
  hi: { papers: 'पेपर' },
  gu: { papers: 'પેપર' },
}

const EXAMS = {
  en: {
    lifecycleCloseNow: 'Close now',
    lifecycleCancel: 'Cancel exam',
    lifecycleConfirm: 'Cancel this exam?',
    lifecycleConfirmYes: 'Yes, cancel it',
    lifecycleConfirmNo: 'Keep it',
    lifecycleClosed: 'The exam is closed.',
    lifecycleCancelled: 'The exam has been cancelled.',
    lifecycleFailed: 'That could not be changed.',
    lifecycleHint:
      'Anyone already part-way through keeps the time they were given — closing or cancelling does not cut them off mid-question.',
  },
  hi: {
    lifecycleCloseNow: 'अभी बंद करें',
    lifecycleCancel: 'परीक्षा रद्द करें',
    lifecycleConfirm: 'क्या यह परीक्षा रद्द करनी है?',
    lifecycleConfirmYes: 'हाँ, रद्द करें',
    lifecycleConfirmNo: 'रहने दें',
    lifecycleClosed: 'परीक्षा बंद हो गई।',
    lifecycleCancelled: 'परीक्षा रद्द कर दी गई।',
    lifecycleFailed: 'यह बदला नहीं जा सका।',
    lifecycleHint:
      'जो पहले से परीक्षा दे रहे हैं उन्हें उनका पूरा समय मिलेगा — बंद या रद्द करने से वे बीच में नहीं रुकेंगे।',
  },
  gu: {
    lifecycleCloseNow: 'હમણાં બંધ કરો',
    lifecycleCancel: 'પરીક્ષા રદ કરો',
    lifecycleConfirm: 'શું આ પરીક્ષા રદ કરવી છે?',
    lifecycleConfirmYes: 'હા, રદ કરો',
    lifecycleConfirmNo: 'રહેવા દો',
    lifecycleClosed: 'પરીક્ષા બંધ થઈ ગઈ.',
    lifecycleCancelled: 'પરીક્ષા રદ કરવામાં આવી.',
    lifecycleFailed: 'આ બદલી શકાયું નહીં.',
    lifecycleHint:
      'જે લોકો પહેલેથી પરીક્ષા આપી રહ્યા છે તેમને પૂરો સમય મળશે — બંધ કે રદ કરવાથી તેઓ વચ્ચે અટકશે નહીં.',
  },
}

const PAPERS = {
  en: {
    publishAudience: 'Who sits it',
    publishedButNotAssigned: 'Published, but the staff list did not save. Choose them below.',
    cardStartsLabel: 'Opens',
    cardDeadlineLabel: 'Closes',
    generateViewPaper: 'Open the paper',
    generatePublishNow: 'Publish it',
  },
  hi: {
    publishAudience: 'कौन देगा',
    publishedButNotAssigned: 'प्रकाशित हो गई, पर स्टाफ़ की सूची सेव नहीं हुई। नीचे चुनें।',
    cardStartsLabel: 'खुलती है',
    cardDeadlineLabel: 'बंद होती है',
    generateViewPaper: 'पेपर खोलें',
    generatePublishNow: 'प्रकाशित करें',
  },
  gu: {
    publishAudience: 'કોણ આપશે',
    publishedButNotAssigned: 'પ્રકાશિત થઈ, પણ સ્ટાફની યાદી સેવ થઈ નથી. નીચે પસંદ કરો.',
    cardStartsLabel: 'ખૂલે છે',
    cardDeadlineLabel: 'બંધ થાય છે',
    generateViewPaper: 'પેપર ખોલો',
    generatePublishNow: 'પ્રકાશિત કરો',
  },
}

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))

  let added = 0
  for (const [ns, table] of [['nav', NAV], ['exams', EXAMS], ['papers', PAPERS]]) {
    json[ns] ??= {}
    for (const [key, value] of Object.entries(table[locale])) {
      if (json[ns][key] === undefined) added++
      json[ns][key] = value
    }
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  const total =
    Object.keys(NAV[locale]).length +
    Object.keys(EXAMS[locale]).length +
    Object.keys(PAPERS[locale]).length
  console.log(`  ${locale}: ${added} added, ${total - added} already present`)
}
