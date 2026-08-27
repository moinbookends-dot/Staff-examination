'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveRegistration, rejectRegistration, type PendingRegistration } from '@/server/actions/users'
import type { OrgOption } from '@/server/actions/org'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'

/**
 * One pending registration.
 *
 * Outlet and department are chosen HERE, by the chef — they were only hints on
 * the registration form. These two fields decide the person's entire data
 * scope under RLS, so they are an authority decision, not a self-declaration.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A CARD, NOT A TABLE ROW — AND NOT ONLY ON PHONES.                         │
 * │                                                                           │
 * │ This was a five-column TableRow, and on a 390px screen the table          │
 * │ side-scrolled: the outlet select, the department select and the Approve   │
 * │ button — the entire point of the page — sat off-screen to the right. An   │
 * │ approver on a phone saw a name and a scrollbar.                           │
 * │                                                                           │
 * │ A table was the wrong shape on desktop too: each row carries two form     │
 * │ controls and two actions, which is a form, and the queue rarely holds     │
 * │ more than a handful of people. One card per applicant works at every      │
 * │ width, so there is exactly one markup path to keep correct — no           │
 * │ hidden-md duplicate to drift.                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function ApprovalRow({
  registration,
  outlets,
  departments,
}: {
  registration: PendingRegistration
  outlets: OrgOption[]
  departments: OrgOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const uid = useId()

  const [outletId, setOutletId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  function onApprove() {
    setError(null)
    startTransition(async () => {
      const result = await approveRegistration({ userId: registration.id, outletId, departmentId })
      if (!result.ok) setError(result.error ?? 'Could not approve.')
      else router.refresh()
    })
  }

  function onReject() {
    setError(null)
    startTransition(async () => {
      const result = await rejectRegistration({ userId: registration.id, reason })
      if (!result.ok) setError(result.error ?? 'Could not reject.')
      else router.refresh()
    })
  }

  return (
    <li className="surface-1 rounded-xl p-4 sm:p-5">
      {/* ── Who ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{registration.full_name}</p>
          <p className="truncate text-sm text-muted-foreground">{registration.email}</p>
          {registration.phone && (
            <p className="text-sm text-muted-foreground">{registration.phone}</p>
          )}
        </div>
        <Badge variant="secondary">{registration.preferred_locale}</Badge>
      </div>

      {/* ── Scope ───────────────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-outlet`}>Outlet</Label>
          <select
            id={`${uid}-outlet`}
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            disabled={pending}
            // min-h-11: a select is the first thing a thumb reaches for here.
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Select outlet…</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-department`}>Department</Label>
          <select
            id={`${uid}-department`}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            disabled={pending}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Select department…</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <InlineError className="mt-3">{error}</InlineError>}

      {/* ── Decision ────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={onApprove}
          // Approving without a scope would leave the person with null
          // outlet_id, which every RLS policy reads — they would see
          // nothing and nobody would see them.
          disabled={pending || !outletId || !departmentId}
          className="min-h-11 flex-1 sm:flex-none sm:px-6"
        >
          Approve
        </Button>
        <Button
          variant="outline"
          onClick={() => setRejecting((v) => !v)}
          disabled={pending}
          className="min-h-11 flex-1 sm:flex-none sm:px-6"
        >
          Reject
        </Button>
      </div>

      {rejecting && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason — this is shown to the applicant"
            disabled={pending}
            className="min-h-11"
          />
          <Button
            variant="destructive"
            onClick={onReject}
            disabled={pending || reason.trim().length < 3}
            className="min-h-11 shrink-0"
          >
            Confirm rejection
          </Button>
        </div>
      )}
    </li>
  )
}
