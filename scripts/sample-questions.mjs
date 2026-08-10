import { translateOption } from './sample-option-translations.mjs'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * The sample question corpus.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS DEMONSTRATION DATA. IT IS NOT THE QUESTION BANK.                  ║
 * ║                                                                           ║
 * ║ The real bank is 3,000 questions curated outside this repository and       ║
 * ║ imported through the frozen JSON contract. Nothing here is part of it.     ║
 * ║                                                                           ║
 * ║ Every row seeded from this file carries an external_id beginning           ║
 * ║ `sample-`, and `npm run db:sample -- --clean` deletes exactly those, so    ║
 * ║ demonstration content can never be mistaken for curated content.           ║
 * ║                                                                           ║
 * ║ DIFFICULTY HERE IS AN ARBITRARY BUCKET, NOT A JUDGEMENT. Questions are     ║
 * ║ spread across the three levels so the generator's three cards have data    ║
 * ║ behind them. The real levels come from the Difficulty Rules document, and  ║
 * ║ nothing in this application infers a level from anything.                  ║
 * ║                                                                           ║
 * ║ The Hindi and Gujarati text is illustrative. Its purpose is to exercise    ║
 * ║ Devanagari and Gujarati shaping in the PDF renderer, not to be exam-grade  ║
 * ║ translation.                                                              ║
 * ║                                                                           ║
 * ║ STEMS AND OPTIONS ARE BOTH TRANSLATED. An earlier version of this corpus  ║
 * ║ passed the English options straight into the hi and gu variants, so a     ║
 * ║ Gujarati paper printed a Gujarati question with four English answers —    ║
 * ║ which reads as a half-finished product rather than as sample data.        ║
 * ║                                                                           ║
 * ║ Options now come from sample-option-translations.mjs, keyed on the exact  ║
 * ║ English string so an option used by a dozen questions is translated once. ║
 * ║ Numbers and units map to themselves: `74 °C` is `74 °C` in every script.  ║
 * ║ buildCorpus() returns every string it could NOT translate, and the seed   ║
 * ║ script prints the count, so a gap is visible rather than silent.          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Questions are assembled from FACT TABLES rather than typed one at a time.
 * Each row of a table is a genuinely different fact — a different food, a
 * different allergen, a different piece of equipment — so the questions it
 * produces are genuinely distinct, which matters: 0054 has a unique index on
 * (brand, difficulty, lower(english question)) and near-duplicates would be
 * refused by the database rather than silently accepted.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** Core temperatures. One question per food, four plausible options. */
const CORE_TEMPS = [
  ['chicken breast', 'चिकन ब्रेस्ट', 'ચિકન બ્રેસ્ટ', '74 °C', ['63 °C', '68 °C', '74 °C', '82 °C'], 'C'],
  ['minced beef', 'कीमा', 'નાનું માંસ', '71 °C', ['60 °C', '71 °C', '77 °C', '85 °C'], 'B'],
  ['whole cuts of lamb', 'भेड़ का साबुत टुकड़ा', 'ઘેટાંનો આખો ટુકડો', '63 °C', ['55 °C', '63 °C', '70 °C', '75 °C'], 'B'],
  ['pork chops', 'पोर्क चॉप', 'પોર્ક ચોપ', '71 °C', ['63 °C', '71 °C', '79 °C', '88 °C'], 'B'],
  ['fish fillets', 'मछली का फ़िले', 'માછલીની ફિલે', '63 °C', ['52 °C', '58 °C', '63 °C', '71 °C'], 'C'],
  ['egg dishes', 'अंडे के व्यंजन', 'ઈંડાની વાનગી', '71 °C', ['63 °C', '71 °C', '77 °C', '82 °C'], 'B'],
  ['reheated leftovers', 'दोबारा गरम किया खाना', 'ફરી ગરમ કરેલું ખાવાનું', '75 °C', ['60 °C', '68 °C', '75 °C', '90 °C'], 'C'],
  ['stuffed poultry', 'भरवां मुर्गी', 'ભરેલું મરઘું', '74 °C', ['65 °C', '70 °C', '74 °C', '80 °C'], 'C'],
  ['turkey', 'टर्की', 'ટર્કી', '74 °C', ['63 °C', '70 °C', '74 °C', '85 °C'], 'C'],
  ['duck breast', 'बत्तख का ब्रेस्ट', 'બતકનું બ્રેસ્ટ', '63 °C', ['57 °C', '63 °C', '71 °C', '77 °C'], 'B'],
]

