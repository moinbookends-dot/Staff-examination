/**
 * The candidate's own dashboard.
 *
 * Added because /dashboard had only two branches — the bank view and a
 * fallback commented "a chef sees papers only" — so an Employee was shown
 * "Papers generated" and "Editors", two counts about a subsystem they cannot
 * open, both reading 0 because RLS correctly returns them nothing.
 *
 * Flat keys: next-intl rejects a dot inside a key.
 *
 *   node scripts/add-candidate-dashboard-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = {
  en: {
    dashCandidateSubtitle: 'Your exams and results.',
    statToSit: 'Exams to sit',
    statToSitHint: 'Assigned to you and still open',
    statInProgress: 'In progress',
    statInProgressHint: 'Started but not yet submitted',
    candidateNext: 'What to do next',
    candidateNextHint: 'Open My exams to start or finish a paper.',
    candidateNothing: 'Nothing is waiting for you right now.',
    candidateGoToExams: 'My exams',
    candidateGoToResults: 'My results',
  },
  hi: {
    dashCandidateSubtitle: 'आपकी परीक्षाएँ और परिणाम।',
    statToSit: 'देने योग्य परीक्षाएँ',
    statToSitHint: 'आपको दी गई और अभी खुली हुई',
    statInProgress: 'चल रही है',
    statInProgressHint: 'शुरू की गई, अभी जमा नहीं',
    candidateNext: 'आगे क्या करें',
    candidateNextHint: 'परीक्षा शुरू या पूरी करने के लिए “मेरी परीक्षाएँ” खोलें।',
    candidateNothing: 'अभी आपके लिए कुछ भी नहीं है।',
    candidateGoToExams: 'मेरी परीक्षाएँ',
    candidateGoToResults: 'मेरे परिणाम',
  },
  gu: {
    dashCandidateSubtitle: 'તમારી પરીક્ષાઓ અને પરિણામ.',
    statToSit: 'આપવાની પરીક્ષાઓ',
    statToSitHint: 'તમને આપેલી અને હજી ખુલ્લી',
    statInProgress: 'ચાલુ છે',
    statInProgressHint: 'શરૂ કરી, હજી જમા નથી',
    candidateNext: 'હવે શું કરવું',
    candidateNextHint: 'પરીક્ષા શરૂ કરવા કે પૂરી કરવા “મારી પરીક્ષાઓ” ખોલો.',
    candidateNothing: 'અત્યારે તમારા માટે કંઈ બાકી નથી.',
    candidateGoToExams: 'મારી પરીક્ષાઓ',
    candidateGoToResults: 'મારાં પરિણામ',
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

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log(`  ${locale}: ${added} added, ${Object.keys(keys).length - added} already present`)
}
