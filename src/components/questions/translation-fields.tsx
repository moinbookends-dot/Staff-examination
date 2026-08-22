'use client'

import { useTranslations } from 'next-intl'
import type { TranslationContent } from '@/lib/questions/translation'
import type { RenderableContent } from './types'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/**
 * The fields a translator fills in, for any format.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE COMPONENT, NOT NINE — AND THAT IS A REAL DIFFERENCE FROM editors/.    │
 * │                                                                           │
 * │ Nine editors exist because authoring a matching question and authoring a  │
 * │ sequence are genuinely different jobs with different controls. Translating│
 * │ them is not: for every format the task is the same shape — here is a      │
 * │ string in English, write it in Gujarati — and the only variation is which │
 * │ list the strings come from. Nine files would be nine copies of one text   │
 * │ box, and nine places for that text box to drift.                          │
 * │                                                                           │
 * │ THE ID SET IS READ-ONLY. Every input below is keyed by an id taken from   │
 * │ the base question, and there is no control to add or remove one. A        │
 * │ translation that invented an id would render nothing; one that dropped an │
 * │ id silently falls back to English, which is the designed behaviour.       │
 * │                                                                           │
 * │ THERE IS NO ANSWER KEY HERE, and its absence is the point rather than an  │
 * │ omission. A translator cannot change what a question is worth because     │
 * │ this surface has nowhere to say it.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

interface Props {
  base: RenderableContent
  value: TranslationContent
  onChange: (next: TranslationContent) => void
  disabled?: boolean
}

/** `[id, English text]` for whichever list this format keeps its strings in. */
function sourceList(base: RenderableContent, key: 'choices' | 'left' | 'right' | 'items') {
  const list = (base as Record<string, unknown>)[key]
  if (!Array.isArray(list)) return []
  return list.map((item) => {
    const row = item as { id?: unknown; text?: unknown }
    return [String(row.id ?? ''), String(row.text ?? '')] as const
  })
}

type ListKey = 'choices' | 'left' | 'right' | 'items' | 'blankLabels'

/**
 * A column of source strings with an input beside each.
 *
 * MODULE SCOPE, NOT DEFINED IN THE PARENT. A component created during render is
 * a new type on every render, so React unmounts and remounts these inputs on
 * every keystroke — which ejects the translator's cursor mid-word. The same
 * trap registry.tsx documents for dynamic().
 */
function StringList({
  label,
  listKey,
  entries,
  value,
  onEntry,
  disabled,
}: {
  label: string
  listKey: ListKey
  entries: ReadonlyArray<readonly [string, string]>
  value: TranslationContent
  onEntry: (key: ListKey, id: string, text: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {entries.map(([id, source]) => (
        <div key={id} className="grid gap-2 sm:grid-cols-2 sm:items-center">
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {source || <span className="italic">—</span>}
          </p>
          <Input
            aria-label={`${label}: ${source || id}`}
            value={value[listKey]?.[id] ?? ''}
            onChange={(e) => onEntry(listKey, id, e.target.value)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  )
}

export function TranslationFields({ base, value, onChange, disabled }: Props) {
  const t = useTranslations('translations')

  const set = (patch: Partial<TranslationContent>) => onChange({ ...value, ...patch })
  const setEntry = (key: ListKey, id: string, text: string) =>
    set({ [key]: { ...(value[key] ?? {}), [id]: text } } as Partial<TranslationContent>)

  const list = (label: string, listKey: ListKey, entries: ReadonlyArray<readonly [string, string]>) => (
    <StringList
      label={label}
      listKey={listKey}
      entries={entries}
      value={value}
      onEntry={setEntry}
      disabled={disabled}
    />
  )

  switch (base.format) {
    case 'choice_single':
    case 'choice_multi':
      return list(t('optionsLabel'), 'choices', sourceList(base, 'choices'))

    case 'pairs':
      return (
        <div className="space-y-4">
          {list(t('leftLabel'), 'left', sourceList(base, 'left'))}
          {list(t('rightLabel'), 'right', sourceList(base, 'right'))}
        </div>
      )

    case 'order':
      return list(t('itemsLabel'), 'items', sourceList(base, 'items'))

    case 'blanks': {
      const blanks = Array.isArray((base as { blanks?: unknown }).blanks)
        ? (base as { blanks: Array<{ id: string; label?: string }> }).blanks
        : []
      return (
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="t-template" className="text-xs font-medium text-muted-foreground">
              {t('template')}
            </label>
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {String((base as { template?: unknown }).template ?? '')}
            </p>
            <Textarea
              id="t-template"
              rows={3}
              value={value.template ?? ''}
              onChange={(e) => set({ template: e.target.value })}
              disabled={disabled}
            />
            {/* The failure this warns about is invisible: fewer boxes than the
                key grades, and the candidate is marked wrong for a blank they
                were never shown. */}
            <p className="text-xs text-muted-foreground">{t('templateHint')}</p>
          </div>

          {blanks.some((b) => b.label) && (
            list(t('labelsLabel'), 'blankLabels', blanks.map((b) => [b.id, b.label ?? ''] as const))
          )}
        </div>
      )
    }

    case 'evaluator_only':
      return (
        <div className="space-y-1">
          <label htmlFor="t-instructions" className="text-xs font-medium text-muted-foreground">
            {t('instructionsLabel')}
          </label>
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {String((base as { instructions?: unknown }).instructions ?? '')}
          </p>
          <Textarea
            id="t-instructions"
            rows={4}
            value={value.instructions ?? ''}
            onChange={(e) => set({ instructions: e.target.value })}
            disabled={disabled}
          />
        </div>
      )

    default:
      // boolean, text_short, text_long — the stem is the whole translation.
      return <p className="text-sm text-muted-foreground">{t('nothingToTranslate')}</p>
  }
}
