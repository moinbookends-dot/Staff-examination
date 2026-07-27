'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { duplicateExam } from '@/server/actions/exams'
import { Button } from '@/components/ui/button'
import { CopyIcon } from 'lucide-react'

/**
 * Duplicate this exam into a fresh draft.
 *
 * NOT A CONVENIENCE. Published exams are immutable, so without this, correcting
 * one typo means rebuilding a 40-question exam by hand — which nobody will do.
 * They will edit the database directly instead, and then the lock protects
 * nothing. It is the escape hatch that makes the immutability rule liveable.
 *
 * The copy takes the settings, sections and rules but NOT the frozen paper and
 * NOT the assignments: a draft draws its own paper at its own publish, and
 * silently re-assigning 300 people to somebody's experiment is the kind of
 * helpfulness nobody wants.
 */
export function CloneExamButton({ examId }: { examId: string }) {
  const router = useRouter()
  const t = useTranslations('exams')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await duplicateExam({ id: examId })
            if (!result.ok || !result.id) {
              setError(result.error ?? 'Could not duplicate.')
              return
            }
            toast.success(t('duplicated'))
            // Straight into the copy: the reason somebody duplicates an exam is
            // to change something, so leaving them on the original is a step
            // they would immediately have to undo.
            router.push(`/exams/${result.id}`)
          })
        }
      >
        <CopyIcon />
        {t('duplicate')}
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  )
}
