import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { QuestionForm } from '@/components/bank/question-form'
import { loadFormOptions, loadQuestion } from '@/server/papers/bank-data'
import { saveQuestion } from '@/server/actions/bank'
import { dbId } from '@/lib/db/id'

/**
 * Edit a question.
 *
 * The subtree layout has already enforced canOpenQuestionBank; saveQuestion
 * re-checks on its own because a server action is reachable without this page.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO REVISION HISTORY PANEL.                                                │
 * │                                                                           │
 * │ The Stitch design shows one (v1.0 / v1.1 / v1.2). It was explicitly       │
 * │ dropped from the product, there is no table behind it, and rendering an   │
 * │ empty panel would imply a feature that does not exist.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // dbId(), not z.uuid(): Zod 4's stricter uuid() rejects the seeded ids this
  // project uses, and this value arrives from a URL.
  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  const [question, options] = await Promise.all([
    loadQuestion(parsed.data),
    loadFormOptions(),
  ])

  // One answer for "no such question" and "not yours" — RLS makes another
  // company's row absent, and anything else would confirm it exists.
  if (!question) notFound()

  const t = await getTranslations('bank')
  const format = await getFormatter()

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('editTitle')}
        description={question.brandName || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t(`status.${question.status}`)}</Badge>
            <Badge variant="outline">{t(`type.${question.qtype}`)}</Badge>
          </div>
        }
      />

      <QuestionForm question={question} options={options} onSubmit={saveQuestion} />

      {/* Metadata the design places beside the form. Created/updated are real
          columns; anything the schema does not hold is simply not shown. */}
      <dl className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-3">
        <div>
          <dt className="text-label-caps text-muted-foreground">{t('metaCreatedBy')}</dt>
          <dd className="mt-1 text-body-md">{question.createdByName}</dd>
        </div>
        <div>
          <dt className="text-label-caps text-muted-foreground">{t('metaCreated')}</dt>
          <dd className="mt-1 text-body-md">
            {format.dateTime(new Date(question.createdAt), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </dd>
        </div>
        <div>
          <dt className="text-label-caps text-muted-foreground">{t('metaUpdated')}</dt>
          <dd className="mt-1 text-body-md">
            {format.dateTime(new Date(question.updatedAt), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </dd>
        </div>
      </dl>
    </div>
  )
}