/** Cold-chain and holding limits. */
const HOLDING = [
  ['a refrigerator', 'रेफ़्रिजरेटर', 'રેફ્રિજરેટર', '1–4 °C', ['−2–0 °C', '1–4 °C', '6–9 °C', '10–12 °C'], 'B'],
  ['a freezer', 'फ़्रीज़र', 'ફ્રીઝર', '−18 °C or below', ['0 °C', '−5 °C', '−12 °C', '−18 °C or below'], 'D'],
  ['hot holding', 'गरम होल्डिंग', 'ગરમ હોલ્ડિંગ', '63 °C or above', ['50 °C or above', '55 °C or above', '63 °C or above', '70 °C or above'], 'C'],
  ['a hot display counter', 'गरम डिस्प्ले काउंटर', 'ગરમ ડિસ્પ્લે કાઉન્ટર', '63 °C or above', ['45 °C', '55 °C', '63 °C or above', '75 °C or above'], 'C'],
  ['a salad bar', 'सलाद बार', 'સલાડ બાર', '5 °C or below', ['5 °C or below', '8 °C', '10 °C', '12 °C'], 'A'],
]

/** The danger zone and time limits. */
const TIME_RULES = [
  ['the temperature danger zone', 'तापमान डेंजर ज़ोन', 'તાપમાન ડેન્જર ઝોન', '5 °C to 63 °C', ['0 °C to 40 °C', '5 °C to 63 °C', '10 °C to 50 °C', '20 °C to 80 °C'], 'B'],
  ['the maximum time hot food may sit at room temperature', 'गरम खाना कमरे के तापमान पर कितनी देर', 'ગરમ ખાવાનું ઓરડાના તાપમાને કેટલો સમય', '2 hours', ['30 minutes', '1 hour', '2 hours', '4 hours'], 'C'],
  ['how quickly cooked food should be cooled to 5 °C', 'पका खाना कितनी जल्दी 5 °C तक ठंडा हो', 'રાંધેલું ખાવાનું કેટલી ઝડપે 5 °C સુધી ઠંડું', 'within 90 minutes', ['within 30 minutes', 'within 90 minutes', 'within 4 hours', 'within 8 hours'], 'B'],
  ['how long opened milk may be kept refrigerated', 'खुला दूध फ़्रिज में कितने दिन', 'ખુલ્લું દૂધ ફ્રિજમાં કેટલા દિવસ', '3 days', ['1 day', '3 days', '7 days', '14 days'], 'B'],
]

/** Allergens — each is a genuinely different question. */
const ALLERGENS = [
  ['peanuts', 'मूँगफली', 'મગફળી'],
  ['tree nuts', 'मेवे', 'સૂકા મેવા'],
  ['sesame', 'तिल', 'તલ'],
  ['milk', 'दूध', 'દૂધ'],
  ['eggs', 'अंडे', 'ઈંડાં'],
  ['fish', 'मछली', 'માછલી'],
  ['crustaceans', 'झींगा-केकड़ा', 'ક્રસ્ટેશિયન'],
  ['molluscs', 'शंबुक', 'મોલસ્ક'],
  ['soya', 'सोया', 'સોયા'],
  ['gluten', 'ग्लूटेन', 'ગ્લુટેન'],
  ['mustard', 'सरसों', 'રાઈ'],
  ['celery', 'अजमोद', 'સેલરી'],
  ['lupin', 'ल्यूपिन', 'લ્યુપિન'],
  ['sulphites', 'सल्फ़ाइट', 'સલ્ફાઇટ'],
]

/** Fridge storage order, top shelf to bottom. */
const STORAGE = [
  ['ready-to-eat food', 'खाने के लिए तैयार भोजन', 'ખાવા માટે તૈયાર ખોરાક', 'the top shelf', ['the top shelf', 'the middle shelf', 'the bottom shelf', 'the door'], 'A'],
  ['raw poultry', 'कच्ची मुर्गी', 'કાચું મરઘું', 'the bottom shelf', ['the top shelf', 'the middle shelf', 'the bottom shelf', 'the door'], 'C'],
  ['raw fish', 'कच्ची मछली', 'કાચી માછલી', 'the middle shelf', ['the top shelf', 'the middle shelf', 'the bottom shelf', 'the door'], 'B'],
  ['cooked meat', 'पका हुआ मांस', 'રાંધેલું માંસ', 'the top shelf', ['the top shelf', 'the middle shelf', 'the bottom shelf', 'the freezer'], 'A'],
  ['salad leaves', 'सलाद के पत्ते', 'સલાડનાં પાન', 'the salad drawer', ['the salad drawer', 'the bottom shelf', 'the door', 'the freezer'], 'A'],
]

