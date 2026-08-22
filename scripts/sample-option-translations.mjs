/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Hindi and Gujarati for every MCQ option string in the sample corpus.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS FILE EXISTS SEPARATELY FROM sample-questions.mjs.                ║
 * ║                                                                           ║
 * ║ That file holds fact tables a person can read and check — foods and their ║
 * ║ safe temperatures, allergens, knife cuts. This is bulk lookup data. Mixing ║
 * ║ them would bury the facts under three hundred lines of translation.       ║
 * ║                                                                           ║
 * ║ Keyed on the exact English string, so an option used by twelve questions  ║
 * ║ is translated once and cannot drift between them.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * NUMBERS AND UNITS MAP TO THEMSELVES. `74 °C` is `74 °C` in every language;
 * "translating" it would be wrong rather than merely unnecessary. They are
 * listed explicitly rather than left out, so a string missing from this table
 * means a genuine gap and the seed script can report it as one.
 *
 * These translations are illustrative demonstration content, in keeping with
 * the rest of the sample corpus. They are not exam-grade.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** English → [Hindi, Gujarati]. */
export const OPTION_TRANSLATIONS = {
  // ── Temperatures, times and other unit values: identical in every script ──
  '4 °C': ['4 °C', '4 °C'], '52 °C': ['52 °C', '52 °C'], '55 °C': ['55 °C', '55 °C'],
  '57 °C': ['57 °C', '57 °C'], '58 °C': ['58 °C', '58 °C'], '60 °C': ['60 °C', '60 °C'],
  '63 °C': ['63 °C', '63 °C'], '65 °C': ['65 °C', '65 °C'], '68 °C': ['68 °C', '68 °C'],
  '70 °C': ['70 °C', '70 °C'], '71 °C': ['71 °C', '71 °C'], '74 °C': ['74 °C', '74 °C'],
  '75 °C': ['75 °C', '75 °C'], '77 °C': ['77 °C', '77 °C'], '79 °C': ['79 °C', '79 °C'],
  '80 °C': ['80 °C', '80 °C'], '82 °C': ['82 °C', '82 °C'], '85 °C': ['85 °C', '85 °C'],
  '88 °C': ['88 °C', '88 °C'], '90 °C': ['90 °C', '90 °C'], '100 °C': ['100 °C', '100 °C'],
  '0 °C': ['0 °C', '0 °C'], '−5 °C': ['−5 °C', '−5 °C'], '−12 °C': ['−12 °C', '−12 °C'],
  '5 °C': ['5 °C', '5 °C'], '8 °C': ['8 °C', '8 °C'], '10 °C': ['10 °C', '10 °C'],
  '12 °C': ['12 °C', '12 °C'], '45 °C': ['45 °C', '45 °C'], '50 °C': ['50 °C', '50 °C'],
  '1–4 °C': ['1–4 °C', '1–4 °C'], '6–9 °C': ['6–9 °C', '6–9 °C'],
  '10–12 °C': ['10–12 °C', '10–12 °C'], '−2–0 °C': ['−2–0 °C', '−2–0 °C'],
  '−18 °C or below': ['−18 °C या उससे कम', '−18 °C કે તેથી ઓછું'],
  '63 °C or above': ['63 °C या उससे ऊपर', '63 °C કે તેથી વધુ'],
  '70 °C or above': ['70 °C या उससे ऊपर', '70 °C કે તેથી વધુ'],
  '55 °C or above': ['55 °C या उससे ऊपर', '55 °C કે તેથી વધુ'],
  '50 °C or above': ['50 °C या उससे ऊपर', '50 °C કે તેથી વધુ'],
  '5 °C or below': ['5 °C या उससे कम', '5 °C કે તેથી ઓછું'],
  '5 °C to 63 °C': ['5 °C से 63 °C', '5 °C થી 63 °C'],
  '0 °C to 40 °C': ['0 °C से 40 °C', '0 °C થી 40 °C'],
  '10 °C to 50 °C': ['10 °C से 50 °C', '10 °C થી 50 °C'],
  '20 °C to 80 °C': ['20 °C से 80 °C', '20 °C થી 80 °C'],
  '30 minutes': ['30 मिनट', '30 મિનિટ'],
  '1 hour': ['1 घंटा', '1 કલાક'],
  '2 hours': ['2 घंटे', '2 કલાક'],
  '4 hours': ['4 घंटे', '4 કલાક'],
  '1 day': ['1 दिन', '1 દિવસ'],
  '3 days': ['3 दिन', '3 દિવસ'],
  '7 days': ['7 दिन', '7 દિવસ'],
  '14 days': ['14 दिन', '14 દિવસ'],
  '5 seconds': ['5 सेकंड', '5 સેકન્ડ'],
  '30 seconds': ['30 सेकंड', '30 સેકન્ડ'],
  '75 °C or above': ['75 °C या उससे ऊपर', '75 °C કે તેથી વધુ'],
  '10 seconds': ['10 सेकंड', '10 સેકન્ડ'],
  '20 seconds': ['20 सेकंड', '20 સેકન્ડ'],
  '60 seconds': ['60 सेकंड', '60 સેકન્ડ'],
  '5 minutes': ['5 मिनट', '5 મિનિટ'],
  '20 minutes': ['20 मिनट', '20 મિનિટ'],
  'within 30 minutes': ['30 मिनट के भीतर', '30 મિનિટમાં'],
  'within 90 minutes': ['90 मिनट के भीतर', '90 મિનિટમાં'],
  'within 4 hours': ['4 घंटे के भीतर', '4 કલાકમાં'],
  'within 8 hours': ['8 घंटे के भीतर', '8 કલાકમાં'],
  'Pink centre, 63 °C': ['बीच में गुलाबी, 63 °C', 'વચ્ચે ગુલાબી, 63 °C'],

  // ── Probe placement ───────────────────────────────────────────────────────
  'At the surface': ['सतह पर', 'સપાટી પર'],
  'At the thickest part': ['सबसे मोटे हिस्से में', 'સૌથી જાડા ભાગમાં'],
  'Near the bone': ['हड्डी के पास', 'હાડકાં પાસે'],
  'At the edge': ['किनारे पर', 'કિનારે'],

  // ── Frequencies ───────────────────────────────────────────────────────────
  'After every use': ['हर बार इस्तेमाल के बाद', 'દરેક ઉપયોગ પછી'],
  'Once a week': ['सप्ताह में एक बार', 'અઠવાડિયે એક વાર'],
  'once a week': ['सप्ताह में एक बार', 'અઠવાડિયે એક વાર'],
  'Once a month': ['महीने में एक बार', 'મહિને એક વાર'],
  'At least daily': ['कम से कम रोज़', 'ઓછામાં ઓછું રોજ'],
  'Only on inspection': ['सिर्फ़ निरीक्षण पर', 'ફક્ત નિરીક્ષણ વખતે'],
  'Only when faulty': ['सिर्फ़ ख़राब होने पर', 'ફક્ત ખરાબ થાય ત્યારે'],
  'at the end of the shift': ['शिफ़्ट के अंत में', 'શિફ્ટના અંતે'],
  'only when visibly dirty': ['सिर्फ़ दिखने में गंदा होने पर', 'ફક્ત દેખીતું ગંદું હોય ત્યારે'],
  'between raw and ready-to-eat food': ['कच्चे और तैयार भोजन के बीच', 'કાચા અને તૈયાર ખોરાક વચ્ચે'],
  'One day': ['एक दिन', 'એક દિવસ'],
  'Until the next shift': ['अगली शिफ़्ट तक', 'આગલી શિફ્ટ સુધી'],
  'They need not be kept': ['रखने की ज़रूरत नहीं', 'રાખવાની જરૂર નથી'],
  'As required by local law': ['स्थानीय क़ानून के अनुसार', 'સ્થાનિક કાયદા મુજબ'],

  // ── Storage locations ─────────────────────────────────────────────────────
  'the top shelf': ['सबसे ऊपर वाला खाना', 'સૌથી ઉપરનું ખાનું'],
  'the middle shelf': ['बीच वाला खाना', 'વચ્ચેનું ખાનું'],
  'the bottom shelf': ['सबसे नीचे वाला खाना', 'સૌથી નીચેનું ખાનું'],
  'the door': ['दरवाज़े में', 'દરવાજામાં'],
  'the freezer': ['फ़्रीज़र में', 'ફ્રીઝરમાં'],
  'the salad drawer': ['सलाद दराज़', 'સલાડ ડ્રોઅર'],

  // ── Cleaning ──────────────────────────────────────────────────────────────
  'clean, then sanitise': ['साफ़ करें, फिर सैनिटाइज़', 'સાફ કરો, પછી સેનિટાઇઝ'],
  'sanitise only': ['सिर्फ़ सैनिटाइज़', 'ફક્ત સેનિટાઇઝ'],
  'sanitise, then clean': ['सैनिटाइज़, फिर साफ़', 'સેનિટાઇઝ, પછી સાફ'],
  'rinse only': ['सिर्फ़ धोना', 'ફક્ત ધોવું'],
  'wash, rinse, sanitise': ['धोना, खंगालना, सैनिटाइज़', 'ધોવું, ખંગાળવું, સેનિટાઇઝ'],
  'wash, dry, store': ['धोना, सुखाना, रखना', 'ધોવું, સૂકવવું, રાખવું'],
  'soak, scrub, dry': ['भिगोना, रगड़ना, सुखाना', 'પલાળવું, ઘસવું, સૂકવવું'],
  'rinse, soak, wash': ['खंगालना, भिगोना, धोना', 'ખંગાળવું, પલાળવું, ધોવું'],
  'Scrubbing while hot': ['गरम रहते रगड़ना', 'ગરમ હોય ત્યારે ઘસવું'],
  'Rinsing with water': ['पानी से धोना', 'પાણીથી ધોવું'],
  'Sterilise plates': ['प्लेट स्टरलाइज़ करना', 'પ્લેટ સ્ટરિલાઇઝ કરવી'],
  'Wash utensils': ['बर्तन धोना', 'વાસણ ધોવાં'],

  // ── Technique ─────────────────────────────────────────────────────────────
  'thin matchsticks': ['पतली माचिस जैसी कटाई', 'પાતળી દીવાસળી જેવો કાપ'],
  'small cubes': ['छोटे टुकड़े', 'નાના ટુકડા'],
  'thin rounds': ['पतले गोल टुकड़े', 'પાતળા ગોળ ટુકડા'],
  'coarse shreds': ['मोटी कतरन', 'જાડી કતરણ'],
  'very small dice': ['बहुत बारीक़ कटाई', 'ખૂબ ઝીણો કાપ'],
  'long strips': ['लंबी पट्टियाँ', 'લાંબી પટ્ટીઓ'],
  'thick wedges': ['मोटे फाँक', 'જાડા ફાડિયા'],
  'diagonal slices': ['तिरछे टुकड़े', 'ત્રાંસા ટુકડા'],
  'ribbons of leafy herbs': ['पत्तेदार जड़ी-बूटी की पट्टियाँ', 'પાંદડાંવાળી વનસ્પતિની પટ્ટીઓ'],
  'cubed root vegetables': ['कंद सब्ज़ियों के टुकड़े', 'કંદ શાકના ટુકડા'],
  'crushed garlic': ['कुटा हुआ लहसुन', 'છૂંદેલું લસણ'],
  'sliced onion rings': ['प्याज़ के छल्ले', 'ડુંગળીના રિંગ'],
  'brief boiling then ice water': ['थोड़ा उबालकर बर्फ़ के पानी में', 'થોડું ઉકાળી બરફના પાણીમાં'],
  'slow roasting': ['धीमी भुनाई', 'ધીમું શેકવું'],
  'deep frying': ['डीप फ्राई', 'ડીપ ફ્રાય'],
  'curing in salt': ['नमक में क्योर करना', 'મીઠામાં ક્યોર કરવું'],
  'fat and flour': ['वसा और आटा', 'ચરબી અને લોટ'],
  'egg and cream': ['अंडा और क्रीम', 'ઈંડું અને ક્રીમ'],
  'stock and wine': ['स्टॉक और वाइन', 'સ્ટોક અને વાઇન'],
  'butter and sugar': ['मक्खन और चीनी', 'માખણ અને ખાંડ'],
  'milk and roux': ['दूध और रू', 'દૂધ અને રૂ'],
  'tomato and garlic': ['टमाटर और लहसुन', 'ટામેટાં અને લસણ'],
  'Tomato and garlic': ['टमाटर और लहसुन', 'ટામેટાં અને લસણ'],
  'stock and cream': ['स्टॉक और क्रीम', 'સ્ટોક અને ક્રીમ'],
  'egg yolk and butter': ['अंडे की जर्दी और मक्खन', 'ઈંડાની જરદી અને માખણ'],
  'tomato and stock': ['टमाटर और स्टॉक', 'ટામેટાં અને સ્ટોક'],
  'cream and cheese': ['क्रीम और चीज़', 'ક્રીમ અને ચીઝ'],
  'combining fat and liquid': ['वसा और तरल मिलाना', 'ચરબી અને પ્રવાહી ભેળવવું'],
  'boiling off water': ['पानी उड़ाना', 'પાણી ઉડાડવું'],
  'freezing a sauce': ['सॉस जमाना', 'સોસ થીજવવો'],
  'browning sugar': ['चीनी भूनना', 'ખાંડ શેકવી'],
  'Lifting fond with liquid': ['तरल से पैन का रस उठाना', 'પ્રવાહીથી પેનનો રસ ઉઠાવવો'],
  'Draining the fat': ['चर्बी निकालना', 'ચરબી કાઢવી'],
  'Cooling rapidly': ['तेज़ी से ठंडा करना', 'ઝડપથી ઠંડું કરવું'],
  'Controlled heating and cooling': ['नियंत्रित गरम और ठंडा करना', 'નિયંત્રિત ગરમ-ઠંડું કરવું'],
  'Adding water': ['पानी मिलाना', 'પાણી ઉમેરવું'],
  'Freezing quickly': ['जल्दी जमाना', 'ઝડપથી થીજવવું'],
  'Whipping air in': ['हवा फेंटना', 'હવા ફીણવી'],

  // ── Dishes ────────────────────────────────────────────────────────────────
  'Tomato, mozzarella, basil': ['टमाटर, मोज़रेला, तुलसी', 'ટામેટાં, મોઝેરેલા, તુલસી'],
  'Pepperoni and onion': ['पेपरोनी और प्याज़', 'પેપરોની અને ડુંગળી'],
  'Four cheeses': ['चार चीज़', 'ચાર ચીઝ'],
  'Ham and pineapple': ['हैम और अनानास', 'હેમ અને અનાનસ'],
  'Egg, cheese, cured pork': ['अंडा, चीज़, क्योर पोर्क', 'ઈંડું, ચીઝ, ક્યોર પોર્ક'],
  'Cream and mushroom': ['क्रीम और मशरूम', 'ક્રીમ અને મશરૂમ'],
  'Tomato and chilli': ['टमाटर और मिर्च', 'ટામેટાં અને મરચું'],
  'Pesto and pine nut': ['पेस्तो और चिलगोज़ा', 'પેસ્તો અને ચિલગોજા'],
  'Basil, pine nut, cheese, oil': ['तुलसी, चिलगोज़ा, चीज़, तेल', 'તુલસી, ચિલગોજા, ચીઝ, તેલ'],
  'Anchovy, egg, parmesan': ['एंकोवी, अंडा, परमेज़ान', 'એન્કોવી, ઈંડું, પરમેઝાન'],
  'Yoghurt and mint': ['दही और पुदीना', 'દહીં અને ફુદીનો'],
  'Tomato and basil': ['टमाटर और तुलसी', 'ટામેટાં અને તુલસી'],
  'Soy and ginger': ['सोया और अदरक', 'સોયા અને આદુ'],
  'Three parts oil to one acid': ['तीन भाग तेल, एक भाग अम्ल', 'ત્રણ ભાગ તેલ, એક ભાગ એસિડ'],
  'Equal oil and acid': ['बराबर तेल और अम्ल', 'સરખું તેલ અને એસિડ'],
  'One oil to three acid': ['एक तेल, तीन अम्ल', 'એક તેલ, ત્રણ એસિડ'],
  'Oil only': ['सिर्फ़ तेल', 'ફક્ત તેલ'],
  'Firm to the bite': ['काटने में सख़्त', 'ચાવવામાં કડક'],
  'Very soft': ['बहुत नरम', 'ખૂબ નરમ'],
  'Raw in the centre': ['बीच में कच्चा', 'વચ્ચે કાચું'],
  'Crisp and dry': ['कुरकुरा और सूखा', 'કડક અને સૂકું'],
  'Fully grey throughout': ['पूरी तरह भूरा', 'સંપૂર્ણ ભૂખરું'],
  'Cold centre': ['बीच में ठंडा', 'વચ્ચે ઠંડું'],
  'Charred outside only': ['सिर्फ़ बाहर से जला', 'ફક્ત બહારથી બળેલું'],
  'A pouring custard': ['डालने वाला कस्टर्ड', 'રેડવાનું કસ્ટર્ડ'],
  'A whipped cream': ['फेंटी हुई क्रीम', 'ફીણેલી ક્રીમ'],
  'A fruit coulis': ['फल का कुली', 'ફળનું કુલી'],
  'A caramel sauce': ['कैरेमल सॉस', 'કેરેમલ સોસ'],
  'Chocolate and cream': ['चॉकलेट और क्रीम', 'ચોકલેટ અને ક્રીમ'],
  'Sugar and water': ['चीनी और पानी', 'ખાંડ અને પાણી'],
  'Egg and butter': ['अंडा और मक्खन', 'ઈંડું અને માખણ'],
  'Egg and lemon': ['अंडा और नींबू', 'ઈંડું અને લીંબુ'],
  'Flour and milk': ['आटा और दूध', 'લોટ અને દૂધ'],
  'Cream and butter': ['क्रीम और मक्खन', 'ક્રીમ અને માખણ'],
  'Onion, carrot, celery': ['प्याज़, गाजर, अजमोद', 'ડુંગળી, ગાજર, સેલરી'],
  'Garlic and ginger': ['लहसुन और अदरक', 'લસણ અને આદુ'],
  'Leek and potato': ['लीक और आलू', 'લીક અને બટાટા'],

  // ── Equipment ─────────────────────────────────────────────────────────────
  'Cool food rapidly': ['खाना तेज़ी से ठंडा करना', 'ખોરાક ઝડપથી ઠંડો કરવો'],
  'Hold food hot': ['खाना गरम रखना', 'ખોરાક ગરમ રાખવો'],
  'Hold food hot in water': ['पानी में खाना गरम रखना', 'પાણીમાં ખોરાક ગરમ રાખવો'],
  'Prove dough': ['आटा फुलाना', 'લોટ ફુલાવવો'],
  'Let dough rise warm': ['आटे को गरमी में फुलाना', 'લોટને ગરમીમાં ફુલાવવો'],
  'Dry herbs': ['जड़ी-बूटी सुखाना', 'વનસ્પતિ સૂકવવી'],
  'Grill and glaze from above': ['ऊपर से ग्रिल और ग्लेज़', 'ઉપરથી ગ્રિલ અને ગ્લેઝ'],
  'Freeze stock': ['स्टॉक जमाना', 'સ્ટોક થીજવવો'],
  'Knead dough': ['आटा गूँधना', 'લોટ બાંધવો'],
  'Knead bread dough': ['ब्रेड का आटा गूँधना', 'બ્રેડનો લોટ બાંધવો'],
  'Slice evenly and thinly': ['एक-सा पतला काटना', 'સરખું પાતળું કાપવું'],
  'Measure liquids': ['तरल मापना', 'પ્રવાહી માપવું'],
  'Whip cream': ['क्रीम फेंटना', 'ક્રીમ ફીણવી'],
  'Whip air into cream': ['क्रीम में हवा फेंटना', 'ક્રીમમાં હવા ફીણવી'],
  'Seal bags': ['बैग सील करना', 'બેગ સીલ કરવી'],
  'Measure core temperature': ['भीतरी तापमान मापना', 'અંદરનું તાપમાન માપવું'],
  'Weigh portions': ['हिस्से तौलना', 'ભાગ તોલવા'],
  'Time a bake': ['बेक का समय देखना', 'બેકનો સમય જોવો'],
  'Test pH': ['pH जाँचना', 'pH ચકાસવું'],
  'Remove air before storage': ['भंडारण से पहले हवा निकालना', 'સંગ્રહ પહેલાં હવા કાઢવી'],
  'Add carbonation': ['कार्बोनेशन जोड़ना', 'કાર્બોનેશન ઉમેરવું'],
  'Chill sauces': ['सॉस ठंडा करना', 'સોસ ઠંડો કરવો'],
  'Chill desserts': ['मिठाई ठंडी करना', 'મીઠાઈ ઠંડી કરવી'],
  'Chill dough': ['आटा ठंडा करना', 'લોટ ઠંડો કરવો'],
  'Smoke fish': ['मछली स्मोक करना', 'માછલી સ્મોક કરવી'],
  'Deep fry': ['डीप फ्राई करना', 'ડીપ ફ્રાય કરવું'],
  'Blast freeze': ['ब्लास्ट फ़्रीज़', 'બ્લાસ્ટ ફ્રીઝ'],
  'Grind spices': ['मसाले पीसना', 'મસાલા દળવા'],
  'Roll pasta': ['पास्ता बेलना', 'પાસ્તા વણવો'],
  'Roll dough to an even thickness': ['आटा एक-सी मोटाई में बेलना', 'લોટ સરખી જાડાઈમાં વણવો'],
  'Portion sauces': ['सॉस के हिस्से करना', 'સોસના ભાગ કરવા'],
  'Bake bread': ['ब्रेड बेक करना', 'બ્રેડ બેક કરવી'],
  'Hold the oil temperature': ['तेल का तापमान बनाए रखना', 'તેલનું તાપમાન જાળવવું'],
  'Filter the oil': ['तेल छानना', 'તેલ ગાળવું'],
  'Time the basket': ['बास्केट का समय देखना', 'બાસ્કેટનો સમય જોવો'],
  'Drain the fat': ['चर्बी निकालना', 'ચરબી કાઢવી'],
  'Beat and combine': ['फेंटना और मिलाना', 'ફીણવું અને ભેળવવું'],
  'Purée soup': ['सूप प्यूरे करना', 'સૂપ પ્યુરે કરવું'],

  // ── Allergens and service ─────────────────────────────────────────────────
  'Only if asked': ['सिर्फ़ पूछे जाने पर', 'ફક્ત પૂછે તો'],
  'Always, before ordering': ['हमेशा, ऑर्डर से पहले', 'હંમેશાં, ઓર્ડર પહેલાં'],
  'Only for children': ['सिर्फ़ बच्चों के लिए', 'ફક્ત બાળકો માટે'],
  'Never': ['कभी नहीं', 'ક્યારેય નહીં'],
  'Separate utensils and surfaces': ['अलग बर्तन और सतह', 'અલગ વાસણ અને સપાટી'],
  'Cooking at high heat': ['तेज़ आँच पर पकाना', 'તેજ આંચે રાંધવું'],
  'Serving quickly': ['जल्दी परोसना', 'ઝડપથી પીરસવું'],
  'Check the recipe and allergen sheet': ['रेसिपी और एलर्जन शीट देखें', 'રેસિપી અને એલર્જન શીટ જુઓ'],
  'Guess from memory': ['याद से अंदाज़ा लगाएँ', 'યાદથી અંદાજ લગાવો'],
  'Say it is safe': ['कह दें कि सुरक्षित है', 'કહો કે સલામત છે'],
  'Refuse to answer': ['जवाब देने से मना करें', 'જવાબ આપવાની ના પાડો'],

  // ── Personal hygiene ──────────────────────────────────────────────────────
  'Report and stay away 48 hours': ['सूचित करें और 48 घंटे दूर रहें', 'જાણ કરો અને 48 કલાક દૂર રહો'],
  'Wear gloves and continue': ['दस्ताने पहनकर काम जारी रखें', 'ગ્લોવ્ઝ પહેરી કામ ચાલુ રાખો'],
  'Work only on cold food': ['सिर्फ़ ठंडे भोजन पर काम करें', 'ફક્ત ઠંડા ખોરાક પર કામ કરો'],
  'Take a short break': ['थोड़ा विश्राम लें', 'થોડો વિરામ લો'],
  'Cover with a blue waterproof dressing': ['नीली वॉटरप्रूफ़ पट्टी लगाएँ', 'વાદળી વોટરપ્રૂફ પટ્ટી લગાવો'],
  'Leave it open to dry': ['सूखने के लिए खुला छोड़ें', 'સૂકવવા ખુલ્લું રાખો'],
  'Rinse and continue': ['धोकर काम जारी रखें', 'ધોઈને કામ ચાલુ રાખો'],
  'Wear two gloves': ['दो दस्ताने पहनें', 'બે ગ્લોવ્ઝ પહેરો'],
  'Remove all but a plain band': ['सादे छल्ले के अलावा सब उतारें', 'સાદી વીંટી સિવાય બધું ઉતારો'],
  'Wear freely': ['बेझिझक पहनें', 'મુક્તપણે પહેરો'],
  'Cover with tape': ['टेप से ढकें', 'ટેપથી ઢાંકો'],
  'Only rings allowed': ['सिर्फ़ अँगूठी ठीक है', 'ફક્ત વીંટી ચાલે'],
  'Tied back and covered': ['बाँधकर ढके हुए', 'બાંધીને ઢાંકેલા'],
  'Left loose': ['खुले छोड़े हुए', 'ખુલ્લા રાખેલા'],
  'Tucked into collar': ['कॉलर में दबाए', 'કોલરમાં દબાવેલા'],
  'Only a cap needed': ['सिर्फ़ टोपी चाहिए', 'ફક્ત ટોપી જોઈએ'],
  'Use a clean spoon each time': ['हर बार साफ़ चम्मच लें', 'દર વખતે સાફ ચમચી લો'],
  'Use fingers': ['उँगली से', 'આંગળીથી'],
  'Reuse the same spoon': ['वही चम्मच दोबारा', 'એ જ ચમચી ફરી'],
  'Taste from the pan': ['पैन से ही चखें', 'પેનમાંથી જ ચાખો'],
  'Change between tasks': ['हर काम के बीच बदलें', 'દરેક કામ વચ્ચે બદલો'],
  'Wear all shift': ['पूरी शिफ़्ट पहनें', 'આખી શિફ્ટ પહેરો'],
  'Wash and reuse': ['धोकर दोबारा', 'ધોઈને ફરી'],
  'Not required': ['ज़रूरी नहीं', 'જરૂરી નથી'],
  'Never permitted': ['कभी अनुमति नहीं', 'ક્યારેય પરવાનગી નથી'],
  'Allowed on breaks': ['ब्रेक में अनुमति', 'બ્રેકમાં પરવાનગી'],
  'Allowed by the door': ['दरवाज़े के पास अनुमति', 'દરવાજા પાસે પરવાનગી'],
  'Allowed if washed after': ['बाद में धोने पर अनुमति', 'પછી ધોવાથી પરવાનગી'],
  'Remove before leaving': ['बाहर जाने से पहले उतारें', 'બહાર જતાં પહેલાં ઉતારો'],
  'Keep on always': ['हमेशा पहने रहें', 'હંમેશાં પહેરી રાખો'],
  'Turn inside out': ['उलटा कर लें', 'ઊંધું કરી લો'],
  'Only for deliveries': ['सिर्फ़ डिलीवरी के लिए', 'ફક્ત ડિલિવરી માટે'],
  'Your supervisor': ['आपका पर्यवेक्षक', 'તમારા સુપરવાઇઝર'],
  'A colleague': ['सहकर्मी', 'સહકર્મી'],
  'The customer': ['ग्राहक', 'ગ્રાહક'],
  'Nobody': ['कोई नहीं', 'કોઈ નહીં'],

  // ── HACCP and records ─────────────────────────────────────────────────────
  'Hazard Analysis Critical Control Point': ['हैज़र्ड एनालिसिस क्रिटिकल कंट्रोल पॉइंट', 'હેઝાર્ડ એનાલિસિસ ક્રિટિકલ કંટ્રોલ પોઈન્ટ'],
  'Hygiene And Cleaning Control Plan': ['हाइजीन एंड क्लीनिंग कंट्रोल प्लान', 'હાઈજીન એન્ડ ક્લીનિંગ કંટ્રોલ પ્લાન'],
  'Health And Catering Compliance Policy': ['हेल्थ एंड कैटरिंग कंप्लायंस पॉलिसी', 'હેલ્થ એન્ડ કેટરિંગ કમ્પ્લાયન્સ પોલિસી'],
  'Hot And Cold Control Procedure': ['हॉट एंड कोल्ड कंट्रोल प्रोसीजर', 'હોટ એન્ડ કોલ્ડ કંટ્રોલ પ્રોસિજર'],
  'A step where a hazard is controlled': ['वह चरण जहाँ ख़तरा नियंत्रित हो', 'જ્યાં જોખમ નિયંત્રિત થાય તે તબક્કો'],
  'Any cleaning task': ['कोई भी सफ़ाई काम', 'કોઈ પણ સફાઈ કામ'],
  'The busiest service hour': ['सबसे व्यस्त सर्विस घंटा', 'સૌથી વ્યસ્ત સર્વિસ કલાક'],
  'The delivery door': ['डिलीवरी दरवाज़ा', 'ડિલિવરી દરવાજો'],
  'First in, first out': ['पहले आया, पहले गया', 'પહેલું આવ્યું, પહેલું ગયું'],
  'Fast in, fast out': ['जल्दी आया, जल्दी गया', 'ઝડપી આવ્યું, ઝડપી ગયું'],
  'Freshis first only': ['सिर्फ़ ताज़ा पहले', 'ફક્ત તાજું પહેલાં'],
  'Frozen in, fried out': ['जमा आया, तला गया', 'થીજેલું આવ્યું, તળેલું ગયું'],
  'A safety deadline': ['सुरक्षा की अंतिम तिथि', 'સલામતીની અંતિમ તારીખ'],
  'A quality suggestion': ['गुणवत्ता का सुझाव', 'ગુણવત્તાનું સૂચન'],
  'A quality guide': ['गुणवत्ता मार्गदर्शन', 'ગુણવત્તા માર્ગદર્શન'],
  'A delivery date': ['डिलीवरी तिथि', 'ડિલિવરી તારીખ'],
  'A stock code': ['स्टॉक कोड', 'સ્ટોક કોડ'],
  'A cooking time': ['पकाने का समय', 'રાંધવાનો સમય'],
  'A batch number': ['बैच नंबर', 'બેચ નંબર'],
  'Temperature, date and condition': ['तापमान, तिथि और स्थिति', 'તાપમાન, તારીખ અને સ્થિતિ'],
  'Price only': ['सिर्फ़ क़ीमत', 'ફક્ત કિંમત'],
  'Weight only': ['सिर्फ़ वज़न', 'ફક્ત વજન'],
  'Supplier name only': ['सिर्फ़ आपूर्तिकर्ता का नाम', 'ફક્ત સપ્લાયરનું નામ'],
  'It keeps food safe and traceable': ['यह भोजन सुरक्षित और ट्रेस-योग्य रखता है', 'તે ખોરાક સલામત અને ટ્રેસ કરી શકાય તેવો રાખે છે'],
  'It reduces the menu price': ['यह मेन्यू की क़ीमत घटाता है', 'તે મેન્યુની કિંમત ઘટાડે છે'],
  'It speeds up service': ['यह सर्विस तेज़ करता है', 'તે સર્વિસ ઝડપી કરે છે'],
  'It is optional paperwork': ['यह वैकल्पिक काग़ज़ी काम है', 'તે વૈકલ્પિક કાગળિયું છે'],
}

