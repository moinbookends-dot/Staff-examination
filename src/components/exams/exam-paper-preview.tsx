'use client'

import { useTranslations } from 'next-intl'
import { getFormat } from '@/lib/questions/registry'
import type { QuestionContent, ResponseFormat } from '@/lib/questions/schemas'
import { FormatRenderer } from '@/components/questions/registry'
import type { PaperQuestion } from '@/server/actions/exams'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoIcon } from 'lucide-react'

/**
 * The paper, as a candidate will see it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS MOUNTS THE SAME RENDERERS EXAM DELIVERY WILL.                        │
 * │                                                                           │
 * │ That was the point of typing FormatRendererProps as the candidate-facing  │
 * │ contract back in M2 rather than building preview-only components: a       │
 * │ preview drawn by different code can drift from delivery, and the drift is │
 * │ discovered during an exam.                                                │
 * │                                                                           │
 * │ Read-only here — no onAnswerChange — so nothing can be typed into it, and │
 * │ the answer passed in is the format's empty value.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The answer key is not in these props and never was: `snapshot` is built by
 * question_snapshot(), which reads neither question_answer_keys nor
 * question_revisions.
 */
export function ExamPaperPreview({ paper }: { paper: PaperQuestion[] }) {
  const t = useTranslations('exams.paper')

  if (paper.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    )
  }

  const isPreview = paper[0].is_preview
  const totalMarks = paper.reduce((sum, q) => sum + Number(q.marks), 0)

  // Grouped by section, preserving paper order — the sections are the shape a
  // candidate navigates, not an implementation detail of the draw.
  const sections: { id: string; title: string; questions: PaperQuestion[] }[] = []
  for (const question of paper) {
    const last = sections[sections.length - 1]
    if (last && last.id === question.section_id) last.questions.push(question)
    else sections.push({ id: question.section_id, title: question.section_title, questions: [question] })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>
          {t('summary', { questions: paper.length, marks: totalMarks })}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Said loudly, because a chef who believes this is THE paper will
            reasonably conclude the exam is broken when a candidate reports
            different questions. */}
        {isPreview && (
          <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <p>{t('previewNotice')}</p>
          </div>
        )}

        {sections.map((section) => (
          <div key={section.id} className="space-y-4">
            <h3 className="text-sm font-medium">{section.title}</h3>

            {section.questions.map((question) => {
              const format = question.snapshot.response_format as ResponseFormat
              return (
                <div key={question.question_id} className="space-y-3 rounded-md border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="flex-1 text-sm font-medium">
                      {question.paper_position}. {question.snapshot.stem}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      {/* PROVENANCE. Which wording was frozen — the revision
                          that attempt analytics will group by, so two versions
                          of a question never merge into one statistic. */}
                      <Badge variant="secondary" title={t('revisionHint')}>
                        {t('revision', { n: question.question_revision })}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {t('marks', { n: Number(question.marks) })}
                      </span>
                    </div>
                  </div>

                  {/* Recorded at draw time when the rule could not be met
                      exactly; otherwise a substituted question is invisible
                      months later when somebody asks why the paper looks odd. */}
                  {question.fallback_reason && (
                    <p className="text-sm text-muted-foreground">
                      {t(`fallback.${question.fallback_reason}`)}
                    </p>
                  )}

                  <FormatRenderer
                    format={format}
                    content={question.snapshot.content as QuestionContent}
                    answer={getFormat(format).emptyAnswer()}
                    readOnly
                  />
                </div>
              )
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
