/**
 * Add the `bank` namespace to every message bundle, in one pass.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A SCRIPT RATHER THAN THREE HAND EDITS, AND THE REASON IS RECORDED IN THIS │
 * │ REPOSITORY'S OWN HISTORY.                                                 │
 * │                                                                           │
 * │ tests/unit/messages.test.ts fails on an ORPHAN KEY — one that exists in a │
 * │ locale file but not in English — because the deep-merge fallback makes    │
 * │ that failure otherwise invisible: the string silently never renders and   │
 * │ quietly reverts to English with nothing to say so. Editing three JSON     │
 * │ files by hand is exactly how a key ends up spelled differently in one.    │
 * │                                                                           │
 * │ It also pins PLACEHOLDER parity: a translation that renames {count} to    │
 * │ {ginti} renders literal braces at a person, or throws. Writing all three  │
 * │ from one source with the same placeholders makes that impossible here.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Idempotent: re-running overwrites the `bank` namespace and leaves the rest
 * of each bundle untouched, including key order.
 *
 *   node scripts/add-bank-messages.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = resolve('messages')

/**
 * English is the source. Hindi and Gujarati are written beside it rather than
 * left to fall back, because this is the screen an Editor lives in while
 * entering 3,000 questions — the one place where working in your own language
 * is worth more than anywhere else in the product.
 *
 * Kitchen vocabulary, not textbook vocabulary. A cook says "option", not
 * "vikalp"; the Hindi below keeps the English nouns a kitchen already uses.
 */
