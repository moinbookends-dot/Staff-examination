import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { BankLocale, OptionKey } from '@/lib/bank/vocabulary'
import { OPTION_KEYS } from '@/lib/bank/vocabulary'
import { fontFamilyFor } from './fonts'
import type { PaperDocumentInput, PaperQuestion, PaperVariant } from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The printed paper and its answer key.
 *
 * Both are rendered from ONE PaperDocumentInput, which is what makes it
 * impossible for a key to describe a different paper than the paper it belongs
 * to. The only difference between them is `variant`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE QUESTION PAPER NEVER READS correctOption OR answerText.               │
 * │                                                                           │
 * │ Not "does not currently print them" — does not read them. The two fields  │
 * │ are touched in exactly one place below, guarded by `isKey`, so the        │
 * │ candidate's paper cannot acquire an answer through a layout change, a     │
 * │ copied component or a merged conditional.                                 │
 * │                                                                           │
 * │ This matters because the caller passes the SAME object to both functions. │
 * │ A renderer that printed whatever it was given would put the answer key on │
 * │ the exam the moment somebody passed the full question set — which is the  │
 * │ normal thing to do.                                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO DATE IS COMPUTED HERE.                                                 │
 * │                                                                           │
 * │ The date is a blank line the person running the exam fills in by hand —   │
 * │ the customer chose that, and it also means this module is a pure function │
 * │ of its input. Two renders of the same paper produce byte-comparable       │
 * │ output, which is what lets the regenerate path be checked.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** UI furniture, per language. Not question content — labels this file prints. */
const COPY: Record<
  BankLocale,
  {
    paperNo: string
    level: string
    totalMarks: string
    time: string
    date: string
    name: string
    employeeId: string
    outlet: string
    signature: string
    instructions: string
    instructionLines: string[]
    sectionA: string
    sectionB: string
    /**
     * "marks", and its singular where the language has one.
     *
     * A section can legitimately hold a single question — the 20-mark paper
     * has four short answers, but a company that adds a smaller size could
     * have one — and "(1 marks)" on a printed exam is the kind of small wrong
     * thing that makes a document look unproofed. Hindi and Gujarati do not
     * inflect here, so both entries are the same word in those languages,
     * which is why this is a pair rather than a count-aware formatter.
     */
    marksSuffix: string
    marksSuffixOne: string
    answerKey: string
    answer: string
    passMark: string
    page: string
  }
> = {
  en: {
    paperNo: 'Paper No.',
    level: 'Level',
    totalMarks: 'Total Marks',
    time: 'Time',
    date: 'Date',
    name: 'Name',
    employeeId: 'Employee ID',
    outlet: 'Outlet',
    signature: 'Signature',
    instructions: 'INSTRUCTIONS',
    instructionLines: [
      'Answer all questions.',
      'Each question carries 1 mark.',
      'For multiple choice questions, tick ONE option only.',
      'Write clearly in the space provided.',
    ],
    sectionA: 'SECTION A — Multiple Choice',
    sectionB: 'SECTION B — Short Answer',
    marksSuffix: 'marks',
    marksSuffixOne: 'mark',
    answerKey: 'ANSWER KEY',
    answer: 'ANSWER',
    passMark: 'Pass mark',
    page: 'Page',
  },
  hi: {
    paperNo: 'पेपर नंबर',
    level: 'स्तर',
    totalMarks: 'कुल अंक',
    time: 'समय',
    date: 'तारीख़',
    name: 'नाम',
    employeeId: 'कर्मचारी ID',
    outlet: 'आउटलेट',
    signature: 'हस्ताक्षर',
    instructions: 'निर्देश',
    instructionLines: [
      'सभी प्रश्नों के उत्तर दें।',
      'हर प्रश्न 1 अंक का है।',
      'बहुविकल्पीय प्रश्नों में सिर्फ़ एक ऑप्शन पर टिक करें।',
      'दी गई जगह में साफ़ लिखें।',
    ],
    sectionA: 'भाग A — बहुविकल्पीय',
    sectionB: 'भाग B — छोटा उत्तर',
    marksSuffix: 'अंक',
    marksSuffixOne: 'अंक',
    answerKey: 'उत्तर कुंजी',
    answer: 'उत्तर',
    passMark: 'पास अंक',
    page: 'पेज',
  },
  gu: {
    paperNo: 'પેપર નંબર',
    level: 'સ્તર',
    totalMarks: 'કુલ ગુણ',
    time: 'સમય',
    date: 'તારીખ',
    name: 'નામ',
    employeeId: 'કર્મચારી ID',
    outlet: 'આઉટલેટ',
    signature: 'સહી',
    instructions: 'સૂચનાઓ',
    instructionLines: [
      'બધા પ્રશ્નોના જવાબ આપો.',
      'દરેક પ્રશ્ન 1 ગુણનો છે.',
      'બહુવિકલ્પ પ્રશ્નોમાં ફક્ત એક ઓપ્શન પર ટિક કરો.',
      'આપેલી જગ્યામાં સ્પષ્ટ લખો.',
    ],
    sectionA: 'વિભાગ A — બહુવિકલ્પ',
    sectionB: 'વિભાગ B — ટૂંકો જવાબ',
    marksSuffix: 'ગુણ',
    marksSuffixOne: 'ગુણ',
    answerKey: 'ઉત્તર કૂંચી',
    answer: 'જવાબ',
    passMark: 'પાસ ગુણ',
    page: 'પેજ',
  },
}

