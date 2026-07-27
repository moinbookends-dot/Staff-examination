-- ═════════════════════════════════════════════════════════════════════════════
-- 0017 — Assign an exam to one person
--
-- WHAT THIS CLOSES. 0014 shipped group targeting only — outlet, department,
-- brand, role — and recorded the consequence honestly as known debt: there was
-- no way to give ONE person a retake. max_attempts applies to the whole cohort,
-- so the only lever was raising it for everybody, which quietly hands a second
-- go to the people who already passed.
--
-- For a programme with a pass mark that is not a hypothetical. Somebody fails,
-- is coached, and sits it again; nobody else should be affected.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY EVERY COMPARISON BELOW CASTS TO text.                                 │
-- │                                                                           │
-- │ ALTER TYPE … ADD VALUE is permitted inside a transaction from Postgres 12,│
-- │ but the new label CANNOT BE USED in that same transaction — a CHECK       │
-- │ constraint or function body naming 'user' as an enum literal fails with   │
-- │ "unsafe use of new value of enum type".                                   │
-- │                                                                           │
-- │ Comparing `target_kind::text = 'user'` compares strings and never         │
-- │ resolves the label, so this migration applies cleanly whether the runner  │
-- │ wraps it in a transaction (our replay harness) or not (psql, db push).    │
-- │ The alternative — splitting the ALTER TYPE into a file of its own — makes │
-- │ the schema depend on how the migration tool happens to batch statements.  │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

alter type public.assignment_target add value if not exists 'user';

-- on delete cascade, not set null: an assignment whose person is gone is not a
-- broken row to be repaired, it is an assignment that no longer means anything.
alter table public.exam_assignments
  add column target_user_id uuid references public.profiles(id) on delete cascade;

-- ── Exactly one target, whichever kind ───────────────────────────────────────
alter table public.exam_assignments drop constraint assignment_target_shape;

alter table public.exam_assignments
  add constraint assignment_target_shape check (
    case target_kind::text
      when 'user' then target_user_id is not null and target_id is null and target_role is null
      when 'role' then target_role    is not null and target_id is null and target_user_id is null
      else             target_id      is not null and target_role is null and target_user_id is null
    end
  );

drop index if exists public.exam_assignments_uq;
create unique index exam_assignments_uq
  on public.exam_assignments (
    exam_id, target_kind,
    coalesce(target_id::text, target_user_id::text, target_role)
  );

create index exam_assignments_user_idx
  on public.exam_assignments (target_user_id) where target_user_id is not null;

-- ── Visibility ───────────────────────────────────────────────────────────────
-- Re-issued from 0015 with the fourth branch. Still joins nothing but
-- exam_assignments: auth.uid() is as much a claim as my_outlet() is.
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
         (a.target_kind::text = 'outlet'     and a.target_id = public.my_outlet())
      or (a.target_kind::text = 'department' and a.target_id = public.my_department())
      or (a.target_kind::text = 'brand'      and a.target_id = public.my_brand())
      or (a.target_kind::text = 'role'       and public.has_role(a.target_role))
      or (a.target_kind::text = 'user'       and a.target_user_id = auth.uid())
       )
  );
$$;

-- ── Audience ─────────────────────────────────────────────────────────────────
-- Re-issued from 0014. The company_id check still applies to the user branch:
-- an id is not authorisation, and an assignment naming somebody outside the
-- company must reach nobody.
create or replace function public.exam_audience(p_exam_id uuid)
returns table (id uuid, email text, preferred_locale text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct p.id, p.email, p.preferred_locale
    from public.profiles p
    join public.exams e on e.id = p_exam_id
    join public.exam_assignments a on a.exam_id = e.id
   where p.deleted_at is null
     and p.approval_status = 'approved'
     and p.company_id = e.company_id
     and (
       (a.target_kind::text = 'outlet'     and a.target_id = p.outlet_id)
    or (a.target_kind::text = 'department' and a.target_id = p.department_id)
    or (a.target_kind::text = 'brand'      and a.target_id = (
          select o.brand_id from public.outlets o where o.id = p.outlet_id))
    or (a.target_kind::text = 'role'       and exists (
          select 1 from public.user_roles ur
            join public.roles ro on ro.id = ur.role_id
           where ur.user_id = p.id and ro.key = a.target_role))
    or (a.target_kind::text = 'user'       and a.target_user_id = p.id)
     );
$$;

comment on column public.exam_assignments.target_user_id is
  'Individual assignment. Exists so one person can be given a retake without raising max_attempts for the whole cohort — which would hand a second attempt to everyone who already passed.';
