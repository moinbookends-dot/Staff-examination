import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { getTranslationWorkbench } from '@/server/actions/translations'
import { TranslationWorkbench } from '@/components/questions/translation-workbench'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon } from 'lucide-react'

/**
 * Translating one question.
 *
 * A route rather than a fourth tab on the question editor. That component holds
 * the whole question in one state object behind one explicit Save; a second
 * independently-dirty half would break that contract, and folding translations
 * into save_question would drag them into its transaction and its
 * revision-bumping triggers. It is also a different permission and, in
 * practice, a different person.
 *
 * Gated on questions.read and passing canTranslate down for presentation, with
 * the real check inside the action — the same split questions/[id]/page.tsx
 * states: hiding a control is not the boundary.
 */
export default async function QuestionTranslationsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const claims = await requirePermission('questions.read')
  const { id } = await params
  const t = await getTranslations('translations')

  const data = await getTranslationWorkbench(id)
  // Null covers both "no such question" and "another company's", which 0031
  // makes indistinguishable on purpose.
  if (!data) notFound()

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/questions/${id}`}
          className={buttonVariants({ variant: 'ghost', size: 'sm' }) + ' -ml-2 mb-2'}
        >
          <ArrowLeftIcon className="size-4" />
          {t('backToQuestion')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <TranslationWorkbench data={data} canTranslate={can(claims, 'questions.translate')} />
    </div>
  )
}
