-- ═══════════════════════════════════════════════════════════════════════════
-- 0093 — The complete paper viewer's data, and user access management.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THREE THINGS, ALL ON EXISTING TABLES:                                     ║
-- ║                                                                           ║
-- ║ 1. monitor_attempt_review learns to return the WHOLE question as the      ║
-- ║    candidate received it — snapshot stem, the MCQ options, the selected   ║
-- ║    id — so a monitor pages through the paper the person actually sat,     ║
-- ║    not a summary. It also fixes 0092's own defect: stems live at          ║
-- ║    snapshot->>'stem' and the previous coalesce over 'question' rendered   ║
-- ║    every stem blank. The verdict stays the RECORDED one (grade_detail);   ║
-- ║    nothing regrades.                                                      ║
-- ║                                                                           ║
-- ║ 2. admin_list_users — the Users page. Gated users.read_team/read_all      ║
-- ║    (0030's shape: team = same outlet), returning profile, place, role     ║
-- ║    keys and approval status. Reads profiles/user_roles/roles as they are. ║
-- ║                                                                           ║
-- ║ 3. set_user_access — role, department, outlet in one transaction. The     ║
-- ║    permission is users.assign_roles, WHICH NO ROLE HOLDS: only the        ║
-- ║    is_super_admin() bypass in has_perm() satisfies it, so "only Super     ║
-- ║    Admin manages roles" is enforced by the permission model that already  ║
-- ║    exists rather than by a hardcoded role name.                           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.monitor_attempt_review(uuid);

create or replace function public.monitor_attempt_review(p_attempt_id uuid)
returns table(
  question_id  uuid,
  paper_position int,
  stem         text,
  qformat      text,
  content      jsonb,
  marks        numeric,
  score        numeric,
  answered     boolean,
  correct      boolean,
  needs_review boolean,
  selected     text,
  answer_text  text,
  -- Null unless the caller holds evaluation.evaluate — the permission that
  -- already sees keys in the marking form. Applies to the MCQ correct option
  -- and the short-answer model alike: both ARE the answer sheet.
  correct_answer text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sees_keys boolean := public.has_perm('evaluation.evaluate');
begin
  perform public.monitor_attempt_reach(p_attempt_id);

  return query
    select aq.question_id,
           aq.position,
           coalesce(aq.snapshot ->> 'stem', ''),
           coalesce(aq.snapshot -> 'content' ->> 'format', aq.snapshot ->> 'type', ''),
           -- The options as the candidate saw them; no key hides in content.
           aq.snapshot -> 'content',
           aq.marks,
           aa.score,
           coalesce(aa.answer is not null and jsonb_typeof(aa.answer) <> 'null', false),
           -- The verdict the grader recorded — never recomputed here.
           (aa.grade_detail ->> 'correct')::boolean,
           coalesce(aa.needs_review, false),
           coalesce(aa.grade_detail ->> 'selected', aa.answer ->> 'choice'),
           aa.answer ->> 'text',
           case when v_sees_keys
                then coalesce(aq.answer_key ->> 'model', aq.answer_key ->> 'correct')
           end
      from public.attempt_questions aq
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
     order by aq.position;
end;
$$;

revoke all on function public.monitor_attempt_review(uuid) from public, anon;
grant execute on function public.monitor_attempt_review(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The Users page.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.admin_list_users()
returns table(
  user_id       uuid,
  full_name     text,
  email         text,
  employee_code text,
  department    text,
  outlet        text,
  approval_status text,
  role_keys     text[],
  last_attempt_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or not (public.has_perm('users.read_all') or public.has_perm('users.read_team')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select p.id,
           p.full_name,
           p.email,
           p.employee_code,
           d.name,
           o.name,
           p.approval_status::text,
           coalesce(
             (select array_agg(r.key order by r.key)
                from public.user_roles ur
                join public.roles r on r.id = ur.role_id
               where ur.user_id = p.id),
             '{}'::text[]
           ),
           (select max(aa.submitted_at) from public.analytics_attempts aa
             where aa.candidate_id = p.id)
      from public.profiles p
      left join public.departments d on d.id = p.department_id
      left join public.outlets o     on o.id = p.outlet_id
     where p.company_id = public.my_company()
       and p.deleted_at is null
       -- Team reach mirrors 0030: your outlet unless you hold read_all.
       and (public.has_perm('users.read_all') or p.outlet_id = public.my_outlet())
     order by p.full_name nulls last, p.email;
end;
$$;

revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Access management — one transaction, four hard rules.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.set_user_access(
  p_user_id       uuid,
  p_role_key      text,
  p_department_id uuid default null,
  p_outlet_id     uuid default null
)
returns table(updated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_company uuid := public.my_company();
  v_role_id uuid;
  v_sa_role uuid;
  v_remaining int;
begin
  -- users.assign_roles is held by NO role; has_perm() satisfies it only
  -- through the is_super_admin() bypass. That IS the Super-Admin-only rule.
  if v_uid is null or not public.has_perm('users.assign_roles') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Rule 1: never your own row. A person who can rewrite their own access can
  -- also quietly undo every other rule below.
  if p_user_id = v_uid then
    raise exception 'you cannot change your own access' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles p
     where p.id = p_user_id and p.company_id = v_company and p.deleted_at is null
  ) then
    raise exception 'user not found' using errcode = '42501';
  end if;

  select r.id into v_role_id from public.roles r where r.key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  select r.id into v_sa_role from public.roles r where r.key = 'super_admin';

  -- Rule 2: demoting a Super Admin must never remove the LAST one. A company
  -- with zero super admins has nobody left who can manage access at all.
  if exists (
    select 1 from public.user_roles ur
     where ur.user_id = p_user_id and ur.role_id = v_sa_role
  ) and v_role_id <> v_sa_role then
    select count(*) into v_remaining
      from public.user_roles ur
      join public.profiles p on p.id = ur.user_id
     where ur.role_id = v_sa_role
       and p.company_id = v_company
       and p.deleted_at is null
       and ur.user_id <> p_user_id;
    if v_remaining = 0 then
      raise exception 'cannot demote the last super admin' using errcode = '22023';
    end if;
  end if;

  /*
   * The role SET becomes {employee, <chosen>} — matching the convention every
   * seeded account already follows (Employee as the base role plus at most
   * one speciality). Choosing 'employee' yields just the base role.
   */
  delete from public.user_roles where user_id = p_user_id;
  insert into public.user_roles (user_id, role_id, granted_by)
  select p_user_id, r.id, v_uid
    from public.roles r
   where r.key in ('employee', p_role_key)
     on conflict do nothing;

  -- Department and outlet, when given: same columns approve_registration sets.
  if p_outlet_id is not null then
    if not exists (
      select 1 from public.outlets o
       where o.id = p_outlet_id and o.company_id = v_company
         and o.deleted_at is null and o.is_active
    ) then
      raise exception 'unknown outlet' using errcode = '22023';
    end if;
    update public.profiles set outlet_id = p_outlet_id where id = p_user_id;
  end if;

  if p_department_id is not null then
    if not exists (
      select 1 from public.departments d
       where d.id = p_department_id and d.company_id = v_company and d.deleted_at is null
    ) then
      raise exception 'unknown department' using errcode = '22023';
    end if;
    update public.profiles set department_id = p_department_id where id = p_user_id;
  end if;

  return query select true;
end;
$$;

comment on function public.set_user_access(uuid, text, uuid, uuid) is
  'Role, department and outlet in one transaction. users.assign_roles gates it, which only the is_super_admin() bypass satisfies. Never the caller''s own row; never removes the last super admin. Role changes take effect at the target''s next token refresh — the same latency every claim change in this system has.';

revoke all on function public.set_user_access(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.set_user_access(uuid, text, uuid, uuid) to authenticated;

-- The role catalogue for the dropdown — names only, no invention.
create or replace function public.list_roles()
returns table(role_key text, role_name text)
language sql
stable
security definer
set search_path = public
as $$
  select r.key, r.name from public.roles r
   where public.has_perm('users.read_all') or public.has_perm('users.read_team')
   order by r.name;
$$;

revoke all on function public.list_roles() from public, anon;
grant execute on function public.list_roles() to authenticated;
