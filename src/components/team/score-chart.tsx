'use client'

import { useMemo, useState } from 'react'
import { useTranslations, useFormatter } from 'next-intl'
import { useRouter } from '@/lib/i18n/navigation'
import type { HistoryRow } from '@/lib/analytics/performance'
import { completedChronological } from '@/lib/analytics/performance'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Score over time — one person, one series.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ FORM: a dot-and-line over time, because the question is "is this person   ║
 * ║ getting better", which is change-over-time by definition. ONE series, so  ║
 * ║ per the chart rules there is no legend box — the section heading names    ║
 * ║ it. One y-axis, fixed 0–100: percentages have a natural scale and         ║
 * ║ letting the axis zoom to the data would manufacture drama out of noise.   ║
 * ║                                                                           ║
 * ║ COLOR: the single series wears the product's --primary token, which is    ║
 * ║ theme-aware by construction; pass/fail is stated as TEXT in the tooltip,  ║
 * ║ never as color alone. Grid and axis text wear muted ink — recessive,      ║
 * ║ as the mark spec demands.                                                 ║
 * ║                                                                           ║
 * ║ EVERY POINT IS A REAL COMPLETED ATTEMPT from the rows passed in,          ║
 * ║ chronologically ordered by the same unit-tested function the trend uses   ║
 * ║ — the chart and the trend cannot disagree about order. No completed rows  ║
 * ║ → the empty-state sentence, never an empty grid.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The table below the chart is the accessible data view; the chart itself is
 * aria-hidden decoration over the same rows.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const W = 640
const H = 220
const PAD = { top: 12, right: 16, bottom: 28, left: 36 }

export function ScoreChart({ rows }: { rows: HistoryRow[] }) {
  const t = useTranslations('perf')
  const te = useTranslations('exams')
  const format = useFormatter()
  const router = useRouter()
  const [active, setActive] = useState<number | null>(null)

  const points = useMemo(() => {
    const done = completedChronological(rows)
    const xs = done.map((r) => Date.parse(r.submitted_at as string))
    const min = Math.min(...xs)
    const max = Math.max(...xs)
    const span = Math.max(max - min, 1)
    const plotW = W - PAD.left - PAD.right
    const plotH = H - PAD.top - PAD.bottom
    return done.map((r, i) => ({
      row: r,
      // A single attempt sits centred rather than glued to the left edge.
      x: PAD.left + (done.length === 1 ? plotW / 2 : ((xs[i] - min) / span) * plotW),
      y: PAD.top + plotH - ((r.percent as number) / 100) * plotH,
    }))
  }, [rows])

  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{t('noCompleted')}</p>
  }

  const gridY = [0, 25, 50, 75, 100]
  const plotBottom = H - PAD.bottom
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const current = active !== null ? points[active] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('chartLabel')}
        className="w-full"
        onMouseLeave={() => setActive(null)}
      >
        {/* Recessive grid: four faint rules and their percent labels. */}
        {gridY.map((v) => {
          const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / 100)
          return (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {v}
              </text>
            </g>
          )
        })}

        {/* First and last date anchor the x-axis; every date is in the table. */}
        <text
          x={PAD.left}
          y={H - 8}
          className="fill-muted-foreground text-[10px]"
        >
          {format.dateTime(new Date(points[0].row.submitted_at as string), {
            day: 'numeric',
            month: 'short',
          })}
        </text>
        {points.length > 1 && (
          <text
            x={W - PAD.right}
            y={H - 8}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            {format.dateTime(new Date(points[points.length - 1].row.submitted_at as string), {
              day: 'numeric',
              month: 'short',
            })}
          </text>
        )}

        {/* The 2px series line, then ≥8px markers with a surface ring. */}
        {points.length > 1 && (
          <path d={line} fill="none" strokeWidth="2" className="stroke-primary" />
        )}
        {points.map((p, i) => (
          <g key={p.row.attempt_id}>
            <circle
              cx={p.x}
              cy={p.y}
              r={active === i ? 6 : 4}
              strokeWidth="2"
              className="fill-primary stroke-card"
            />
            {/*
              The hit target is far larger than the mark, per the interaction
              spec — a 4px dot is not a tap target. Tap = tooltip; the second
              tap (already active) opens the attempt.
            */}
            <circle
              cx={p.x}
              cy={p.y}
              r={16}
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                if (active === i) router.push(`/monitoring/${p.row.attempt_id}`)
                else setActive(i)
              }}
            />
            {/* Crosshair drop to the axis for the active point. */}
            {active === i && (
              <line
                x1={p.x}
                x2={p.x}
                y1={p.y}
                y2={plotBottom}
                strokeDasharray="3 3"
                className="stroke-muted-foreground"
                strokeWidth="1"
              />
            )}
          </g>
        ))}
      </svg>

      {/* HTML tooltip, positioned in chart fractions so it scales with it. */}
      {current && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 max-w-56 -translate-x-1/2 rounded-md border bg-card px-3 py-2 text-xs shadow-md"
          style={{
            left: `${(current.x / W) * 100}%`,
            top: `${(current.y / H) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <p className="truncate font-medium">{current.row.exam_title}</p>
          <p className="mt-0.5 text-muted-foreground">
            {format.dateTime(new Date(current.row.submitted_at as string), {
              dateStyle: 'medium',
            })}
          </p>
          <p className="mt-0.5 tabular-nums">
            {current.row.score} / {current.row.max_score} · {current.row.percent}% ·{' '}
            {current.row.passed ? te('resultPass') : te('resultFail')}
          </p>
        </div>
      )}
    </div>
  )
}
