import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { getEvaluationItems } from '@/server/actions/evaluation'
import { MarkingForm } from './marking-form'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon } from 'lucide-react'

/**
 * Marking one paper.
 *
 * getEvaluationItems returns [] both when the attempt does not exist and when
 * it is not awaiting evaluation — attempt_evaluation_items() raises in either
 * case, and the two are indistinguishable on purpose. A 404 is the honest
 * answer to both.
 */
export default async function MarkAttemptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePermission('evaluation.evaluate')
  const { id } = await params
  const t = await getTranslations('evaluation')

  const items = await getEvaluationItems(id)
  if (items.length === 0) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/evaluate"
          className={buttonVariants({ variant: 'ghost', size: 'sm' }) + ' -ml-2 mb-2'}
        >
          <ArrowLeftIcon className="size-4" />
          {t('backToQueue')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('markingTitle')}</h1>
      </div>

      <MarkingForm attemptId={id} items={items} />
    </div>
  )
}
