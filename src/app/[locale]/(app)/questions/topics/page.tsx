import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { TopicManager } from '@/components/bank/topic-manager'
import { loadArchivedTopics, loadTopicsWithUsage } from '@/server/papers/bank-data'
import { createTopic, setTopicArchived, updateTopic } from '@/server/actions/topics'

/**
 * /questions/topics — Editor only, by virtue of the subtree layout.
 *
 * The three handlers below are Server Actions, which is the one kind of
 * function that may cross into a Client Component: React passes a serialisable
 * reference rather than attempting to serialise the function itself. Ordinary
 * predicates must not cross — that is what took the shell down earlier.
 *
 * They are wrapped rather than passed directly because the component's
 * signature takes (id, input) and the actions take positional arguments in the
 * same order; the wrappers exist so the component never has to know an action
 * from a plain callback.
 */
export default async function TopicsPage() {
  const t = await getTranslations('bank')

  const [topics, archived] = await Promise.all([loadTopicsWithUsage(), loadArchivedTopics()])

  const onCreate = async (input: { name: string; sortOrder: number }) => {
    'use server'
    return createTopic(input)
  }

  const onUpdate = async (id: string, input: { name: string; sortOrder: number }) => {
    'use server'
    return updateTopic(id, input)
  }

  const onArchive = async (id: string, isArchived: boolean) => {
    'use server'
    return setTopicArchived(id, isArchived)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('topicsTitle')} description={t('topicsSubtitle')} />

      <TopicManager
        topics={topics}
        archived={archived}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onArchive={onArchive}
      />
    </div>
  )
}
