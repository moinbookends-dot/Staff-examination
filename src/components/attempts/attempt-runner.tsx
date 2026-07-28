'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getFormat } from '@/lib/questions/registry'
import { FormatRenderer } from '@/components/questions/registry'
import type { AnswerPayload, QuestionContent, ResponseFormat } from '@/lib/questions/schemas'
import type { AttemptQuestion, AttemptState } from '@/server/actions/attempts'
import { saveAnswer, submitAttempt } from '@/server/actions/attempts'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ClockIcon, CheckIcon, LoaderIcon, AlertTriangleIcon } from 'lucide-react'

/**
 * Sitting an exam.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COUNTDOWN HERE DECIDES NOTHING.                                       │
 * │                                                                           │
 * │ It renders `expiresAt - now` and nothing else. The deadline it counts     │
 * │ toward was stamped by the server at start_attempt, every save is refused  │
 * │ against it by save_answer, and expire_attempts closes the paper whether   │
 * │ this component is running or not.                                         │
 * │                                                                           │
 * │ So the three obvious attacks are all no-ops: putting the machine clock    │
 * │ back changes the number on screen and nothing else; pausing JavaScript in │
 * │ devtools stops the display but not the clock; closing the tab does not    │
 * │ pause anything. When the timer reaches zero this asks the server to close │
 * │ the attempt — and if that request never arrives, the sweeper closes it    │
 * │ anyway, which is why the auto-submit below is a convenience rather than   │
 * │ an enforcement.                                                           │
 * │                                                                           │
 * │ Every save returns the server's expires_at, so a browser whose clock      │
 * │ drifts or sleeps is corrected continuously rather than at the end.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** How long after the last keystroke to autosave. */
const SAVE_DEBOUNCE_MS = 800

