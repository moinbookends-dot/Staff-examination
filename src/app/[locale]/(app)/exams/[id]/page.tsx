import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { getExam, getRuleCounts, getExamHealth, getExamPaper } from '@/server/actions/exams'
import { listCategories } from '@/server/actions/questions'
import {
  listOutlets,
  listDepartments,
  listBrands,
  listAssignableRoles,
  listTeamMembers,
} from '@/server/actions/directory'
import { ExamSettingsForm, type ExamSettings } from '@/components/exams/exam-settings-form'
import {
  SectionBuilder,
  type SectionDraft,
} from '@/components/exams/section-builder'
import { ExamHealthPanel } from '@/components/exams/exam-health-panel'
import { ExamSchedule } from '@/components/exams/exam-schedule'
import { ExamAssignments, type AssignmentRow } from '@/components/exams/exam-assignments'
import { CloneExamButton } from '@/components/exams/clone-exam-button'
import { ExamPaperPreview } from '@/components/exams/exam-paper-preview'
import { Badge } from '@/components/ui/badge'
import { Link } from '@/lib/i18n/navigation'
import { LockIcon, FileTextIcon } from 'lucide-react'

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

  const canAssign = can(claims, 'exams.assign')

  const [categories, ruleCounts, health, outlets, departments, brands, roles, people, paper] =
    await Promise.all([
      listCategories(),
      getRuleCounts(id),
      // Skipped entirely without the permission: the RPC would raise, and
      // swallowing that would hide a real authorisation failure behind an
      // empty report.
      canEdit ? getExamHealth(id) : Promise.resolve([]),
      listOutlets(),
      listDepartments(),
      listBrands(),
      listAssignableRoles(),
      // The individual picker reads profiles, which needs exams.assign. A
      // reader without it gets an empty list rather than a thrown guard.
      canAssign ? listTeamMembers() : Promise.resolve([]),
      getExamPaper(id),
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

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ A PAPER-BACKED EXAM HIDES THREE PANELS, BECAUSE ALL THREE READ THE        │
   * │ LEGACY MODEL AND WOULD REPORT NOTHING TRUTHFULLY.                         │
   * │                                                                           │
   * │ SectionBuilder edits exam_sections and exam_rules; ExamPaperPreview reads │
   * │ exam_questions; ExamHealthPanel runs exam_health(), which validates a     │
   * │ RULE-DRAWN paper — pool depth, captured answer-key revisions, marks       │
   * │ arithmetic. A paper-backed exam has none of those rows, so all three      │
   * │ would render empty and the health panel would call an exam "unhealthy"    │
   * │ for lacking rules it is not supposed to have.                             │
   * │                                                                           │
   * │ The questions came from the Question Bank and were fixed at generation.   │
   * │ There is nothing on this screen to edit about them, and the paper's own   │
   * │ page shows the composition — so this links there instead of restating it. │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const paperBacked = exam.paper_id !== null && exam.paper_id !== undefined

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
                  {data.publishedByName
                    ? t('publishedOnBy', {
                        date: format.dateTime(new Date(exam.published_at), {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        }),
                        name: data.publishedByName,
                      })
                    : t('publishedOn', {
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
        {can(claims, 'exams.create') && <CloneExamButton examId={exam.id} />}
      </div>

      {locked && (
        <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <LockIcon className="mt-0.5 size-4 shrink-0" />
          <p>{t('lockedNotice')}</p>
        </div>
      )}

      <ExamSettingsForm exam={exam as unknown as ExamSettings} readOnly={locked} />

      {paperBacked ? (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-lg font-semibold">{t('fromPaperTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('fromPaperBody')}</p>
          <Link
            href={`/history/${exam.paper_id}`}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <FileTextIcon className="size-4" />
            {t('fromPaperLink')}
          </Link>
        </section>
      ) : (
        <SectionBuilder
          examId={exam.id}
          initialSections={initialSections}
          categories={categories}
          ruleCounts={ruleCounts}
          readOnly={locked}
        />
      )}

      <ExamSchedule
        examId={exam.id}
        opensAt={exam.opens_at}
        closesAt={exam.closes_at}
        timezone={exam.timezone}
        locked={locked}
        canEdit={canEdit}
      />

      {/* Assignments stay editable after publish — the 0016 lock covers what is
          asked, not who sits it. */}
      <ExamAssignments
        examId={exam.id}
        initial={data.assignments as AssignmentRow[]}
        outlets={outlets}
        departments={departments}
        brands={brands}
        roles={roles}
        people={people}
        canAssign={canAssign}
      />

      {/* The health report needs exams.update — it returns question ids and
          stems in its detail payload, so it is as sensitive as the paper. A
          reader without that permission simply does not see the panel. */}
      {canEdit && !paperBacked && (
        <ExamHealthPanel
          examId={exam.id}
          status={exam.status}
          initialIssues={health}
          canPublishExam={canPublishExam}
        />
      )}

      {!paperBacked && <ExamPaperPreview paper={paper} />}
    </div>
  )
}
