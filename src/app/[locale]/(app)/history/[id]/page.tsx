import { PaperStatusControl } from '@/components/papers/paper-status'
import { PublishPaper } from '@/components/papers/publish-paper'
import { setPaperStatus, publishPaperAsExam } from '@/server/actions/papers'
import { can } from '@/lib/auth/claims'
import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { ArrowLeftIcon, FileTextIcon, KeyRoundIcon, UsersIcon } from 'lucide-react'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { dbId } from '@/lib/db/id'
import { BANK_LOCALES, BANK_LOCALE_LABELS, type Difficulty } from '@/lib/bank/vocabulary'
import { loadPaperDetail } from '@/server/papers/availability'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /history/[id] — one generated paper.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THIS SHOWS, AND WHAT IT DELIBERATELY DOES NOT.                       │
 * │                                                                           │
 * │ exam_papers, exam_paper_questions and exam_paper_files are readable with  │
 * │ papers.read_history, so the paper's identity, composition and files are   │
 * │ all available to a chef under RLS.                                        │
 * │                                                                           │
 * │ The question TEXT is not. It lives in bank_question_texts behind          │
 * │ bank.read, which a chef does not hold — so this page shows the SHAPE of   │
 * │ the paper (how many of each type, in printed order) and the downloads,    │
 * │ and does not pretend to list the questions. Reaching around RLS with a    │
 * │ service-role client to fill that gap would hand a chef exactly what the   │
 * │ policies exist to withhold.                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Numbers come from the PAPER, never re-derived. mcq_n and short_n were copied
 * onto exam_papers at generation precisely because paper_settings is editable;
 * recomputing them from the current settings would make an old paper report a
 * split it was not built with.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function PaperDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const claims = await requirePermission('papers.read_history')

  const { id } = await params

  // dbId(), not z.uuid(): ids here come out of uuid columns and through a URL.
  // Zod 4's stricter uuid() rejects the seeded ids this project uses.
  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  const paper = await loadPaperDetail(parsed.data)

  // One answer for "no such paper" and "not yours". RLS makes another
  // company's paper simply absent, and a 404 is the only honest response to
  // both — anything else confirms the row exists.
  if (!paper) notFound()

  const t = await getTranslations('papers')
  const format = await getFormatter()

  /*
   * A Server Action, wrapped so the client component takes a plain callback.
   * setPaperStatus re-checks the caller and the paper's visibility itself —
   * this page having rendered is not authorisation for the write.
   */
  const onStatusChange = async (input: { paperId: string; status: 'live' | 'retired' }) => {
    'use server'
    return setPaperStatus(input)
  }

  /*
   * Editors generate papers; Chefs run them. An Editor reaching this page holds
   * papers.read_history and sees everything else, but gets no publish form —
   * and passing `undefined` rather than rendering a disabled control is what
   * makes that a fact about their permissions instead of a UI state.
   *
   * publishPaperAsExam re-checks both permissions itself. This decides what to
   * draw, never what is allowed.
   */
  const mayPublish = can(claims, 'exams.create') && can(claims, 'exams.publish')

  const onPublish = mayPublish
    ? async (input: {
        paperId: string
        title: string
        instructions: string
        durationMinutes: number
        maxAttempts: number
        passMarkPercent: number
        opensAt: string | null
        closesAt: string | null
        resultsRelease: 'immediate' | 'on_close'
      }) => {
        'use server'
        return publishPaperAsExam(input)
      }
    : undefined

  const difficultyLabels: Record<Difficulty, string> = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/history"
          className="inline-flex items-center gap-1.5 text-body-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          {t('detailsBackToHistory')}
        </Link>
      </div>

      <PageHeader
        title={t('detailsTitle', { paperNo: paper.paperNo })}
        description={paper.brandName || undefined}
      />

      {/* ── Metadata ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('detailsMeta')}</h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label={t('colDifficulty')}>
            <Badge variant="outline">{difficultyLabels[paper.difficulty]}</Badge>
          </Fact>
          <Fact label={t('colMarks')}>
            <span className="tabular-nums">{paper.marks}</span>
          </Fact>
          <Fact label={t('colQuestions')}>
            <span className="tabular-nums">{paper.questionCount}</span>
          </Fact>
          <Fact label={t('colDate')}>
            {format.dateTime(new Date(paper.generatedAt), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Fact>
          <Fact label={t('colGeneratedBy')}>{paper.generatedByName}</Fact>
        </dl>
      </section>

      {/* ── Composition ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('detailsQuestions')}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          {t('sizeBreakdown', {
            mcq: paper.blueprint.mcqCount,
            short: paper.blueprint.shortAnswerCount,
          })}
        </p>

        {paper.composition.length === 0 ? (
          <p className="mt-4 text-body-sm text-muted-foreground">{t('noActivity')}</p>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <SectionTile
                label={t('typeMcq')}
                actual={paper.mcqCount}
                expected={paper.blueprint.mcqCount}
              />
              <SectionTile
                label={t('typeShort')}
                actual={paper.shortAnswerCount}
                expected={paper.blueprint.shortAnswerCount}
              />
            </div>

            {/*
              The printed order, as numbers. Not question text — see the box at
              the top. A chef checking that paper 42 really is 16 + 4 in the
              right order can do it here; reading the questions is the PDF's job.
            */}
            <ol className="mt-4 flex flex-wrap gap-1.5">
              {paper.composition.map((q) => (
                <li
                  key={q.questionNo}
                  className={cn(
                    'grid size-8 place-items-center rounded-md border text-label-caps',
                    q.section === 'mcq'
                      ? 'border-primary/30 bg-primary/5 text-primary'
                      : 'border-border bg-muted/40 text-muted-foreground',
                  )}
                  title={q.section === 'mcq' ? t('typeMcq') : t('typeShort')}
                >
                  {q.questionNo}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {/* ── Status ───────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('statusTitle')}</h2>
        <div className="mt-3">
          <PaperStatusControl paperId={paper.id} status={paper.status} onChange={onStatusChange} />
        </div>
      </section>

      {/* ── Publish online ───────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('publishTitle')}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('publishSubtitle')}</p>

        <div className="mt-4">
          {paper.liveExam ? (
            /*
             * ┌───────────────────────────────────────────────────────────────┐
             * │ "PUBLISHED" AND "ANYBODY CAN SEE IT" ARE DIFFERENT FACTS, AND │
             * │ THIS IS WHERE THAT STOPPED BEING INVISIBLE.                   │
             * │                                                               │
             * │ Publishing deliberately assigns nobody — an exam with no      │
             * │ audience is invisible rather than open to everyone, which is  │
             * │ the safe way round. But the only thing that ever said so was  │
             * │ a toast, and a toast is gone by the time anyone wonders why   │
             * │ the exam has not appeared for their staff.                    │
             * │                                                               │
             * │ So the unassigned case is stated here, permanently, as the    │
             * │ unfinished step it is — not as an error, because nothing has  │
             * │ gone wrong; the work is simply half done.                     │
             * └───────────────────────────────────────────────────────────────┘
             */
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{t('publishedAs')}</Badge>
                <span className="text-body-md">{paper.liveExam.title}</span>
              </div>

              {paper.liveExam.assignmentCount === 0 ? (
                <div className="flex items-start gap-3 rounded-lg border border-dashed border-warning/50 bg-warning/5 p-3">
                  <UsersIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-body-sm font-medium">{t('publishedNobodyTitle')}</p>
                    <p className="mt-0.5 text-body-sm text-muted-foreground">
                      {t('publishedNobodyBody')}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-body-sm text-muted-foreground">
                  {t('publishedAssigned', { count: paper.liveExam.assignmentCount })}
                </p>
              )}

              <Link
                href={`/exams/${paper.liveExam.id}`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <UsersIcon />
                {paper.liveExam.assignmentCount === 0
                  ? t('publishedChooseWho')
                  : t('publishedOpenExam')}
              </Link>
            </div>
          ) : (
            <PublishPaper
              paperId={paper.id}
              paperNo={paper.paperNo}
              marks={paper.marks}
              retired={paper.status === 'retired'}
              onPublish={onPublish}
            />
          )}
        </div>
      </section>

      {/* ── Downloads ────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('downloadsFor')}</h2>

        {/*
          ┌───────────────────────────────────────────────────────────────────┐
          │ ALL SIX ARE ALWAYS OFFERED, AND THIS USED TO OFFER NONE.          │
          │                                                                   │
          │ These links were gated on paper.availableFiles, which reads       │
          │ exam_paper_files — a table nothing has ever written. It was       │
          │ therefore always empty, so this section permanently showed the    │
          │ "files need regenerating" message and the downloads never         │
          │ appeared at all.                                                  │
          │                                                                   │
          │ The route renders on demand from exam_paper_questions, which      │
          │ never changes for a paper, so every one of the six documents can  │
          │ always be produced. There is nothing left to gate on.             │
          └───────────────────────────────────────────────────────────────────┘
        */}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {BANK_LOCALES.map((locale) => (
            <div key={locale} className="rounded-lg border p-3">
              <span className="text-label-caps text-muted-foreground">
                {BANK_LOCALE_LABELS[locale]}
              </span>
              <div className="mt-2 flex flex-col gap-1.5">
                <a
                  href={`/api/papers/${paper.id}/${locale}/paper.pdf`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <FileTextIcon />
                  {t('downloadPaper')}
                </a>
                <a
                  href={`/api/papers/${paper.id}/${locale}/key.pdf`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <KeyRoundIcon />
                  {t('downloadKey')}
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-body-md">{children}</dd>
    </div>
  )
}

/**
 * Actual against expected.
 *
 * They should always match — the generator refuses to save a short paper — so
 * a mismatch is worth showing rather than hiding. Silently rendering only the
 * actual count would conceal exactly the fault this comparison exists to catch.
 */
function SectionTile({
  label,
  actual,
  expected,
}: {
  label: string
  actual: number
  expected: number
}) {
  const matches = actual === expected

  return (
    <div className="rounded-lg border p-4">
      <span className="text-label-caps text-muted-foreground">{label}</span>
      <p className="mt-1 text-title-md tabular-nums">
        {actual}
        {!matches && <span className="text-destructive"> / {expected}</span>}
      </p>
    </div>
  )
}
