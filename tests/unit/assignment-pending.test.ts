import { describe, expect, it } from 'vitest'
import {
  NO_PENDING,
  pendingRow,
  withPending,
  type AssignmentRow,
} from '@/components/exams/assignment-picker'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A choice the reader can see is a choice that gets saved.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BUG THIS EXISTS FOR                                                   ║
 * ║                                                                           ║
 * ║ "Assign to: Role · Employee" was chosen, "Save assignments" pressed, and  ║
 * ║ a success toast shown — while exam_assignments stayed EMPTY. The two      ║
 * ║ dropdowns were state private to the picker, and only the "+ Add" button   ║
 * ║ ever read them, so a selection that was never Added did not exist as far  ║
 * ║ as saving was concerned.                                                  ║
 * ║                                                                           ║
 * ║ Nothing failed. The exam was live, its window open, and it reached no     ║
 * ║ one — which on the candidate's side is indistinguishable from not being   ║
 * ║ invited at all.                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * withPending() is now the only way either screen builds what it submits, so
 * these cases are the guarantee itself rather than a check on one caller.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const roleRow = (role: string): AssignmentRow => ({
  target_kind: 'role',
  target_id: null,
  target_role: role,
  target_user_id: null,
})

describe('pendingRow', () => {
  it('is null while the "Which" dropdown is on its placeholder', () => {
    expect(pendingRow(NO_PENDING)).toBeNull()
    expect(pendingRow({ kind: 'role', value: '' })).toBeNull()
  })

  /*
   * The column a target lands in is the whole of the assignment_target_shape
   * CHECK, and getting it wrong is not a save error — 'employee' written to
   * target_id would simply never match anybody.
   */
  it('puts a role in target_role, leaving the id columns null', () => {
    expect(pendingRow({ kind: 'role', value: 'employee' })).toEqual({
      target_kind: 'role',
      target_id: null,
      target_role: 'employee',
      target_user_id: null,
    })
  })

  it('puts a person in target_user_id and a group in target_id', () => {
    expect(pendingRow({ kind: 'user', value: 'u1' })).toMatchObject({
      target_user_id: 'u1',
      target_id: null,
      target_role: null,
    })
    expect(pendingRow({ kind: 'outlet', value: 'o1' })).toMatchObject({
      target_id: 'o1',
      target_role: null,
      target_user_id: null,
    })
  })
})

describe('withPending', () => {
  /** The exact reported failure: chosen, never Added, then saved. */
  it('saves a selection that was never added', () => {
    expect(withPending([], { kind: 'role', value: 'employee' })).toEqual([roleRow('employee')])
  })

  it('leaves an empty audience empty when nothing is chosen', () => {
    expect(withPending([], NO_PENDING)).toEqual([])
  })

  it('keeps the rows already added, in order, and appends the pending one', () => {
    const rows = [roleRow('hr')]
    expect(withPending(rows, { kind: 'role', value: 'employee' })).toEqual([
      roleRow('hr'),
      roleRow('employee'),
    ])
  })

  /*
   * Added, then left showing in the dropdown — the ordinary state right after
   * pressing Add is undone. Appending again would trip the unique index and
   * turn a no-op into an error message.
   */
  it('does not duplicate a selection that is already in the list', () => {
    const rows = [roleRow('employee')]
    expect(withPending(rows, { kind: 'role', value: 'employee' })).toEqual(rows)
  })

  it('tells kinds apart when the values collide', () => {
    const rows: AssignmentRow[] = [
      { target_kind: 'outlet', target_id: 'x1', target_role: null, target_user_id: null },
    ]
    expect(withPending(rows, { kind: 'department', value: 'x1' })).toHaveLength(2)
  })

  it('does not mutate the rows it was given', () => {
    const rows = [roleRow('hr')]
    withPending(rows, { kind: 'role', value: 'employee' })
    expect(rows).toEqual([roleRow('hr')])
  })
})
