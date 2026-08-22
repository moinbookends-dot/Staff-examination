import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { QuestionForm } from '@/components/bank/question-form'
import { loadFormOptions } from '@/server/papers/bank-data'
import { saveQuestion } from '@/server/actions/bank'

/**
 * Create a question.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO PERMISSION CHECK HERE, AND THAT IS DELIBERATE.                         │
 * │                                                                           │
 * │ questions/layout.tsx gates the whole subtree on canOpenQuestionBank, so   │
 * │ this page is unreachable without it. Repeating the check would be a       │
 * │ second copy of a rule that must not be able to disagree with the first.   │
 * │                                                                           │
 * │ saveQuestion re-checks independently, because a server action is callable │
 * │ without ever rendering this page.                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `saveQuestion` is a Server Action, which is the one kind of function that
 * MAY cross into a Client Component — React gives it a serialisable reference
 * rather than trying to serialise the function itself.
 */
export default async function NewQuestionPage() {
  const t = await getTranslations('bank')
  const options = await loadFormOptions()

  return (
    <div className="space-y-6">
      <PageHeader title={t('newTitle')} />
      <QuestionForm options={options} onSubmit={saveQuestion} />
    </div>
  )
}
