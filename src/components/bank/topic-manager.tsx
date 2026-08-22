'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArchiveIcon, CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'
import { EmptyState } from '@/components/ui/empty-state'
import { TagsIcon } from 'lucide-react'
import type { BankTopic } from '@/lib/bank/types'
import type { TopicResult } from '@/server/actions/topics'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Topic management, per the Stitch design.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EDIT IN PLACE, NOT IN A DIALOG.                                           │
 * │                                                                           │
 * │ A topic is a name and a sort order. A modal for two fields costs an open, │
 * │ a focus trap and a close for every rename, and this screen exists to be   │
 * │ used a dozen times in a row while somebody tidies a taxonomy.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Archived topics stay listed under a toggle rather than vanishing: questions
 * already filed under one keep their label, so an Editor needs to see what
 * they retired in order to restore it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface TopicManagerProps {
  topics: BankTopic[]
  archived: BankTopic[]
  onCreate: (input: { name: string; sortOrder: number }) => Promise<TopicResult>
  onUpdate: (id: string, input: { name: string; sortOrder: number }) => Promise<TopicResult>
  onArchive: (id: string, archived: boolean) => Promise<TopicResult>
}

export function TopicManager({
  topics,
  archived,
  onCreate,
  onUpdate,
  onArchive,
}: TopicManagerProps) {
  const t = useTranslations('bank')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const run = (fn: () => Promise<TopicResult>, success: string, after?: () => void) => {
    setError(null)
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast.success(success)
        after?.()
      } else {
        setError(result.message)
      }
    })
  }

  const create = () => {
    const name = newName.trim()
    if (!name) return
    // Appended to the end, spaced by ten so a later topic can be slotted
    // between two without renumbering the list.
    const sortOrder = (topics.at(-1)?.sortOrder ?? 0) + 10
    run(() => onCreate({ name, sortOrder }), t('topicSaved'), () => setNewName(''))
  }

  return (
    <div className="space-y-6">
      {error && <InlineError>{error}</InlineError>}

      {/* ── Add ──────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits: this row is used repeatedly while setting a
              // taxonomy up, and reaching for the mouse each time is friction
              // with no purpose.
              if (e.key === 'Enter') {
                e.preventDefault()
                create()
              }
            }}
            placeholder={t('topicName')}
            aria-label={t('topicName')}
            disabled={pending}
          />
          <Button onClick={create} disabled={pending || !newName.trim()}>
            <PlusIcon />
            {t('topicAdd')}
          </Button>
        </div>
      </div>

      {/* ── List ─────────────────────────────────────────────────────────── */}
      {topics.length === 0 ? (
        <EmptyState icon={TagsIcon} message={t('empty')} hint={t('topicsSubtitle')} />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {topics.map((topic) => {
            const editing = editingId === topic.id

            return (
              <li key={topic.id} className="flex flex-wrap items-center gap-3 p-4">
                {editing ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label={t('topicName')}
                      disabled={pending}
                      className="min-w-0 flex-1"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      disabled={pending || !editName.trim()}
                      onClick={() =>
                        run(
                          () => onUpdate(topic.id, { name: editName.trim(), sortOrder: topic.sortOrder }),
                          t('topicSaved'),
                          () => setEditingId(null),
                        )
                      }
                    >
                      <CheckIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setEditingId(null)}
                    >
                      <XIcon />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-md">{topic.name}</span>
                      <span className="block truncate text-label-caps text-muted-foreground">
                        {topic.slug}
                      </span>
                    </span>

                    {/* Usage is shown because it decides whether archiving is
                        consequential — a topic with forty questions keeps its
                        label on all forty. */}
                    <Badge variant="outline">
                      {topic.questionCount > 0
                        ? t('topicInUse', { count: topic.questionCount })
                        : t('topicUnused')}
                    </Badge>

                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`${t('topicName')} — ${topic.name}`}
                      onClick={() => {
                        setEditingId(topic.id)
                        setEditName(topic.name)
                      }}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={t('archive')}
                      onClick={() => run(() => onArchive(topic.id, true), t('topicRemoved'))}
                    >
                      <ArchiveIcon />
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* ── Archived ─────────────────────────────────────────────────────── */}
      {archived.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? t('showActive') : t('showDeleted')} ({archived.length})
          </Button>

          {showArchived && (
            <ul className="mt-3 divide-y rounded-xl border bg-card">
              {archived.map((topic) => (
                <li key={topic.id} className="flex items-center gap-3 p-4">
                  <span className="min-w-0 flex-1 truncate text-body-md text-muted-foreground">
                    {topic.name}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(() => onArchive(topic.id, false), t('restored'))}
                  >
                    <RotateCcwIcon />
                    {t('restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
