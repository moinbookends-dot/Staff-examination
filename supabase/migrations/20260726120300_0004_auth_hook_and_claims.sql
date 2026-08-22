-- ═════════════════════════════════════════════════════════════════════════════
-- 0004 — Custom access token hook + JWT claim helpers
--
-- THE PROBLEM THIS SOLVES
--
-- The obvious way to write an RLS policy is to join through the RBAC tables:
--
--   using (exists (select 1 from user_roles ur
--                    join role_permissions rp on rp.role_id = ur.role_id
--                    join permissions p on p.id = rp.permission_id
--                   where ur.user_id = auth.uid() and p.key = 'questions.read'))
--
-- That runs a three-way join ONCE PER CANDIDATE ROW. On a 5,000-row question
-- list it is 5,000 joins. Worse, any policy on user_roles that itself queries
-- user_roles recurses and deadlocks.
--
-- THE FIX
--
-- Bake roles, permissions and org scope into the JWT when it is minted. Token
-- issue happens roughly once an hour; row filtering happens constantly. One
-- query per hour beats one query per row by any measure.
--
-- Every helper below then reads only auth.jwt() — it touches NO TABLES, so it
-- cannot recurse and costs nothing.
--
-- THE TRADE-OFF, stated plainly: claims are a snapshot. Approve a user at 10:00
-- and their existing token still says approved=false until it refreshes. See
-- me_status() at the bottom and plan §5.5 for the four mitigations.
-- ═════════════════════════════════════════════════════════════════════════════

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
      p.brand_id,
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

-- Only the auth server may execute the hook. If `authenticated` could call it,
-- a user could inspect it; if it were writable, worse. Lock it down explicitly.
grant  usage   on schema public to supabase_auth_admin;
grant  execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- The hook runs as supabase_auth_admin and must read the RBAC tables.
grant select on public.profiles, public.user_roles, public.roles,
                public.role_permissions, public.permissions
  to supabase_auth_admin;

-- ═════════════════════════════════════════════════════════════════════════════
-- Claim accessors
--
-- All are STABLE and read no tables. Always call them wrapped in a subselect
-- inside policies — `(select public.has_perm('x'))` — so Postgres hoists the
-- call into an InitPlan evaluated once per query instead of once per row.
-- On a large scan that is the difference between milliseconds and seconds.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.jwt_app()
returns jsonb
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app', '{}'::jsonb);
$$;

create or replace function public.is_approved()
returns boolean
language sql
stable
as $$
  select coalesce((public.jwt_app() ->> 'approved')::boolean, false);
$$;

create or replace function public.has_role(role_key text)
returns boolean
language sql
stable
as $$
  select coalesce(public.jwt_app() -> 'roles' ? role_key, false);
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
as $$
  select public.has_role('super_admin');
$$;

-- The workhorse. Note it ANDs in is_approved(), so a pending or suspended
-- user's token fails every permission check for free — the approval gate is
-- enforced at the database layer, not merely in middleware.
--
-- Super admins pass implicitly rather than by holding every key, so a newly
-- added permission cannot accidentally lock the platform owner out.
create or replace function public.has_perm(permission_key text)
returns boolean
language sql
stable
as $$
  select public.is_approved()
     and (public.is_super_admin()
          or coalesce(public.jwt_app() -> 'perms' ? permission_key, false));
$$;

create or replace function public.my_company()
returns uuid
language sql
stable
as $$
  select nullif(public.jwt_app() ->> 'company_id', '')::uuid;
$$;

create or replace function public.my_brand()
returns uuid
language sql
stable
as $$
  select nullif(public.jwt_app() ->> 'brand_id', '')::uuid;
$$;

create or replace function public.my_outlet()
returns uuid
language sql
stable
as $$
  select nullif(public.jwt_app() ->> 'outlet_id', '')::uuid;
$$;

create or replace function public.my_department()
returns uuid
language sql
stable
as $$
  select nullif(public.jwt_app() ->> 'department_id', '')::uuid;
$$;

grant execute on function
  public.jwt_app(), public.is_approved(), public.has_role(text),
  public.is_super_admin(), public.has_perm(text), public.my_company(),
  public.my_brand(), public.my_outlet(), public.my_department()
  to authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════════════
-- me_status() — the staleness escape hatch
--
-- A just-approved user still carries approved=false in their current token.
-- The /pending screen polls this instead: it reads profiles DIRECTLY, bypassing
-- the stale claim. When it flips, the client calls supabase.auth.refreshSession()
-- to mint a token carrying the new claims, then redirects.
--
-- SECURITY DEFINER because a pending user's own RLS grants are minimal, and it
-- is scoped hard to auth.uid() — a caller can only ever see their own row.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.me_status()
returns table (
  approval_status  public.approval_status,
  rejection_reason text,
  full_name        text,
  preferred_locale text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.approval_status, p.rejection_reason, p.full_name, p.preferred_locale
    from public.profiles p
   where p.id = (select auth.uid())
     and p.deleted_at is null;
$$;

grant execute on function public.me_status() to authenticated;

comment on function public.custom_access_token_hook(jsonb) is
  'Injects app claims (approved, roles, perms, org scope) into the access token at mint time so RLS policies never join the RBAC tables. Register in config.toml under [auth.hook.custom_access_token].';
comment on function public.has_perm(text) is
  'Primary RLS predicate. Includes the approval gate. Always call wrapped: (select public.has_perm(...)) so it evaluates once per query, not once per row.';
comment on function public.me_status() is
  'Reads approval status directly from profiles, bypassing stale JWT claims. Used by the /pending poll to detect approval before the token refreshes.';