/**
 * Translate one option, or return it unchanged.
 *
 * Reports misses to the caller rather than swallowing them: an option with no
 * entry would print in English on a Hindi paper, which is the exact defect this
 * table was written to remove, so it must be visible.
 */
export function translateOption(english, localeIndex) {
  const entry = OPTION_TRANSLATIONS[english]
  if (!entry) return { text: english, missing: true }
  return { text: entry[localeIndex], missing: false }
}

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE GUJARATI HERE IS WRITTEN NATURALLY, INCLUDING અં AND આં.              ║
 * ║                                                                           ║
 * ║ It was not always. Those sequences — an independent vowel followed by      ║
 * ║ anusvara — used to CRASH the PDF renderer:                                 ║
 * ║                                                                           ║
 * ║   TypeError: Cannot read properties of null (reading 'xCoordinate')        ║
 * ║                                                                           ║
 * ║ found by bisecting a failing paper down to single strings, and worked      ║
 * ║ around here by rephrasing. That workaround is GONE, because the actual bug ║
 * ║ was found and fixed: patches/fontkit+2.0.4.patch.                          ║
 * ║                                                                           ║
 * ║ fontkit's GPOS applyAnchor() dereferenced a NULL anchor. A null anchor     ║
 * ║ offset is legal OpenType — it means a mark class has no attachment point   ║
 * ║ on that base — so the fix is to skip attachment rather than crash.         ║
 * ║                                                                           ║
 * ║ This mattered well beyond demo data: અંક means marks and આંખ means      ║
 * ║ eye. Any real Gujarati paper containing them could not be printed.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
