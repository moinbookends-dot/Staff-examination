'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useRouter } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/inline-error'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CheckIcon, CopyIcon } from 'lucide-react'
import {
  ANSWER_MAX_LENGTH,
  BANK_LOCALES,
  BANK_LOCALE_LABELS,
  DIFFICULTIES,
  OPTION_KEYS,
  QUESTION_TYPES,
  type BankLocale,
  type Difficulty,
  type OptionKey,
  type QuestionStatus,
  type QuestionType,
} from '@/lib/bank/vocabulary'
import { incompleteLocales, isLocaleComplete, type QuestionTextInput } from '@/lib/bank/schemas'
import type { BankFormOptions, BankMutationResult, BankQuestionRow } from '@/lib/bank/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The Question Editor form.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS SCREEN IS USED 3,000 TIMES. IT IS DESIGNED FOR THE 3,000th, NOT THE  ║
 * ║ FIRST.                                                                    ║
 * ║                                                                           ║
 * ║ Every question in this system is written by hand, and the customer is     ║
 * ║ entering a thousand at each of three levels. That single fact decides      ║
 * ║ most of what is unusual below:                                            ║
 * ║                                                                           ║
 * ║  · SAVE AND ADD ANOTHER keeps the context — type, level, brand, topic,    ║
 * ║    reference document and page — and clears only the text. Somebody       ║
 * ║    working through one chapter of a cookbook at one level sets those      ║
 * ║    six fields ONCE and then types questions. Re-picking them 1,000 times  ║
 * ║    is roughly six thousand interactions that buy nothing.                 ║
 * ║  · Ctrl/Cmd+Enter saves from anywhere, so a hand never leaves the         ║
 * ║    keyboard to find a button.                                             ║
 * ║  · Focus returns to the first empty question field after each save, so    ║
 * ║    the next question starts where the last one ended.                     ║
 * ║  · Native <select> rather than a styled listbox: it opens on a keystroke, ║
 * ║    filters as you type, and is the fastest control on this page. The      ║
 * ║    previous question form made the same call.                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CORRECT ANSWER IS SHOWN IN EVERY LANGUAGE TAB, AND IS ONE VALUE.      │
 * │                                                                           │
 * │ correctOption is a POSITION (A-D) on the language-neutral row — migration │
 * │ 0054 is built around that, and it is why no translation can change what   │
 * │ is correct. The radio therefore appears beside the options in all three   │
 * │ tabs but is bound to a single piece of state: somebody translating into   │
 * │ Gujarati can SEE which option is the right one while they work, and       │
 * │ cannot change it into a different one by accident.                        │
 * │                                                                           │
 * │ The consequence, which the hint under it states out loud: option ORDER    │
 * │ must match across languages. Hindi option B has to be the translation of  │
 * │ English option B.                                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THERE IS NO GUIDANCE UNDER THE DIFFICULTY FIELD, AND THAT IS DELIBERATE.  │
 * │                                                                           │
 * │ What Easy, Medium and Hard mean is defined in a separate document that is │
 * │ the single source of truth. Nothing here suggests, defaults or infers a   │
 * │ level — see the box in src/lib/bank/vocabulary.ts. When that document     │
 * │ exists its text belongs beside this field; until then, inventing a hint   │
 * │ would be inventing the rule.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const EMPTY_TEXT: QuestionTextInput = {
  question: '',
  optionA: '',
  optionB: '',
  optionC: '',
  optionD: '',
  answerText: '',
}

type Texts = Record<BankLocale, QuestionTextInput>

function emptyTexts(): Texts {
  return { en: { ...EMPTY_TEXT }, hi: { ...EMPTY_TEXT }, gu: { ...EMPTY_TEXT } }
}

/** Fill the three tabs from a loaded question, leaving absent languages blank. */
function textsFrom(question: BankQuestionRow | undefined): Texts {
  const out = emptyTexts()
  if (!question) return out

  for (const locale of BANK_LOCALES) {
    const t = question.texts[locale]
    if (!t) continue
    out[locale] = {
      question: t.question ?? '',
      optionA: t.optionA ?? '',
      optionB: t.optionB ?? '',
      optionC: t.optionC ?? '',
      optionD: t.optionD ?? '',
      answerText: t.answerText ?? '',
    }
  }
  return out
}

export interface QuestionFormProps {
  /** Absent when creating. */
  question?: BankQuestionRow
  options: BankFormOptions
  /** Server action. Returns a discriminated result rather than throwing. */
  onSubmit: (input: unknown) => Promise<BankMutationResult>
}

