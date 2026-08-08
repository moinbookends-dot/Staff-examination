/**
 * PHASE 0 SPIKE — can this renderer shape Devanagari and Gujarati?
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT THIS IS PROVING, AND WHY A GLANCE AT THE PDF IS NOT ENOUGH.          ║
 * ║                                                                           ║
 * ║ An unshaped Indic PDF is not blank and does not error. It renders every   ║
 * ║ codepoint, in the order they are stored, and looks like text to anybody   ║
 * ║ who cannot read the script. That is the failure mode this file exists to  ║
 * ║ catch before 6,000 questions are printed wrongly.                         ║
 * ║                                                                           ║
 * ║ The strings below are chosen so the failure is VISIBLE, not subtle:       ║
 * ║                                                                           ║
 * ║  · REORDERING — Devanagari ि (U+093F) and Gujarati િ (U+0ABF) are stored  ║
 * ║    AFTER their consonant and must render BEFORE it. In किस the ि belongs  ║
 * ║    to the left of क. Unshaped output puts it on the right: क ि स. This is ║
 * ║    the single most diagnostic character in the whole test.                ║
 * ║                                                                           ║
 * ║  · CONJUNCTS — क् + ख must fuse into क्ख, म् + र into म्र, પ્ + ર into પ્ર.   ║
 * ║    Unshaped output shows the bare virama (्) sitting between two full     ║
 * ║    letters instead of one ligature.                                       ║
 * ║                                                                           ║
 * ║  · MATRA STACKING — ि ी ु ू ं ँ ृ attach above, below and around the      ║
 * ║    consonant. Unshaped output lays them out as separate advancing glyphs. ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Run:  node scripts/pdf-spike.mjs
 * Then LOOK at the file it writes. This script cannot tell you it is right.
 */

import { createElement as h } from 'react'
import path from 'node:path'
import fs from 'node:fs'
import ReactPDF, { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer'

const FONT_DIR = path.resolve('public/fonts')
const OUT = path.resolve('scripts/.spike/shaping-test.pdf')

// ─────────────────────────────────────────────────────────────────────────────
// Fonts
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Three families, registered separately rather than as one fallback chain.
 *
 * react-pdf has no automatic font fallback: a glyph missing from the active
 * font renders as a blank box, silently. Since every paper is generated in ONE
 * language, the renderer picks the family for that language and there is
 * nothing to fall back from — which is simpler and safer than hoping a chain
 * resolves correctly for a script it was not built for.
 */
Font.register({ family: 'NotoLatin', src: path.join(FONT_DIR, 'NotoSans-VF.ttf') })
Font.register({ family: 'NotoDeva', src: path.join(FONT_DIR, 'NotoSansDevanagari-VF.ttf') })
Font.register({ family: 'NotoGuj', src: path.join(FONT_DIR, 'NotoSansGujarati-VF.ttf') })

// ─────────────────────────────────────────────────────────────────────────────
// The test corpus — real exam content, chosen for the shaping it exercises
// ─────────────────────────────────────────────────────────────────────────────

const CASES = [
  {
    locale: 'en',
    label: 'ENGLISH — control. If this is wrong, nothing else matters.',
    font: 'NotoLatin',
    question: 'Which oil has the highest smoke point?',
    options: ['Butter', 'Olive oil', 'Rice bran oil', 'Coconut oil'],
    short: 'At what temperature should poultry be cooked?',
    answer: '74°C for 15 seconds',
    notes: 'Baseline only. Latin needs no reordering.',
  },
  {
    locale: 'hi',
    label: 'HINDI (Devanagari)',
    font: 'NotoDeva',
    question: 'किस तेल का धूम्र बिंदु सबसे अधिक है?',
    options: ['मक्खन', 'जैतून का तेल', 'चावल की भूसी का तेल', 'नारियल का तेल'],
    short: 'मुर्गी को किस तापमान पर पकाना चाहिए?',
    answer: '15 सेकंड के लिए 74°C',
    notes:
      'CHECK: किस — the ि must sit LEFT of क. मक्खन — क्ख is ONE ligature. ' +
      'धूम्र — म्र is one ligature. मुर्गी — the र् rides ABOVE as a reph.',
  },
  {
    locale: 'gu',
    label: 'GUJARATI',
    font: 'NotoGuj',
    question: 'કયા તેલનું ધુમ્ર બિંદુ સૌથી વધુ છે?',
    options: ['માખણ', 'ઓલિવ તેલ', 'ચોખાની કુશકીનું તેલ', 'નાળિયેર તેલ'],
    short: 'મરઘાંને કયા તાપમાને રાંધવું જોઈએ?',
    answer: '15 સેકન્ડ માટે 74°C',
    notes:
      'CHECK: બિંદુ — the િ must sit LEFT of બ. ધુમ્ર — મ્ર is ONE ligature. ' +
      'તેલનું — the ું stacks above. સેકન્ડ — ન્ડ is one ligature.',
  },
]

/*
 * The reordering probe, isolated.
 *
 * Above, a wrong ि hides inside a sentence. Here each pair is printed alone and
 * large, so the difference between "correct" and "the matra is on the wrong
 * side" is unmissable even to a reader who knows neither script.
 */
const REORDER_PROBES = [
  { font: 'NotoDeva', script: 'Devanagari', pairs: ['कि', 'कु', 'को', 'कौ', 'क्क', 'र्क', 'क्र'] },
  { font: 'NotoGuj', script: 'Gujarati', pairs: ['કિ', 'કુ', 'કો', 'કૌ', 'ક્ક', 'ર્ક', 'ક્ર'] },
]

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: 'NotoLatin' },
  h1: { fontSize: 16, marginBottom: 4 },
  intro: { fontSize: 9, color: '#555', marginBottom: 16, lineHeight: 1.4 },
  block: { marginBottom: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#ddd' },
  label: { fontSize: 9, color: '#666', marginBottom: 6, fontFamily: 'NotoLatin' },
  q: { fontSize: 13, marginBottom: 8, lineHeight: 1.6 },
  opt: { fontSize: 12, marginBottom: 5, lineHeight: 1.6, paddingLeft: 12 },
  notes: { fontSize: 8, color: '#a00', marginTop: 8, lineHeight: 1.4, fontFamily: 'NotoLatin' },
  probeRow: { flexDirection: 'row', marginBottom: 10, alignItems: 'center' },
  probe: { fontSize: 30, marginRight: 22 },
})

