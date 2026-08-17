/**
 * Message keys for the paper review-and-edit screen (migration 0072).
 *
 * One table, three files, as every other add-*-messages.mjs here does — so a
 * Gujarati reader cannot end up looking at an English label because somebody
 * hand-edited two files out of three.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** [key, en, hi, gu] */
const KEYS = [
  ['reviewTitle', 'Review the paper', 'पेपर जाँचें', 'પેપર તપાસો'],
  [
    'reviewSubtitle',
    'Remove, replace or reorder questions before you publish. Nothing is saved until you press Save.',
    'प्रकाशित करने से पहले प्रश्न हटाएँ, बदलें या क्रम बदलें। सेव दबाने तक कुछ सेव नहीं होता।',
    'પ્રકાશિત કરતાં પહેલાં પ્રશ્નો દૂર કરો, બદલો કે ક્રમ બદલો. સેવ દબાવો ત્યાં સુધી કશું સેવ થતું નથી.',
  ],
  ['reviewCount', '{n} of {expected} questions', '{expected} में से {n} प्रश्न', '{expected} માંથી {n} પ્રશ્નો'],
  ['reviewMcq', 'MCQ {n}/{expected}', 'बहुविकल्पी {n}/{expected}', 'બહુવિકલ્પ {n}/{expected}'],
  ['reviewShort', 'Short {n}/{expected}', 'लघु {n}/{expected}', 'ટૂંકા {n}/{expected}'],
  [
    'reviewInvalid',
    'This paper needs {mcq} multiple-choice and {short} short answers before it can be saved.',
    'सेव करने से पहले इस पेपर में {mcq} बहुविकल्पी और {short} लघु उत्तर चाहिए।',
    'સેવ કરતાં પહેલાં આ પેપરમાં {mcq} બહુવિકલ્પ અને {short} ટૂંકા જવાબ જોઈએ.',
  ],
  ['reviewUnsaved', 'You have unsaved changes.', 'आपके बदलाव सेव नहीं हुए हैं।', 'તમારા ફેરફારો સેવ થયા નથી.'],
  ['reviewSave', 'Save paper', 'पेपर सेव करें', 'પેપર સેવ કરો'],
  ['reviewSaving', 'Saving…', 'सेव हो रहा है…', 'સેવ થઈ રહ્યું છે…'],
  ['reviewDiscard', 'Discard changes', 'बदलाव छोड़ें', 'ફેરફારો છોડો'],
  [
    'reviewSaved',
    'Paper {paperNo} saved with {n} questions.',
    'पेपर {paperNo} {n} प्रश्नों के साथ सेव हुआ।',
    'પેપર {paperNo} {n} પ્રશ્નો સાથે સેવ થયું.',
  ],
  ['reviewReplace', 'Replace', 'बदलें', 'બદલો'],
  ['reviewRemove', 'Remove question {n}', 'प्रश्न {n} हटाएँ', 'પ્રશ્ન {n} દૂર કરો'],
  ['reviewMoveUp', 'Move question {n} up', 'प्रश्न {n} ऊपर करें', 'પ્રશ્ન {n} ઉપર કરો'],
  ['reviewMoveDown', 'Move question {n} down', 'प्रश्न {n} नीचे करें', 'પ્રશ્ન {n} નીચે કરો'],
  ['reviewSearch', 'Search the question bank', 'प्रश्न बैंक खोजें', 'પ્રશ્ન બેંક શોધો'],
  ['reviewSearchGo', 'Search', 'खोजें', 'શોધો'],
  ['reviewCancel', 'Cancel', 'रद्द करें', 'રદ કરો'],
  ['reviewNoMatches', 'No eligible questions match.', 'कोई उपयुक्त प्रश्न नहीं मिला।', 'કોઈ યોગ્ય પ્રશ્ન મળ્યો નથી.'],
  ['reviewNoTopic', 'No topic', 'कोई विषय नहीं', 'કોઈ વિષય નથી'],
  ['reviewNoText', '(no English text)', '(अंग्रेज़ी पाठ नहीं)', '(અંગ્રેજી લખાણ નથી)'],
  ['reviewEmpty', 'Paper {paperNo} has no questions left.', 'पेपर {paperNo} में कोई प्रश्न नहीं बचा।', 'પેપર {paperNo} માં કોઈ પ્રશ્ન બાકી નથી.'],
  [
    'reviewFrozenTitle',
    'This paper can no longer be changed',
    'यह पेपर अब बदला नहीं जा सकता',
    'આ પેપર હવે બદલી શકાતું નથી',
  ],
  [
    'reviewFrozenBody',
    'It has been published as an exam. Each candidate is given the paper when they start, so changing it now would hand later candidates a different paper. Generate a new one instead.',
    'यह परीक्षा के रूप में प्रकाशित हो चुका है। हर उम्मीदवार को शुरू करते समय पेपर मिलता है, इसलिए अब बदलने पर बाद वालों को अलग पेपर मिलेगा। नया पेपर बनाएँ।',
    'તે પરીક્ષા તરીકે પ્રકાશિત થઈ ચૂક્યું છે. દરેક ઉમેદવારને શરૂ કરતી વખતે પેપર મળે છે, તેથી હવે બદલવાથી પછીનાને અલગ પેપર મળશે. નવું પેપર બનાવો.',
  ],
]

const LOCALES = ['en', 'hi', 'gu']

for (const [index, locale] of LOCALES.entries()) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf-8'))

  json.papers ??= {}
  for (const [key, ...values] of KEYS) json.papers[key] = values[index]

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf-8')
  console.log(`  ${locale}: papers +${KEYS.length}`)
}
