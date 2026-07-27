import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { getExam, getRuleCounts, getExamHealth } from '@/server/actions/exams'
import { listCategories } from '@/server/actions/questions'
import { ExamSettingsForm, type ExamSettings } from '@/components/exams/exam-settings-form'
import {
  SectionBuilder,
  type SectionDraft,
} from '@/components/exams/section-builder'
import { ExamHealthPanel } from '@/components/exams/exam-health-panel'
import { Badge } from '@/components/ui/badge'
import { LockIcon } from 'lucide-react'

/**
 * One exam.
 *
 * getExam returns null when RLS filters the row out, which is indistinguishable
 * from "does not exist" — deliberately. A 404 for another company's exam is the
 * correct answer.
 */
export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
  const claims = await requirePermission('exams.read')
  const { id } = await params
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const data = await getExam(id)
  if (!data) notFound()

  const exam = data.exam
  const canEdit = can(claims, 'exams.update')
  const canPublishExam = can(claims, 'exams.publish')

  const [categories, ruleCounts, health] = await Promise.all([
    listCategories(),
    getRuleCounts(id),
    // Skipped entirely without the permission: the RPC would raise, and
    // swallowing that would hide a real authorisation failure behind an
    // empty report.
    canEdit ? getExamHealth(id) : Promise.resolve([]),
  ])

  // The builder works in drafts keyed by a client-side handle rather than by
  // database id: a rule the chef has just added has no id yet, and React needs
  // a stable key for it either way.
  const initialSections: SectionDraft[] = data.sections.map((section, index) => ({
    key: `s${index}`,
    id: section.id,
    title: section.title,
    instructions: section.instructions ?? '',
    rules: section.rules.map((rule, ruleIndex) => ({
      key: `s${index}r${ruleIndex}`,
      id: rule.id,
      categoryId: rule.category_id,
      includeSubcategories: rule.include_subcategories,
      difficultyMin: rule.difficulty_min,
      difficultyMax: rule.difficulty_max,
      questionCount: rule.question_count,
      marksPerQuestion: rule.marks_per_question === null ? null : Number(rule.marks_per_question),
    })),
  }))
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

      <SectionBuilder
        examId={exam.id}
        initialSections={initialSections}
        categories={categories}
        ruleCounts={ruleCounts}
        readOnly={locked}
      />

      {/* The health report needs exams.update — it returns question ids and
          stems in its detail payload, so it is as sensitive as the paper. A
          reader without that permission simply does not see the panel. */}
      {canEdit && (
        <ExamHealthPanel
          examId={exam.id}
          status={exam.status}
          initialIssues={health}
          canPublishExam={canPublishExam}
        />
      )}
    </div>
  )
}
