'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { updateSchedule } from '@/server/actions/exams'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * When the exam runs.
 *
 * A PUBLISHED EXAM OFFERS ONLY THE CLOSING TIME. Migration 0016's trigger
 * permits `closes_at` to move and nothing else, so the opening time and
 * timezone are shown as read-only text rather than as inputs the database
 * would refuse. The action narrows the write to match.
 *
 * Timezone is explicit rather than implied by the browser: "opens 9am Monday"
 * is a commitment to a local wall clock, and the chef scheduling it may not be
 * sitting in the outlet that sits it.
 */

/** <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm` with no zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'UTC',
]

export function ExamSchedule({
  examId,
  opensAt,
  closesAt,
  timezone,
  locked,
  canEdit,
}: {
  examId: string
  opensAt: string | null
  closesAt: string | null
  timezone: string
  locked: boolean
  canEdit: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams.schedule')
  const [pending, startTransition] = useTransition()
  const [opens, setOpens] = useState(toLocalInput(opensAt))
  const [closes, setCloses] = useState(toLocalInput(closesAt))
  const [zone, setZone] = useState(timezone)
  const [error, setError] = useState<string | null>(null)

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await updateSchedule({
        examId,
        opensAt: toIso(opens),
        closesAt: toIso(closes),
        timezone: zone,
      })
      if (!result.ok) {
        setError(result.error ?? 'Could not save the schedule.')
        return
      }
      toast.success(t('saved'))
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{locked ? t('lockedDescription') : t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <InlineError>{error}</InlineError>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="exam-opens">{t('opens')}</Label>
            {locked ? (
              // Read-only text, not a disabled input: a disabled field still
              // looks like something that could be enabled, and this one never
              // can be for a published exam.
              <p className="text-sm text-muted-foreground">
                {opensAt ? new Date(opensAt).toLocaleString() : t('notSet')}
              </p>
            ) : (
              <Input
                id="exam-opens"
                type="datetime-local"
                value={opens}
                onChange={(e) => setOpens(e.target.value)}
                disabled={pending || !canEdit}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="exam-closes">{t('closes')}</Label>
            <Input
              id="exam-closes"
              type="datetime-local"
              value={closes}
              onChange={(e) => setCloses(e.target.value)}
              disabled={pending || !canEdit}
            />
            {locked && <p className="text-sm text-muted-foreground">{t('closesStillEditable')}</p>}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="exam-timezone">{t('timezone')}</Label>
          {locked ? (
            <p className="text-sm text-muted-foreground">{timezone}</p>
          ) : (
            <select
              id="exam-timezone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              disabled={pending || !canEdit}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          )}
          {!locked && <p className="text-sm text-muted-foreground">{t('timezoneHint')}</p>}
        </div>

        {canEdit && (
          <Button onClick={save} disabled={pending}>
            {t('save')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