const RULE = '#111111'
const MUTED = '#555555'

function makeStyles(fontFamily: string) {
  return StyleSheet.create({
    page: {
      fontFamily,
      fontSize: 10.5,
      paddingTop: 34,
      paddingBottom: 42,
      paddingHorizontal: 40,
      lineHeight: 1.5,
      color: RULE,
    },

    org: { fontSize: 13, textAlign: 'center' },
    brand: { fontSize: 11, textAlign: 'center', color: MUTED, marginTop: 1 },

    /*
     * The logo is height-constrained and width-auto, so a wide wordmark and a
     * square badge both sit on the same baseline without either being
     * distorted. objectFit contain rather than a fixed width, for the same
     * reason: a squashed logo is worse than a small one.
     */
    logoRow: { alignItems: 'center', marginBottom: 6 },
    logo: { height: 34, objectFit: 'contain' },

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ THE WATERMARK IS PAINTED FIRST AND KEPT VERY LIGHT.                   │
     * │                                                                       │
     * │ react-pdf paints in document order with no z-index, so the only way   │
     * │ to put something BEHIND the questions is to emit it before them. It   │
     * │ is the first child of Page for that reason and no other.              │
     * │                                                                       │
     * │ 0.08 opacity, not 0.2. This is a document somebody writes on in pen   │
     * │ and a marker reads afterwards, frequently from a photocopy — and a    │
     * │ photocopier will darken a mid-grey diagonal into something that       │
     * │ competes with the handwriting. Faint enough to be deniable on screen  │
     * │ is about right on paper.                                              │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    watermark: {
      position: 'absolute',
      top: '42%',
      left: 0,
      right: 0,
      textAlign: 'center',
      color: '#000000',
      opacity: 0.08,
      transform: 'rotate(-35deg)',
      // fontSize is set per-document by watermarkFontSize() — see below.
    },

    metaBox: { marginTop: 12, borderTopWidth: 1, borderTopColor: RULE, paddingTop: 8 },
    metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    metaCell: { flexDirection: 'row', width: '48%' },
    metaLabel: { color: MUTED },
    // The blank a person writes on. A bottom border rather than underscores,
    // which would wrap unpredictably at different label widths.
    metaFill: { flex: 1, borderBottomWidth: 0.7, borderBottomColor: MUTED, marginLeft: 4 },
    metaValue: { flex: 1, marginLeft: 4 },

    instructions: {
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: RULE,
      borderBottomWidth: 1,
      borderBottomColor: RULE,
      paddingVertical: 7,
    },
    instructionsTitle: { fontSize: 9, color: MUTED, marginBottom: 3 },
    instructionLine: { fontSize: 9.5, marginBottom: 1 },

    sectionHeading: {
      marginTop: 16,
      marginBottom: 8,
      fontSize: 11,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },

    // wrap={false} on this keeps a question and its options on one page.
    question: { marginBottom: 11 },
    questionRow: { flexDirection: 'row' },
    questionNo: { width: 22 },
    questionText: { flex: 1 },
    questionMark: { width: 26, textAlign: 'right', color: MUTED },

    optionGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingLeft: 22, marginTop: 3 },
    option: { flexDirection: 'row', width: '50%', paddingRight: 8, marginBottom: 2 },
    // 24, not 20: "[C]" is a touch wider than "(C)" and a marked option must
    // not push its own text out of alignment with the three unmarked ones.
    optionKey: { width: 24 },
    optionText: { flex: 1 },
    /** The answer-key highlight. Redundant with the brackets, never alone. */
    chosen: { color: '#065f46' },

    // Ruled lines for a handwritten answer. Two, matching the two-line rule
    // the answer field is capped at.
    answerLines: { paddingLeft: 22, marginTop: 5 },
    answerLine: { borderBottomWidth: 0.7, borderBottomColor: '#999999', height: 15 },

    keyAnswer: { paddingLeft: 22, marginTop: 3, color: '#065f46' },

    /*
     * Indented past the answer and set smaller, so a marker's eye lands on the
     * ANSWER first and the rationale second. Grey rather than the answer's
     * green: it is supporting material, and colouring both the same makes the
     * key harder to scan at speed.
     */
    keyExplanation: { paddingLeft: 34, marginTop: 1, fontSize: 9, color: MUTED },

    /*
     * ╔═══════════════════════════════════════════════════════════════════════╗
     * ║ STATIC TEXT ONLY. THE `render` PROP EMITS NOTHING IN THIS VERSION,     ║
     * ║ AND THERE IS THEREFORE NO PAGE NUMBER.                                 ║
     * ║                                                                       ║
     * ║ Measured, not guessed. One render of this document carried three       ║
     * ║ footer variants side by side:                                          ║
     * ║                                                                       ║
     * ║   static + fixed        → PRINTED                                      ║
     * ║   render + fixed        → nothing                                      ║
     * ║   render, not fixed     → nothing                                      ║
     * ║                                                                       ║
     * ║ @react-pdf/renderer 4.5.1 via renderToBuffer. The types advertise      ║
     * ║ `render?: ({pageNumber, totalPages}) => ReactNode` on Text, and it is  ║
     * ║ the documented way to number pages — it simply produces no output      ║
     * ║ here, silently, in a PDF that is otherwise perfectly valid.            ║
     * ║                                                                       ║
     * ║ Two earlier shapes also failed silently before that was understood: a  ║
     * ║ `fixed` View wrapping two Texts printed on no page at all, and adding  ║
     * ║ `fixed` to the inner Texts changed nothing.                            ║
     * ║                                                                       ║
     * ║ ALL THREE were invisible to text assertions — a missing footer reads   ║
     * ║ exactly like a footer nobody asserted on. Every one was found by       ║
     * ║ rasterising a sample and looking at the bottom of the page, which is   ║
     * ║ what tests/unit/pdf-sample.test.ts exists for.                         ║
     * ║                                                                       ║
     * ║ "Page 1 of 3" is worth having on a printed exam, so if it is wanted:   ║
     * ║ re-run that three-way probe against a newer renderer, or against       ║
     * ║ renderToStream, before writing any layout code around it. Do NOT       ║
     * ║ simply re-add `render` — it looks correct and does nothing.            ║
     * ╚═══════════════════════════════════════════════════════════════════════╝
     */
    footer: {
      position: 'absolute',
      bottom: 20,
      left: 40,
      right: 40,
      textAlign: 'center',
      fontSize: 8.5,
      color: MUTED,
    },
  })
}