/** Cleaning and sanitising. */
const CLEANING = [
  ['the correct order for cleaning a food surface', 'खाद्य सतह साफ़ करने का सही क्रम', 'ખોરાકની સપાટી સાફ કરવાનો સાચો ક્રમ', 'clean, then sanitise', ['sanitise only', 'clean, then sanitise', 'sanitise, then clean', 'rinse only'], 'B'],
  ['the minimum contact time for most sanitisers', 'ज़्यादातर सैनिटाइज़र का न्यूनतम संपर्क समय', 'મોટા ભાગના સેનિટાઇઝરનો ન્યૂનતમ સંપર્ક સમય', '30 seconds', ['5 seconds', '30 seconds', '5 minutes', '20 minutes'], 'B'],
  ['how long hands should be washed', 'हाथ कितनी देर धोने चाहिए', 'હાથ કેટલો સમય ધોવા જોઈએ', '20 seconds', ['5 seconds', '10 seconds', '20 seconds', '60 seconds'], 'C'],
  ['what a three-sink system is used for', 'तीन-सिंक प्रणाली किसलिए', 'ત્રણ-સિંક પદ્ધતિ શા માટે', 'wash, rinse, sanitise', ['wash, dry, store', 'wash, rinse, sanitise', 'soak, scrub, dry', 'rinse, soak, wash'], 'B'],
  ['when a chopping board should be changed', 'चॉपिंग बोर्ड कब बदलें', 'ચોપિંગ બોર્ડ ક્યારે બદલવું', 'between raw and ready-to-eat food', ['at the end of the shift', 'between raw and ready-to-eat food', 'once a week', 'only when visibly dirty'], 'B'],
]

/** Knife cuts and technique. */
const TECHNIQUE = [
  ['a julienne cut', 'जूलियन कट', 'જુલિયન કટ', 'thin matchsticks', ['thin matchsticks', 'small cubes', 'thin rounds', 'coarse shreds'], 'A'],
  ['a brunoise cut', 'ब्रुनोइस कट', 'બ્રુનોઈસ કટ', 'very small dice', ['long strips', 'very small dice', 'thick wedges', 'diagonal slices'], 'B'],
  ['a chiffonade cut', 'शिफ़ोनाड कट', 'શિફોનેડ કટ', 'ribbons of leafy herbs', ['ribbons of leafy herbs', 'cubed root vegetables', 'crushed garlic', 'sliced onion rings'], 'A'],
  ['blanching', 'ब्लांचिंग', 'બ્લાન્ચિંગ', 'brief boiling then ice water', ['slow roasting', 'brief boiling then ice water', 'deep frying', 'curing in salt'], 'B'],
  ['what a roux is made from', 'रू किससे बनता है', 'રૂ શેમાંથી બને છે', 'fat and flour', ['fat and flour', 'egg and cream', 'stock and wine', 'butter and sugar'], 'A'],
  ['the base of a béchamel sauce', 'बेचामेल सॉस का आधार', 'બેશામેલ સોસનો આધાર', 'milk and roux', ['tomato and garlic', 'milk and roux', 'stock and cream', 'egg yolk and butter'], 'B'],
  ['the base of a hollandaise sauce', 'हॉलनडेज़ सॉस का आधार', 'હોલેન્ડેઝ સોસનો આધાર', 'egg yolk and butter', ['milk and roux', 'egg yolk and butter', 'tomato and stock', 'cream and cheese'], 'B'],
  ['what emulsification means', 'इमल्सीफ़िकेशन क्या है', 'ઈમલ્સિફિકેશન એટલે શું', 'combining fat and liquid', ['combining fat and liquid', 'boiling off water', 'freezing a sauce', 'browning sugar'], 'A'],
]

