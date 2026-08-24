import { Link } from '@/lib/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { BankQuestionListRow } from '@/lib/bank/types'
import type { Difficulty, QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The Question Bank list.
 *
 * A Server Component: it renders links and text, holds no state, and needs no
 * interactivity. Shipping it to the browser would send the whole question list
 * twice — once as HTML and once as serialised props — for no behaviour.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TABLE ON DESKTOP, CARDS BELOW `md` — DESIGN.md's adaptivity rule.         │
 * │                                                                           │
 * │ Both render the SAME rows from the same array rather than one being a     │
 * │ filtered subset, so a question can never appear on one breakpoint and not │
 * │ the other.                                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Difficulty is presentation-only here. It carries no logic — see vocabulary.ts. */
const DIFFICULTY_TONE: Record<Difficulty, string> = {
  easy: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-400',
  medium: 'border-amber-500/30 text-amber-700 dark:text-amber-400',
  hard: 'border-rose-500/30 text-rose-700 dark:text-rose-400',
}

export interface QuestionListProps {
  rows: BankQuestionListRow[]
  difficultyLabels: Record<Difficulty, string>
  labels: {
    question: string
    brand: string
    difficulty: string
    type: string
    topic: string
    status: string
    languages: string
    uuid: string
    untitled: string
  }
  /** Display names for the two question types, keyed by the enum value. */
  typeLabels: Record<QuestionType, string>
}

export function QuestionList({ rows, difficultyLabels, typeLabels, labels }: QuestionListProps) {
  return (
    <>
      {/* ── Desktop ─────────────────────────────────────────────────────── */}
      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b">
              {[labels.question, labels.brand, labels.difficulty, labels.type, labels.topic, labels.status, labels.languages]
                .map((h) => (
                  <th key={h} className="px-4 py-3 text-label-caps text-muted-foreground">
                    {h}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.rowKey} className="hover:bg-accent/40">
                <td className="max-w-md px-4 py-3">
                  <Link
                    href={`/questions/${row.rowKey}`}
                    className="line-clamp-2 text-body-sm hover:underline"
                  >
                    {row.question || labels.untitled}
                  </Link>
                  {/* Only rendered when the server decided this caller may see
                      it — the field is absent from the payload otherwise. */}
                  {row.id && (
                    <span className="mt-0.5 block truncate text-label-caps text-muted-foreground">
                      {labels.uuid}: {row.id}
                    </span>
                  )}
                </td>
                {/* Which restaurant's bank the row lives in — the axis papers
                    are drawn along, so it is visible, not inferred. */}
                <td className="px-4 py-3">
                  <Badge variant="outline">{row.brandName || '—'}</Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={cn(DIFFICULTY_TONE[row.difficulty])}>
                    {difficultyLabels[row.difficulty]}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-body-sm text-muted-foreground">
                  {typeLabels[row.qtype]}
                </td>
                <td className="px-4 py-3 text-body-sm text-muted-foreground">
                  {row.topicName ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline">{row.status}</Badge>
                </td>
                <td className="px-4 py-3 text-label-caps text-muted-foreground">
                  {row.completeLocales.join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile ──────────────────────────────────────────────────────── */}
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={row.rowKey} className="rounded-xl border bg-card p-4">
            <Link href={`/questions/${row.rowKey}`} className="block">
              <span className="line-clamp-3 text-body-md">{row.question || labels.untitled}</span>
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {row.brandName && <Badge variant="outline">{row.brandName}</Badge>}
              <Badge variant="outline" className={cn(DIFFICULTY_TONE[row.difficulty])}>
                {difficultyLabels[row.difficulty]}
              </Badge>
              <Badge variant="outline">{row.status}</Badge>
              {row.topicName && <Badge variant="outline">{row.topicName}</Badge>}
              <span className="text-label-caps text-muted-foreground">
                {row.completeLocales.join(' · ')}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