const BANK = {
  en: {
    title: 'Question Bank',
    subtitle: 'Every question an exam can draw from.',

    // ── List ──────────────────────────────────────────────────────────────
    search: 'Search questions',
    searchPlaceholder: 'Search the question, options or answer…',
    create: 'New question',
    import: 'Import',
    export: 'Export',
    manageTopics: 'Topics',

    empty: 'No questions yet.',
    emptyHint: 'Add the first one, or import a spreadsheet.',
    emptyFiltered: 'No questions match these filters.',
    emptyFilteredHint: 'Try widening the search, or clear the filters.',
    clearFilters: 'Clear filters',

    emptyDeleted: 'Nothing has been deleted.',
    emptyDeletedHint: 'Deleted questions are kept here so papers that use them still work.',

    // ── Columns ───────────────────────────────────────────────────────────
    colQuestion: 'Question',
    colType: 'Type',
    colDifficulty: 'Difficulty',
    colTopic: 'Topic',
    colStatus: 'Status',
    colLanguages: 'Languages',
    colReference: 'Reference',
    colPage: 'Page',
    colBrand: 'Brand',
    colCreatedBy: 'Created by',
    colUpdated: 'Updated',
    colActions: 'Actions',
    colUuid: 'UUID',

    // ── Vocabulary ────────────────────────────────────────────────────────
    type: {
      mcq: 'MCQ',
      short_answer: 'Short answer',
    },
    difficulty: {
      easy: 'Easy',
      medium: 'Medium',
      hard: 'Hard',
    },
    status: {
      draft: 'Draft',
      active: 'Active',
      archived: 'Archived',
    },
    locale: {
      en: 'English',
      hi: 'Hindi',
      gu: 'Gujarati',
    },

    // ── Filters ───────────────────────────────────────────────────────────
    filterAllDifficulties: 'All difficulties',
    filterAllTypes: 'All types',
    filterAllStatuses: 'All statuses',
    filterAllTopics: 'All topics',
    filterAllBrands: 'All brands',
    showDeleted: 'Recycle bin',
    showActive: 'Back to the bank',

    // ── Language completeness ─────────────────────────────────────────────
    complete: 'All three languages',
    incomplete: '{done} of 3 languages',
    missingLanguages: 'Missing: {languages}',

    // ── Editor form ───────────────────────────────────────────────────────
    newTitle: 'New question',
    editTitle: 'Edit question',
    formType: 'Question type',
    formDifficulty: 'Difficulty',
    formBrand: 'Brand',
    formTopic: 'Topic',
    formTopicNone: 'No topic',
    formReference: 'Reference document',
    formReferenceNone: 'No reference',
    formPage: 'Page number',
    formStatus: 'Status',

    formQuestion: 'Question',
    formOptionA: 'Option A',
    formOptionB: 'Option B',
    formOptionC: 'Option C',
    formOptionD: 'Option D',
    formAnswer: 'Answer',
    formCorrect: 'Correct answer',
    formCorrectHint: 'The correct answer is a position, so it is the same in every language.',
    formAnswerHint: 'About two lines. {max} characters at most.',

    // The difficulty field carries NO guidance text. What Easy, Medium and
    // Hard mean is defined in a separate document that is the single source of
    // truth, and inventing a hint here would compete with it.
    save: 'Save',
    saveAndNew: 'Save and add another',
    publish: 'Publish',
    saveDraft: 'Save draft',
    cancel: 'Cancel',
    preview: 'Preview',
    duplicate: 'Duplicate',
    archive: 'Archive',
    restore: 'Restore',
    delete: 'Delete',
    unarchive: 'Move to draft',

    // ── Feedback ──────────────────────────────────────────────────────────
    saved: 'Question saved.',
    savedAndNew: 'Saved. Write the next one.',
    published: 'Question published. It can now appear on papers.',
    archived: 'Question archived. It will not appear on new papers.',
    restored: 'Question restored.',
    deleted: 'Question deleted. Papers that already use it are unaffected.',
    duplicated: 'Copied. Edit the copy and save it.',

    cannotPublish: 'Write all three languages before publishing.',
    duplicateQuestion: 'That question is already in this bank, at this level.',
    duplicateHint: 'If you cannot find it, look in the recycle bin.',

    // ── Metadata panel ────────────────────────────────────────────────────
    metaCreated: 'Created',
    metaUpdated: 'Updated',
    metaCreatedBy: 'Created by',
    metaUuid: 'Question UUID',
    metaUuidHint: 'Internal identifier. Visible to Editors only.',
    metaCopied: 'Copied',

    // ── Bulk ──────────────────────────────────────────────────────────────
    selected: '{count} selected',
    selectAll: 'Select all',
    clearSelection: 'Clear',
    bulkArchive: 'Archive',
    bulkDelete: 'Delete',
    bulkExport: 'Export selected',
    bulkDone: '{affected} of {requested} updated.',
    bulkNone: 'Nothing was changed.',

    // ── Topics ────────────────────────────────────────────────────────────
    topicsTitle: 'Topics',
    topicsSubtitle: 'Labels for filing questions. Changing them never affects a generated paper.',
    topicName: 'Topic name',
    topicAdd: 'Add topic',
    topicInUse: '{count} questions',
    topicUnused: 'Not used yet',
    topicSaved: 'Topic saved.',
    topicRemoved: 'Topic removed. Questions filed under it keep it.',

    pagination: 'Page {page} of {lastPage} · {total} questions',
    previous: 'Previous',
    next: 'Next',
  },

  hi: {
    title: 'प्रश्न बैंक',
    subtitle: 'हर प्रश्न जिससे पेपर बन सकता है।',

    search: 'प्रश्न खोजें',
    searchPlaceholder: 'प्रश्न, ऑप्शन या उत्तर खोजें…',
    create: 'नया प्रश्न',
    import: 'इम्पोर्ट',
    export: 'एक्सपोर्ट',
    manageTopics: 'टॉपिक',

    empty: 'अभी कोई प्रश्न नहीं है।',
    emptyHint: 'पहला प्रश्न जोड़ें, या स्प्रेडशीट इम्पोर्ट करें।',
    emptyFiltered: 'इन फ़िल्टर से कोई प्रश्न नहीं मिला।',
    emptyFilteredHint: 'खोज को थोड़ा बड़ा करें, या फ़िल्टर हटा दें।',
    clearFilters: 'फ़िल्टर हटाएँ',

    emptyDeleted: 'कुछ भी डिलीट नहीं किया गया।',
    emptyDeletedHint: 'डिलीट किए प्रश्न यहाँ रहते हैं ताकि पुराने पेपर काम करते रहें।',

    colQuestion: 'प्रश्न',
    colType: 'प्रकार',
    colDifficulty: 'कठिनाई',
    colTopic: 'टॉपिक',
    colStatus: 'स्थिति',
    colLanguages: 'भाषाएँ',
    colReference: 'संदर्भ',
    colPage: 'पेज',
    colBrand: 'ब्रांड',
    colCreatedBy: 'बनाया',
    colUpdated: 'अपडेट',
    colActions: 'कार्रवाई',
    colUuid: 'UUID',

    type: {
      mcq: 'MCQ',
      short_answer: 'छोटा उत्तर',
    },
    difficulty: {
      easy: 'आसान',
      medium: 'मध्यम',
      hard: 'कठिन',
    },
    status: {
      draft: 'ड्राफ़्ट',
      active: 'एक्टिव',
      archived: 'आर्काइव',
    },
    locale: {
      en: 'अंग्रेज़ी',
      hi: 'हिन्दी',
      gu: 'गुजराती',
    },

    filterAllDifficulties: 'सभी कठिनाई',
    filterAllTypes: 'सभी प्रकार',
    filterAllStatuses: 'सभी स्थिति',
    filterAllTopics: 'सभी टॉपिक',
    filterAllBrands: 'सभी ब्रांड',
    showDeleted: 'रीसायकल बिन',
    showActive: 'बैंक पर वापस',

    complete: 'तीनों भाषाएँ',
    incomplete: '3 में से {done} भाषाएँ',
    missingLanguages: 'बाकी: {languages}',

    newTitle: 'नया प्रश्न',
    editTitle: 'प्रश्न एडिट करें',
    formType: 'प्रश्न का प्रकार',
    formDifficulty: 'कठिनाई',
    formBrand: 'ब्रांड',
    formTopic: 'टॉपिक',
    formTopicNone: 'कोई टॉपिक नहीं',
    formReference: 'संदर्भ दस्तावेज़',
    formReferenceNone: 'कोई संदर्भ नहीं',
    formPage: 'पेज नंबर',
    formStatus: 'स्थिति',

    formQuestion: 'प्रश्न',
    formOptionA: 'ऑप्शन A',
    formOptionB: 'ऑप्शन B',
    formOptionC: 'ऑप्शन C',
    formOptionD: 'ऑप्शन D',
    formAnswer: 'उत्तर',
    formCorrect: 'सही उत्तर',
    formCorrectHint: 'सही उत्तर एक पोज़िशन है, इसलिए हर भाषा में वही रहता है।',
    formAnswerHint: 'लगभग दो लाइन। ज़्यादा से ज़्यादा {max} अक्षर।',

    save: 'सेव',
    saveAndNew: 'सेव करके अगला',
    publish: 'पब्लिश',
    saveDraft: 'ड्राफ़्ट सेव',
    cancel: 'रद्द',
    preview: 'प्रीव्यू',
    duplicate: 'कॉपी',
    archive: 'आर्काइव',
    restore: 'वापस लाएँ',
    delete: 'डिलीट',
    unarchive: 'ड्राफ़्ट में ले जाएँ',

    saved: 'प्रश्न सेव हो गया।',
    savedAndNew: 'सेव हो गया। अगला लिखें।',
    published: 'प्रश्न पब्लिश हो गया। अब यह पेपर में आ सकता है।',
    archived: 'प्रश्न आर्काइव हो गया। नए पेपर में नहीं आएगा।',
    restored: 'प्रश्न वापस आ गया।',
    deleted: 'प्रश्न डिलीट हो गया। पुराने पेपर पर कोई असर नहीं।',
    duplicated: 'कॉपी बन गई। एडिट करके सेव करें।',

    cannotPublish: 'पब्लिश करने से पहले तीनों भाषाएँ लिखें।',
    duplicateQuestion: 'यह प्रश्न इस लेवल पर पहले से मौजूद है।',
    duplicateHint: 'अगर नहीं मिल रहा, तो रीसायकल बिन देखें।',

    metaCreated: 'बनाया',
    metaUpdated: 'अपडेट',
    metaCreatedBy: 'बनाने वाले',
    metaUuid: 'प्रश्न UUID',
    metaUuidHint: 'आंतरिक पहचान। सिर्फ़ Editor देख सकते हैं।',
    metaCopied: 'कॉपी हो गया',

    selected: '{count} चुने गए',
    selectAll: 'सभी चुनें',
    clearSelection: 'हटाएँ',
    bulkArchive: 'आर्काइव',
    bulkDelete: 'डिलीट',
    bulkExport: 'चुने हुए एक्सपोर्ट',
    bulkDone: '{requested} में से {affected} अपडेट हुए।',
    bulkNone: 'कुछ नहीं बदला।',

    topicsTitle: 'टॉपिक',
    topicsSubtitle: 'प्रश्न फ़ाइल करने के लेबल। इन्हें बदलने से पेपर पर कोई असर नहीं पड़ता।',
    topicName: 'टॉपिक का नाम',
    topicAdd: 'टॉपिक जोड़ें',
    topicInUse: '{count} प्रश्न',
    topicUnused: 'अभी इस्तेमाल नहीं',
    topicSaved: 'टॉपिक सेव हो गया।',
    topicRemoved: 'टॉपिक हटा दिया। पुराने प्रश्नों पर बना रहेगा।',

    pagination: 'पेज {page} / {lastPage} · {total} प्रश्न',
    previous: 'पिछला',
    next: 'अगला',
  },

  gu: {
    title: 'પ્રશ્ન બેંક',
    subtitle: 'દરેક પ્રશ્ન જેમાંથી પેપર બની શકે.',

    search: 'પ્રશ્ન શોધો',
    searchPlaceholder: 'પ્રશ્ન, ઓપ્શન કે જવાબ શોધો…',
    create: 'નવો પ્રશ્ન',
    import: 'ઇમ્પોર્ટ',
    export: 'એક્સપોર્ટ',
    manageTopics: 'ટોપિક',

    empty: 'હજી કોઈ પ્રશ્ન નથી.',
    emptyHint: 'પહેલો પ્રશ્ન ઉમેરો, અથવા સ્પ્રેડશીટ ઇમ્પોર્ટ કરો.',
    emptyFiltered: 'આ ફિલ્ટરથી કોઈ પ્રશ્ન મળ્યો નથી.',
    emptyFilteredHint: 'શોધ થોડી પહોળી કરો, અથવા ફિલ્ટર કાઢી નાખો.',
    clearFilters: 'ફિલ્ટર કાઢો',

    emptyDeleted: 'કંઈ ડિલીટ થયું નથી.',
    emptyDeletedHint: 'ડિલીટ કરેલા પ્રશ્નો અહીં રહે છે જેથી જૂના પેપર ચાલતા રહે.',

    colQuestion: 'પ્રશ્ન',
    colType: 'પ્રકાર',
    colDifficulty: 'મુશ્કેલી',
    colTopic: 'ટોપિક',
    colStatus: 'સ્થિતિ',
    colLanguages: 'ભાષાઓ',
    colReference: 'સંદર્ભ',
    colPage: 'પેજ',
    colBrand: 'બ્રાન્ડ',
    colCreatedBy: 'બનાવ્યું',
    colUpdated: 'અપડેટ',
    colActions: 'ક્રિયા',
    colUuid: 'UUID',

    type: {
      mcq: 'MCQ',
      short_answer: 'ટૂંકો જવાબ',
    },
    difficulty: {
      easy: 'સહેલું',
      medium: 'મધ્યમ',
      hard: 'અઘરું',
    },
    status: {
      draft: 'ડ્રાફ્ટ',
      active: 'એક્ટિવ',
      archived: 'આર્કાઇવ',
    },
    locale: {
      en: 'અંગ્રેજી',
      hi: 'હિન્દી',
      gu: 'ગુજરાતી',
    },

    filterAllDifficulties: 'બધી મુશ્કેલી',
    filterAllTypes: 'બધા પ્રકાર',
    filterAllStatuses: 'બધી સ્થિતિ',
    filterAllTopics: 'બધા ટોપિક',
    filterAllBrands: 'બધી બ્રાન્ડ',
    showDeleted: 'રિસાયકલ બિન',
    showActive: 'બેંક પર પાછા',

    complete: 'ત્રણેય ભાષા',
    incomplete: '3 માંથી {done} ભાષા',
    missingLanguages: 'બાકી: {languages}',

    newTitle: 'નવો પ્રશ્ન',
    editTitle: 'પ્રશ્ન એડિટ કરો',
    formType: 'પ્રશ્નનો પ્રકાર',
    formDifficulty: 'મુશ્કેલી',
    formBrand: 'બ્રાન્ડ',
    formTopic: 'ટોપિક',
    formTopicNone: 'કોઈ ટોપિક નહીં',
    formReference: 'સંદર્ભ દસ્તાવેજ',
    formReferenceNone: 'કોઈ સંદર્ભ નહીં',
    formPage: 'પેજ નંબર',
    formStatus: 'સ્થિતિ',

    formQuestion: 'પ્રશ્ન',
    formOptionA: 'ઓપ્શન A',
    formOptionB: 'ઓપ્શન B',
    formOptionC: 'ઓપ્શન C',
    formOptionD: 'ઓપ્શન D',
    formAnswer: 'જવાબ',
    formCorrect: 'સાચો જવાબ',
    formCorrectHint: 'સાચો જવાબ એક પોઝિશન છે, એટલે દરેક ભાષામાં એ જ રહે છે.',
    formAnswerHint: 'આશરે બે લીટી. વધુમાં વધુ {max} અક્ષર.',

    save: 'સેવ',
    saveAndNew: 'સેવ કરીને આગળનો',
    publish: 'પબ્લિશ',
    saveDraft: 'ડ્રાફ્ટ સેવ',
    cancel: 'રદ',
    preview: 'પ્રીવ્યૂ',
    duplicate: 'કોપી',
    archive: 'આર્કાઇવ',
    restore: 'પાછું લાવો',
    delete: 'ડિલીટ',
    unarchive: 'ડ્રાફ્ટમાં લઈ જાઓ',

    saved: 'પ્રશ્ન સેવ થયો.',
    savedAndNew: 'સેવ થયો. આગળનો લખો.',
    published: 'પ્રશ્ન પબ્લિશ થયો. હવે એ પેપરમાં આવી શકે.',
    archived: 'પ્રશ્ન આર્કાઇવ થયો. નવા પેપરમાં નહીં આવે.',
    restored: 'પ્રશ્ન પાછો આવ્યો.',
    deleted: 'પ્રશ્ન ડિલીટ થયો. જૂના પેપર પર કોઈ અસર નથી.',
    duplicated: 'કોપી બની. એડિટ કરીને સેવ કરો.',

    cannotPublish: 'પબ્લિશ કરતાં પહેલાં ત્રણેય ભાષા લખો.',
    duplicateQuestion: 'આ પ્રશ્ન આ લેવલ પર પહેલેથી છે.',
    duplicateHint: 'ન મળે તો રિસાયકલ બિન જુઓ.',

    metaCreated: 'બનાવ્યું',
    metaUpdated: 'અપડેટ',
    metaCreatedBy: 'બનાવનાર',
    metaUuid: 'પ્રશ્ન UUID',
    metaUuidHint: 'આંતરિક ઓળખ. ફક્ત Editor જોઈ શકે.',
    metaCopied: 'કોપી થયું',

    selected: '{count} પસંદ થયા',
    selectAll: 'બધા પસંદ કરો',
    clearSelection: 'કાઢો',
    bulkArchive: 'આર્કાઇવ',
    bulkDelete: 'ડિલીટ',
    bulkExport: 'પસંદ કરેલા એક્સપોર્ટ',
    bulkDone: '{requested} માંથી {affected} અપડેટ થયા.',
    bulkNone: 'કંઈ બદલાયું નથી.',

    topicsTitle: 'ટોપિક',
    topicsSubtitle: 'પ્રશ્ન ફાઇલ કરવાના લેબલ. એ બદલવાથી પેપર પર અસર થતી નથી.',
    topicName: 'ટોપિકનું નામ',
    topicAdd: 'ટોપિક ઉમેરો',
    topicInUse: '{count} પ્રશ્ન',
    topicUnused: 'હજી વપરાયું નથી',
    topicSaved: 'ટોપિક સેવ થયું.',
    topicRemoved: 'ટોપિક કાઢ્યું. જૂના પ્રશ્નો પર રહેશે.',

    pagination: 'પેજ {page} / {lastPage} · {total} પ્રશ્ન',
    previous: 'પાછળ',
    next: 'આગળ',
  },
}