/** Short-answer prompts. Each expects one or two lines. */
const SHORT = [
  ['Name the temperature range known as the danger zone.', 'डेंजर ज़ोन का तापमान बताइए।', 'ડેન્જર ઝોન તાપમાન જણાવો.', '5 °C to 63 °C', 'Bacteria multiply fastest in this range.'],
  ['State the safe core temperature for cooking chicken.', 'चिकन पकाने का सुरक्षित तापमान लिखिए।', 'ચિકન રાંધવાનું સલામત તાપમાન લખો.', '74 °C', 'Measured at the thickest part.'],
  ['How long should hands be washed for?', 'हाथ कितनी देर धोने चाहिए?', 'હાથ કેટલો સમય ધોવા જોઈએ?', 'At least 20 seconds', 'With soap and warm running water.'],
  ['Name two of the fourteen declarable allergens.', 'चौदह घोषित एलर्जन में से दो बताइए।', 'ચૌદ જાહેર કરવાના એલર્જનમાંથી બે જણાવો.', 'For example peanuts and milk', 'Any two of the fourteen is acceptable.'],
  ['Where should raw poultry be stored in a fridge?', 'कच्ची मुर्गी फ़्रिज में कहाँ रखें?', 'કાચું મરઘું ફ્રિજમાં ક્યાં રાખવું?', 'On the bottom shelf', 'So drips cannot fall onto other food.'],
  ['What are the three stages of a three-sink system?', 'तीन-सिंक प्रणाली के तीन चरण क्या हैं?', 'ત્રણ-સિંક પદ્ધતિના ત્રણ તબક્કા કયા છે?', 'Wash, rinse, sanitise', 'In that order.'],
  ['State the maximum time hot food may be held below 63 °C.', '63 °C से नीचे गरम खाना अधिकतम कितनी देर?', '63 °C થી નીચે ગરમ ખાવાનું વધુમાં વધુ કેટલો સમય?', 'Two hours', 'After that it must be discarded.'],
  ['Name the sauce made from milk and a roux.', 'दूध और रू से बनी सॉस का नाम बताइए।', 'દૂધ અને રૂમાંથી બનતા સોસનું નામ જણાવો.', 'Béchamel', 'One of the classical mother sauces.'],
  ['What does FIFO stand for in stock rotation?', 'स्टॉक रोटेशन में FIFO का अर्थ क्या है?', 'સ્ટોક રોટેશનમાં FIFO એટલે શું?', 'First In, First Out', 'Oldest stock is used first.'],
  ['Give the correct fridge temperature range.', 'फ़्रिज का सही तापमान बताइए।', 'ફ્રિજનું સાચું તાપમાન જણાવો.', '1 °C to 4 °C', 'Checked and recorded daily.'],
  ['Why must chopping boards be colour coded?', 'चॉपिंग बोर्ड रंग-कोडित क्यों होते हैं?', 'ચોપિંગ બોર્ડ રંગ-કોડેડ કેમ હોય છે?', 'To prevent cross contamination', 'Separate boards for raw and ready-to-eat.'],
  ['State the freezer temperature required for frozen storage.', 'फ़्रोज़न भंडारण के लिए फ़्रीज़र तापमान लिखिए।', 'ફ્રોઝન સંગ્રહ માટે ફ્રીઝર તાપમાન લખો.', '−18 °C or below', 'Measured at the warmest point.'],
  ['What should be done with food past its use-by date?', 'यूज़-बाय तारीख़ बीत जाने पर क्या करें?', 'યુઝ-બાય તારીખ પછી ખોરાકનું શું કરવું?', 'Discard it', 'It must never be served.'],
  ['Name the cut that produces thin matchsticks.', 'पतली माचिस जैसी कटाई का नाम बताइए।', 'પાતળી દીવાસળી જેવા કાપનું નામ જણાવો.', 'Julienne', 'Roughly 3 mm square.'],
  ['Why should a probe thermometer be sanitised between uses?', 'प्रोब थर्मामीटर हर बार क्यों सैनिटाइज़ करें?', 'પ્રોબ થર્મોમીટર દર વખતે કેમ સેનિટાઇઝ કરવું?', 'To avoid transferring bacteria', 'Especially between raw and cooked food.'],
]

