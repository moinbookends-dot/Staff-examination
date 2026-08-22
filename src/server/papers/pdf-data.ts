import 'server-only'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { BANK_LOCALES, type BankLocale } from '@/lib/bank/vocabulary'
import type { PaperQuestion } from '@/lib/pdf'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything a paper PDF needs that is not already on the paper row.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A SEPARATE FILE FROM bank-data.ts, AND THE SPLIT IS THE PERMISSION LINE.  ║
 * ║                                                                           ║
 * ║ bank-data.ts states at the top that everything in it requires bank.read.  ║
 * ║ A Chef holds none of that — yet the Chef is exactly who downloads papers. ║
 * ║ Putting these reads there would put a chef-facing path behind an          ║
 * ║ Editor-only door and it would fail as empty results rather than an error. ║
 * ║                                                                           ║
 * ║ Everything here is reachable with papers.read_history.                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The bits of PaperHeader that come from settings rather than the paper. */
export interface PaperPdfSettings {
  companyName: string
  /** exam_settings.pdf_header, already defaulted to the company name. */
  title: string
  /** exam_settings.pdf_footer. Null is meaningful — the renderer falls back. */
  footerText: string | null
  /** Omitted from the page entirely when null, never printed as "0%". */
  passingPercent: number | null
}

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO difficultyLabels HERE, DELIBERATELY.                                   │
 * │                                                                           │
 * │ exam_settings.label_easy/medium/hard are single NOT NULL strings, so they │
 * │ cannot carry a level's name in three languages — a Hindi paper printed    │
 * │ "स्तर: Hard" because of it.                                                │
 * │                                                                           │
 * │ The level name is now resolved from next-intl against the DOCUMENT's      │
 * │ locale, by the PDF route and the generate screen alike. Everything left   │
 * │ in this type is genuinely per-company and language-neutral.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * exam_settings + the company name.
 *
 * exam_settings_read (0053) admits bank.read OR papers.generate OR
 * papers.read_history, so a Chef can read this — the migration's own comment
 * says "the generator needs the labels and the pass mark to render a paper".
 * companies_read (0005) admits any approved member.
 */
export async function loadPaperPdfSettings(): Promise<PaperPdfSettings> {
  const supabase = await createClient()

  const [settings, company] = await Promise.all([
    supabase
      .from('exam_settings')
      .select('pdf_header, pdf_footer, passing_percent')
      .maybeSingle(),
    supabase.from('companies').select('name').maybeSingle(),
  ])

  const companyName = company.data?.name ?? 'Bookends'

  return {
    companyName,
    // The renderer prints header.title raw, so the fallback belongs here.
    title: settings.data?.pdf_header?.trim() || companyName,
    footerText: settings.data?.pdf_footer?.trim() || null,
    passingPercent: settings.data?.passing_percent ?? null,
  }
}

/**
 * The RPC's rows, validated rather than asserted — gen-types.mjs emits
 * `Returns: unknown` for every function.
 *
 * Note there is no question_id: 0060 deliberately does not return one, so a
 * Chef never receives a durable handle on a bank question.
 */
const contentRowSchema = z.object({
  question_no: z.number().int(),
  section: z.enum(['mcq', 'short_answer']),
  question: z.string().nullable(),
  option_a: z.string().nullable(),
  option_b: z.string().nullable(),
  option_c: z.string().nullable(),
  option_d: z.string().nullable(),
  correct_option: z.string().nullable(),
  answer_text: z.string().nullable(),
  explanation: z.string().nullable(),
})

const optionKeySchema = z.enum(['A', 'B', 'C', 'D'])

/**
 * One paper's questions, in printed order, in one language.
 *
 * Returns [] when the paper is not visible to the caller — 0060 answers
 * nothing rather than raising, exactly as RLS would, so this cannot be used to
 * discover which paper ids exist.
 */
export async function loadPaperContent(
  paperId: string,
  locale: BankLocale,
): Promise<PaperQuestion[]> {
  if (!(BANK_LOCALES as readonly string[]).includes(locale)) {
    throw new Error(`Unknown locale ${locale}.`)
  }

  const supabase = await createClient()

  const { data, error } = await supabase.rpc('exam_paper_content', {
    p_paper_id: paperId,
    p_locale: locale,
  })

  if (error) throw new Error(`Could not read the paper: ${error.message}`)

  const rows = z.array(contentRowSchema).parse(data ?? [])

  return rows.map((row) => {
    const question: PaperQuestion = {
      questionNo: row.question_no,
      section: row.section,
      /*
       * A question with no row in this language prints blank rather than
       * vanishing. 0060 left-joins the texts for the same reason: a short paper
       * looks correct and is not, whereas a blank line is obvious on the page
       * and tells an Editor precisely which translation is missing.
       */
      text: row.question ?? '',
    }

    // All four or none — 0054's shape CHECK guarantees that upstream, and the
    // renderer treats a partial set as a caller error rather than laying out
    // three options.
    if (
      row.section === 'mcq' &&
      row.option_a &&
      row.option_b &&
      row.option_c &&
      row.option_d
    ) {
      question.options = {
        A: row.option_a,
        B: row.option_b,
        C: row.option_c,
        D: row.option_d,
      }
    }

    // Answer-key fields are always populated; renderQuestionPaper ignores them
    // by design, so the candidate's paper cannot leak them.
    const correct = optionKeySchema.safeParse(row.correct_option)
    if (correct.success) question.correctOption = correct.data
    if (row.answer_text) question.answerText = row.answer_text
    if (row.explanation) question.explanation = row.explanation

    return question
  })
}