/**
 * How large the watermark can be before it runs out of page.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A FIXED SIZE TRUNCATED LONGER TEXT, SILENTLY.                             ║
 * ║                                                                           ║
 * ║ This was a flat 62pt. Rotation happens AFTER layout, so the text box is    ║
 * ║ still the page width — and at 62pt anything past roughly fifteen           ║
 * ║ characters simply ran off the end of it. "CONFIDENTIAL" fitted;            ║
 * ║ "SPECIMEN — DO NOT COPY" would have lost its last few characters on every  ║
 * ║ page of every paper, with nothing to indicate it.                          ║
 * ║                                                                           ║
 * ║ Caught by a test whose token happened to be nineteen characters long. A    ║
 * ║ shorter fixture would have passed and shipped the bug.                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * 0.6 is the average advance of an uppercase glyph as a fraction of font size
 * in a grotesque; 560 is the usable width of an A4 text column in points. The
 * floor of 18 keeps a very long watermark legible rather than shrinking it to
 * nothing — past that it is better for the text to be small than absent.
 */
export function watermarkFontSize(text: string): number {
  const MAX = 62
  const MIN = 18
  const USABLE_WIDTH = 560
  const AVERAGE_ADVANCE = 0.6

  const fitted = Math.floor(USABLE_WIDTH / (Math.max(text.length, 1) * AVERAGE_ADVANCE))
  return Math.max(MIN, Math.min(MAX, fitted))
}