/** Equipment. */
const EQUIPMENT = [
  ['a blast chiller', 'ब्लास्ट चिलर', 'બ્લાસ્ટ ચિલર', ['Cool food rapidly', 'Hold food hot', 'Prove dough', 'Dry herbs'], 'A'],
  ['a salamander', 'सैलामैंडर', 'સેલામેન્ડર', ['Grill and glaze from above', 'Freeze stock', 'Knead dough', 'Wash utensils'], 'A'],
  ['a mandoline', 'मैंडोलिन', 'મેન્ડોલિન', ['Slice evenly and thinly', 'Measure liquids', 'Whip cream', 'Seal bags'], 'A'],
  ['a probe thermometer', 'प्रोब थर्मामीटर', 'પ્રોબ થર્મોમીટર', ['Measure core temperature', 'Weigh portions', 'Time a bake', 'Test pH'], 'A'],
  ['a vacuum sealer', 'वैक्यूम सीलर', 'વેક્યુમ સીલર', ['Remove air before storage', 'Add carbonation', 'Sterilise plates', 'Chill sauces'], 'A'],
  ['a proving drawer', 'प्रूविंग ड्रॉअर', 'પ્રૂવિંગ ડ્રોઅર', ['Let dough rise warm', 'Deep fry', 'Chill desserts', 'Smoke fish'], 'A'],
  ['a bain-marie', 'बैन-मैरी', 'બેન-મેરી', ['Hold food hot in water', 'Blast freeze', 'Grind spices', 'Roll pasta'], 'A'],
  ['a deep fryer thermostat', 'डीप फ़्रायर थर्मोस्टेट', 'ડીપ ફ્રાયર થર્મોસ્ટેટ', ['Hold the oil temperature', 'Filter the oil', 'Time the basket', 'Drain the fat'], 'A'],
  ['a dough sheeter', 'डो शीटर', 'ડો શીટર', ['Roll dough to an even thickness', 'Portion sauces', 'Chill dough', 'Bake bread'], 'A'],
  ['a food mixer paddle attachment', 'मिक्सर पैडल अटैचमेंट', 'મિક્સર પેડલ એટેચમેન્ટ', ['Beat and combine', 'Whip air into cream', 'Knead bread dough', 'Purée soup'], 'A'],
]

/** Dishes and menu knowledge. */
const DISHES = [
  ['a Margherita pizza', 'मार्गेरिटा पिज़्ज़ा', 'માર્ગેરિટા પિઝા', ['Tomato, mozzarella, basil', 'Pepperoni and onion', 'Four cheeses', 'Ham and pineapple'], 'A'],
  ['carbonara', 'कार्बोनारा', 'કાર્બોનારા', ['Egg, cheese, cured pork', 'Cream and mushroom', 'Tomato and chilli', 'Pesto and pine nut'], 'A'],
  ['pesto', 'पेस्तो', 'પેસ્તો', ['Basil, pine nut, cheese, oil', 'Tomato and garlic', 'Cream and butter', 'Egg and lemon'], 'A'],
  ['a Caesar salad dressing', 'सीज़र सलाद ड्रेसिंग', 'સીઝર સલાડ ડ્રેસિંગ', ['Anchovy, egg, parmesan', 'Yoghurt and mint', 'Tomato and basil', 'Soy and ginger'], 'A'],
  ['a vinaigrette ratio', 'विनैग्रेट अनुपात', 'વિનેગ્રેટ ગુણોત્તર', ['Three parts oil to one acid', 'Equal oil and acid', 'One oil to three acid', 'Oil only'], 'A'],
  ['al dente pasta', 'अल डेंते पास्ता', 'અલ ડેન્ટે પાસ્તા', ['Firm to the bite', 'Very soft', 'Raw in the centre', 'Crisp and dry'], 'A'],
  ['a beef burger cooked medium', 'मीडियम बीफ़ बर्गर', 'મીડિયમ બીફ બર્ગર', ['Pink centre, 63 °C', 'Fully grey throughout', 'Cold centre', 'Charred outside only'], 'A'],
  ['crème anglaise', 'क्रेम एंग्लेज़', 'ક્રેમ એંગ્લેઝ', ['A pouring custard', 'A whipped cream', 'A fruit coulis', 'A caramel sauce'], 'A'],
  ['a ganache', 'गनाश', 'ગનાશ', ['Chocolate and cream', 'Sugar and water', 'Egg and butter', 'Flour and milk'], 'A'],
  ['tempering chocolate', 'चॉकलेट टेम्परिंग', 'ચોકલેટ ટેમ્પરિંગ', ['Controlled heating and cooling', 'Adding water', 'Freezing quickly', 'Whipping air in'], 'A'],
  ['a mirepoix', 'मिरेपॉ', 'મિરેપોઈ', ['Onion, carrot, celery', 'Garlic and ginger', 'Tomato and basil', 'Leek and potato'], 'A'],
  ['deglazing a pan', 'पैन डिग्लेज़ करना', 'પેન ડિગ્લેઝ કરવું', ['Lifting fond with liquid', 'Draining the fat', 'Scrubbing while hot', 'Cooling rapidly'], 'A'],
]

