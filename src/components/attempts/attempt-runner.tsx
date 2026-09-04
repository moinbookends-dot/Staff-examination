'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getFormat } from '@/lib/questions/registry'
import { FormatRenderer } from '@/components/questions/registry'
import type { AnswerPayload, QuestionContent, ResponseFormat } from '@/lib/questions/schemas'
import type { AttemptQuestion, AttemptState } from '@/server/actions/attempts'
import { saveAnswer, submitAttempt } from '@/server/actions/attempts'
import {
  acknowledgeAnswer,
  clearOutbox,
  pendingAnswers,
  queueAnswer,
  readOutbox,
} from '@/lib/attempts/outbox'
import { useExamChrome, useExitGuard, useOnline } from './use-exam-mode'
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
import {
  ClockIcon,
  CheckIcon,
  LoaderIcon,
  AlertTriangleIcon,
  CloudOffIcon,
  LockIcon,
} from 'lucide-react'

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

/**
 * `pending` is the state the old vocabulary was missing, and its absence is
 * what made the indicator dishonest: an answer that had not reached the
 * server could only be shown as "saved" or as "failed", and it was neither.
 * It is on this device, and it is queued.
 */
type SaveState = 'idle' | 'saving' | 'saved' | 'pending' | 'failed'

/** How long after the last keystroke to autosave. */
const SAVE_DEBOUNCE_MS = 800