const NAV = { en: 'Question Bank', hi: 'प्रश्न बैंक', gu: 'પ્રશ્ન બેંક' }

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve(MESSAGES, `${locale}.json`)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))

  bundle.bank = BANK[locale]
  bundle.nav = { ...bundle.nav, bank: NAV[locale] }

  // Two-space indent and a trailing newline, matching what is already there.
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  console.log(`  ${locale}.json — bank namespace written`)
}

/**
 * Structural parity check, run here as well as in the test suite.
 *
 * The unit test compares every locale against English and fails on an orphan
 * key. Checking it at write time too means a mistake in the table above is
 * reported by the thing that made it, rather than several minutes later by a
 * test whose message points at a JSON file nobody edited by hand.
 */
function paths(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? paths(v, prefix ? `${prefix}.${k}` : k)
      : [prefix ? `${prefix}.${k}` : k],
  )
}

const enPaths = paths(BANK.en).sort()
for (const locale of ['hi', 'gu']) {
  const localePaths = paths(BANK[locale]).sort()
  const missing = enPaths.filter((p) => !localePaths.includes(p))
  const extra = localePaths.filter((p) => !enPaths.includes(p))
  if (missing.length || extra.length) {
    console.error(`\n  ${locale}: missing ${missing.join(', ') || 'none'}`)
    console.error(`  ${locale}: extra   ${extra.join(', ') || 'none'}`)
    process.exit(1)
  }
}
console.log(`\n  ${enPaths.length} keys, identical in all three locales.`)
