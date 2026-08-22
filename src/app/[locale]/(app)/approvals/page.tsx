import { requirePermission } from '@/lib/auth/guards'
import { listPendingRegistrations } from '@/server/actions/users'
import { listOutletsForRegistration, listDepartmentsForRegistration } from '@/server/actions/org'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ApprovalRow } from './approval-row'

export default async function ApprovalsPage() {
  // Enforced again here even though nav hides the link and middleware gates the
  // route. Hiding a link is presentation; this is the check that matters.
  await requirePermission('users.approve')

  const [registrations, outlets, departments] = await Promise.all([
    listPendingRegistrations(),
    listOutletsForRegistration(),
    listDepartmentsForRegistration(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Registration approvals</h1>
        <p className="text-sm text-muted-foreground">
          New staff cannot sign in until approved. Assigning an outlet and department here sets
          what they can see across the platform.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Pending {registrations.length > 0 && `(${registrations.length})`}
          </CardTitle>
          <CardDescription>Oldest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {registrations.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing waiting. New registrations appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Outlet</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registrations.map((r) => (
                  <ApprovalRow
                    key={r.id}
                    registration={r}
                    outlets={outlets}
                    departments={departments}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