/** First retry after a failed save. Doubles, capped — see scheduleRetry. */
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 30_000

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

  /** Raised when back is pressed, so leaving is a decision rather than a swipe. */
  const [exitOpen, setExitOpen] = useState(false)
  /**
   * The paper was closed because the candidate left the active exam. Drives
   * the blocking dialog below — the DISPLAY only. The record itself is
   * attempts.submit_reason='tab_switch', written server-side by the submit;
   * clearing this state, or any client state, changes nothing the server or
   * an admin will ever see.
   */
  const [leftExam, setLeftExam] = useState(false)

  const current = questions[index]
  const answered = useMemo(
    () => Object.values(answers).filter((a) => a !== null && a !== undefined).length,
    [answers],
  )

  // ── Saving ─────────────────────────────────────────────────────────────────

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** Guards against a late response from an earlier save clobbering the state. */
  const submitted = useRef(false)

  /**
   * Bumped whenever a save fails, to ask for another attempt.
   *
   * A counter rather than a boolean, and state rather than a ref, because the
   * retry is owned by an EFFECT below. That inverts the obvious design — a
   * failure handler that schedules its own timer — and it is worth it: the
   * handler would have to reach forward to a drain that does not exist yet,
   * and the timer would have to read it through a ref written during render.
   * Both are the shapes React now rejects outright.
   */
  const [retryRequest, setRetryRequest] = useState(0)
  const backoff = useRef(RETRY_BASE_MS)

  /**
   * Send one answer, and keep it queued until the server says it has it.
   *
   * The outbox write happens in onAnswerChange BEFORE this is ever called, so
   * an answer is durable from the keystroke onward rather than from the
   * response onward. This only ever REMOVES from the queue.
   */
  const flush = useCallback(
    async (questionId: string, answer: AnswerPayload) => {
      setSaveState('saving')
      const result = await saveAnswer({ attemptId: attempt.attempt_id, questionId, answer })

      if (result.ok) {
        acknowledgeAnswer(attempt.attempt_id, questionId, answer)
        backoff.current = RETRY_BASE_MS

        // Anything still queued keeps the honest state: some of this
        // candidate's work is on this device and nowhere else.
        const stillQueued = pendingAnswers(attempt.attempt_id).length > 0
        setSaveState(stillQueued ? 'pending' : 'saved')

        // Re-anchor the countdown on the server's answer, every time.
        setExpiresAt(new Date(result.data.expiresAt).getTime())
        return true
      }

      /*
       * Left in the outbox deliberately. The retry effect is what makes the
       * "retrying" wording true — the copy used to say it and nothing did it.
       */
      setSaveState('failed')
      setRetryRequest((n) => n + 1)
      return false
    },
    [attempt.attempt_id],
  )

  /**
   * Push everything the server has not acknowledged, oldest first.
   *
   * Stops at the first failure rather than marching through the queue: if one
   * request could not reach the server, the next twenty will not either, and
   * hammering a dead connection is how a flaky network becomes a flat battery.
   */
  const drain = useCallback(async () => {
    if (submitted.current) return

    for (const [questionId, answer] of pendingAnswers(attempt.attempt_id)) {
      if (submitted.current) return
      const ok = await flush(questionId, answer)
      if (!ok) return
    }
  }, [attempt.attempt_id, flush])

  /*
   * The retry, owned here so nothing has to reach forward to it.
   *
   * Exponential and capped: a candidate on a dead connection for ten minutes
   * should not have sent three hundred requests by the time it returns.
   */
  useEffect(() => {
    if (retryRequest === 0) return

    const wait = backoff.current
    backoff.current = Math.min(backoff.current * 2, RETRY_MAX_MS)

    const id = setTimeout(() => void drain(), wait)
    return () => clearTimeout(id)
  }, [retryRequest, drain])
  const onAnswerChange = useCallback(
    (questionId: string, answer: AnswerPayload) => {
      setAnswers((prev) => ({ ...prev, [questionId]: answer }))

      /*
       * Durable BEFORE the network is involved. Synchronous, so it has
       * already happened if the tab is closed on the next line.
       */
      queueAnswer(attempt.attempt_id, questionId, answer)
      setSaveState('pending')

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
    [attempt.attempt_id, flush],
  )

  /*
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THIS COMMENT USED TO BE FALSE.                                        │
   * │                                                                       │
   * │ It said the pending debounce was flushed on unmount; the code cleared │
   * │ the timers instead. Leaving the screen within 800ms of a keystroke    │
   * │ therefore dropped that answer without a trace.                        │
   * │                                                                       │
   * │ The timers are still cleared — they are about to fire into a dead     │
   * │ component — but what they were going to send is now in the outbox,    │
   * │ so it is picked up on the next mount rather than lost.                │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [])

  /*
   * Anything this device knows and the server does not — from a previous
   * visit, a reload, or a crash — is adopted on mount and pushed.
   *
   * The queued copy WINS over the server’s: it is strictly newer, because it
   * only exists at all while the server has not acknowledged it.
   */
  const adopted = useRef(false)
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true

    /*
     * Async so the state write is not synchronous inside the effect body —
     * and honest about ordering: the queued copy is adopted BEFORE the drain
     * is attempted, so the candidate sees their own answer immediately even
     * if the network is still down.
     */
    void (async () => {
      const queued = readOutbox(attempt.attempt_id)
      if (Object.keys(queued).length > 0) {
        setAnswers((prev) => ({ ...prev, ...queued }))
        setSaveState('pending')
      }
      await drain()
    })()
  }, [attempt.attempt_id, drain])

  /*
   * Both signals, because neither is sufficient. `online` fires when the
   * browser regains an interface, which is not the same as the server being
   * reachable; `visibilitychange` catches the phone that was asleep through
   * the whole outage and woke up with a working connection and a full queue.
   */
  useEffect(() => {
    const retry = () => void drain()
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry()
    }

    window.addEventListener('online', retry)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', retry)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [drain])

  // ── The clock ──────────────────────────────────────────────────────────────

  const doSubmit = useCallback(
    async (reason: 'user' | 'timer' | 'tab_switch') => {
      if (submitted.current) return
      submitted.current = true
      // Shown the moment they come back, not when the network round-trip
      // finishes — a candidate returning from another app should meet the
      // consequence, not a still-open paper.
      if (reason === 'tab_switch') setLeftExam(true)
      // The attempt is closed; the server will refuse these from here on.
      clearOutbox(attempt.attempt_id)
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

  /*
   * ── Leaving the exam IS cheating ──────────────────────────────────────────
   *
   * Explicit product decision: minimising the app, switching tabs or apps,
   * locking the phone, split-screen that hides the page, or navigating away
   * closes the paper as it stands with reason 'tab_switch', and the product
   * displays that closure as CHEATING everywhere — monitoring, history, and
   * to the candidate. visibilitychange→hidden is the primary trigger because
   * it is the one signal every browser fires reliably for all of those.
   *
   * WHAT IS DELIBERATELY NOT A TRIGGER:
   *  · window blur alone — clicking the address bar, a permission prompt, or
   *    a print dialog blurs the window while the exam stays fully visible.
   *    Submitting on it would brand people for using their browser. A desktop
   *    window placed alongside (exam still visible) therefore goes undetected;
   *    that limitation is documented, not papered over.
   *  · pagehide — the only case it adds over visibilitychange is a RELOAD,
   *    and an accidental refresh is not leaving the exam.
   *
   * THE COST IS REAL AND ACCEPTED: hidden also fires for an incoming call
   * answered or a screen that auto-locks while the candidate is thinking.
   * Those now count as cheating, and the exit dialog says so up front. Every
   * answer is already on the server (each change saves through the outbox),
   * so what is lost is the chance to continue — never work already done. The
   * server stays authoritative: repeated events are a no-op (submit_attempt
   * is idempotent since 0094), and the sweeper closes the paper if this
   * handler never runs at all.
   *
   * Distinct from the drain-on-visible listener above on purpose: that one
   * recovers answers, this one enforces policy, and coupling them would make
   * the recovery path depend on the punishment path.
   */
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && !submitted.current) {
        void doSubmit('tab_switch')
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [doSubmit])

  /** Thresholds already spoken, so a re-render cannot repeat one. */
  const announced = useRef(new Set<number>())
  /**
   * True until the first tick has run.
   *
   * A fresh mount starts with an empty `announced` set, so every threshold
   * above the time now left looks uncrossed. Speaking the smallest of them is
   * how somebody who hits Resume with 5:01 on the clock gets told they have
   * TEN minutes — and on an exam of ten minutes or less it happens on the very
   * first tick of the paper, announcing more time than the exam contains.
   *
   * So the first tick banks whatever has already gone by and says nothing.
   * A number that is silently absent is recoverable; a number that is wrong is
   * acted on.
   */
  const firstTick = useRef(true)

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
        // Banked either way, so a threshold that has already gone by can never
        // be replayed one-per-second afterwards.
        for (const s of crossed) announced.current.add(s)

        const nearest = Math.min(...crossed)
        // Spoken only if it was crossed JUST NOW. `nearest - seconds` is how
        // stale the crossing is: 0-1s on a live tick, minutes on a mount or
        // after a throttled tab. Announcing a stale threshold states a time
        // the candidate does not have, and this region is the only clock a
        // screen-reader user gets — the display is deliberately silent.
        if (!firstTick.current && nearest - seconds <= 2) {
          setAnnounceSeconds(nearest)
        }
      }
      firstTick.current = false

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

  // ── Exam Mode ──────────────────────────────────────────────────────────────

  /*
   * Above the early return, because hooks cannot be conditional — an attempt
   * with no questions must run exactly the same hooks as one with fifty.
   *
   * `submitting` and `timedOut` rather than the `submitted` ref: a ref may not
   * be read during render, and these two are the same fact in state form. Once
   * either is true the attempt is over, so every guard lifts together and the
   * candidate is not trapped on a results card with the screen forced awake.
   */
  const examLive = !timedOut && !submitting && !leftExam

  useExamChrome(examLive)
  const online = useOnline()

  const onAttemptedExit = useCallback(() => setExitOpen(true), [])
  useExitGuard(examLive, onAttemptedExit)

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!current) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>
  }

  const format = (current.snapshot.response_format ?? 'choice_single') as ResponseFormat
  const stem = String(current.snapshot.stem ?? '')
  const progressPercent = Math.round((answered / questions.length) * 100)
  const locked = timedOut || submitting || leftExam

  return (
    <div className="pb-safe space-y-4 pb-4">
      {/*
        ── Connection ───────────────────────────────────────────────────────
        Shown only while the browser believes it is offline, and worded around
        what is actually true: the answers are on this device. It deliberately
        does NOT say they are saved — the outbox knows the difference between
        "written here" and "the server has it", and so should the candidate.

        role="status", not "alert": losing Wi-Fi mid-question is not an error
        the candidate caused and cannot be one they must dismiss.
      */}
      {!online && (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          {t('offlineBanner')}
        </p>
      )}
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
      {/*
        top-0, not top-14.

        The 14 was hand-tuned to clear the app shell's 56px header — which this
        screen no longer renders inside, now that Exam Mode is its own route
        group. Left alone it would pin the exam header 56px down the page with
        nothing above it.

        pt-safe because the exam now draws edge to edge and the bar has to
        clear the notch itself. Still no `glass`: this screen uses no
        translucency anywhere, deliberately — a timed assessment should not
        trade contrast for decoration.
      */}
      <div className="pt-safe px-safe sticky top-0 z-20 -mx-4 border-b bg-background px-4 py-3 lg:-mx-6 lg:px-6">
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
            <SaveIndicator state={saveState} online={online} />
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
            {/*
              The unanswered count, stated rather than left to be worked out.

              "Answered 37 of 50" is the same arithmetic, but this is the last
              moment before an irreversible action and the number that matters
              is the one being given up. Rendered only when there is one, so a
              complete paper is not congratulated on having nothing missing.
            */}
            {answered < questions.length && (
              <p className="mt-2 text-sm font-medium text-warning">
                {t('unanswered', { count: questions.length - answered })}
              </p>
            )}
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

      {/*
        The violation counterpart of the time-up dialog. No footer and no way
        to dismiss: there is no decision left to make. router.refresh() is
        already in flight and replaces this whole screen with the closed
        result card, which repeats the same sentence in ink.
        `!timedOut` so the two verdicts can never stack — the clock's dialog
        wins the race it lost the paper to.
      */}
      <AlertDialog open={leftExam && !timedOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cheatedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('cheatedBody')}</AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        ── Leaving ──────────────────────────────────────────────────────────
        Raised by the back button, never by the timer.

        It does NOT submit. Leaving is not finishing: the attempt stays open,
        the deadline keeps running on the server, and the answers are already
        durable. Submitting on somebody's behalf because they mis-swiped would
        be a worse outcome than the accident it prevents.

        The wording says the timer keeps running, because that is the part a
        candidate cannot see and would otherwise assume is paused.
      */}
      <AlertDialog open={exitOpen} onOpenChange={setExitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('leaveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('leaveBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('leaveStay')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // The guard pushed a sentinel entry to catch this press; going
                // back twice steps over it and off the exam.
                setExitOpen(false)
                window.history.go(-2)
              }}
            >
              {t('leaveConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
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
function SaveIndicator({ state, online }: { state: SaveState; online: boolean }) {
  const t = useTranslations('sitting')

  /*
   * `pending` is the state that makes the rest of this honest.
   *
   * "Saved" now means the server has it. Anything still on this device says
   * so, in those words — a candidate who loses their phone should not have
   * been told their work was safe when it was sitting in localStorage.
   */
  const map = {
    saving: { icon: LoaderIcon, label: t('saving'), className: 'animate-spin' },
    saved: { icon: CheckIcon, label: t('saved'), className: '' },
    pending: { icon: CloudOffIcon, label: t('savedOnDevice'), className: '' },
    failed: { icon: AlertTriangleIcon, label: t('saveFailed'), className: '' },
  } as const

  /*
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ "SAVING…" IS A LIE WHILE THE DEVICE IS OFFLINE.                       │
   * │                                                                       │
   * │ A request made with no network does not fail quickly — it hangs until │
   * │ the browser gives up, which can be tens of seconds. The state machine │
   * │ is therefore genuinely in `saving` that whole time, and the candidate │
   * │ watches a spinner that claims their answer is on its way to a server  │
   * │ it cannot reach. Measured: still "Saving…" two seconds after the      │
   * │ network was cut.                                                      │
   * │                                                                       │
   * │ What is TRUE in that moment is what `pending` says: the answer is on  │
   * │ this device. So while the browser reports no connection, an in-flight │
   * │ save reads as pending rather than as progress.                        │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  const effective: SaveState = !online && state === 'saving' ? 'pending' : state

  const entry = effective === 'idle' ? null : map[effective]
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
        // `effective`, not `state`: offline reads as pending, and pending is
        // a normal condition rather than an error.
        effective === 'failed' ? 'text-destructive' : 'text-muted-foreground',
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
