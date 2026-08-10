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
import { ExamMonitoring } from '@/components/exams/exam-monitoring'
import { loadParticipation, loadParticipants } from '@/server/exams/live'
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

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE LEGACY LOADERS ARE GATED ON WHETHER THEIR PANEL WILL RENDER, AND      │
   * │ THIS FIXED A 500 FOR HR.                                                  │
   * │                                                                           │
   * │ listCategories() requires questions.read. HR holds exams.read and         │
   * │ attempts.read_all but NOT questions.read, so this Promise.all threw for   │
   * │ them on every exam — measured: /en/exams/<id> returned 500 for HR while   │
   * │ /en/exams returned 200.                                                   │
   * │                                                                           │
   * │ The insult is that the result was discarded anyway: categories feed       │
   * │ SectionBuilder, which a paper-backed exam does not render, and the health │
   * │ report and paper preview are equally legacy-only. Fetching them for       │
   * │ every reader of every exam bought nothing and locked a role out.          │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const paperBacked = exam.paper_id !== null && exam.paper_id !== undefined

  const [categories, ruleCounts, health, outlets, departments, brands, roles, people, paper] =
    await Promise.all([
      // questions.read — needed only by the section builder, which a
      // paper-backed exam replaces with a link to the paper.
      !paperBacked && canEdit ? listCategories() : Promise.resolve([]),
      !paperBacked ? getRuleCounts(id) : Promise.resolve([]),
      // Skipped entirely without the permission: the RPC would raise, and
      // swallowing that would hide a real authorisation failure behind an
      // empty report.
      canEdit && !paperBacked ? getExamHealth(id) : Promise.resolve([]),
      listOutlets(),
      listDepartments(),
      listBrands(),
      listAssignableRoles(),
      // The individual picker reads profiles, which needs exams.assign. A
      // reader without it gets an empty list rather than a thrown guard.
      canAssign ? listTeamMembers() : Promise.resolve([]),
      !paperBacked ? getExamPaper(id) : Promise.resolve([]),
    ])

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ MONITORING IS FETCHED ONLY FOR A PAPER-BACKED EXAM.                      │
   * │                                                                           │
   * │ exam_participation() and exam_participants() expand the audience through  │
   * │ exam_assignments, which the legacy rule-drawn exams also use — so they    │
   * │ would technically answer. But the legacy exams have their own reporting   │
   * │ and none of the state vocabulary this panel is built around, and running  │
   * │ two audience expansions on every render of an unrelated screen is a cost  │
   * │ for a panel that would not be shown.                                      │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const canMonitor =
    can(claims, 'attempts.read_all') || can(claims, 'attempts.read_team')

  const [participation, participants] = paperBacked
    ? await Promise.all([loadParticipation(id), loadParticipants(id)])
    : [null, []]

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

      {/* Participation first: on a live exam it is the reason somebody opened
          this page, and the configuration below it is reference material. */}
      {participation && (
        <ExamMonitoring
          participation={participation}
          participants={participants}
          canSeeTable={canMonitor}
        />
      )}

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
