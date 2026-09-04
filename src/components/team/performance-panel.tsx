'use client'

import { useMemo, useState } from 'react'
import { useTranslations, useFormatter } from 'next-intl'
import { ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import {
  filterHistory,
  sortHistory,
  summarise,
  type HistoryRow,
  type HistorySort,
} from '@/lib/analytics/performance'
import { ScoreChart } from './score-chart'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Chart, summary and history — one filtered dataset, three renderings.
 *
 * The filter runs ONCE (lib/analytics/performance.ts, unit-tested) and its
 * output feeds the summary tiles, the chart and the table together, so the
 * three can never disagree about which attempts are in view — the spec's
 * "the graph should update according to the selected filters" holds by
 * construction rather than by synchronisation.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SORTS: HistorySort[] = ['newest', 'oldest', 'highest', 'lowest']

export function PerformancePanel({ rows }: { rows: HistoryRow[] }) {
  const t = useTranslations('perf')
  const te = useTranslations('exams')
  const format = useFormatter()

  const [search, setSearch] = useState('')
  const [result, setResult] = useState<'all' | 'passed' | 'failed'>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<HistorySort>('newest')

  const filtered = useMemo(
    () => filterHistory(rows, { search, result, from: from || null, to: to || null }),
    [rows, search, result, from, to],
  )
  const shown = useMemo(() => sortHistory(filtered, sort), [filtered, sort])
  const summary = useMemo(() => summarise(filtered), [filtered])

  const trendLabel =
    summary.trend === 'improving' ? t('trendImproving')
    : summary.trend === 'declining' ? t('trendDeclining')
    : summary.trend === 'stable' ? t('trendStable')
    : t('trendInsufficient')

  const sortLabel = (v: HistorySort) =>
    v === 'newest' ? t('sortNewest')
    : v === 'oldest' ? t('sortOldest')
    : v === 'highest' ? t('sortHighest')
    : t('sortLowest')

  const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

  return (
    <div className="space-y-6">
      {/* ── Summary tiles ───────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t('totalExams')} value={String(summary.totalAttempts)} />
        <Tile label={t('avgScore')} value={pct(summary.avgPercent)} />
        <Tile label={t('best')} value={pct(summary.bestPercent)} />
        <Tile label={t('passRate')} value={pct(summary.passRate)} />
        <Tile label={t('completed')} value={String(summary.completed)} />
        <Tile label={t('passed')} value={String(summary.passed)} />
        <Tile label={t('failed')} value={String(summary.failed)} />
        <Tile label={t('trend')} value={trendLabel} />
      </div>

      {/* ── The chart ───────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('chartLabel')}</h2>
        <div className="mt-3">
          <ScoreChart rows={filtered} />
        </div>
      </section>

      {/* ── History ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('history')}</h2>

        <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('searchExam')}
              placeholder={t('searchExam')}
              className="min-h-11 w-full rounded-md border border-input bg-transparent pr-3 pl-9 text-sm"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={result}
              onChange={(e) => setResult(e.target.value as typeof result)}
              aria-label={t('colResult')}
              className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="all">{t('resultAll')}</option>
              <option value="passed">{t('resultPassed')}</option>
              <option value="failed">{t('resultFailed')}</option>
            </select>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label={t('from')}
              className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label={t('to')}
              className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as HistorySort)}
              aria-label={t('sortNewest')}
              className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {SORTS.map((v) => (
                <option key={v} value={v}>{sortLabel(v)}</option>
              ))}
            </select>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noCompleted')}</p>
        ) : (
          <>
            {/* Phones: one card per attempt, tap-through. */}
            <ul className="mt-3 space-y-3 md:hidden">
              {shown.map((r) => (
                <li key={r.attempt_id} className="rounded-lg border">
                  <Link href={`/monitoring/${r.attempt_id}`} className="block p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate font-medium">{r.exam_title}</p>
                      <ResultBadge passed={r.passed} pass={te('resultPass')} fail={te('resultFail')} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        {r.submitted_at
                          ? format.dateTime(new Date(r.submitted_at), { dateStyle: 'medium' })
                          : '—'}
                      </span>
                      <span className="tabular-nums">
                        {r.score ?? '—'} / {r.max_score ?? '—'} · {r.percent ?? '—'}%
                      </span>
                      {r.minutes !== null && (
                        <span className="tabular-nums">{t('minutesShort', { n: r.minutes })}</span>
                      )}
                      <ChevronRightIcon aria-hidden className="ml-auto size-4" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {/* md and up: the table. */}
            <div className="mt-3 hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colExam')}</TableHead>
                    <TableHead>{t('colDate')}</TableHead>
                    <TableHead className="text-right">{t('colAttempt')}</TableHead>
                    <TableHead className="text-right">{t('colScore')}</TableHead>
                    <TableHead className="text-right">{t('colPercent')}</TableHead>
                    <TableHead className="text-right">{t('colDuration')}</TableHead>
                    <TableHead>{t('colResult')}</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r) => (
                    <TableRow key={r.attempt_id}>
                      <TableCell className="font-medium">{r.exam_title}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {r.submitted_at
                          ? format.dateTime(new Date(r.submitted_at), { dateStyle: 'medium' })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.attempt_no ?? 1}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.score ?? '—'} / {r.max_score ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.percent ?? '—'}%</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.minutes !== null ? t('minutesShort', { n: r.minutes }) : '—'}
                      </TableCell>
                      <TableCell>
                        <ResultBadge passed={r.passed} pass={te('resultPass')} fail={te('resultFail')} />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/monitoring/${r.attempt_id}`}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          {t('viewAttempt')}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-1 rounded-xl p-4">
      <p className="text-label-caps text-muted-foreground">{label}</p>
      <p className="mt-1 text-title-md tabular-nums">{value}</p>
    </div>
  )
}

function ResultBadge({
  passed,
  pass,
  fail,
}: {
  passed: boolean | null
  pass: string
  fail: string
}) {
  if (passed === null) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <Badge
      variant="outline"
      className={
        passed
          ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
          : 'border-destructive/40 text-destructive'
      }
    >
      {passed ? pass : fail}
    </Badge>
  )
}
