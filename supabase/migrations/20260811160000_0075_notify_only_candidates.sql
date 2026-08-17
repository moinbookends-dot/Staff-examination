-- ═════════════════════════════════════════════════════════════════════════════
-- 0075 — Notify the people who will SIT the exam, not everyone standing near it.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0074 NOTIFIED THIRTEEN PEOPLE. FIVE OF THEM CANNOT TAKE AN EXAM.          ║
-- ║                                                                           ║
-- ║ Assigning one outlet produced notifications for the super admin, both HR  ║
-- ║ managers and the chef, alongside the employees. exam_audience() answers   ║
-- ║ "who does this assignment REACH" — an org-scope question — and that is    ║
-- ║ the right question for visibility. It is the wrong one for "who is        ║
-- ║ supposed to sit this".                                                    ║
-- ║                                                                           ║
-- ║ An administrator does not hold attempts.take. /my-exams is not in their   ║
-- ║ navigation, and the exam would not appear there if they opened it. So the ║
-- ║ notification pointed them at a screen that is empty for them by           ║
-- ║ construction — and every admin would receive one for every exam ever      ║
-- ║ published, which is the fastest possible way to make the bell worthless.  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ FILTERED ON THE PERMISSION, NOT ON THE ROLE NAME.                        │
-- │                                                                           │
-- │ `attempts.take` is what start_attempt() requires and what makes           │
-- │ /my-exams non-empty, so it is the true definition of "can sit an exam".   │
-- │ Matching on role key 'employee' instead would break the moment somebody   │
-- │ creates a custom role that sits exams — exactly the drift 0023 wrote      │
-- │ assignment_matches() to prevent for the audience question.                │
-- │                                                                           │
-- │ NOTE this deliberately does NOT use has_perm(): that reads the CALLER's   │
-- │ JWT, and here we are asking about somebody else entirely. The grant is    │
-- │ read from the tables, which is the only way to ask that question about a  │
-- │ third party.                                                              │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.notify_exam_audience(p_exam_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_exam    public.exams%rowtype;
  v_written int;
begin
  select * into v_exam from public.exams where id = p_exam_id and deleted_at is null;
  if not found then
    return 0;
  end if;

  -- A draft is not an announcement, and a closed exam has nothing to sit.
  if v_exam.status not in ('scheduled', 'active') then
    return 0;
  end if;

  insert into public.notifications (user_id, kind, title, body, link, data)
  select a.id,
         'exam.assigned',
         'You have a new exam',
         v_exam.title,
         '/my-exams',
         jsonb_build_object('exam_id', p_exam_id, 'title', v_exam.title)
    from public.exam_audience(p_exam_id) a
   where
     -- Can this person actually sit an exam? Asked of THEIR grants, not the
     -- caller's — has_perm() would answer for whoever triggered the assignment.
     exists (
       select 1
         from public.user_roles ur
         join public.role_permissions rp on rp.role_id = ur.role_id
         join public.permissions pm      on pm.id = rp.permission_id
        where ur.user_id = a.id
          and pm.key = 'attempts.take'
     )
     and not exists (
       select 1 from public.notifications n
        where n.user_id = a.id
          and n.kind = 'exam.assigned'
          and n.data ->> 'exam_id' = p_exam_id::text
     );

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function public.notify_exam_audience(uuid) is
  'Writes an in-app notification for everybody who will SIT a published exam and has not already been told. Narrowed by attempts.take (0075) — exam_audience() answers an org-scope question and legitimately includes administrators and HR, who cannot take an attempt and whose /my-exams is empty by construction. Idempotent; silent for drafts, cancelled and closed exams.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Undo the over-notification 0074 produced
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * Removes exam.assigned notifications held by people who cannot take an exam.
 *
 * Narrow on purpose: `kind = 'exam.assigned'` only, so nothing else in the
 * table is touched, and only for accounts that hold no attempts.take — which
 * is precisely the set 0074 should never have written. A notification nobody
 * can act on is noise, and leaving it would train people to dismiss the bell
 * before the feature has even shipped.
 */
delete from public.notifications n
 where n.kind = 'exam.assigned'
   and not exists (
     select 1
       from public.user_roles ur
       join public.role_permissions rp on rp.role_id = ur.role_id
       join public.permissions pm      on pm.id = rp.permission_id
      where ur.user_id = n.user_id
        and pm.key = 'attempts.take'
   );