/** A labelled blank for somebody to write on. */
function MetaBlank({ label, styles }: { label: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}:</Text>
      <View style={styles.metaFill} />
    </View>
  )
}

/** A label with a value already known. */
function MetaValue({
  label,
  value,
  styles,
}: {
  label: string
  value: string
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}:</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )
}

function QuestionBlock({
  question,
  isKey,
  copy,
  styles,
}: {
  question: PaperQuestion
  isKey: boolean
  copy: (typeof COPY)[BankLocale]
  styles: ReturnType<typeof makeStyles>
}) {
  const isMcq = question.section === 'mcq'

  return (
    /* wrap={false}: a question split across a page break is a question whose
       options are on the next page, which candidates miss. */
    <View style={styles.question} wrap={false}>
      <View style={styles.questionRow}>
        <Text style={styles.questionNo}>{question.questionNo}.</Text>
        <Text style={styles.questionText}>{question.text}</Text>
        <Text style={styles.questionMark}>[1]</Text>
      </View>

      {isMcq && question.options && (
        <View style={styles.optionGrid}>
          {OPTION_KEYS.map((key: OptionKey) => {
            const chosen = isKey && question.correctOption === key
            return (
              <View key={key} style={styles.option}>
                {/*
                  ┌───────────────────────────────────────────────────────────┐
                  │ [C] FOR THE CORRECT OPTION, (C) FOR THE REST. ASCII ONLY,  │
                  │ AND NOT COLOUR ALONE.                                      │
                  │                                                            │
                  │ This was a ▶ until a test caught it rendering as ¶.        │
                  │ U+25B6 is not in Noto Sans, and a glyph the font does not  │
                  │ have does not fail — it prints as whatever sits at that    │
                  │ index. Precisely the hazard the box in fonts.ts describes, │
                  │ committed here by the file that describes it.              │
                  │                                                            │
                  │ Brackets are in every one of the three families. They also │
                  │ survive the thing colour does not: an answer key printed   │
                  │ on the kitchen's black-and-white printer, where a green    │
                  │ option and a black one are the same option.                │
                  │                                                            │
                  │ Colour is kept as a second, redundant signal for anybody   │
                  │ reading on screen or printing in colour.                   │
                  └───────────────────────────────────────────────────────────┘

                  This is the ONLY place correctOption is read, and it is
                  behind `isKey`. On the question paper `chosen` is false for
                  every option regardless of what the caller passed.
                */}
                <Text style={[styles.optionKey, chosen ? styles.chosen : {}]}>
                  {chosen ? `[${key}]` : `(${key})`}
                </Text>
                <Text style={[styles.optionText, chosen ? styles.chosen : {}]}>
                  {question.options?.[key] ?? ''}
                </Text>
              </View>
            )
          })}
        </View>
      )}

      {/* Short answer: ruled lines to write on, or the expected answer. */}
      {!isMcq &&
        (isKey ? (
          <Text style={styles.keyAnswer}>
            {copy.answer}: {question.answerText ?? ''}
          </Text>
        ) : (
          <View style={styles.answerLines}>
            <View style={styles.answerLine} />
            <View style={styles.answerLine} />
          </View>
        ))}

      {isKey && isMcq && (
        <Text style={styles.keyAnswer}>
          {copy.answer}: {question.correctOption ?? ''}
        </Text>
      )}

      {/* The rationale, key only. Guarded by `isKey` like everything else that
          must never reach a candidate — and rendered only when it exists,
          since explanations are optional per question and per language. */}
      {isKey && question.explanation && (
        <Text style={styles.keyExplanation}>{question.explanation}</Text>
      )}
    </View>
  )
}

