'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import type { TranslationWorkbench as Data } from '@/server/actions/translations'
import { saveQuestionTranslation } from '@/server/actions/translations'
import {
  emptyTranslation,
  mergeTranslation,
  translationIssues,
  type TranslationContent,
  type Locale,
} from '@/lib/questions/translation'
import { TranslationFields } from './translation-fields'
import { FormatRenderer } from './registry'
import { getFormat } from '@/lib/questions/registry'
import type { QuestionContent } from '@/lib/questions/schemas'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AlertTriangleIcon, CheckIcon } from 'lucide-react'

/**
 * Translating one question.
 *
 * Explicit save, never autosave — the same rule question-form.tsx states, and
 * for a sharper reason here: a save can demote a published translation back to
 * review, and that should be something a person did, not something a pause in
 * typing did.
 *
 * The preview mounts the SAME renderer a candidate gets, over
 * mergeTranslation(base, value) — the exact function 0033's delivery path
 * calls. A preview built any other way would be a second opinion about what the
 * paper says.
 */

const TARGETS: Locale[] = ['hi', 'gu']

export function TranslationWorkbench({
  data,
  canTranslate,
}: {
  data: Data
  canTranslate: boolean
}) {
  const t = useTranslations('translations')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const byLocale = new Map(data.translations.map((x) => [x.locale, x]))
  const [locale, setLocale] = useState<Locale>(TARGETS[0])

  const existing = byLocale.get(locale)
  const [stem, setStem] = useState(existing?.stem ?? '')
  const [value, setValue] = useState<TranslationContent>(
    existing?.content ?? emptyTranslation(data.question.content),
  )
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  /** Switching language reloads the editor from that locale's row. */
  function pick(next: Locale) {
    const row = byLocale.get(next)
    setLocale(next)
    setStem(row?.stem ?? '')
    setValue(row?.content ?? emptyTranslation(data.question.content))
    setError(null)
    setSavedAt(null)
  }

  const issues = translationIssues(data.question.content, value)
  const merged = mergeTranslation(data.question.content, value)

  function save(status: 'draft' | 'review' | 'published') {
    setError(null)
    startTransition(async () => {
      const result = await saveQuestionTranslation({
        questionId: data.question.id,
        locale,
        stem,
        content: value,
        status,
        expectedUpdatedAt: byLocale.get(locale)?.updated_at,
      })
      if (result.ok) {
        setSavedAt(Date.now())
        router.refresh()
      } else {
        setError(result.error ?? null)
      }
    })
  }

  const statusLabel = (s: string | undefined) =>
    s === 'published' ? t('statusPublished') : s === 'review' ? t('statusReview') : s === 'draft' ? t('statusDraft') : t('notStarted')

  return (
    <div className="space-y-4">
      <Tabs value={locale} onValueChange={(v) => pick(v as Locale)}>
        <TabsList>
          {TARGETS.map((l) => {
            const row = byLocale.get(l)
            return (
              <TabsTrigger key={l} value={l} className="gap-2">
                {l}
                <Badge variant={row?.status === 'published' ? 'default' : 'outline'} className="text-[10px]">
                  {statusLabel(row?.status)}
                </Badge>
                {/* A published translation of wording that no longer exists is
                    worse than none — it is delivered with more confidence than
                    the English it no longer matches. */}
                {row?.stale && <AlertTriangleIcon className="size-3 text-amber-600" />}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {TARGETS.map((l) => (
          <TabsContent key={l} value={l} className="space-y-4">
            {existing?.stale && (
              <p className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangleIcon className="size-4 shrink-0 text-amber-600" />
                <span>
                  <strong>{t('stale')}</strong> — {t('staleHint')}
                </span>
              </p>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('stem')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2 sm:items-start">
                <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {data.question.stem}
                </p>
                <Input
                  aria-label={t('stem')}
                  placeholder={t('stemPlaceholder')}
                  value={stem}
                  onChange={(e) => setStem(e.target.value)}
                  disabled={!canTranslate || pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <TranslationFields
                  base={data.question.content}
                  value={value}
                  onChange={setValue}
                  disabled={!canTranslate || pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="gap-1">
                <CardTitle className="text-base">{t('preview')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t('previewHint')}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium">{stem || data.question.stem}</p>
                <FormatRenderer
                  format={data.question.response_format}
                  content={merged as QuestionContent}
                  answer={getFormat(data.question.response_format).emptyAnswer()}
                  readOnly
                />
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>

      {issues.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive" role="alert">
          {issues.map((i) => (
            <li key={i.path}>{i.message}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {canTranslate && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {existing?.status === 'published'
              ? t('publishedEditWarning')
              : existing?.status === 'draft'
                ? t('reviewFirst')
                : ''}
          </p>
          <div className="flex items-center gap-2">
            {savedAt && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckIcon className="size-3.5" />
                {t('saved')}
              </span>
            )}
            <Button variant="outline" onClick={() => save('draft')} disabled={pending || !stem.trim()}>
              {t('save')}
            </Button>
            <Button
              variant="outline"
              onClick={() => save('review')}
              disabled={pending || !stem.trim() || issues.length > 0}
            >
              {t('sendForReview')}
            </Button>
            {/* Offered only from review: 0032 refuses a jump from draft, and a
                button that always errors is worse than no button. */}
            {existing?.status === 'review' && (
              <Button onClick={() => save('published')} disabled={pending || issues.length > 0}>
                {t('publish')}
              </Button>
            )}
          </div>
        </div>
      )}

      {existing && (
        <p className="text-xs text-muted-foreground">
          {existing.translated_by_name && t('translatedBy', { name: existing.translated_by_name })}
          {existing.reviewed_by_name &&
            ' · ' +
              (existing.reviewed_by_name === existing.translated_by_name
                ? t('selfReviewed')
                : t('reviewedBy', { name: existing.reviewed_by_name }))}
        </p>
      )}
    </div>
  )
}