/** Personal hygiene and reporting. */
const HYGIENE = [
  ['a food handler with vomiting or diarrhoea', 'उल्टी या दस्त वाला फ़ूड हैंडलर', 'ઊલટી કે ઝાડાવાળો ફૂડ હેન્ડલર', ['Report and stay away 48 hours', 'Wear gloves and continue', 'Work only on cold food', 'Take a short break'], 'A'],
  ['a cut on the hand', 'हाथ पर कटा', 'હાથ પર કાપ', ['Cover with a blue waterproof dressing', 'Leave it open to dry', 'Rinse and continue', 'Wear two gloves'], 'A'],
  ['jewellery in a kitchen', 'रसोई में गहने', 'રસોડામાં ઘરેણાં', ['Remove all but a plain band', 'Wear freely', 'Cover with tape', 'Only rings allowed'], 'A'],
  ['long hair on the line', 'लाइन पर लंबे बाल', 'લાઇન પર લાંબા વાળ', ['Tied back and covered', 'Left loose', 'Tucked into collar', 'Only a cap needed'], 'A'],
  ['tasting food during service', 'सर्विस के दौरान चखना', 'સર્વિસ દરમિયાન ચાખવું', ['Use a clean spoon each time', 'Use fingers', 'Reuse the same spoon', 'Taste from the pan'], 'A'],
  ['gloves when handling ready-to-eat food', 'रेडी-टू-ईट भोजन के लिए दस्ताने', 'રેડી-ટુ-ઈટ ખોરાક માટે ગ્લોવ્ઝ', ['Change between tasks', 'Wear all shift', 'Wash and reuse', 'Not required'], 'A'],
  ['smoking near a food area', 'खाद्य क्षेत्र के पास धूम्रपान', 'ખોરાક વિસ્તાર પાસે ધૂમ્રપાન', ['Never permitted', 'Allowed on breaks', 'Allowed by the door', 'Allowed if washed after'], 'A'],
  ['aprons when leaving the kitchen', 'रसोई से बाहर जाते समय एप्रन', 'રસોડામાંથી બહાર જતાં એપ્રન', ['Remove before leaving', 'Keep on always', 'Turn inside out', 'Only for deliveries'], 'A'],
]

/** HACCP and records. */
const HACCP = [
  ['what HACCP stands for', 'HACCP का पूरा नाम', 'HACCP નું પૂરું નામ', ['Hazard Analysis Critical Control Point', 'Hygiene And Cleaning Control Plan', 'Health And Catering Compliance Policy', 'Hot And Cold Control Procedure'], 'A'],
  ['a critical control point', 'क्रिटिकल कंट्रोल पॉइंट', 'ક્રિટિકલ કંટ્રોલ પોઈન્ટ', ['A step where a hazard is controlled', 'Any cleaning task', 'The busiest service hour', 'The delivery door'], 'A'],
  ['FIFO stock rotation', 'FIFO स्टॉक रोटेशन', 'FIFO સ્ટોક રોટેશન', ['First in, first out', 'Fast in, fast out', 'Freshis first only', 'Frozen in, fried out'], 'A'],
  ['a use-by date', 'यूज़-बाय तारीख़', 'યુઝ-બાય તારીખ', ['A safety deadline', 'A quality suggestion', 'A delivery date', 'A stock code'], 'A'],
  ['a best-before date', 'बेस्ट-बिफ़ोर तारीख़', 'બેસ્ટ-બિફોર તારીખ', ['A quality guide', 'A safety deadline', 'A cooking time', 'A batch number'], 'A'],
  ['what a delivery check should include', 'डिलीवरी जाँच में क्या', 'ડિલિવરી ચકાસણીમાં શું', ['Temperature, date and condition', 'Price only', 'Weight only', 'Supplier name only'], 'A'],
  ['how long temperature records should be kept', 'तापमान रिकॉर्ड कितने समय रखें', 'તાપમાન રેકોર્ડ કેટલો સમય રાખવા', ['As required by local law', 'One day', 'Until the next shift', 'They need not be kept'], 'A'],
]

const TOPICS = [
  'food-safety', 'kitchen-hygiene', 'storage', 'preparation',
  'cleaning', 'cooking-techniques', 'kitchen-equipment', 'recipes',
]

/**
 * Build the corpus.
 *
 * Distributed across the three levels round-robin so each has a full pool, and
 * the level is recorded explicitly on every row — never derived from content.
 */
