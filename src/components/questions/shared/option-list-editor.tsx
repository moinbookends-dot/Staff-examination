'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'

/**
 * The list-of-things control behind choices, match columns and sequence items.
 *
 * ORDERING IS BUTTONS, NOT DRAG-AND-DROP. No dnd library is installed and this
 * is not worth adding one for: chefs author on phones (see the mobile nav in
 * the app layout), where dragging a row inside a scrolling page fights the
 * scroll gesture and has no keyboard equivalent. Two buttons work on every
 * input device and need no library.
 */

export interface EditableItem {
  id: string
  text: string
}

/**
 * Next unused id.
 *
 * Letters by default, because that is what a chef writing options expects and
 * what the CSV importer generates (src/lib/questions/registry.ts) — a question
 * authored here and one imported from a spreadsheet get the same ids.
 *
 * Ids are never reused after a deletion and never renumbered on reorder: an
 * answer key references them, as will every attempt_answer once M4 lands.
 * Renumbering on reorder would silently change which option was correct.
 */
export function nextId(existing: readonly { id: string }[], prefix = ''): string {
  const taken = new Set(existing.map((item) => item.id))

  if (!prefix) {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(97 + i)
      if (!taken.has(letter)) return letter
    }
  }

  for (let i = 1; i < 1000; i++) {
    const candidate = `${prefix || 'x'}${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${prefix || 'x'}${Date.now()}`
}

export function OptionListEditor({
  items,
  onChange,
  max,
  min = 0,
  idPrefix = '',
  disabled,
  placeholder = 'Option text',
  addLabel = 'Add option',
  renderLead,
  emptyHint,
}: {
  items: EditableItem[]
  onChange: (items: EditableItem[]) => void
  max: number
  min?: number
  idPrefix?: string
  disabled?: boolean
  placeholder?: string
  addLabel?: string
  /** The per-row "is this correct?" control, supplied by the format's editor. */
  renderLead?: (item: EditableItem, index: number) => ReactNode
  emptyHint?: string
}) {
  function update(index: number, text: string) {
    onChange(items.map((item, i) => (i === index ? { ...item, text } : item)))
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {items.length === 0 && emptyHint && (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      )}

      {items.map((item, index) => (
        <div key={item.id} className="flex items-center gap-2">
          {renderLead?.(item, index)}

          <span
            className="w-6 shrink-0 text-center font-mono text-xs text-muted-foreground"
            title="Answer keys reference this id"
          >
            {item.id}
          </span>

          <Input
            value={item.text}
            onChange={(e) => update(index, e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={`${placeholder} ${item.id}`}
          />

          <div className="flex shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Move up"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Move down"
              disabled={disabled || index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${item.id}`}
              // Below the minimum the question stops being answerable, so the
              // control is disabled rather than allowing a state the publish
              // gate will reject later with a less obvious message.
              disabled={disabled || items.length <= min}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || items.length >= max}
        onClick={() => onChange([...items, { id: nextId(items, idPrefix), text: '' }])}
      >
        <PlusIcon />
        {addLabel}
      </Button>
      {items.length >= max && (
        <span className="ml-2 text-xs text-muted-foreground">Maximum of {max}.</span>
      )}
    </div>
  )
}
