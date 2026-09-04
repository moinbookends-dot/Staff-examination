'use client'

import { useMemo, useState } from 'react'
import { useTranslations, useFormatter, useNow } from 'next-intl'
import { ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import type { ParticipantRow } from '@/server/exams/live'
import {
  filterParticipants,
  sortParticipants,
  type ParticipantSort,
  type ParticipantStatusFilter,
} from '@/lib/analytics/participants'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The participant table, with its controls.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ CLIENT-SIDE OVER THE FETCHED ROWS, AND THAT IS A SIZED DECISION, not a    ║
 * ║ shortcut: an exam audience here is a company's staff — tens, not tens of  ║
 * ║ thousands — and the rows are already in hand for the summary tiles.       ║
 * ║ Filtering them again on the server would add a round trip per keystroke   ║
 * ║ to make the same list smaller. The filter functions live in               ║
 * ║ lib/analytics/participants.ts where they are unit-tested; this file only  ║
 * ║ wires them to inputs.                                                     ║
 * ║                                                                           ║
 * ║ SCORES ARRIVE ALREADY WITHHELD (see exam-monitoring's box). Nothing here  ║
 * ║ decides visibility — a dash means the database sent null.                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const STATE_TONE: Record<ParticipantRow['state'], string> = {
  released: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  submitted: 'border-sky-500/40 text-sky-700 dark:text-sky-400',
  in_progress: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  expired: 'border-destructive/40 text-destructive',
  not_started: 'border-muted-foreground/30 text-muted-foreground',
}

const STATUS_FILTERS: ParticipantStatusFilter[] = [
  'all', 'not_started', 'in_progress', 'submitted', 'released', 'expired',
  'auto_submitted', 'passed', 'failed',
]

const SORTS: ParticipantSort[] = ['name', 'started', 'submitted', 'activity', 'highest', 'lowest']

export function ParticipantTable({ rows }: { rows: ParticipantRow[] }) {
  const t = useTranslations('exams')
  const format = useFormatter()
  // Ticks once a minute so "time left" stays honest without a per-second timer.
  const now = useNow({ updateInterval: 60_000 })

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ParticipantStatusFilter>('all')
  const [sort, setSort] = useState<ParticipantSort>('name')

  const shown = useMemo(
    () => sortParticipants(filterParticipants(rows, { search, status }), sort),
    [rows, search, status, sort],
  )

  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—'

  const timeLeft = (r: ParticipantRow) => {
    if (r.state !== 'in_progress' || !r.expiresAt) return null
    const ms = Date.parse(r.expiresAt) - now.getTime()
    if (ms <= 0) return '0:00'
    const mins = Math.floor(ms / 60_000)
    const secs = Math.floor((ms % 60_000) / 1000)
    return `${mins}:${String(secs).padStart(2, '0')}`
  }

  const statusLabel = (r: ParticipantRow) =>
    t(
      (r.state === 'not_started' ? 'pNotStarted'
        : r.state === 'in_progress' ? 'pInProgress'
        : r.state === 'submitted' ? 'pSubmitted'
        : r.state === 'expired' ? 'pExpired'
        : 'pReleased') as 'pNotStarted',
    )

  const filterLabel = (v: ParticipantStatusFilter) =>
    v === 'all' ? t('monFilterAll')
    : v === 'auto_submitted' ? t('monAutoSubmitted')
    : v === 'passed' ? t('monPassedF')
    : v === 'failed' ? t('monFailedF')
    : v === 'not_started' ? t('pNotStarted')
    : v === 'in_progress' ? t('pInProgress')
    : v === 'submitted' ? t('pSubmitted')
    : v === 'expired' ? t('pExpired')
    : t('pReleased')

  const sortLabel = (v: ParticipantSort) =>
    v === 'name' ? t('monSortName')
    : v === 'started' ? t('monSortStarted')
    : v === 'submitted' ? t('monSortSubmitted')
    : v === 'activity' ? t('monSortActivity')
    : v === 'highest' ? t('monSortHighest')
    : t('monSortLowest')

  const resultCell = (r: ParticipantRow) =>
    r.passed === null ? (
      <span className="text-body-sm text-muted-foreground">
        {r.state === 'not_started' ? '—' : t('resultPending')}
      </span>
    ) : (
      <Badge
        variant="outline"
        className={
          r.passed
            ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
            : 'border-destructive/40 text-destructive'
        }
      >
        {r.passed ? t('resultPass') : t('resultFail')}
      </Badge>
    )

  /*
   * Only a row with an attempt is a link — a not-started person has no attempt
   * page to open, and a dead link teaches people the table is broken.
   */
  const rowHref = (r: ParticipantRow) => (r.attemptId ? `/monitoring/${r.attemptId}` : null)

  return (
    <div className="space-y-3">
      {/* ── Controls ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('monSearch')}
            placeholder={t('monSearch')}
            className="min-h-11 w-full rounded-md border border-input bg-transparent pr-3 pl-9 text-sm"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ParticipantStatusFilter)}
          aria-label={t('monStatus')}
          className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {STATUS_FILTERS.map((v) => (
            <option key={v} value={v}>{filterLabel(v)}</option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as ParticipantSort)}
          aria-label={t('monSortName')}
          className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {SORTS.map((v) => (
            <option key={v} value={v}>{sortLabel(v)}</option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('monNoMatch')}</p>
      ) : (
        <>
          {/* ── Phones: one card per person ─────────────────────────────── */}
          <ul className="space-y-3 md:hidden">
            {shown.map((r) => {
              const left = timeLeft(r)
              const href = rowHref(r)
              const body = (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.fullName || r.email}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {[r.department, r.outlet].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </div>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="outline" className={cn(STATE_TONE[r.state])}>
                        {statusLabel(r)}
                      </Badge>
                      {r.autoSubmitted && (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t('monAutoSubmitted')}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    {r.state === 'in_progress' && (
                      <span className="tabular-nums">
                        {t('monProgress')}: {r.answeredN}/{r.questionN}
                        {left && <> · {t('monTimeLeft')}: {left}</>}
                      </span>
                    )}
                    <span className="tabular-nums">{t('monStarted')}: {when(r.startedAt)}</span>
                    <span className="tabular-nums">{t('monSubmittedCol')}: {when(r.submittedAt)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="tabular-nums text-sm">
                      {r.score !== null ? `${r.score} / ${r.maxScore ?? 0}` : '—'}
                    </span>
                    <span className="flex items-center gap-2">
                      {resultCell(r)}
                      {href && <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
                    </span>
                  </div>
                </>
              )
              return (
                <li key={r.employeeId} className="rounded-lg border">
                  {href ? (
                    <Link href={href} className="block p-3">{body}</Link>
                  ) : (
                    <div className="p-3">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>

          {/* ── md and up: the table ────────────────────────────────────── */}
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('monEmployee')}</TableHead>
                  <TableHead>{t('monDepartment')}</TableHead>
                  <TableHead>{t('monStatus')}</TableHead>
                  <TableHead className="text-right">{t('monProgress')}</TableHead>
                  <TableHead>{t('monStarted')}</TableHead>
                  <TableHead>{t('monSubmittedCol')}</TableHead>
                  <TableHead className="text-right">{t('monScore')}</TableHead>
                  <TableHead>{t('monResult')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const left = timeLeft(r)
                  const href = rowHref(r)
                  return (
                    <TableRow key={r.employeeId}>
                      <TableCell>
                        <span className="font-medium">{r.fullName || r.email}</span>
                        {r.attemptNo !== null && r.attemptNo > 1 && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t('monAttemptNo')} {r.attemptNo}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {[r.department, r.outlet].filter(Boolean).join(' · ') || '—'}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge variant="outline" className={cn(STATE_TONE[r.state])}>
                            {statusLabel(r)}
                          </Badge>
                          {r.autoSubmitted && (
                            <Badge variant="outline" className="text-muted-foreground">
                              {t('monAutoSubmitted')}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.state === 'in_progress' ? (
                          <span>
                            {r.answeredN}/{r.questionN}
                            {left && (
                              <span className="block text-xs text-muted-foreground">{left}</span>
                            )}
                          </span>
                        ) : r.attemptId ? (
                          `${r.answeredN}/${r.questionN}`
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{when(r.startedAt)}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{when(r.submittedAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.score !== null ? `${r.score} / ${r.maxScore ?? 0}` : '—'}
                      </TableCell>
                      <TableCell>{resultCell(r)}</TableCell>
                      <TableCell>
                        {href && (
                          <Link
                            href={href}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            {t('monOpen')}
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