export function PaperDocument({
  input,
  variant,
}: {
  input: PaperDocumentInput
  variant: PaperVariant
}) {
  const { locale, header, questions } = input
  const copy = COPY[locale]
  const styles = makeStyles(fontFamilyFor(locale))
  const isKey = variant === 'key'

  const mcq = questions.filter((q) => q.section === 'mcq')
  const short = questions.filter((q) => q.section === 'short_answer')

  const passMarks =
    header.passingPercent == null
      ? null
      : Math.ceil((header.totalMarks * header.passingPercent) / 100)

  return (
    <Document
      title={`${header.title} — ${copy.paperNo} ${header.paperNo}${isKey ? ` (${copy.answerKey})` : ''}`}
    >
      <Page size="A4" style={styles.page}>
        {/* FIRST CHILD, deliberately: react-pdf has no z-index and paints in
            document order, so this is the only way to sit behind the
            questions. `fixed` repeats it on every page. */}
        {header.watermark && (
          <Text
            style={[styles.watermark, { fontSize: watermarkFontSize(header.watermark) }]}
            fixed
          >
            {header.watermark}
          </Text>
        )}

        {/* ── Header ─────────────────────────────────────────────────── */}
        {header.logo && (
          <View style={styles.logoRow}>
            {/*
              eslint-disable-next-line jsx-a11y/alt-text --
              This is @react-pdf/renderer's Image, not an HTML <img>. It takes
              no alt prop, and PDF accessibility works through structure tagging
              rather than an attribute — so the rule is matching on the element
              NAME and has nothing to check here. Disabled on this line only, so
              a real <img> elsewhere is still caught.
            */}
            <Image style={styles.logo} src={header.logo} />
          </View>
        )}
        <Text style={styles.org}>{header.title}</Text>
        <Text style={styles.brand}>{header.brandName}</Text>
        {isKey && (
          <Text style={[styles.org, { marginTop: 6, color: '#065f46' }]}>{copy.answerKey}</Text>
        )}

        <View style={styles.metaBox}>
          <View style={styles.metaRow}>
            <MetaValue label={copy.paperNo} value={String(header.paperNo)} styles={styles} />
            <MetaBlank label={copy.date} styles={styles} />
          </View>
          <View style={styles.metaRow}>
            <MetaValue label={copy.level} value={header.difficultyLabel} styles={styles} />
            <MetaBlank label={copy.time} styles={styles} />
          </View>
          <View style={styles.metaRow}>
            <MetaValue
              label={copy.totalMarks}
              value={String(header.totalMarks)}
              styles={styles}
            />
            {/* Omitted entirely when unset — never printed as 0%. */}
            {passMarks != null ? (
              <MetaValue
                label={copy.passMark}
                value={`${passMarks} / ${header.totalMarks}`}
                styles={styles}
              />
            ) : (
              <View style={styles.metaCell} />
            )}
          </View>

          {/* The candidate's own details are blanks on the paper and are
              pointless on a marker's key, so they are omitted there. */}
          {!isKey && (
            <>
              <View style={styles.metaRow}>
                <MetaBlank label={copy.name} styles={styles} />
                <MetaBlank label={copy.employeeId} styles={styles} />
              </View>
              <View style={styles.metaRow}>
                <MetaBlank label={copy.outlet} styles={styles} />
                <MetaBlank label={copy.signature} styles={styles} />
              </View>
            </>
          )}
        </View>

        {!isKey && (
          <View style={styles.instructions}>
            <Text style={styles.instructionsTitle}>{copy.instructions}</Text>
            {copy.instructionLines.map((line, i) => (
              <Text key={i} style={styles.instructionLine}>
                {i + 1}. {line}
              </Text>
            ))}
          </View>
        )}

        {/* ── Section A ──────────────────────────────────────────────── */}
        {mcq.length > 0 && (
          <>
            <View style={styles.sectionHeading}>
              <Text>{copy.sectionA}</Text>
              <Text style={{ color: MUTED }}>
                ({mcq.length} {mcq.length === 1 ? copy.marksSuffixOne : copy.marksSuffix})
              </Text>
            </View>
            {mcq.map((q) => (
              <QuestionBlock
                key={q.questionNo}
                question={q}
                isKey={isKey}
                copy={copy}
                styles={styles}
              />
            ))}
          </>
        )}

        {/* ── Section B ──────────────────────────────────────────────── */}
        {short.length > 0 && (
          <>
            <View style={styles.sectionHeading}>
              <Text>{copy.sectionB}</Text>
              <Text style={{ color: MUTED }}>
                ({short.length} {short.length === 1 ? copy.marksSuffixOne : copy.marksSuffix})
              </Text>
            </View>
            {short.map((q) => (
              <QuestionBlock
                key={q.questionNo}
                question={q}
                isKey={isKey}
                copy={copy}
                styles={styles}
              />
            ))}
          </>
        )}

        <Text style={styles.footer} fixed>
          {header.footerText ?? header.companyName}
        </Text>
      </Page>
    </Document>
  )
}
