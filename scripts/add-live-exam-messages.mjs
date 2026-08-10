/**
 * Messages for the Live / Upcoming / Closed exam sections, the monitoring
 * panel, the dashboard live card, and the publish form's new fields.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE VOCABULARY IS LOAD-BEARING, SO IT IS SET IN ONE PLACE.                │
 * │                                                                           │
 * │ PAPER   — a generated question set. Lives under `papers`.                 │
 * │ EXAM    — a published, scheduled assessment. Lives under `exams`.         │
 * │ LIVE    — an exam candidates can sit right now.                           │
 * │                                                                           │
 * │ "Live" means something different on a paper (the one being printed) and   │
 * │ on an exam (open to candidates). Keeping the two namespaces separate is   │
 * │ what stops a translator collapsing them into one word.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Flat keys: next-intl rejects a dot inside a key.
 *
 *   node scripts/add-live-exam-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EXAMS = {
  en: {
    sectionsLabel: 'Exam sections',
    stateDraft: 'Draft',
    stateScheduled: 'Upcoming',
    stateLive: 'Live',
    stateClosed: 'Closed',
    stateCancelled: 'Cancelled',

    liveTitle: 'Live exams',
    liveSubtitle: 'Exams staff can sit right now.',
    liveEmpty: 'No exam is running.',
    liveEmptyHint: 'Publish a generated paper and assign it to staff to start one.',
    upcomingTitle: 'Upcoming exams',
    upcomingSubtitle: 'Published and scheduled, not open yet.',
    upcomingEmpty: 'Nothing is scheduled.',
    upcomingEmptyHint: 'Published exams with a future start time appear here.',
    closedTitle: 'Closed exams',
    closedSubtitle: 'Finished, and how they went.',
    closedEmpty: 'No exam has finished yet.',
    closedEmptyHint: 'An exam moves here once its deadline passes.',

    cardPaper: 'Paper',
    cardQuestions: 'questions',
    cardMarks: 'marks',
    cardDuration: 'min',
    cardStarts: 'Started',
    cardDeadline: 'Deadline',
    cardAttempts: 'Attempts',
    cardSubmitted: 'Submitted',
    cardInProgress: 'In progress',
    cardNotStarted: 'Not started',
    cardOfEmployees: 'staff',
    cardNoAudience: 'Nobody has been chosen to sit this yet, so it does not appear for anyone.',

    monParticipation: 'Participation',
    monEligible: 'Eligible staff',
    monNotStarted: 'Not started',
    monInProgress: 'In progress',
    monSubmitted: 'Submitted',
    monAttemptRate: 'Attempted',
    monSubmitRate: 'Submitted',
    monTable: 'Staff',
    monEmployee: 'Employee',
    monDepartment: 'Department',
    monStarted: 'Started',
    monSubmittedCol: 'Submitted',
    monStatus: 'Status',
    monScore: 'Score',
    monPercent: '%',
    monResult: 'Result',
    monNoAccess: 'You can see the totals for this exam but not the individual staff results.',
    monNobody: 'Nobody has been assigned to this exam yet.',

    pNotStarted: 'Not started',
    pInProgress: 'In progress',
    pSubmitted: 'Submitted',
    pReleased: 'Released',
    pExpired: 'Expired',

    resultPass: 'Passed',
    resultFail: 'Failed',
    resultPending: 'Not released',

    dashLiveTitle: 'Live exams',
    dashLiveAll: 'View all',
    dashLiveExams: 'Running now',
    dashActiveAttempts: 'Active attempts',
    dashActiveAttemptsHint: 'Staff sitting an exam right now',
    dashSubmittedToday: 'Submitted today',
    dashUpcoming: 'Upcoming',
  },
  hi: {
    sectionsLabel: 'परीक्षा अनुभाग',
    stateDraft: 'ड्राफ़्ट',
    stateScheduled: 'आगामी',
    stateLive: 'चालू',
    stateClosed: 'बंद',
    stateCancelled: 'रद्द',

    liveTitle: 'चालू परीक्षाएँ',
    liveSubtitle: 'जो परीक्षाएँ स्टाफ़ अभी दे सकता है।',
    liveEmpty: 'कोई परीक्षा नहीं चल रही।',
    liveEmptyHint: 'तैयार पेपर प्रकाशित करें और स्टाफ़ को दें, तब परीक्षा शुरू होगी।',
    upcomingTitle: 'आगामी परीक्षाएँ',
    upcomingSubtitle: 'प्रकाशित और निर्धारित, अभी शुरू नहीं हुईं।',
    upcomingEmpty: 'कुछ भी निर्धारित नहीं है।',
    upcomingEmptyHint: 'आगे की तारीख़ वाली प्रकाशित परीक्षाएँ यहाँ दिखेंगी।',
    closedTitle: 'बंद परीक्षाएँ',
    closedSubtitle: 'समाप्त, और उनका नतीजा।',
    closedEmpty: 'अभी कोई परीक्षा समाप्त नहीं हुई।',
    closedEmptyHint: 'समय-सीमा बीतने पर परीक्षा यहाँ आ जाती है।',

    cardPaper: 'पेपर',
    cardQuestions: 'प्रश्न',
    cardMarks: 'अंक',
    cardDuration: 'मिनट',
    cardStarts: 'शुरू हुई',
    cardDeadline: 'समय-सीमा',
    cardAttempts: 'प्रयास',
    cardSubmitted: 'जमा',
    cardInProgress: 'चल रही',
    cardNotStarted: 'शुरू नहीं की',
    cardOfEmployees: 'स्टाफ़',
    cardNoAudience: 'अभी तक किसी को नहीं चुना गया है, इसलिए यह किसी को नहीं दिखती।',

    monParticipation: 'भागीदारी',
    monEligible: 'योग्य स्टाफ़',
    monNotStarted: 'शुरू नहीं की',
    monInProgress: 'चल रही',
    monSubmitted: 'जमा',
    monAttemptRate: 'प्रयास किया',
    monSubmitRate: 'जमा किया',
    monTable: 'स्टाफ़',
    monEmployee: 'कर्मचारी',
    monDepartment: 'विभाग',
    monStarted: 'शुरू',
    monSubmittedCol: 'जमा',
    monStatus: 'स्थिति',
    monScore: 'अंक',
    monPercent: '%',
    monResult: 'परिणाम',
    monNoAccess: 'आप इस परीक्षा के कुल आँकड़े देख सकते हैं, पर अलग-अलग स्टाफ़ के परिणाम नहीं।',
    monNobody: 'इस परीक्षा के लिए अभी किसी को नहीं चुना गया है।',

    pNotStarted: 'शुरू नहीं की',
    pInProgress: 'चल रही',
    pSubmitted: 'जमा',
    pReleased: 'जारी',
    pExpired: 'समय समाप्त',

    resultPass: 'उत्तीर्ण',
    resultFail: 'अनुत्तीर्ण',
    resultPending: 'जारी नहीं',

    dashLiveTitle: 'चालू परीक्षाएँ',
    dashLiveAll: 'सभी देखें',
    dashLiveExams: 'अभी चल रही',
    dashActiveAttempts: 'चालू प्रयास',
    dashActiveAttemptsHint: 'अभी परीक्षा दे रहे स्टाफ़',
    dashSubmittedToday: 'आज जमा',
    dashUpcoming: 'आगामी',
  },
  gu: {
    sectionsLabel: 'પરીક્ષા વિભાગો',
    stateDraft: 'ડ્રાફ્ટ',
    stateScheduled: 'આગામી',
    stateLive: 'ચાલુ',
    stateClosed: 'બંધ',
    stateCancelled: 'રદ',

    liveTitle: 'ચાલુ પરીક્ષાઓ',
    liveSubtitle: 'જે પરીક્ષાઓ સ્ટાફ અત્યારે આપી શકે.',
    liveEmpty: 'કોઈ પરીક્ષા ચાલુ નથી.',
    liveEmptyHint: 'તૈયાર પેપર પ્રકાશિત કરો અને સ્ટાફને આપો, પછી પરીક્ષા શરૂ થશે.',
    upcomingTitle: 'આગામી પરીક્ષાઓ',
    upcomingSubtitle: 'પ્રકાશિત અને નક્કી, હજી શરૂ થઈ નથી.',
    upcomingEmpty: 'કંઈ નક્કી થયું નથી.',
    upcomingEmptyHint: 'આગળની તારીખવાળી પ્રકાશિત પરીક્ષાઓ અહીં દેખાશે.',
    closedTitle: 'બંધ પરીક્ષાઓ',
    closedSubtitle: 'પૂરી થયેલી, અને તેનું પરિણામ.',
    closedEmpty: 'હજી કોઈ પરીક્ષા પૂરી થઈ નથી.',
    closedEmptyHint: 'સમયમર્યાદા વીતતાં પરીક્ષા અહીં આવી જાય છે.',

    cardPaper: 'પેપર',
    cardQuestions: 'પ્રશ્નો',
    cardMarks: 'ગુણ',
    cardDuration: 'મિનિટ',
    cardStarts: 'શરૂ થઈ',
    cardDeadline: 'સમયમર્યાદા',
    cardAttempts: 'પ્રયાસ',
    cardSubmitted: 'જમા',
    cardInProgress: 'ચાલુ',
    cardNotStarted: 'શરૂ કરી નથી',
    cardOfEmployees: 'સ્ટાફ',
    cardNoAudience: 'હજી કોઈને પસંદ કર્યા નથી, તેથી તે કોઈને દેખાતી નથી.',

    monParticipation: 'ભાગીદારી',
    monEligible: 'પાત્ર સ્ટાફ',
    monNotStarted: 'શરૂ કરી નથી',
    monInProgress: 'ચાલુ',
    monSubmitted: 'જમા',
    monAttemptRate: 'પ્રયાસ કર્યો',
    monSubmitRate: 'જમા કર્યું',
    monTable: 'સ્ટાફ',
    monEmployee: 'કર્મચારી',
    monDepartment: 'વિભાગ',
    monStarted: 'શરૂ',
    monSubmittedCol: 'જમા',
    monStatus: 'સ્થિતિ',
    monScore: 'ગુણ',
    monPercent: '%',
    monResult: 'પરિણામ',
    monNoAccess: 'તમે આ પરીક્ષાના કુલ આંકડા જોઈ શકો છો, પણ દરેક સ્ટાફનાં પરિણામ નહીં.',
    monNobody: 'આ પરીક્ષા માટે હજી કોઈને પસંદ કર્યા નથી.',

    pNotStarted: 'શરૂ કરી નથી',
    pInProgress: 'ચાલુ',
    pSubmitted: 'જમા',
    pReleased: 'જાહેર',
    pExpired: 'સમય પૂરો',

    resultPass: 'પાસ',
    resultFail: 'નાપાસ',
    resultPending: 'જાહેર નથી',

    dashLiveTitle: 'ચાલુ પરીક્ષાઓ',
    dashLiveAll: 'બધી જુઓ',
    dashLiveExams: 'અત્યારે ચાલુ',
    dashActiveAttempts: 'ચાલુ પ્રયાસ',
    dashActiveAttemptsHint: 'અત્યારે પરીક્ષા આપી રહેલો સ્ટાફ',
    dashSubmittedToday: 'આજે જમા',
    dashUpcoming: 'આગામી',
  },
}

const PAPERS = {
  en: {
    publishInstructions: 'Instructions for candidates (optional)',
    publishInstructionsHint: 'Shown before they start. Anything they need to know.',
    publishResults: 'When results are released',
    publishResultsImmediate: 'As soon as marking is done',
    publishResultsImmediateHint:
      'Each person sees their result the moment their paper has been marked.',
    publishResultsOnClose: 'When the exam closes',
    publishResultsOnCloseHint:
      'Nobody sees a result until the deadline passes, so the whole team finds out together.',
    publishNeedsDeadline: 'Give the exam a closing time.',
    publishDeadlineBeforeStart: 'The closing time must be after the opening time.',
    publishDeadlinePast: 'The closing time has already passed.',
  },
  hi: {
    publishInstructions: 'परीक्षार्थियों के लिए निर्देश (वैकल्पिक)',
    publishInstructionsHint: 'शुरू करने से पहले दिखेंगे। जो कुछ उन्हें जानना ज़रूरी है।',
    publishResults: 'परिणाम कब जारी हों',
    publishResultsImmediate: 'जाँच पूरी होते ही',
    publishResultsImmediateHint: 'जैसे ही किसी का पेपर जाँच लिया जाएगा, उसे उसका परिणाम दिख जाएगा।',
    publishResultsOnClose: 'परीक्षा बंद होने पर',
    publishResultsOnCloseHint:
      'समय-सीमा बीतने तक किसी को परिणाम नहीं दिखेगा, ताकि पूरी टीम को एक साथ पता चले।',
    publishNeedsDeadline: 'परीक्षा की समय-सीमा दें।',
    publishDeadlineBeforeStart: 'समय-सीमा शुरू होने के समय के बाद होनी चाहिए।',
    publishDeadlinePast: 'यह समय-सीमा पहले ही बीत चुकी है।',
  },
  gu: {
    publishInstructions: 'પરીક્ષાર્થીઓ માટે સૂચનાઓ (વૈકલ્પિક)',
    publishInstructionsHint: 'શરૂ કરતાં પહેલાં દેખાશે. જે કંઈ તેમને જાણવું જરૂરી છે.',
    publishResults: 'પરિણામ ક્યારે જાહેર થાય',
    publishResultsImmediate: 'ચકાસણી પૂરી થતાં જ',
    publishResultsImmediateHint: 'જેવું કોઈનું પેપર ચકાસાઈ જશે, તેને તરત પોતાનું પરિણામ દેખાશે.',
    publishResultsOnClose: 'પરીક્ષા બંધ થાય ત્યારે',
    publishResultsOnCloseHint:
      'સમયમર્યાદા વીતે ત્યાં સુધી કોઈને પરિણામ નહીં દેખાય, જેથી આખી ટીમને સાથે ખબર પડે.',
    publishNeedsDeadline: 'પરીક્ષાની સમયમર્યાદા આપો.',
    publishDeadlineBeforeStart: 'સમયમર્યાદા શરૂ થવાના સમય પછી હોવી જોઈએ.',
    publishDeadlinePast: 'આ સમયમર્યાદા પહેલેથી વીતી ગઈ છે.',
  },
}

for (const locale of ['en', 'hi', 'gu']) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))

  let added = 0
  for (const [ns, table] of [['exams', EXAMS], ['papers', PAPERS]]) {
    json[ns] ??= {}
    for (const [key, value] of Object.entries(table[locale])) {
      if (json[ns][key] === undefined) added++
      json[ns][key] = value
    }
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  const total = Object.keys(EXAMS[locale]).length + Object.keys(PAPERS[locale]).length
  console.log(`  ${locale}: ${added} added, ${total - added} already present`)
}
