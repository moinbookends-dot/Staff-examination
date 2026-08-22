'use client'

import type { AnswerKey, MatchMode, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type Content = Extract<QuestionContentDraft, { format: 'blanks' }>
type Key = Extract<AnswerKey, { format: 'blanks' }>
type KeyBlank = Key['blanks'][number]

/** Same expression the CSV importer uses (src/lib/questions/registry.ts). */
const PLACEHOLDER = /\{\{([a-zA-Z0-9_-]+)\}\}/g

const MATCH_MODES: { value: MatchMode; label: string; hint: string }[] = [
  { value: 'ci', label: 'Ignore case', hint: 'Case and surrounding spaces ignored. The sane default.' },
  { value: 'exact', label: 'Exact', hint: 'Character for character, including case.' },
  { value: 'fuzzy', label: 'Allow typos', hint: 'Near-misses are credited but flagged for a human to confirm.' },
  { value: 'regex', label: 'Pattern', hint: 'Each accepted answer is a regular expression, anchored at both ends.' },
]

/**
 * Fill in the blanks.
 *
 * BLANK IDS ARE DERIVED FROM THE TEXT, never declared separately. The chef
 * writes the sentence with {{temp}} where the gap goes and the blank appears —
 * which removes the entire class of "declared a blank that is not in the
 * sentence" errors that validateQuestion() would otherwise have to report after
 * the fact. The CSV importer already works this way; doing the same here means
 * a question typed in and one imported from a spreadsheet behave identically.
 */
export default function BlanksEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  function setTemplate(template: string) {
    const ids = [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))]
    const existing = new Map(k.blanks.map((b) => [b.id, b]))

    onChange({
      content: { ...c, template, blanks: ids.map((id) => ({ id })) },
      answerKey: {
        ...k,
        // Accepted answers survive a rewording of the sentence around them —
        // losing them because a comma moved would be maddening.
        blanks: ids.map((id) => existing.get(id) ?? { id, accept: [], match: 'ci' as const }),
      },
    })
  }

  function updateBlank(id: string, patch: Partial<KeyBlank>) {
    onChange({
      content: c,
      answerKey: {
        ...k,
        blanks: k.blanks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      },
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="blanks-template">The sentence</Label>
        <Textarea
          id="blanks-template"
          value={c.template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder="Cook chicken to an internal temperature of {{temp}}°C."
          rows={3}
          disabled={disabled}
        />
        <p className="text-sm text-muted-foreground">
          Write <code className="font-mono">{'{{name}}'}</code> wherever a blank goes. Each one
          becomes an input for the candidate.
        </p>
      </div>

      {k.blanks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No blanks yet — add a <code className="font-mono">{'{{placeholder}}'}</code> to the
          sentence above.
        </p>
      ) : (
        <div className="space-y-3">
          <Label>Accepted answers</Label>
          {k.blanks.map((blank) => (
            <div key={blank.id} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{blank.id}</span>
                <Input
                  className="min-w-48 flex-1"
                  value={blank.accept.join(', ')}
                  onChange={(e) =>
                    updateBlank(blank.id, {
                      // Comma-separated, so "74, 75, seventy-four" is one field
                      // rather than a repeater. Blanks routinely have three or
                      // four spellings across four languages.
                      accept: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  placeholder="74, 75 — separate alternatives with commas"
                  disabled={disabled}
                  aria-label={`Accepted answers for ${blank.id}`}
                />
                <select
                  value={blank.match}
                  onChange={(e) => {
                    const match = e.target.value as MatchMode
                    updateBlank(blank.id, {
                      match,
                      // fuzzy without a tolerance fails validateQuestion, so the
                      // default is applied here rather than reported later.
                      tolerance: match === 'fuzzy' ? (blank.tolerance ?? 1) : undefined,
                    })
                  }}
                  disabled={disabled}
                  aria-label={`Matching for ${blank.id}`}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  {MATCH_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>

                {blank.match === 'fuzzy' && (
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    className="w-20"
                    value={blank.tolerance ?? 1}
                    onChange={(e) =>
                      updateBlank(blank.id, { tolerance: Number(e.target.value) || 1 })
                    }
                    disabled={disabled}
                    aria-label={`Typo tolerance for ${blank.id}`}
                  />
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {MATCH_MODES.find((m) => m.value === blank.match)?.hint}
              </p>

              {blank.accept.length === 0 && (
                <p className="text-sm text-destructive">
                  No accepted answers — every candidate would be marked wrong.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-3 rounded-md border p-3">
        <Switch
          checked={k.partialCredit}
          onCheckedChange={(checked) =>
            onChange({ content: c, answerKey: { ...k, partialCredit: Boolean(checked) } })
          }
          disabled={disabled}
          aria-label="Partial credit"
        />
        <div className="space-y-0.5">
          <Label>Partial credit</Label>
          <p className="text-sm text-muted-foreground">
            Score each blank separately. Off means every blank must be right.
          </p>
        </div>
      </div>
    </div>
  )
}
