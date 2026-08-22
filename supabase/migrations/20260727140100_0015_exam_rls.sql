-- ═════════════════════════════════════════════════════════════════════════════
-- 0015 — RLS for the exam layer
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT A CANDIDATE MAY SEE, AND WHAT THEY MAY NOT.                          │
-- │                                                                           │
-- │ MAY:  the exam itself (title, timing, marks) once it is assigned to them  │
-- │       and scheduled — they have to know it exists to sit it               │
-- │       its section titles and instructions, to navigate the paper          │
-- │                                                                           │
-- │ MAY NOT: exam_rules      — the rules describe HOW the paper was chosen.   │
-- │                            "12 questions from Food Safety at difficulty   │
-- │                            4–5" tells a candidate what to revise and      │
-- │                            roughly what they will be asked. Employees     │
-- │                            hold NO policy on this table at all.           │
-- │                                                                           │
-- │          exam_questions  — THE PAPER ITSELF. A candidate who could select │
-- │                            from this table would read the whole paper     │
-- │                            before the timer started, which defeats the    │
-- │                            exam entirely. They hold no policy here        │
-- │                            either; M4 serves questions through a          │
-- │                            SECURITY DEFINER route gated on an in-progress │
-- │                            attempt.                                       │
-- │                                                                           │
-- │          exam_assignments — who else was assigned is nobody's business.   │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- This is the same shape as the question bank: the sensitive table has no
-- candidate policy at all, so RLS denies by default, AND the serving path is a
-- function that cannot return the sensitive columns. Either alone would do;
-- both cost nothing.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── is_exam_assigned_to_me ───────────────────────────────────────────────────
--
-- SECURITY DEFINER because it reads exam_assignments, on which a candidate
-- deliberately holds no policy — a SECURITY INVOKER version would evaluate to
-- false for exactly the people it exists to serve.
--
-- It joins nothing but exam_assignments: every target is already a JWT claim,
-- which is why assignment targets are outlet/department/brand/role and why
-- 'role' is stored as a KEY rather than a uuid. A uuid role target would force
-- a join to user_roles on every candidate row.
create or replace function public.is_exam_assigned_to_me(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.exam_assignments a
     where a.exam_id = p_exam_id
       and (
         (a.target_kind = 'outlet'     and a.target_id = public.my_outlet())
      or (a.target_kind = 'department' and a.target_id = public.my_department())
      or (a.target_kind = 'brand'      and a.target_id = public.my_brand())
      or (a.target_kind = 'role'       and public.has_role(a.target_role))
       )
  );
$$;

grant execute on function public.is_exam_assigned_to_me(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- exams
-- ═════════════════════════════════════════════════════════════════════════════

create policy exams_read_manage on public.exams
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('exams.read'))
    and company_id = (select public.my_company())
    and (brand_id is null
         or brand_id = (select public.my_brand())
         or (select public.is_super_admin()))
  );

-- The candidate's view. Deliberately narrow:
--   · assigned to them, by any of the four target kinds
--   · not a draft — an unpublished exam is a chef's working document
--   · not archived or cancelled — nothing to do with it
-- 'completed' stays visible so a candidate can still find the exam their
-- results refer to.
create policy exams_read_assigned on public.exams
  for select to authenticated
  using (
    deleted_at is null
    and (select public.is_approved())
    and company_id = (select public.my_company())
    and status in ('scheduled', 'active', 'completed')
    and (select public.is_exam_assigned_to_me(id))
  );

create policy exams_insert on public.exams
  for insert to authenticated
  with check (
    (select public.has_perm('exams.create'))
    and company_id = (select public.my_company())
    -- Authorship asserted by the database, never by the client payload.
    and created_by = (select auth.uid())
  );

