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
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
import { cn } from '@/lib/utils'
import { ClockIcon, CheckIcon, LoaderIcon, AlertTriangleIcon, LockIcon } from 'lucide-react'

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
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO GLASS, NO TRANSLUCENCY, ANYWHERE ON THIS SCREEN.                       │
 * │                                                                           │
 * │ Every other surface in the product may use the frosted chrome. This one   │
 * │ may not: it is a timed assessment read on a phone, in a kitchen, often on │
 * │ a screen with grease on it and a window behind it. Translucency costs     │
 * │ contrast, and contrast here costs marks.                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT A SCREEN-READER USER GETS THAT THEY DID NOT BEFORE.                  │
 * │                                                                           │
 * │  · The time remaining, spoken at thresholds. role="timer" is not a live   │
 * │    region — a number that changes every second inside one announces       │
 * │    nothing in most screen readers, and if it did it would be unusable.    │
 * │    So the ticking display stays silent and a separate polite region says  │
 * │    "ten minutes remaining" once, at each threshold that matters.          │
 * │  · The question, on arrival. Moving between questions changes the whole   │
 * │    document with no navigation, so focus is placed on the new question's  │
 * │    heading — otherwise focus stays on the Next button and nothing is read.│
 * │  · Whether a question is answered, in the navigator's accessible name     │
 * │    rather than only in its colour.                                        │
 * │  · Save state from a region that is always in the DOM. A live region      │
 * │    inserted at the same moment as its content is routinely missed.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** How long after the last keystroke to autosave. */
const SAVE_DEBOUNCE_MS = 800

/**
 * Seconds remaining at which the time is spoken.
 *
 * Descending, and each fires once. Ten and five minutes are "wrap this up";
 * one minute and thirty seconds are "stop writing". Announcing more often than
 * this turns an aid into a distraction — the whole point is that somebody who
 * cannot see the clock gets the same handful of glances a sighted candidate
 * takes, not a metronome.
 */
