/**
 * The model answer on the marking view.
 *
 * The hint matters as much as the label: the model answer is a REFERENCE, not
 * a target to match word for word. A short-answer question has many correct
 * phrasings, and a marker who treats the model as the only acceptable wording
 * will fail people who knew the answer.
 *
 *   node scripts/add-marking-messages.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MESSAGES = {
  en: {
    modelAnswer: 'Model answer',
    modelAnswerHint:
      'A reference, not a required wording. Award the marks if the candidate got it right in their own words.',
  },
  hi: {
    modelAnswer: 'आदर्श उत्तर',
    modelAnswerHint:
      'यह केवल संदर्भ है, ज़रूरी शब्द नहीं। यदि उत्तर अपने शब्दों में सही है, तो अंक दें।',
  },
  gu: {
    modelAnswer: 'આદર્શ જવાબ',
    modelAnswerHint:
      'આ ફક્ત સંદર્ભ છે, જરૂરી શબ્દો નહીં. જવાબ પોતાના શબ્દોમાં સાચો હોય તો ગુણ આપો.',
  },
}

for (const [locale, keys] of Object.entries(MESSAGES)) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))

  json.evaluation ??= {}
  let added = 0
  for (const [key, value] of Object.entries(keys)) {
    if (json.evaluation[key] === undefined) added++
    json.evaluation[key] = value
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log(`  ${locale}: ${added} added, ${Object.keys(keys).length - added} already present`)
}