create policy exams_update on public.exams
  for update to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('exams.update'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- No delete policy. Removal is deleted_at; an exam referenced by past attempts
-- must never vanish, or historical results become unexplainable.

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_sections — the one child table a candidate may read
-- ═════════════════════════════════════════════════════════════════════════════

create policy exam_sections_read on public.exam_sections
  for select to authenticated
  using (
    exists (
      select 1 from public.exams e
       where e.id = exam_id
         and e.deleted_at is null
         and e.company_id = (select public.my_company())
         and (
           (select public.has_perm('exams.read'))
           -- Titles and instructions only. A candidate needs "Section 2:
           -- Knife Skills — 10 minutes" to navigate; that reveals nothing the
           -- paper itself will not.
           or (e.status in ('scheduled', 'active', 'completed')
               and (select public.is_exam_assigned_to_me(e.id)))
         )
    )
  );

create policy exam_sections_write on public.exam_sections
  for all to authenticated
  using (
    (select public.has_perm('exams.update'))
    and exists (select 1 from public.exams e
                 where e.id = exam_id and e.company_id = (select public.my_company()))
  )
  with check (
    (select public.has_perm('exams.update'))
    and exists (select 1 from public.exams e
                 where e.id = exam_id and e.company_id = (select public.my_company()))
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_rules — authors only. No candidate policy, by design (see header).
-- ═════════════════════════════════════════════════════════════════════════════

create policy exam_rules_read on public.exam_rules
  for select to authenticated
  using (
    (select public.has_perm('exams.read'))
    and exists (
      select 1 from public.exam_sections s
        join public.exams e on e.id = s.exam_id
       where s.id = section_id and e.company_id = (select public.my_company())
    )
  );

create policy exam_rules_write on public.exam_rules
  for all to authenticated
  using (
    (select public.has_perm('exams.update'))
    and exists (
      select 1 from public.exam_sections s
        join public.exams e on e.id = s.exam_id
       where s.id = section_id and e.company_id = (select public.my_company())
    )
  )
  with check (
    (select public.has_perm('exams.update'))
    and exists (
      select 1 from public.exam_sections s
        join public.exams e on e.id = s.exam_id
       where s.id = section_id and e.company_id = (select public.my_company())
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_questions — THE PAPER. Authors read it; candidates do not.
--
-- No insert or update policy for anyone: publish_exam() is SECURITY DEFINER and
-- is the only writer. That makes the paper unwritable from the application even
-- before 0016's lock refuses post-publish edits.
-- ═════════════════════════════════════════════════════════════════════════════

create policy exam_questions_read on public.exam_questions
  for select to authenticated
  using (
    (select public.has_perm('exams.read'))
    and exists (
      select 1 from public.exams e
       where e.id = exam_id
         and e.deleted_at is null
         and e.company_id = (select public.my_company())
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_assignments — authors only. Who else sits an exam is nobody's business,
-- and the exam's own visibility already tells a candidate they are assigned.
-- ═════════════════════════════════════════════════════════════════════════════

create policy exam_assignments_read on public.exam_assignments
  for select to authenticated
  using (
    (select public.has_perm('exams.read'))
    and exists (select 1 from public.exams e
                 where e.id = exam_id and e.company_id = (select public.my_company()))
  );

create policy exam_assignments_write on public.exam_assignments
  for all to authenticated
  using (
    (select public.has_perm('exams.assign'))
    and exists (select 1 from public.exams e
                 where e.id = exam_id and e.company_id = (select public.my_company()))
  )
  with check (
    (select public.has_perm('exams.assign'))
    and exists (select 1 from public.exams e
                 where e.id = exam_id and e.company_id = (select public.my_company()))
  );

comment on policy exam_questions_read on public.exam_questions is
  'Authors only. Candidates hold NO policy on this table: selecting from it would hand them the whole paper before the timer started. M4 serves questions through a SECURITY DEFINER route gated on an in-progress attempt.';
comment on function public.is_exam_assigned_to_me(uuid) is
  'SECURITY DEFINER because candidates hold no policy on exam_assignments — an invoker version would return false for exactly the people it serves. Joins nothing but that table; every assignment target is already a JWT claim.';
