-- ═════════════════════════════════════════════════════════════════════════════
-- 0023 — One definition of "is this exam assigned to this person"
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT WAS WRONG                                                            │
-- │                                                                           │
-- │ Two functions answered the same question and disagreed:                   │
-- │                                                                           │
-- │   is_exam_assigned_to_me  brand branch → a.target_id = my_brand()         │
-- │   exam_audience           brand branch → the OUTLET's brand_id            │
-- │                                                                           │
-- │ my_brand() reads the `brand_id` claim, which the auth hook copies from    │
-- │ profiles.brand_id — A COLUMN NOTHING EVER WRITES. Registration does not   │
-- │ set it; approveRegistration sets outlet_id and department_id and not      │
-- │ this. So it is null for every real user, and:                             │
-- │                                                                           │
-- │   · a brand-targeted exam NOTIFIED everyone and EMAILED them, via         │
-- │     exam_audience, which resolves brand correctly from the outlet…        │
-- │   · …and was then invisible to all of them, because                       │
-- │     is_exam_assigned_to_me compared their target to null.                 │
-- │                                                                           │
-- │ The same null also broke exams_read_manage for chefs: `brand_id =         │
-- │ my_brand()` meant a brand-scoped exam was invisible to everyone except a  │
-- │ super admin, whom has_perm short-circuits.                                │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THE FIX IS TWO PARTS, AND BOTH ARE NEEDED.
--
-- 1. Make the claim true. Brand is a property of WHERE SOMEBODY WORKS, so it is
--    derived from their outlet, with profiles.brand_id kept as an explicit
--    override for anyone posted to a brand rather than an outlet. Deriving it
--    at token-mint time costs one join per login instead of one per row, which
--    is the whole reason the claims model exists.
--
-- 2. Make divergence impossible rather than merely fixed. assignment_matches()
--    below is the ONLY place that decides whether an assignment reaches a
--    person. Both callers pass their own view of that person into it; neither
--    contains a comparison of its own. Two implementations cannot drift when
--    there is one implementation.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The single rule ──────────────────────────────────────────────────────────
create or replace function public.assignment_matches(
  p_target_kind    public.assignment_target,
  p_target_id      uuid,
  p_target_role    text,
  p_target_user_id uuid,
  -- the person, however the caller happens to know them
  p_outlet         uuid,
  p_department     uuid,
  p_brand          uuid,
  p_user           uuid,
  p_role_keys      text[]
)
returns boolean
language sql
immutable
as $$
  select case p_target_kind::text
    when 'outlet'     then p_target_id      is not null and p_target_id      = p_outlet
    when 'department' then p_target_id      is not null and p_target_id      = p_department
    when 'brand'      then p_target_id      is not null and p_target_id      = p_brand
    when 'role'       then p_target_role    is not null and p_target_role    = any(coalesce(p_role_keys, '{}'))
    when 'user'       then p_target_user_id is not null and p_target_user_id = p_user
    else false
  end;
$$;

-- Immutable and pure — no tables, no claims, nothing to leak. Safe to grant,
-- and it must be, because RLS policy bodies evaluate as the invoking role.
grant execute on function public.assignment_matches(
  public.assignment_target, uuid, text, uuid, uuid, uuid, uuid, uuid, text[]
) to authenticated;

comment on function public.assignment_matches(
  public.assignment_target, uuid, text, uuid, uuid, uuid, uuid, uuid, text[]
) is
  'THE single definition of whether an exam assignment reaches a person. is_exam_assigned_to_me() and exam_audience() both delegate here and contain no comparison of their own, so visibility and notification cannot disagree — which they previously did for brand targeting, notifying people about an exam none of them could see.';

-- ── The person, as the database sees them ────────────────────────────────────
-- Brand derived the same way the token is minted: an explicit posting wins,
-- otherwise the outlet decides.
create or replace function public.profile_brand(p_profile_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p.brand_id,
    (select o.brand_id from public.outlets o where o.id = p.outlet_id)
  )
  from public.profiles p
  where p.id = p_profile_id;
$$;

revoke all on function public.profile_brand(uuid) from public, anon, authenticated;

-- ── The auth hook, so the claim stops being null ─────────────────────────────
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_app jsonb;
begin
  select to_jsonb(x) into v_app
  from (
    select
      (p.approval_status = 'approved' and p.deleted_at is null) as approved,
      p.company_id,
      -- DERIVED, not copied. profiles.brand_id is an override that nothing
      -- currently sets; the outlet is where brand actually comes from. Copying
      -- the column verbatim is what made my_brand() null for every user and
      -- broke brand scoping everywhere it was consulted.
      coalesce(
        p.brand_id,
        (select o.brand_id from public.outlets o where o.id = p.outlet_id)
      ) as brand_id,
      p.outlet_id,
      p.department_id,
      coalesce(
        (select array_agg(distinct r.key)
           from public.user_roles ur
           join public.roles r on r.id = ur.role_id
          where ur.user_id = p.id),
        '{}'::text[]
      ) as roles,
      coalesce(
        (select array_agg(distinct pm.key)
           from public.user_roles ur
           join public.role_permissions rp on rp.role_id = ur.role_id
           join public.permissions pm on pm.id = rp.permission_id
          where ur.user_id = p.id),
        '{}'::text[]
      ) as perms
    from public.profiles p
    where p.id = (event ->> 'user_id')::uuid
  ) x;

  -- No profile row (deleted, or the trigger has not fired yet): mint a token
  -- that can do nothing. Failing closed is the only safe default here.
  return jsonb_set(
    event,
    '{claims}',
    coalesce(event -> 'claims', '{}'::jsonb)
      || jsonb_build_object('app', coalesce(v_app, jsonb_build_object('approved', false)))
  );
end;
$$;

-- ── Both callers, now delegating ─────────────────────────────────────────────

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
       and public.assignment_matches(
             a.target_kind, a.target_id, a.target_role, a.target_user_id,
             public.my_outlet(),
             public.my_department(),
             public.my_brand(),
             auth.uid(),
             array(select jsonb_array_elements_text(public.jwt_app() -> 'roles'))
           )
  );
$$;

grant execute on function public.is_exam_assigned_to_me(uuid) to authenticated;

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
     -- An id is not authorisation: an assignment naming somebody in another
     -- company reaches nobody.
     and p.company_id = e.company_id
     and public.assignment_matches(
           a.target_kind, a.target_id, a.target_role, a.target_user_id,
           p.outlet_id,
           p.department_id,
           public.profile_brand(p.id),
           p.id,
           array(select r.key
                   from public.user_roles ur
                   join public.roles r on r.id = ur.role_id
                  where ur.user_id = p.id)
         );
$$;

revoke all on function public.exam_audience(uuid) from public, anon, authenticated;