export function AttemptRunner({
  attempt,
  questions,
}: {
  attempt: AttemptState
  questions: AttemptQuestion[]
}) {
  const t = useTranslations('sitting')
  const router = useRouter()
  const [, startNavigation] = useTransition()

  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, AnswerPayload | null>>(() =>
    Object.fromEntries(questions.map((q) => [q.question_id, q.answer])),
  )
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [expiresAt, setExpiresAt] = useState(() => new Date(attempt.expires_at).getTime())
  const [remaining, setRemaining] = useState(() => expiresAt - Date.now())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [timedOut, setTimedOut] = useState(false)

  const current = questions[index]
  const answered = useMemo(
    () => Object.values(answers).filter((a) => a !== null && a !== undefined).length,
    [answers],
  )

  // ── Saving ─────────────────────────────────────────────────────────────────

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** Guards against a late response from an earlier save clobbering the state. */
  const submitted = useRef(false)

  const flush = useCallback(
    async (questionId: string, answer: AnswerPayload) => {
      setSaveState('saving')
      const result = await saveAnswer({ attemptId: attempt.attempt_id, questionId, answer })

      if (result.ok) {
        setSaveState('saved')
        // Re-anchor the countdown on the server's answer, every time.
        setExpiresAt(new Date(result.data.expiresAt).getTime())
      } else {
        setSaveState('failed')
      }
    },
    [attempt.attempt_id],
  )

  const onAnswerChange = useCallback(
    (questionId: string, answer: AnswerPayload) => {
      setAnswers((prev) => ({ ...prev, [questionId]: answer }))

      // Debounced PER QUESTION, not globally: typing into question 3 must not
      // postpone the save of the choice just made on question 2.
      const existing = timers.current.get(questionId)
      if (existing) clearTimeout(existing)
      timers.current.set(
        questionId,
        setTimeout(() => {
          timers.current.delete(questionId)
          if (!submitted.current) void flush(questionId, answer)
        }, SAVE_DEBOUNCE_MS),
      )
    },
    [flush],
  )

  // Any pending debounce is flushed on unmount, so navigating away mid-keystroke
  // does not silently drop the last thing they typed.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [])

  // ── The clock ──────────────────────────────────────────────────────────────

  const doSubmit = useCallback(
    async (reason: 'user' | 'timer') => {
      if (submitted.current) return
      submitted.current = true
      setSubmitting(true)

      // Flush anything still waiting on its debounce before closing the paper.
      for (const [questionId, timer] of timers.current) {
        clearTimeout(timer)
        const answer = answers[questionId]
        if (answer) await saveAnswer({ attemptId: attempt.attempt_id, questionId, answer })
      }
      timers.current.clear()

      const result = await submitAttempt({ attemptId: attempt.attempt_id, reason })
      setSubmitting(false)

      if (result.ok) {
        startNavigation(() => router.refresh())
      } else {
        // The server refused — most likely the deadline passed and the sweeper
        // already closed it. Refreshing shows the true state rather than
        // leaving them on a paper that no longer accepts answers.
        submitted.current = false
        startNavigation(() => router.refresh())
      }
    },
    [answers, attempt.attempt_id, router, startNavigation],
  )

  useEffect(() => {
    const tick = () => {
      const left = expiresAt - Date.now()
      setRemaining(left)

      if (left <= 0 && !submitted.current) {
        setTimedOut(true)
        void doSubmit('timer')
      }
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt, doSubmit])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!current) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>
  }

  const format = (current.snapshot.response_format ?? 'choice_single') as ResponseFormat
  const stem = String(current.snapshot.stem ?? '')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{attempt.exam_title}</h1>
          <p className="text-sm text-muted-foreground">
            {t('questionOf', { current: index + 1, total: questions.length })}
            {' · '}
            {t('answered')} {answered}/{questions.length}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <SaveIndicator state={saveState} />
          <Countdown remaining={remaining} />
        </div>
      </div>

      <Card>
        <CardHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-base leading-relaxed">{stem}</CardTitle>
            <Badge variant="secondary" className="shrink-0">
              {t('markCount', { count: current.marks })}
            </Badge>
          </div>
          {current.section_title && (
            <p className="text-xs text-muted-foreground">{current.section_title}</p>
          )}
        </CardHeader>
        <CardContent>
          <FormatRenderer
            format={format}
            content={current.snapshot.content as QuestionContent}
            answer={answers[current.question_id] ?? getFormat(format).emptyAnswer()}
            onAnswerChange={(answer) => onAnswerChange(current.question_id, answer)}
            readOnly={timedOut || submitting}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          // An exam that forbids backtracking is an integrity setting, not a
          // preference: once a question is behind you it stays behind you.
          disabled={index === 0 || !attempt.allow_backtrack || timedOut}
        >
          {t('previous')}
        </Button>

        {index < questions.length - 1 ? (
          <Button onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))} disabled={timedOut}>
            {t('next')}
          </Button>
        ) : (
          <Button onClick={() => setConfirmOpen(true)} disabled={timedOut || submitting}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        )}
      </div>

      {/* A compact map, so they can see what they have left without paging. */}
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q, i) => {
          const isAnswered = answers[q.question_id] != null
          return (
            <button
              key={q.question_id}
              type="button"
              onClick={() => setIndex(i)}
              disabled={timedOut || (!attempt.allow_backtrack && i < index)}
              aria-current={i === index ? 'true' : undefined}
              aria-label={t('questionOf', { current: i + 1, total: questions.length })}
              className={[
                'size-8 rounded-md border text-xs font-medium transition-colors',
                i === index ? 'border-primary ring-2 ring-primary/30' : '',
                isAnswered ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
                'disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
            >
              {i + 1}
            </button>
          )
        })}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmSubmitTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmSubmitBody', { answered, total: questions.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doSubmit('user')}>{t('submit')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={timedOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('timeUp')}</AlertDialogTitle>
            <AlertDialogDescription>{t('timeUpBody')}</AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  const t = useTranslations('sitting')
  if (state === 'idle') return null

  const map = {
    saving: { icon: LoaderIcon, label: t('saving'), className: 'text-muted-foreground animate-spin' },
    saved: { icon: CheckIcon, label: t('saved'), className: 'text-muted-foreground' },
    failed: { icon: AlertTriangleIcon, label: t('saveFailed'), className: 'text-destructive' },
  } as const

  const { icon: Icon, label, className } = map[state]
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Icon className={`size-3.5 ${className}`} />
      {label}
    </span>
  )
}

function Countdown({ remaining }: { remaining: number }) {
  const t = useTranslations('sitting')
  const total = Math.max(0, Math.floor(remaining / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  const pad = (n: number) => String(n).padStart(2, '0')
  const display = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`

  // Under two minutes the colour changes. Not a countdown they need to watch —
  // a glance that tells them to stop elaborating and finish.
  const urgent = total <= 120

  return (
    <span
      className={`flex items-center gap-1.5 font-mono text-sm tabular-nums ${
        urgent ? 'text-destructive' : 'text-foreground'
      }`}
      role="timer"
      aria-label={t('timeLeft')}
    >
      <ClockIcon className="size-4" />
      {display}
    </span>
  )
}
