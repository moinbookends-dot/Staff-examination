import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { listCategories, listTags } from '@/server/actions/questions'
import { QuestionForm } from '@/components/questions/question-form'

/**
 * New question.
 *
 * requirePermission runs here even though the nav hides the button and
 * middleware gates the route — hiding a link is presentation. This is the check
 * that matters, and RLS re-checks it again at the insert.
 */
export default async function NewQuestionPage() {
  const claims = await requirePermission('questions.create')

  const [categories, tags] = await Promise.all([listCategories(), listTags()])

  return (
    <QuestionForm
      question={null}
      categories={categories}
      tags={tags}
      revisions={[]}
      canRetire={can(claims, 'questions.retire')}
    />
  )
}