export function buildCorpus() {
  const questions = []
  let n = 0
  /** Option strings with no translation entry. Reported, never swallowed. */
  const untranslated = new Set()

  const push = (q) => {
    questions.push({ ...q, topic: TOPICS[n % TOPICS.length], seq: n })
    n += 1
  }

  /**
   * Options are translated per locale rather than reused.
   *
   * The first version of this corpus passed the English options straight into
   * the `hi` and `gu` variants, so a Gujarati paper printed a Gujarati question
   * with four English answers. The stems were translated and the answers were
   * not, which looks like a half-finished product rather than sample data.
   */
  const localise = (opts, localeIndex) =>
    opts.map((opt) => {
      const { text, missing } = translateOption(opt, localeIndex)
      if (missing) untranslated.add(opt)
      return text
    })

  const mcq = (enQ, hiQ, guQ, opts, correct) => {
    const [a, b, c, d] = opts
    const [ha, hb, hc, hd] = localise(opts, 0)
    const [ga, gb, gc, gd] = localise(opts, 1)

    push({
      type: 'mcq',
      correct,
      en: { q: enQ, a, b, c, d },
      hi: { q: hiQ, a: ha, b: hb, c: hc, d: hd },
      gu: { q: guQ, a: ga, b: gb, c: gc, d: gd },
    })
  }

  for (const [item, hi, gu, , opts, correct] of CORE_TEMPS) {
    mcq(
      `What is the minimum safe core temperature for ${item}?`,
      `${hi} के लिए न्यूनतम सुरक्षित कोर तापमान क्या है?`,
      `${gu} માટે ન્યૂનતમ સલામત કોર તાપમાન શું છે?`,
      opts, correct,
    )
    mcq(
      `Where on ${item} should a probe thermometer be inserted?`,
      `${hi} में प्रोब थर्मामीटर कहाँ लगाएँ?`,
      `${gu} માં પ્રોબ થર્મોમીટર ક્યાં મૂકવું?`,
      ['At the surface', 'At the thickest part', 'Near the bone', 'At the edge'], 'B',
    )
  }

  for (const [place, hi, gu, , opts, correct] of HOLDING) {
    mcq(
      `What is the correct operating temperature for ${place}?`,
      `${hi} का सही तापमान क्या है?`,
      `${gu} નું સાચું તાપમાન શું છે?`,
      opts, correct,
    )
    mcq(
      `How often should the temperature of ${place} be recorded?`,
      `${hi} का तापमान कितनी बार दर्ज करें?`,
      `${gu} નું તાપમાન કેટલી વાર નોંધવું?`,
      ['Once a month', 'Once a week', 'At least daily', 'Only on inspection'], 'C',
    )
  }

  for (const [what, hi, gu, , opts, correct] of TIME_RULES) {
    mcq(
      `Which of these correctly states ${what}?`,
      `${hi} के बारे में कौन सा कथन सही है?`,
      `${gu} વિશે કયું વિધાન સાચું છે?`,
      opts, correct,
    )
  }

  for (const [name, hi, gu] of ALLERGENS) {
    mcq(
      `A dish contains ${name}. When must this be declared to the customer?`,
      `किसी व्यंजन में ${hi} है। ग्राहक को कब बताना ज़रूरी है?`,
      `વાનગીમાં ${gu} છે. ગ્રાહકને ક્યારે જણાવવું જરૂરી છે?`,
      ['Only if asked', 'Always, before ordering', 'Only for children', 'Never'], 'B',
    )
    mcq(
      `Which precaution best prevents ${name} cross contact?`,
      `${hi} का क्रॉस कॉन्टैक्ट रोकने का सबसे अच्छा उपाय?`,
      `${gu} નો ક્રોસ કોન્ટેક્ટ રોકવાનો શ્રેષ્ઠ ઉપાય?`,
      ['Separate utensils and surfaces', 'Rinsing with water', 'Cooking at high heat', 'Serving quickly'], 'A',
    )
  }

  for (const [item, hi, gu, , opts, correct] of STORAGE) {
    mcq(
      `Where should ${item} be stored in a refrigerator?`,
      `${hi} को फ़्रिज में कहाँ रखना चाहिए?`,
      `${gu} ને ફ્રિજમાં ક્યાં રાખવું જોઈએ?`,
      opts, correct,
    )
  }

  for (const [what, hi, gu, , opts, correct] of CLEANING) {
    mcq(
      `Which of these describes ${what}?`,
      `${hi} के बारे में कौन सा सही है?`,
      `${gu} વિશે કયું સાચું છે?`,
      opts, correct,
    )
  }

  for (const [what, hi, gu, , opts, correct] of TECHNIQUE) {
    mcq(
      `Which of these best describes ${what}?`,
      `${hi} को सबसे अच्छा कौन बताता है?`,
      `${gu} ને શ્રેષ્ઠ રીતે કયું વર્ણવે છે?`,
      opts, correct,
    )
  }

  for (const [item, hi, gu, opts, correct] of EQUIPMENT) {
    mcq(
      `What is ${item} used for?`,
      `${hi} किसलिए इस्तेमाल होता है?`,
      `${gu} શા માટે વપરાય છે?`,
      opts, correct,
    )
    mcq(
      `How often should ${item} be cleaned?`,
      `${hi} को कितनी बार साफ़ करना चाहिए?`,
      `${gu} ને કેટલી વાર સાફ કરવું જોઈએ?`,
      ['After every use', 'Once a week', 'Once a month', 'Only when faulty'], 'A',
    )
  }

  for (const [item, hi, gu, opts, correct] of DISHES) {
    mcq(
      `Which of these describes ${item}?`,
      `${hi} को कौन सा सही बताता है?`,
      `${gu} ને કયું સાચું વર્ણવે છે?`,
      opts, correct,
    )
    mcq(
      `A guest asks about the ingredients of ${item}. What should you do?`,
      `कोई ग्राहक ${hi} की सामग्री पूछता है। आपको क्या करना चाहिए?`,
      `ગ્રાહક ${gu} ની સામગ્રી પૂછે છે. તમારે શું કરવું જોઈએ?`,
      ['Check the recipe and allergen sheet', 'Guess from memory', 'Say it is safe', 'Refuse to answer'], 'A',
    )
  }

  for (const [item, hi, gu, opts, correct] of HYGIENE) {
    mcq(
      `What is the correct practice regarding ${item}?`,
      `${hi} के बारे में सही तरीक़ा क्या है?`,
      `${gu} વિશે યોગ્ય રીત કઈ છે?`,
      opts, correct,
    )
    mcq(
      `Who should be informed first about ${item}?`,
      `${hi} के बारे में सबसे पहले किसे बताना चाहिए?`,
      `${gu} વિશે સૌથી પહેલાં કોને જણાવવું જોઈએ?`,
      ['Your supervisor', 'A colleague', 'The customer', 'Nobody'], 'A',
    )
  }

  for (const [item, hi, gu, opts, correct] of HACCP) {
    mcq(
      `Which of these correctly describes ${item}?`,
      `${hi} को कौन सा सही बताता है?`,
      `${gu} ને કયું સાચું વર્ણવે છે?`,
      opts, correct,
    )
    mcq(
      `Why does ${item} matter in a professional kitchen?`,
      `पेशेवर रसोई में ${hi} क्यों ज़रूरी है?`,
      `વ્યાવસાયિક રસોડામાં ${gu} કેમ જરૂરી છે?`,
      ['It keeps food safe and traceable', 'It reduces the menu price', 'It speeds up service', 'It is optional paperwork'], 'A',
    )
  }

  /*
   * Short answers. The pool is smaller than the MCQ pool by design — a paper
   * needs 4 of them at 20 marks and 10 at 50, so fifteen per level is ample
   * headroom while keeping the corpus reviewable.
   *
   * Each is asked twice, once as a direct question and once as a "state/name"
   * instruction, because the two read differently on a printed paper and the
   * unique index is on the English text.
   */
  const shorts = []
  let s = 0
  for (const [enQ, hiQ, guQ, answer, why] of SHORT) {
    for (const [prefixEn, prefixHi, prefixGu] of [
      ['', '', ''],
      ['In your own words: ', 'अपने शब्दों में: ', 'તમારા શબ્દોમાં: '],
      ['Briefly explain — ', 'संक्षेप में समझाइए — ', 'ટૂંકમાં સમજાવો — '],
    ]) {
      shorts.push({
        type: 'short_answer',
        topic: TOPICS[s % TOPICS.length],
        seq: s,
        en: { q: prefixEn + enQ, answer, why },
        hi: { q: prefixHi + hiQ, answer, why },
        gu: { q: prefixGu + guQ, answer, why },
      })
      s += 1
    }
  }

  return { mcqs: questions, shorts, untranslated: [...untranslated].sort() }
}
