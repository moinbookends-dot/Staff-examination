'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveRegistration, rejectRegistration, type PendingRegistration } from '@/server/actions/users'
import type { OrgOption } from '@/server/actions/org'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TableCell, TableRow } from '@/components/ui/table'

/**
 * One pending registration.
 *
 * Outlet and department are chosen HERE, by the chef — they were only hints on
 * the registration form. These two fields decide the person's entire data
 * scope under RLS, so they are an authority decision, not a self-declaration.
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
    <>
      <TableRow>
        <TableCell>
          <div className="font-medium">{registration.full_name}</div>
          <div className="text-sm text-muted-foreground">{registration.email}</div>
          {registration.phone && (
            <div className="text-sm text-muted-foreground">{registration.phone}</div>
          )}
        </TableCell>

        <TableCell>
          <Badge variant="secondary">{registration.preferred_locale}</Badge>
        </TableCell>

        <TableCell>
          <select
            aria-label="Outlet"
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            disabled={pending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Select outlet…</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </TableCell>

        <TableCell>
          <select
            aria-label="Department"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            disabled={pending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Select department…</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </TableCell>

        <TableCell className="text-right">
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={onApprove}
              // Approving without a scope would leave the person with null
              // outlet_id, which every RLS policy reads — they would see
              // nothing and nobody would see them.
              disabled={pending || !outletId || !departmentId}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRejecting((v) => !v)}
              disabled={pending}
            >
              Reject
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {(rejecting || error) && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/30">
            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            {rejecting && (
              <div className="flex gap-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason — this is shown to the applicant"
                  disabled={pending}
                />
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={onReject}
                  disabled={pending || reason.trim().length < 3}
                >
                  Confirm rejection
                </Button>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
