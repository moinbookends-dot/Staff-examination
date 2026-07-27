import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { getExam } from '@/server/actions/exams'
import { ExamSettingsForm, type ExamSettings } from '@/components/exams/exam-settings-form'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LockIcon } from 'lucide-react'

/**
 * One exam.
 *
 * getExam returns null when RLS filters the row out, which is indistinguishable
 * from "does not exist" — deliberately. A 404 for another company's exam is the
 * correct answer.
 */
export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('exams.read')
  const { id } = await params
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const data = await getExam(id)
  if (!data) notFound()

  const exam = data.exam
  // The 0016 trigger refuses content edits once an exam leaves draft, so the
  // form is shown read-only rather than letting somebody type into fields the
  // database will reject on save.
  const locked = exam.status !== 'draft'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{exam.title}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={exam.status === 'active' ? 'default' : 'secondary'}>
              {t(`status.${exam.status}`)}
            </Badge>
            <span>{t(`kinds.${exam.kind}`)}</span>
            <span>·</span>
            <span>{t(`paperMode.${exam.paper_mode}`)}</span>
            {exam.published_at && (
              <>
                <span>·</span>
                <span>
                  {t('publishedOn', {
                    date: format.dateTime(new Date(exam.published_at), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {locked && (
        <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <LockIcon className="mt-0.5 size-4 shrink-0" />
          <p>{t('lockedNotice')}</p>
        </div>
      )}

      <ExamSettingsForm exam={exam as unknown as ExamSettings} readOnly={locked} />

      {/* The section and rule builder lands in the next slice. Stated rather
          than hidden, so the page does not look finished when it is not. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('sections.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.sections.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('sections.none')}
            </p>
          ) : (
            <ul className="space-y-2">
              {data.sections.map((section) => (
                <li key={section.id} className="rounded-md border p-3 text-sm">
                  <span className="font-medium">{section.title}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {t('sections.ruleCount', { count: section.exam_rules?.length ?? 0 })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
