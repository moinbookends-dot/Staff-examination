import { getTranslations } from 'next-intl/server'
import { getQuestionDistractors } from '@/server/actions/quality'
import type { DistractorRow } from '@/lib/questions/quality'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Which option candidates actually chose, on the question's own page.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TWO FINDINGS NOTHING ELSE PRODUCES.                                   │
 * │                                                                           │
 * │ A distractor NOBODY picks is not a distractor. A four-option question     │
 * │ with two dead options is a two-option question being marked as though     │
 * │ guessing gave one chance in four.                                         │
 * │                                                                           │
 * │ A distractor picked MORE than the key is either a genuinely misleading    │
 * │ question or a mis-keyed one. Those are indistinguishable in facility and  │
 * │ in discrimination — both just look like a hard question — and this is the │
 * │ only place the difference shows up.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A server component: it renders a read with no interaction. Both flags come
 * from question_distractors (0045) and neither is recomputed here, so the
 * sample floor that suppresses them below ten responses cannot be bypassed by
 * a component that decided to be helpful.
 */
export async function DistractorPanel({ questionId }: { questionId: string }) {
  const t = await getTranslations('questions.quality.distractors')
  const rows = await getQuestionDistractors(questionId)

  // Empty for every non-choice question — the SQL returns nothing rather than
  // raising, because this is rendered for whatever question is open.
  if (rows.length === 0) return null

  const responses = rows.reduce((sum, row) => sum + row.chosen_n, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        {responses === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <Option key={row.option_id} row={row} responses={responses} t={t} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Option({
  row,
  responses,
  t,
}: {
  row: DistractorRow
  responses: number
  t: Awaited<ReturnType<typeof getTranslations>>
}) {
  const share = responses === 0 ? 0 : Math.round((row.chosen_n / responses) * 100)

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={row.is_correct ? 'font-medium' : ''}>{row.option_text ?? row.option_id}</span>
        {row.is_correct && <Badge variant="success">{t('correct')}</Badge>}
        {/* Ordered by consequence: a distractor beating the key is a reason to
            re-read the key today; a dead one is housekeeping. */}
        {row.outdraws_key && <Badge variant="destructive">{t('outdraws')}</Badge>}
        {row.is_dead && <Badge variant="warning">{t('dead')}</Badge>}
        <span className="ml-auto tabular-nums text-muted-foreground">
          {t('chosen', { n: row.chosen_n, share })}
        </span>
      </div>
      <span className="block h-2 rounded-full bg-muted" aria-hidden>
        <span
          className={`block h-2 rounded-full ${row.is_correct ? 'bg-success' : 'bg-muted-foreground/40'}`}
          style={{ width: `${Math.max(1, share)}%` }}
        />
      </span>
    </li>
  )
}
