'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  EXAM_KINDS,
  DEFAULT_PAPER_MODE,
  type ExamKind,
  type PaperMode,
} from '@/lib/exams/rules'
import { saveExam } from '@/server/actions/exams'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Exam settings — everything that is not the paper itself.
 *
 * Kept separate from the section and rule builder because the two are edited at
 * different moments and, more importantly, because `saveExam` treats an omitted
 * `sections` field as "leave the structure alone". This form never sends one,
 * so correcting a title cannot destroy a paper's structure.
 */

export interface ExamSettings {
  id: string | null
  title: string
  description: string | null
  instructions: string | null
  kind: ExamKind
  paper_mode: PaperMode
  duration_minutes: number
  max_attempts: number
  pass_mark_percent: number
  shuffle_questions: boolean
  shuffle_options: boolean
  allow_backtrack: boolean
  negative_marking_enabled: boolean
  verification_mode: 'auto' | 'single' | 'dual'
  status: string
}

export function ExamSettingsForm({
  exam,
  readOnly,
}: {
  exam: ExamSettings | null
  readOnly?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(exam?.title ?? '')
  const [description, setDescription] = useState(exam?.description ?? '')
  const [instructions, setInstructions] = useState(exam?.instructions ?? '')
  const [kind, setKind] = useState<ExamKind>(exam?.kind ?? 'official')
  // Tracked separately from `kind` so an explicit choice survives a later kind
  // change. null means "whatever this kind implies".
  const [paperMode, setPaperMode] = useState<PaperMode | null>(exam?.paper_mode ?? null)
  const [durationMinutes, setDurationMinutes] = useState(exam?.duration_minutes ?? 30)
  const [maxAttempts, setMaxAttempts] = useState(exam?.max_attempts ?? 1)
  const [passMark, setPassMark] = useState(exam?.pass_mark_percent ?? 60)
  const [shuffleQuestions, setShuffleQuestions] = useState(exam?.shuffle_questions ?? true)
  const [shuffleOptions, setShuffleOptions] = useState(exam?.shuffle_options ?? true)
  const [allowBacktrack, setAllowBacktrack] = useState(exam?.allow_backtrack ?? true)
  const [negativeMarking, setNegativeMarking] = useState(exam?.negative_marking_enabled ?? false)
  const [verificationMode, setVerificationMode] = useState<'auto' | 'single' | 'dual'>(
    exam?.verification_mode ?? 'dual',
  )

  const effectivePaperMode = paperMode ?? DEFAULT_PAPER_MODE[kind]
  const isNew = exam === null
  const locked = Boolean(readOnly)

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await saveExam({
        id: exam?.id ?? null,
        title,
        description: description || null,
        instructions: instructions || null,
        kind,
        // Sent only when the chef overrode it, so the column keeps recording a
        // decision rather than a derived value.
        paperMode: paperMode ?? undefined,
        durationMinutes,
        maxAttempts,
        passMarkPercent: passMark,
        shuffleQuestions,
        shuffleOptions,
        allowBacktrack,
        negativeMarkingEnabled: negativeMarking,
        verificationMode,
        // `sections` deliberately absent — see the note above the component.
      })

      if (!result.ok || !result.id) {
        setError(result.error ?? 'Could not save.')
        return
      }
      toast.success(isNew ? t('created') : t('saved'))
      if (isNew) router.push(`/exams/${result.id}`)
      else router.refresh()
    })
  }

  const disabled = pending || locked
  const selectClass =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('form.basics')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="exam-title">{t('form.title')}</Label>
            <Input
              id="exam-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('form.titlePlaceholder')}
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="exam-description">{t('form.description')}</Label>
            <Textarea
              id="exam-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="exam-instructions">{t('form.instructions')}</Label>
            <Textarea
              id="exam-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t('form.instructionsPlaceholder')}
              rows={3}
              disabled={disabled}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="exam-kind">{t('form.kind')}</Label>
              <select
                id="exam-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as ExamKind)}
                disabled={disabled}
                className={selectClass}
              >
                {EXAM_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`kinds.${value}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="exam-paper-mode">{t('form.paperMode')}</Label>
              <select
                id="exam-paper-mode"
                value={effectivePaperMode}
                onChange={(e) => setPaperMode(e.target.value as PaperMode)}
                disabled={disabled}
                className={selectClass}
              >
                <option value="fixed">{t('paperMode.fixed')}</option>
                <option value="per_attempt">{t('paperMode.per_attempt')}</option>
              </select>
              <p className="text-sm text-muted-foreground">
                {effectivePaperMode === 'fixed'
                  ? t('form.paperModeFixedHint')
                  : t('form.paperModePerAttemptHint')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('form.rules')}</CardTitle>
          <CardDescription>{t('form.rulesHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="exam-duration">{t('form.duration')}</Label>
              <Input
                id="exam-duration"
                type="number"
                min={1}
                max={600}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value) || 30)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exam-attempts">{t('form.maxAttempts')}</Label>
              <Input
                id="exam-attempts"
                type="number"
                min={1}
                max={10}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exam-pass-mark">{t('form.passMark')}</Label>
              <Input
                id="exam-pass-mark"
                type="number"
                min={0}
                max={100}
                value={passMark}
                onChange={(e) => setPassMark(Number(e.target.value))}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exam-verification">{t('form.verification')}</Label>
            <select
              id="exam-verification"
              value={verificationMode}
              onChange={(e) => setVerificationMode(e.target.value as 'auto' | 'single' | 'dual')}
              disabled={disabled}
              className={selectClass}
            >
              <option value="dual">{t('form.verificationDual')}</option>
              <option value="single">{t('form.verificationSingle')}</option>
              <option value="auto">{t('form.verificationAuto')}</option>
            </select>
            {/* Spelled out because 'single' exists for a specific operational
                reason: one chef plus dual verification is a permanent deadlock. */}
            <p className="text-sm text-muted-foreground">{t('form.verificationHint')}</p>
          </div>

          <div className="space-y-3">
            {(
              [
                ['shuffleQuestions', shuffleQuestions, setShuffleQuestions],
                ['shuffleOptions', shuffleOptions, setShuffleOptions],
                ['allowBacktrack', allowBacktrack, setAllowBacktrack],
                ['negativeMarking', negativeMarking, setNegativeMarking],
              ] as const
            ).map(([key, value, setter]) => (
              <div key={key} className="flex items-start gap-3 rounded-md border p-3">
                <Switch
                  checked={value}
                  onCheckedChange={(checked) => setter(Boolean(checked))}
                  disabled={disabled}
                  aria-label={t(`form.${key}`)}
                />
                <div className="space-y-0.5">
                  <Label>{t(`form.${key}`)}</Label>
                  <p className="text-sm text-muted-foreground">{t(`form.${key}Hint`)}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {!locked && (
        <div className="flex gap-2">
          <Button onClick={save} disabled={pending || title.trim().length < 3}>
            {isNew ? t('form.create') : t('form.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