const ANNOUNCE_AT_SECONDS = [600, 300, 120, 60, 30]

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
  /**
   * The threshold last crossed, in seconds — not the rendered sentence.
   *
   * Holding the number rather than the string keeps `t` out of the tick
   * effect's dependencies. `useTranslations` does not promise a stable
   * identity, and an unstable `t` in there would tear down and rebuild the
   * one-second interval on every single render.
   */
  const [announceSeconds, setAnnounceSeconds] = useState<number | null>(null)

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

  /** Thresholds already spoken, so a re-render cannot repeat one. */
  const announced = useRef(new Set<number>())

  useEffect(() => {
    const tick = () => {
      const left = expiresAt - Date.now()
      setRemaining(left)

      const seconds = Math.floor(left / 1000)

      // Every threshold now behind us that has not been spoken. Plural,
      // because a phone that slept through several of them wakes up having
      // crossed them all at once.
      const crossed = ANNOUNCE_AT_SECONDS.filter(
        (s) => seconds <= s && !announced.current.has(s),
      )
      if (crossed.length > 0 && seconds > 0) {
        for (const s of crossed) announced.current.add(s)
        // The SMALLEST of them — the one closest to the truth. Taking the
        // largest instead is a first draft that tells somebody waking at 90
        // seconds left that they have ten minutes, which is worse than saying
        // nothing at all. Marking every crossed threshold consumed is what
        // stops the skipped ones being replayed one per second afterwards.
        setAnnounceSeconds(Math.min(...crossed))
      }

      if (left <= 0 && !submitted.current) {
        setTimedOut(true)
        void doSubmit('timer')
      }
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt, doSubmit])

  // ── Focus, on moving between questions ─────────────────────────────────────

  const headingRef = useRef<HTMLHeadingElement>(null)
  /** Skips the first render: focusing on mount would steal it from the page. */
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    headingRef.current?.focus()
  }, [index])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!current) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>
  }

  const format = (current.snapshot.response_format ?? 'choice_single') as ResponseFormat
  const stem = String(current.snapshot.stem ?? '')
  const progressPercent = Math.round((answered / questions.length) * 100)
  const locked = timedOut || submitting

  return (
    <div className="space-y-4 pb-4">
      {/* Spoken, never seen. Separate from the ticking display, which stays
          silent — see the header. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announceSeconds === null
          ? ''
          : announceSeconds >= 60
            ? t('timeAnnounce', { minutes: Math.round(announceSeconds / 60) })
            : t('timeAnnounceSeconds', { seconds: announceSeconds })}
      </p>

      {/* ── The bar that must always be visible ──────────────────────────────
          Solid, not glass. `top-14` clears the app header, which is sticky. */}
      <div className="sticky top-14 z-20 -mx-4 border-b bg-background px-4 py-3 lg:-mx-6 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="truncate font-heading text-lg font-semibold tracking-tight">
              {attempt.exam_title}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('questionOf', { current: index + 1, total: questions.length })}
              {' · '}
              {t('progressLabel', { answered, total: questions.length })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <SaveIndicator state={saveState} />
            <Countdown remaining={remaining} />
          </div>
        </div>

        {/* Progress. aria-hidden because the same fact is already in the text
            above it, and a second announcement of it is noise. */}
        <div
          aria-hidden
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            {/* A real heading, and focusable. CardTitle renders a <div>, so
                before this the question a candidate was answering was not a
                heading at all and could not be jumped to. tabIndex={-1} makes
                it programmatically focusable without adding a tab stop. */}
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="font-heading text-base leading-relaxed font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="sr-only">
                {t('questionHeading', { current: index + 1, total: questions.length })}.{' '}
              </span>
              {stem}
            </h2>
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
            readOnly={locked}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          size="lg"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          // An exam that forbids backtracking is an integrity setting, not a
          // preference: once a question is behind you it stays behind you.
          disabled={index === 0 || !attempt.allow_backtrack || timedOut}
        >
          {t('previous')}
        </Button>

        {index < questions.length - 1 ? (
          <Button size="lg" onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))} disabled={timedOut}>
            {t('next')}
          </Button>
        ) : (
          <Button size="lg" onClick={() => setConfirmOpen(true)} disabled={locked}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        )}
      </div>

      {/* A compact map, so they can see what they have left without paging. */}
      <nav aria-label={t('navLabel')}>
        {!attempt.allow_backtrack && (
          <p className="mb-2 text-xs text-muted-foreground">{t('noBacktrack')}</p>
        )}
        <ul className="flex flex-wrap gap-1.5">
          {questions.map((q, i) => {
            const isAnswered = answers[q.question_id] != null
            const isCurrent = i === index
            const isLocked = timedOut || (!attempt.allow_backtrack && i < index)

            return (
              <li key={q.question_id}>
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  disabled={isLocked}
                  aria-current={isCurrent ? 'true' : undefined}
                  // The state is in the NAME, not only in the colour. A
                  // navigator that distinguishes answered from unanswered by
                  // fill alone tells a screen-reader user nothing, and tells a
                  // colour-blind user very little.
                  aria-label={
                    isLocked
                      ? t('navLocked', { n: i + 1 })
                      : isCurrent
                        ? t('navCurrent', { n: i + 1 })
                        : isAnswered
                          ? t('navAnswered', { n: i + 1 })
                          : t('navUnanswered', { n: i + 1 })
                  }
                  className={cn(
                    // 44px, because this is tapped with a thumb, mid-shift.
                    'relative grid size-11 place-items-center rounded-lg border text-sm font-medium tabular-nums transition-colors',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
                    isCurrent && 'border-primary ring-2 ring-primary',
                    isAnswered
                      ? 'border-primary/40 bg-primary/15 text-foreground'
                      : 'text-muted-foreground',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  {i + 1}
                  {/* A second, non-colour signal. The number stays legible in
                      every state, which is the rule the design system states. */}
                  {isAnswered && !isLocked && (
                    <CheckIcon
                      aria-hidden
                      className="absolute -top-1 -right-1 size-3.5 rounded-full bg-primary p-0.5 text-primary-foreground"
                    />
                  )}
                  {isLocked && !timedOut && (
                    <LockIcon aria-hidden className="absolute -top-1 -right-1 size-3" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

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

/**
 * Save state.
 *
 * The wrapper is ALWAYS rendered, even when idle, and only its contents change.
 * A live region that appears at the same moment as its first message is
 * routinely missed — the screen reader has to be observing the node before the
 * text arrives. The old version returned null when idle, which is exactly that
 * mistake.
 */
function SaveIndicator({ state }: { state: SaveState }) {
  const t = useTranslations('sitting')

  const map = {
    saving: { icon: LoaderIcon, label: t('saving'), className: 'animate-spin' },
    saved: { icon: CheckIcon, label: t('saved'), className: '' },
    failed: { icon: AlertTriangleIcon, label: t('saveFailed'), className: '' },
  } as const

  const entry = state === 'idle' ? null : map[state]
  const Icon = entry?.icon

  return (
    <span
      role="status"
      aria-live="polite"
      // Deliberately no aria-label: it would replace the contents as the
      // accessible name, and the contents are the entire message. A labelled
      // live region that never announces what changed is worse than none.
      className={cn(
        'flex items-center gap-1.5 text-xs',
        state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {Icon && <Icon aria-hidden className={cn('size-3.5', entry.className)} />}
      {entry?.label}
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

  // Two steps, because one is not enough warning and three is a light show.
  // Under five minutes: amber, stop elaborating. Under one: red, finish.
  const urgent = total <= 60
  const warning = total <= 300 && !urgent

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-lg font-semibold tabular-nums',
        urgent && 'bg-destructive/12 text-destructive',
        warning && 'bg-warning/14 text-warning',
        !urgent && !warning && 'text-foreground',
      )}
      role="timer"
      // Silent on purpose. A number changing every second inside a live region
      // is unusable; the thresholds are announced separately.
      aria-live="off"
    >
      <ClockIcon aria-hidden className="size-4" />
      {/* NOT aria-label. aria-label REPLACES an element's contents as its
          accessible name, so `aria-label="Time left"` on this span — which is
          what was here before — meant a screen reader read "Time left" and
          never read the time. An sr-only prefix adds the label instead of
          substituting for the value. */}
      <span className="sr-only">{t('timeLeft')}: </span>
      {display}
    </span>
  )
}