export function QuestionForm({ question, options, onSubmit }: QuestionFormProps) {
  const t = useTranslations('bank')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const editing = Boolean(question)

  // ── Context fields: what "Save and add another" deliberately keeps ────────
  const [qtype, setQtype] = useState<QuestionType>(question?.qtype ?? 'mcq')
  const [difficulty, setDifficulty] = useState<Difficulty | ''>(question?.difficulty ?? '')
  const [brandId, setBrandId] = useState(question?.brandId ?? options.brands[0]?.id ?? '')
  const [topicId, setTopicId] = useState(question?.topicId ?? '')
  const [referenceDocumentId, setReferenceDocumentId] = useState(
    question?.referenceDocumentId ?? '',
  )
  const [referencePage, setReferencePage] = useState(
    question?.referencePage ? String(question.referencePage) : '',
  )

  // ── Per-question fields: cleared on "Save and add another" ────────────────
  const [texts, setTexts] = useState<Texts>(() => textsFrom(question))
  const [correctOption, setCorrectOption] = useState<OptionKey | ''>(
    question?.correctOption ?? '',
  )

  const [activeLocale, setActiveLocale] = useState<BankLocale>('en')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const questionRef = useRef<HTMLTextAreaElement>(null)

  /*
   * Only the REQUIRED languages gate publishing.
   *
   * options.requiredLocales mirrors exam_settings.required_locales, which is
   * {en} while the bank is being authored in English and {en,hi,gu} once it is
   * translated. The tabs for the other languages stay visible and writable —
   * an Editor who knows the Hindi should be able to put it in now — they just
   * do not hold Publish hostage.
   */
  const missing = useMemo(
    () => incompleteLocales(texts, qtype, options.requiredLocales),
    [texts, qtype, options.requiredLocales],
  )
  const canPublish = missing.length === 0 && Boolean(difficulty) && Boolean(brandId)

  const setText = useCallback(
    (locale: BankLocale, field: keyof QuestionTextInput, value: string) => {
      setTexts((prev) => ({ ...prev, [locale]: { ...prev[locale], [field]: value } }))
    },
    [],
  )

  /**
   * Build the payload the schema expects.
   *
   * Empty strings become undefined so a blank tab is "not written yet" rather
   * than "written as nothing" — the difference decides whether the question can
   * be published, and questionInputSchema treats them differently.
   */
  const buildInput = useCallback(
    (status: QuestionStatus) => {
      const clean = (v: string | undefined) => {
        const trimmed = (v ?? '').trim()
        return trimmed === '' ? undefined : trimmed
      }

      const payloadTexts: Partial<Record<BankLocale, QuestionTextInput>> = {}
      for (const locale of BANK_LOCALES) {
        const t = texts[locale]
        const entry: QuestionTextInput = {
          question: clean(t.question),
          optionA: qtype === 'mcq' ? clean(t.optionA) : undefined,
          optionB: qtype === 'mcq' ? clean(t.optionB) : undefined,
          optionC: qtype === 'mcq' ? clean(t.optionC) : undefined,
          optionD: qtype === 'mcq' ? clean(t.optionD) : undefined,
          answerText: qtype === 'short_answer' ? clean(t.answerText) : undefined,
        }
        // A tab with nothing in it is omitted entirely, not sent as blanks.
        if (Object.values(entry).some(Boolean)) payloadTexts[locale] = entry
      }

      return {
        id: question?.id,
        qtype,
        // Null rather than absent when switching an MCQ to a short answer, so a
        // stale value cannot survive the change. The schema requires it.
        correctOption: qtype === 'mcq' ? (correctOption || undefined) : null,
        difficulty: difficulty || undefined,
        brandId: brandId || undefined,
        topicId: topicId || null,
        referenceDocumentId: referenceDocumentId || null,
        referencePage: referencePage ? Number(referencePage) : null,
        status,
        texts: payloadTexts,
      }
    },
    [
      question?.id, qtype, correctOption, difficulty, brandId, topicId,
      referenceDocumentId, referencePage, texts,
    ],
  )

  const submit = useCallback(
    (status: QuestionStatus, thenAddAnother: boolean) => {
      setError(null)

      startTransition(async () => {
        const result = await onSubmit(buildInput(status))

        if (result.ok) {
          if (thenAddAnother) {
            /*
             * The bulk-entry path. Context stays exactly as it is; only the
             * question itself is cleared, and focus goes back to the first
             * field so the next one can be typed immediately.
             *
             * Deliberately does NOT navigate. A round trip to a fresh /new page
             * would lose the six context fields and cost a page load per
             * question — at 1,000 questions that is the difference between an
             * afternoon and a week.
             */
            setTexts(emptyTexts())
            setCorrectOption('')
            setActiveLocale('en')
            toast.success(t('savedAndNew'))
            requestAnimationFrame(() => questionRef.current?.focus())
            return
          }

          toast.success(status === 'active' ? t('published') : t('saved'))
          router.push('/questions')
          return
        }

        // Failures are discriminated so each one can say something useful
        // rather than all arriving as the same red string.
        if (result.reason === 'duplicate') {
          setError(`${t('duplicateQuestion')} ${t('duplicateHint')}`)
          return
        }
        if (result.reason === 'incomplete') {
          setError(t('cannotPublish'))
          // Jump to the first language that still needs work — the Editor
          // should not have to hunt for which tab the problem is on.
          if (result.missingLocales[0]) setActiveLocale(result.missingLocales[0])
          return
        }
        setError(result.message)
      })
    },
    [buildInput, onSubmit, router, t],
  )

  /*
   * Ctrl/Cmd+Enter saves. Bound at the form rather than per field so it works
   * from any input, including the selects.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !pending) {
        e.preventDefault()
        submit(canPublish ? 'active' : 'draft', false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submit, canPublish, pending])

  const selectClass =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm ' +
    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ' +
    'disabled:opacity-50'

  return (
    <div className="space-y-6">
      {error && <InlineError>{error}</InlineError>}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        {/* ── Context ──────────────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">{t('formType')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="q-type">{t('formType')}</Label>
              <select
                id="q-type"
                value={qtype}
                onChange={(e) => setQtype(e.target.value as QuestionType)}
                disabled={pending}
                className={selectClass}
              >
                {QUESTION_TYPES.map((v) => (
                  <option key={v} value={v}>{t(`type.${v}`)}</option>
                ))}
              </select>
            </div>

            {/*
              Difficulty. Three plain buttons, no default selected, and NO
              guidance text — see the box at the top of this file. An unselected
              state is correct: the Editor must choose, and a pre-selected
              "Medium" would be this software guessing.
            */}
            <div className="space-y-1.5">
              <Label>{t('formDifficulty')}</Label>
              <div className="grid grid-cols-3 gap-1.5" role="group">
                {DIFFICULTIES.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={difficulty === d ? 'default' : 'outline'}
                    aria-pressed={difficulty === d}
                    disabled={pending}
                    onClick={() => setDifficulty(d)}
                  >
                    {/* The company's own label for the level, falling back to
                        the translated default. Presentation only — the value
                        written to the column is always the enum. */}
                    {options.difficultyLabels[d] || t(`difficulty.${d}`)}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-brand">{t('formBrand')}</Label>
              <select
                id="q-brand"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                disabled={pending}
                className={selectClass}
              >
                {options.brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-topic">{t('formTopic')}</Label>
              <select
                id="q-topic"
                value={topicId}
                onChange={(e) => setTopicId(e.target.value)}
                disabled={pending}
                className={selectClass}
              >
                <option value="">{t('formTopicNone')}</option>
                {options.topics.map((tp) => (
                  <option key={tp.id} value={tp.id}>{tp.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-ref">{t('formReference')}</Label>
              <select
                id="q-ref"
                value={referenceDocumentId}
                onChange={(e) => setReferenceDocumentId(e.target.value)}
                disabled={pending}
                className={selectClass}
              >
                <option value="">{t('formReferenceNone')}</option>
                {options.documents.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
            </div>

            {/* Only once a document is chosen — a page number with nothing to
                be a page OF is refused by 0054, and offering the field first
                invites exactly that. */}
            {referenceDocumentId && (
              <div className="space-y-1.5">
                <Label htmlFor="q-page">{t('formPage')}</Label>
                <Input
                  id="q-page"
                  type="number"
                  min={1}
                  value={referencePage}
                  onChange={(e) => setReferencePage(e.target.value)}
                  disabled={pending}
                />
              </div>
            )}

            {/* UUID — Editors only. The panel is absent, not disabled, and the
                value is absent from the payload for everybody else. */}
            {options.showsUuid && question?.id && (
              <div className="space-y-1.5 border-t pt-4">
                <Label>{t('metaUuid')}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {question.id}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={t('metaUuid')}
                    onClick={() => {
                      void navigator.clipboard.writeText(question.id!)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('metaUuidHint')}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── The three languages ──────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <Tabs
              value={activeLocale}
              onValueChange={(v) => setActiveLocale(v as BankLocale)}
            >
              <TabsList>
                {BANK_LOCALES.map((locale) => {
                  const done = isLocaleComplete(texts[locale], qtype)
                  const required = options.requiredLocales.includes(locale)
                  return (
                    <TabsTrigger key={locale} value={locale}>
                      {BANK_LOCALE_LABELS[locale]}
                      {/*
                        A dot, not a tick: at a glance an Editor needs to know
                        which tabs still need work, and three ticks is a harder
                        shape to scan than one missing dot.

                        An OPTIONAL language shows no dot at all rather than an
                        empty one. While the bank is English-only, three grey
                        dots would read as "two things outstanding" on every
                        question ever written — a permanent false alarm, which
                        is how people learn to ignore the indicator that
                        matters.
                      */}
                      {required && (
                        <span
                          aria-hidden
                          data-complete={done}
                          className="ml-1.5 size-1.5 rounded-full bg-muted-foreground/40 data-[complete=true]:bg-emerald-500"
                        />
                      )}
                      <span className="sr-only">
                        {done ? t('complete') : t('missingLanguages', { languages: BANK_LOCALE_LABELS[locale] })}
                      </span>
                    </TabsTrigger>
                  )
                })}
              </TabsList>

              {BANK_LOCALES.map((locale) => (
                <TabsContent key={locale} value={locale} className="pt-4">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor={`q-text-${locale}`}>{t('formQuestion')}</Label>
                      <Textarea
                        id={`q-text-${locale}`}
                        ref={locale === 'en' ? questionRef : undefined}
                        rows={3}
                        value={texts[locale].question ?? ''}
                        onChange={(e) => setText(locale, 'question', e.target.value)}
                        disabled={pending}
                        autoFocus={locale === 'en' && !editing}
                      />
                    </div>

                    {qtype === 'mcq' ? (
                      <div className="space-y-2">
                        <Label>{t('formCorrect')}</Label>
                        {OPTION_KEYS.map((key) => {
                          const field = `option${key}` as keyof QuestionTextInput
                          return (
                            <div key={key} className="flex items-center gap-2">
                              {/*
                                One radio group across all three tabs — the name
                                is not locale-scoped on purpose, because there
                                is one correct answer for the question, not one
                                per language.
                              */}
                              <input
                                type="radio"
                                name="correct-option"
                                value={key}
                                checked={correctOption === key}
                                onChange={() => setCorrectOption(key)}
                                disabled={pending}
                                aria-label={`${t('formCorrect')} ${key}`}
                                className="size-4 shrink-0 accent-emerald-600"
                              />
                              <span className="w-4 shrink-0 text-sm text-muted-foreground">
                                {key}
                              </span>
                              <Input
                                value={(texts[locale][field] as string) ?? ''}
                                onChange={(e) => setText(locale, field, e.target.value)}
                                disabled={pending}
                                aria-label={t(`formOption${key}`)}
                              />
                            </div>
                          )
                        })}
                        <p className="text-xs text-muted-foreground">{t('formCorrectHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label htmlFor={`q-answer-${locale}`}>{t('formAnswer')}</Label>
                        <Textarea
                          id={`q-answer-${locale}`}
                          rows={2}
                          maxLength={ANSWER_MAX_LENGTH}
                          value={texts[locale].answerText ?? ''}
                          onChange={(e) => setText(locale, 'answerText', e.target.value)}
                          disabled={pending}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('formAnswerHint', { max: ANSWER_MAX_LENGTH })}
                        </p>
                      </div>
                    )}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </CardHeader>
        </Card>
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button
          type="button"
          disabled={pending || !canPublish}
          onClick={() => submit('active', false)}
        >
          {t('publish')}
        </Button>

        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => submit('draft', false)}
        >
          {t('saveDraft')}
        </Button>

        {/* The bulk-entry control. Only when creating: "add another" after
            editing an existing question would silently start a new one, which
            is not what the button appears to offer. */}
        {!editing && (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => submit(canPublish ? 'active' : 'draft', true)}
          >
            {t('saveAndNew')}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-3">
          {missing.length > 0 && (
            <Badge variant="outline" className="font-normal">
              {t('missingLanguages', {
                languages: missing.map((l) => BANK_LOCALE_LABELS[l]).join(', '),
              })}
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => router.push('/questions')}
          >
            {t('cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
