/**
 * Message keys for the profile screen and the notification bell.
 * One table, three files — see the other add-*-messages.mjs for why.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** namespace → [key, en, hi, gu][] */
const BLOCKS = {
  profile: [
    ['title', 'Your profile', 'आपकी प्रोफ़ाइल', 'તમારી પ્રોફાઇલ'],
    [
      'subtitle',
      'Your details, and where you sit in the organisation.',
      'आपका विवरण, और संगठन में आपकी जगह।',
      'તમારી વિગતો, અને સંસ્થામાં તમારું સ્થાન.',
    ],
    ['yourDetails', 'Your details', 'आपका विवरण', 'તમારી વિગતો'],
    [
      'yourDetailsHint',
      'These are yours to change.',
      'ये आप बदल सकते हैं।',
      'આ તમે બદલી શકો છો.',
    ],
    ['yourPlace', 'Your role and place', 'आपकी भूमिका और जगह', 'તમારી ભૂમિકા અને સ્થાન'],
    [
      'yourPlaceHint',
      'Set by your manager when your account was approved. Ask them if any of it is wrong.',
      'खाता स्वीकृत होते समय आपके प्रबंधक ने तय किया। कुछ ग़लत हो तो उनसे कहें।',
      'ખાતું મંજૂર થતી વખતે તમારા મેનેજરે નક્કી કર્યું. કંઈ ખોટું હોય તો તેમને કહો.',
    ],
    ['fullName', 'Full name', 'पूरा नाम', 'પૂરું નામ'],
    ['phone', 'Phone number', 'फ़ोन नंबर', 'ફોન નંબર'],
    ['phoneHint', 'Optional. Leave blank to remove it.', 'वैकल्पिक। हटाने के लिए ख़ाली छोड़ें।', 'વૈકલ્પિક. દૂર કરવા ખાલી છોડો.'],
    ['language', 'Preferred language', 'पसंदीदा भाषा', 'પસંદગીની ભાષા'],
    [
      'languageHint',
      'The language your papers and screens use.',
      'आपके पेपर और स्क्रीन इसी भाषा में।',
      'તમારા પેપર અને સ્ક્રીન આ ભાષામાં.',
    ],
    ['save', 'Save changes', 'बदलाव सेव करें', 'ફેરફારો સેવ કરો'],
    ['saved', 'Your details have been saved.', 'आपका विवरण सेव हो गया।', 'તમારી વિગતો સેવ થઈ ગઈ.'],
    ['email', 'Email', 'ईमेल', 'ઈમેલ'],
    ['role', 'Role', 'भूमिका', 'ભૂમિકા'],
    ['noRole', 'No role assigned', 'कोई भूमिका नहीं', 'કોઈ ભૂમિકા નથી'],
    ['company', 'Company', 'कंपनी', 'કંપની'],
    ['brand', 'Brand', 'ब्रांड', 'બ્રાન્ડ'],
    ['outlet', 'Outlet', 'आउटलेट', 'આઉટલેટ'],
    ['department', 'Department', 'विभाग', 'વિભાગ'],
    ['employeeCode', 'Employee code', 'कर्मचारी कोड', 'કર્મચારી કોડ'],
    ['joined', 'Joined', 'शामिल हुए', 'જોડાયા'],
    ['unset', 'Not set', 'तय नहीं', 'નક્કી નથી'],
  ],
  notifications: [
    ['label', 'Notifications', 'सूचनाएँ', 'સૂચનાઓ'],
    ['withCount', 'Notifications, {n} unread', 'सूचनाएँ, {n} अपठित', 'સૂચનાઓ, {n} વણવાંચેલી'],
    ['empty', 'Nothing yet.', 'अभी कुछ नहीं।', 'હજી કંઈ નથી.'],
    ['markAllRead', 'Mark all read', 'सब पढ़ा हुआ', 'બધું વાંચ્યું'],
    ['close', 'Close notifications', 'सूचनाएँ बंद करें', 'સૂચનાઓ બંધ કરો'],
  ],
}

const LOCALES = ['en', 'hi', 'gu']

for (const [index, locale] of LOCALES.entries()) {
  const path = resolve('messages', `${locale}.json`)
  const json = JSON.parse(readFileSync(path, 'utf-8'))

  for (const [namespace, keys] of Object.entries(BLOCKS)) {
    json[namespace] ??= {}
    for (const [key, ...values] of keys) json[namespace][key] = values[index]
  }

  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf-8')
  console.log(
    `  ${locale}: ` +
      Object.entries(BLOCKS).map(([ns, k]) => `${ns} +${k.length}`).join(', '),
  )
}
