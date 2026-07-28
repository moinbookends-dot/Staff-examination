import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { listVerificationQueue, listReleaseQueue, type QueueItem } from '@/server/actions/evaluation'
import { DecisionButtons, ReleaseButton } from './decision-buttons'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ShieldCheckIcon } from 'lucide-react'

/**
 * Signing off.
 *
 * Two queues on one screen, because they are the same job to the person doing
 * it: papers a human marked and papers the machine marked, both waiting for
 * somebody to say the result may go out. Splitting them across two pages would
 * mean checking two places to find out whether anyone is waiting.
 *
 * The counts shown are the real ones — how many sign-offs this round has, out
 * of how many the exam's verification_mode requires. A first approval on a dual
 * paper visibly changes nothing about who may see the result.
 */
export default async function VerifyPage() {
  const claims = await requirePermission('evaluation.verify')
  const t = await getTranslations('evaluation')
  const format = await getFormatter()

  const verifying = await listVerificationQueue()
  const releasing = can(claims, 'evaluation.publish') ? await listReleaseQueue() : []

  const nothing = verifying.length === 0 && releasing.length === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('verifyTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('verifySubtitle')}</p>
      </div>

      {nothing ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ShieldCheckIcon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t('verifyEmpty')}</p>
            <p className="text-sm text-muted-foreground">{t('verifyEmptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {verifying.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                {t('awaitingVerification')}
              </h2>
              {verifying.map((item) => (
                <QueueCard key={item.attempt_id} item={item} t={t} format={format}>
                  <DecisionButtons
                    attemptId={item.attempt_id}
                    evaluatedByMe={item.evaluated_by_me}
                  />
                </QueueCard>
              ))}
            </section>
          )}

          {releasing.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">{t('awaitingRelease')}</h2>
              {releasing.map((item) => (
                <QueueCard key={item.attempt_id} item={item} t={t} format={format}>
                  <ReleaseButton attemptId={item.attempt_id} />
                </QueueCard>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function QueueCard({
  item,
  t,
  format,
  children,
}: {
  item: QueueItem
  t: Awaited<ReturnType<typeof getTranslations<'evaluation'>>>
  format: Awaited<ReturnType<typeof getFormatter>>
  children: React.ReactNode
}) {
  const required = item.verification_mode === 'dual' ? 2 : 1

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{item.candidate_name}</CardTitle>
            <p className="text-sm text-muted-foreground">{item.exam_title}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {item.score != null && item.max_score != null && (
              <Badge variant="secondary">
                {t('scored', { score: item.score, max: item.max_score })}
              </Badge>
            )}
            {item.status === 'verifying' && (
              <Badge variant="outline">
                {t('signoffs', { count: item.signoffs, required })}
              </Badge>
            )}
            {item.returned_count > 0 && (
              <Badge variant="outline">{t('sentBack', { count: item.returned_count })}</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {item.submitted_at
            ? format.dateTime(new Date(item.submitted_at), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : ''}
        </p>
        {children}
      </CardContent>
    </Card>
  )
}
