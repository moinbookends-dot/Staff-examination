import { notFound } from 'next/navigation'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import {
  getQuestion,
  listCategories,
  listQuestionRevisions,
  listTags,
} from '@/server/actions/questions'
import { QuestionForm } from '@/components/questions/question-form'
import { DistractorPanel } from '@/components/questions/distractor-panel'

/**
 * Edit one question.
 *
 * questions.read gates the page; the form's Save calls an action that requires
 * questions.update, so a reader who is not an author sees the question and is
 * refused at the write — by the action AND by the update policy. Hiding the
 * button too is presentation, not the boundary.
 *
 * getQuestion returns null when RLS filters the row out, which is
 * indistinguishable from "does not exist" — deliberately. A 404 for another
 * company's question is the correct answer.
 */
export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const claims = await requirePermission('questions.read')
  const { id } = await params

  const [question, categories, tags, revisions] = await Promise.all([
    getQuestion(id),
    listCategories(),
    listTags(),
    listQuestionRevisions(id),
  ])

  if (!question) notFound()

  return (
    <div className="space-y-6">
      <QuestionForm
        question={question}
        categories={categories}
        tags={tags}
        revisions={revisions}
        canRetire={can(claims, 'questions.retire')}
      />
      {/*
       * Below the editor, not beside it: it is a read about the past, and the
       * thing a chef came here to do is edit. It renders nothing at all for a
       * question with no options, so an essay page is unchanged.
       */}
      <DistractorPanel questionId={id} />
    </div>
  )
}
