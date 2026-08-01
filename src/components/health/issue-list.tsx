import { sortIssues, remedyFor, type HealthIssue } from '@/lib/exams/health'
import { AlertTriangleIcon, XCircleIcon } from 'lucide-react'

/**
 * One issue list, for everything that returns (code, severity, message, detail).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS EXTRACTED RATHER THAN COPIED.                                 │
 * │                                                                           │
 * │ Two functions return this shape: exam_health() for a paper, and 0045's    │
 * │ bank_recommendations() for the bank. bank_recommendations was written to  │
 * │ match exam_health's shape EXACTLY so both could share one renderer and    │
 * │ one remedy map — and that claim is only true if the renderer is actually  │
 * │ shared.                                                                   │
 * │                                                                           │
 * │ A second copy would drift the way every second copy in this codebase has: │
 * │ one of them would gain the remedy line and the other would not, and the   │
 * │ bank screen would show problems with no advice under them, which is the   │
 * │ exact defect tests/unit/health-codes.test.ts was written to catch.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A server component. It renders text and has no state; making it a client
 * component would ship the remedy map to the browser for no reason.
 */
export function HealthIssueList({
  issues,
  tone,
}: {
  issues: HealthIssue[]
  tone: 'blocking' | 'advisory'
}) {
  return (
    <ul className="space-y-2">
      {sortIssues(issues).map((issue, index) => (
        <li
          key={`${issue.code}-${issue.rule_id ?? index}`}
          className={`rounded-md border p-3 text-sm ${
            tone === 'blocking' ? 'border-destructive/40' : ''
          }`}
        >
          <div className="flex items-start gap-2">
            {tone === 'blocking' ? (
              <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="space-y-1">
              <p>{issue.message}</p>
              {/* The database says what is wrong; the remedy says what to do.
                  Kept apart so a SQL message can stay short and factual. */}
              {remedyFor(issue.code) && (
                <p className="text-muted-foreground">{remedyFor(issue.code)}</p>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
