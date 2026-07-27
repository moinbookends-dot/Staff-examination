import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { ExamSettingsForm } from '@/components/exams/exam-settings-form'

/**
 * New exam.
 *
 * Settings only. Sections and rules are added once the exam exists, because
 * they need an id to hang from — and because an exam is a useful thing to save
 * half-finished, which is what `draft` is for.
 */
export default async function NewExamPage() {
  await requirePermission('exams.create')
  const t = await getTranslations('exams')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('form.newTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('form.newSubtitle')}</p>
      </div>
      <ExamSettingsForm exam={null} />
    </div>
  )
}
