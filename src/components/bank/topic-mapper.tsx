'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { PlusIcon, TagIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { topicSlug } from '@/lib/bank/import/format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Mapping a document's headings onto the topics that actually exist.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A HEADING IS NEVER TURNED INTO A TOPIC AUTOMATICALLY, AND THE REASON IS   ║
 * ║ NOT CAUTION — IT IS THAT THE OBVIOUS IMPLEMENTATION IS SILENTLY WRONG.    ║
 * ║                                                                           ║
 * ║ topicSlug() keeps [a-z0-9] and turns everything else into separators. Run ║
 * ║ it on "दोष और समाधान" and the result is the EMPTY STRING. Run it on       ║
 * ║ "गुणवत्ता जांच तर्क" and the result is also the empty string.              ║
 * ║                                                                           ║
 * ║ So a "helpful" auto-match would collapse every Devanagari heading in the  ║
 * ║ document onto one topic — or, worse, create a topic with a blank slug     ║
 * ║ that every future import then matches. Nobody would notice until they     ║
 * ║ filtered the bank by topic and found a thousand questions in the wrong    ║
 * ║ one, with no record of what they had been.                                ║
 * ║                                                                           ║
 * ║ A person maps them. It takes five clicks and it is right.                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Only ever shown when questions are being CREATED. A question the bank
 * already holds keeps the topic the bank has — the document's heading is
 * translated decoration and is not a source of truth for anything.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface TopicMapperProps {
  /** Headings the document printed, in the order they appeared. */
  headings: string[]
  topics: { name: string; slug: string }[]
  /** heading → topic slug. */
  value: Record<string, string>
  onChange: (heading: string, slug: string) => void
  disabled: boolean
  /**
   * Decided on the server from bank.write. Passed as a boolean because a
   * predicate is a function and cannot cross into a Client Component.
   */
  canCreateTopics: boolean
  onCreateTopic: (name: string) => Promise<{ ok: true; slug: string } | { ok: false; message: string }>
}

export function TopicMapper({
  headings,
  topics,
  value,
  onChange,
  disabled,
  canCreateTopics,
  onCreateTopic,
}: TopicMapperProps) {
  const t = useTranslations('import')
  const [pending, startTransition] = useTransition()
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (headings.length === 0) return null

  const create = (heading: string) => {
    setError(null)
    startTransition(async () => {
      const result = await onCreateTopic(name)
      if (!result.ok) {
        setError(result.message)
        return
      }
      onChange(heading, result.slug)
      toast.success(t('topics.created', { name }))
      setCreatingFor(null)
      setName('')
    })
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div>
        <h3 className="text-label-caps text-muted-foreground">{t('topics.title')}</h3>
        <p className="text-body-sm text-muted-foreground">{t('topics.hint')}</p>
      </div>

      {error && <InlineError>{error}</InlineError>}

      <ul className="space-y-3">
        {headings.map((heading) => {
          const chosen = value[heading]

          return (
            <li key={heading} className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <TagIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-body-sm">{heading}</span>
                {chosen ? (
                  <Badge variant="success">{topics.find((x) => x.slug === chosen)?.name ?? chosen}</Badge>
                ) : (
                  <Badge variant="warning">{t('topics.unmapped')}</Badge>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Select
                  value={chosen ?? ''}
                  onValueChange={(next) => onChange(heading, next ?? '')}
                  disabled={disabled || pending}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label={t('topics.choose')}>
                    <SelectValue>
                      {(v) => topics.find((topic) => topic.slug === v)?.name ?? t('topics.choose')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {topics.map((topic) => (
                      <SelectItem key={topic.slug} value={topic.slug}>
                        {topic.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {canCreateTopics && creatingFor !== heading && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || pending}
                    onClick={() => {
                      setCreatingFor(heading)
                      setError(null)
                      setName('')
                    }}
                  >
                    <PlusIcon />
                    {t('topics.create')}
                  </Button>
                )}
              </div>

              {canCreateTopics && creatingFor === heading && (
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor={`topic-name-${heading}`} className="text-label-caps text-muted-foreground">
                    {t('topics.newName')}
                  </Label>
                  <Input
                    id={`topic-name-${heading}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={pending}
                    placeholder={t('topics.newNameHint')}
                  />
                  {/*
                    The derived slug, shown live. createTopic() derives it with
                    the same function and REFUSES a name with no letters or
                    digits — which is every Devanagari heading. Showing the slug
                    is how somebody discovers that before pressing the button
                    rather than after.
                  */}
                  <p className="text-body-sm text-muted-foreground">
                    {topicSlug(name)
                      ? t('topics.slugPreview', { slug: topicSlug(name) })
                      : t('topics.slugEmpty')}
                  </p>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => create(heading)}
                      disabled={pending || !topicSlug(name)}
                    >
                      {pending ? t('topics.creating') : t('topics.create')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCreatingFor(null)}
                      disabled={pending}
                    >
                      {t('topics.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
