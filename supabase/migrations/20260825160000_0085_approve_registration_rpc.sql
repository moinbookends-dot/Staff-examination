-- ═══════════════════════════════════════════════════════════════════════════
-- 0085 — Approving a registration stops needing the RLS-bypassing key.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE SAME FAILURE 0081 FIXED FOR REGISTRATION, IN THE NEXT ROOM ALONG.    ║
-- ║                                                                          ║
-- ║ approveRegistration() and rejectRegistration() call createAdminClient(), ║
-- ║ whose getSecretKey() THROWS when SUPABASE_SECRET_KEY is unset. On a host ║
-- ║ missing that variable, pressing Accept does not show an error — the      ║
-- ║ action throws, and the whole screen falls into the error boundary. The   ║
-- ║ chef sees a broken page and no way to approve anybody.                   ║
-- ║                                                                          ║
-- ║ The admin client was a REASONABLE choice and the comment in users.ts     ║
-- ║ explains why: a chef holds users.approve but NOT users.update, so        ║
-- ║ profiles_admin_update will not let them write another person's outlet.   ║
-- ║ RLS was genuinely in the way.                                            ║
-- ║                                                                          ║
-- ║ A SECURITY DEFINER function is the answer this codebase already uses     ║
-- ║ everywhere else for exactly this shape — publish_exam, bank_pool_counts, ║
-- ║ start_attempt. The privilege is scoped to ONE operation with its own     ║
-- ║ permission check, instead of handing the caller a key that reads every   ║
-- ║ row in the database.                                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- EXECUTE IS GRANTED TO `authenticated` ONLY, NEVER `anon` — see
-- tests/integration/function-acl.test.ts, which exists because 0020 found four
-- SECURITY DEFINER functions callable with nothing but the publishable key.
-- The revoke below is not decoration; PostgreSQL grants EXECUTE to PUBLIC by
-- default, and Supabase adds `grant all on functions … to anon, authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.approve_registration(
  p_user_id       uuid,
  p_outlet_id     uuid,
  p_department_id uuid
)
returns table (approved int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target  record;
  v_actor   uuid := auth.uid();
  v_company uuid := public.my_company();
  v_count   int;
begin
  if not public.has_perm('users.approve') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  /*
   * The caller supplies p_user_id, so scope is re-verified here rather than
   * trusted. Reading through the definer's rights means this sees the row even
   * when the actor's own policies would not — which is exactly why the company
   * check below cannot be skipped.
   */
  select id, company_id, approval_status
    into v_target
    from public.profiles
   where id = p_user_id;

  if v_target.id is null then
    raise exception 'registration not found' using errcode = 'P0002';
  end if;

  if v_target.company_id is distinct from v_company then
    -- Another company's applicant is not this actor's business, and saying so
    -- would confirm the account exists.
    raise exception 'registration not found' using errcode = 'P0002';
  end if;

  if v_target.approval_status <> 'pending' then
    raise exception 'already decided' using errcode = 'P0001';
  end if;

  -- The outlet and department must be real, live, and this company's. Without
  -- this a caller could assign somebody into another company's outlet, which
  -- every RLS policy downstream reads as membership.
  if not exists (
    select 1 from public.outlets
     where id = p_outlet_id and deleted_at is null and is_active
       and company_id = v_company
  ) then
    raise exception 'unknown outlet' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.departments
     where id = p_department_id and deleted_at is null and company_id = v_company
  ) then
    raise exception 'unknown department' using errcode = 'P0002';
  end if;

  update public.profiles
     set approval_status  = 'approved',
         approved_by      = v_actor,
         approved_at      = now(),
         outlet_id        = p_outlet_id,
         department_id    = p_department_id,
         rejection_reason = null
   where id = p_user_id
     -- Optimistic guard, carried over from the action it replaces: two chefs
     -- share one queue, and without this the second click would silently
     -- overwrite the first one's outlet assignment.
     and approval_status = 'pending';

  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

comment on function public.approve_registration(uuid, uuid, uuid) is
  'Approves a pending registration and assigns outlet and department. SECURITY DEFINER because a chef holds users.approve but not users.update; gated on has_perm(users.approve) and scoped to the actor''s own company. Replaces the service-key path in src/server/actions/users.ts, so approval no longer depends on SUPABASE_SECRET_KEY being present.';

revoke all on function public.approve_registration(uuid, uuid, uuid) from public, anon;
grant execute on function public.approve_registration(uuid, uuid, uuid) to authenticated;


-- ── rejection, same reasoning ───────────────────────────────────────────────

create or replace function public.reject_registration(
  p_user_id uuid,
  p_reason  text
)
returns table (rejected int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target  record;
  v_actor   uuid := auth.uid();
  v_company uuid := public.my_company();
  v_count   int;
begin
  if not public.has_perm('users.approve') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select id, company_id, approval_status
    into v_target
    from public.profiles
   where id = p_user_id;

  if v_target.id is null or v_target.company_id is distinct from v_company then
    raise exception 'registration not found' using errcode = 'P0002';
  end if;

  if v_target.approval_status <> 'pending' then
    raise exception 'already decided' using errcode = 'P0001';
  end if;

  update public.profiles
     set approval_status  = 'rejected',
         approved_by      = v_actor,
         approved_at      = now(),
         rejection_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_user_id
     and approval_status = 'pending';

  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

comment on function public.reject_registration(uuid, text) is
  'Rejects a pending registration. Same rationale and guards as approve_registration.';

revoke all on function public.reject_registration(uuid, text) from public, anon;
grant execute on function public.reject_registration(uuid, text) to authenticated;
