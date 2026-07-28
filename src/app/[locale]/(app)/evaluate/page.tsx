import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { listEvaluationQueue } from '@/server/actions/evaluation'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ClipboardCheckIcon } from 'lucide-react'

/**
 * The marking queue.
 *
 * Ordered oldest first, deliberately: a queue sorted by anything else lets the
 * awkward paper sit at the bottom forever while a candidate waits on a result.
 *
 * Scope is RLS's. A chef holding attempts.read_team sees their outlet; HR
 * holding attempts.read_all sees the company. This page filters by nothing.
 */
export default async function EvaluatePage() {
  await requirePermission('evaluation.evaluate')
  const t = await getTranslations('evaluation')
  const format = await getFormatter()

  const queue = await listEvaluationQueue()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {queue.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ClipboardCheckIcon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t('empty')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('candidate')}</TableHead>
                  <TableHead>{t('exam')}</TableHead>
                  <TableHead>{t('submitted')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.map((item) => (
                  <TableRow key={item.attempt_id}>
                    <TableCell className="font-medium">{item.candidate_name}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        {item.exam_title}
                        {item.returned_count > 0 && (
                          <Badge variant="outline">
                            {t('sentBack', { count: item.returned_count })}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.submitted_at
                        ? format.dateTime(new Date(item.submitted_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/evaluate/${item.attempt_id}`}
                        className={buttonVariants({ size: 'sm' })}
                      >
                        {t('mark')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