function caseBlock(c) {
  return h(
    View,
    { style: styles.block, key: c.locale },
    h(Text, { style: styles.label }, c.label),
    h(Text, { style: [styles.q, { fontFamily: c.font }] }, `1.  ${c.question}   [1]`),
    ...c.options.map((o, i) =>
      h(Text, { style: [styles.opt, { fontFamily: c.font }], key: i }, `(${'ABCD'[i]})  ${o}`),
    ),
    h(Text, { style: [styles.q, { fontFamily: c.font, marginTop: 10 }] }, `2.  ${c.short}   [1]`),
    h(Text, { style: [styles.opt, { fontFamily: c.font }] }, `ANSWER:  ${c.answer}`),
    h(Text, { style: styles.notes }, c.notes),
  )
}

function probeBlock(p) {
  return h(
    View,
    { style: styles.block, key: p.script },
    h(Text, { style: styles.label }, `${p.script} — matra reordering and conjuncts, isolated`),
    h(
      View,
      { style: styles.probeRow },
      ...p.pairs.map((s, i) => h(Text, { style: [styles.probe, { fontFamily: p.font }], key: i }, s)),
    ),
  )
}

const doc = h(
  Document,
  null,
  h(
    Page,
    { size: 'A4', style: styles.page },
    h(Text, { style: styles.h1 }, 'Bookends LMS — PDF shaping spike'),
    h(
      Text,
      { style: styles.intro },
      'Phase 0. If the Hindi and Gujarati below are correctly shaped, @react-pdf/renderer ' +
        'is the PDF engine for this project. If any matra sits on the wrong side of its ' +
        'consonant, or a virama appears between two full letters instead of forming a ' +
        'ligature, the fallback is Playwright + headless Chromium. Read the red notes.',
    ),
    ...CASES.map(caseBlock),
    ...REORDER_PROBES.map(probeBlock),
  ),
)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
await ReactPDF.renderToFile(doc, OUT)

const size = fs.statSync(OUT).size
console.log(`\n  Wrote ${OUT}  (${size.toLocaleString()} bytes)`)
console.log('  Now LOOK at it. This script cannot tell you whether the shaping is right.\n')
