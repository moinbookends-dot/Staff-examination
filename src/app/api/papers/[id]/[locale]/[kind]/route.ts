import { getTranslations } from 'next-intl/server'
import { getAppClaims } from '@/lib/auth/claims'
import { can } from '@/lib/auth/can'
import { dbId } from '@/lib/db/id'
import { BANK_LOCALES, type BankLocale } from '@/lib/bank/vocabulary'
import { renderAnswerKey, renderQuestionPaper } from '@/lib/pdf'
import { loadPaperDetail } from '@/server/papers/availability'
import { loadPaperContent, loadPaperPdfSettings } from '@/server/papers/pdf-data'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GET /api/papers/[id]/[locale]/paper.pdf — and .../key.pdf
 *
 * Six documents per paper: three languages × (question paper, answer key).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ AUTHORISATION IS THIS FILE'S OWN JOB.                                     ║
 * ║                                                                           ║
 * ║ src/proxy.ts excludes /api from its matcher entirely, and this route sits ║
 * ║ outside every layout gate, so NOTHING has checked the session before this ║
 * ║ function runs. Its own check is the only thing between a caller and a     ║
 * ║ complete exam paper with its answer key.                                  ║
 * ║                                                                           ║
 * ║ getAppClaims() + can(), not requirePermission(): the latter throws or     ║
 * ║ redirects for page rendering, which would turn a refused download into an ║
 * ║ HTML error page with a 200-shaped body.                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * RENDERED ON DEMAND, not served from storage. The bytes are a pure function of
 * exam_paper_questions, which never changes for a paper, so regenerating is
 * always identical and there is no bucket, lifecycle policy or half-uploaded
 * file to reason about. exam_paper_files stays empty by design.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Node, not Edge: the renderer reads three TTFs off disk via `server-only`.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KINDS = { 'paper.pdf': 'paper', 'key.pdf': 'key' } as const

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; locale: string; kind: string }> },
) {
  const { id, locale, kind } = await params

  const claims = await getAppClaims()

  // The same permission both linking screens gate on.
  if (!can(claims, 'papers.read_history') || !claims.company_id) {
    return new Response('Not permitted.', { status: 403 })
  }

  // Validated before anything touches the database, so a malformed id cannot
  // reach a query and a bad locale cannot reach the renderer.
  const paperId = dbId().safeParse(id)
  if (!paperId.success) return new Response('Not found.', { status: 404 })

  const variant = KINDS[kind as keyof typeof KINDS]
  if (!variant) return new Response('Not found.', { status: 404 })

  if (!(BANK_LOCALES as readonly string[]).includes(locale)) {
    return new Response('Not found.', { status: 404 })
  }

  /*
   * loadPaperDetail is RLS-scoped, so a paper belonging to another company or
   * another brand comes back null — "not found" and "not yours" are one answer,
   * and neither discloses that the id exists.
   */
  const paper = await loadPaperDetail(paperId.data)
  if (!paper) return new Response('Not found.', { status: 404 })

  const [settings, questions, t] = await Promise.all([
    loadPaperPdfSettings(),
    loadPaperContent(paperId.data, locale as BankLocale),
    /*
     * Keyed on the DOCUMENT's locale, not the reader's.
     *
     * The level name used to come from exam_settings.label_easy/medium/hard —
     * single NOT NULL strings, so a Hindi paper printed "स्तर: Hard". One
     * stored string cannot be trilingual, and the product already knows what
     * its own levels are called in all three languages.
     *
     * The trade, recorded because it is a real one: a level renamed in
     * Settings will not appear under that name on a paper. The screens still
     * use it.
     */
    getTranslations({ locale, namespace: 'papers' }),
  ])

  /*
   * A paper with no questions must not be served as a valid empty PDF. That is
   * the exact failure 0060 exists to prevent — a Chef cannot read
   * bank_question_texts, so before that function this route would have produced
   * a perfectly well-formed paper with nothing on it.
   */
  if (questions.length === 0) {
    return new Response('This paper has no content to render.', { status: 409 })
  }

  const input = {
    locale: locale as BankLocale,
    header: {
      title: settings.title,
      companyName: settings.companyName,
      brandName: paper.brandName,
      paperNo: paper.paperNo,
      difficultyLabel: t(`difficulty.${paper.difficulty}`),
      totalMarks: paper.marks,
      passingPercent: settings.passingPercent,
      footerText: settings.footerText,
      // No logo reader exists yet — companies.logo_path is never fetched
      // anywhere in src/. Null rather than a placeholder, so the page simply
      // has no logo instead of a broken one.
      logo: null,
      // Deliberately absent on a real paper. The sample fixture stamps
      // "SPECIMEN — DO NOT COPY" precisely so samples cannot be mistaken for
      // an issued paper; stamping the real thing would defeat that.
      watermark: null,
    },
    questions,
  }

  // renderQuestionPaper ignores correctOption/answerText/explanation even
  // though they are populated, so the candidate's copy cannot leak them.
  const pdf = variant === 'key' ? await renderAnswerKey(input) : await renderQuestionPaper(input)

  const filename = `paper-${paper.paperNo}-${locale}${variant === 'key' ? '-key' : ''}.pdf`

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // An answer key is not something a shared cache should keep.
      'Cache-Control': 'no-store, private',
    },
  })
}
