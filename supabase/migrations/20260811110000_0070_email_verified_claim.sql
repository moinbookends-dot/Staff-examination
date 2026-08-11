-- ═════════════════════════════════════════════════════════════════════════════
-- 0070 — `email_verified` on the app claim.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WITHOUT THIS, EMAIL VERIFICATION IS A SCREEN AND NOT A GATE.              ║
-- ║                                                                           ║
-- ║ The /verify-email flow added alongside this migration can be skipped by   ║
-- ║ typing /dashboard, unless something on the SERVER knows whether the       ║
-- ║ address was confirmed. Two candidates for that something:                 ║
-- ║                                                                           ║
-- ║   1. Query auth.users on every request. A database round trip in the      ║
-- ║      proxy, on every navigation, for a fact that changes once per         ║
-- ║      account — the exact cost 0004 exists to avoid.                       ║
-- ║   2. Put it in the token, where `approved` already lives.                 ║
-- ║                                                                           ║
-- ║ This is (2), and it inherits (2)'s trade-off: the claim is a snapshot     ║
-- ║ taken when the token is minted. A user who verifies at 10:00 still        ║
-- ║ carries email_verified=false until their token refreshes. That is         ║
-- ║ handled the same way approval is — verifyOtp() establishes a fresh        ║
-- ║ session, so the token minted right after verification already carries     ║
-- ║ true, and the /verify-email screen navigates only after that.             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY auth.users AND NOT user_metadata.                                    │
-- │                                                                           │
-- │ GoTrue mirrors a confirmed address into raw_user_meta_data.email_verified,│
-- │ and that field is USER-WRITABLE: signUp({ data: … }) and updateUser({     │
-- │ data: … }) both land there, from the browser. Reading it here would let   │
-- │ a registrant assert their own verification in the same request that       │
-- │ creates the account — the identical mistake 0069 just closed on profiles. │
-- │                                                                           │
-- │ auth.users.email_confirmed_at is written by the auth server alone.        │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- SAFE FOR EVERY EXISTING ACCOUNT: all 13 rows in auth.users carry a non-null
-- email_confirmed_at at the time of writing, so nobody is newly gated. Checked
-- rather than assumed — a migration that silently locks out the live users is
-- the one failure mode this claim has.
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
      /*
       * Read from auth.users, which only the auth server writes. See the box
       * above: raw_user_meta_data.email_verified is client-controlled and
       * would make this claim self-assertable.
       *
       * The subselect (rather than a join) keeps the shape of the query
       * unchanged when a profile exists but the auth row somehow does not —
       * coalesce then makes that case `false`, which is the fail-closed
       * direction.
       */
      coalesce(
        (select u.email_confirmed_at is not null
           from auth.users u
          where u.id = p.id),
        false
      ) as email_verified,
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
  -- that can do nothing. Failing closed is the only safe default here — and it
  -- now withholds email_verified too, so the absent-profile case cannot walk
  -- past the verification gate either.
  return jsonb_set(
    event,
    '{claims}',
    coalesce(event -> 'claims', '{}'::jsonb)
      || jsonb_build_object(
           'app',
           coalesce(v_app, jsonb_build_object('approved', false, 'email_verified', false))
         )
  );
end;
$$;

-- The hook runs as its owner but reads a table in another schema. Granting the
-- narrowest thing that works: SELECT on the one column pair it consults.
grant usage on schema auth to supabase_auth_admin;

comment on function public.custom_access_token_hook(jsonb) is
  'Bakes approval, email verification, org scope, roles and permissions into the access token. email_verified comes from auth.users.email_confirmed_at — never from raw_user_meta_data, which the client can write.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The accessor, alongside is_approved()
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.is_email_verified()
returns boolean
language sql
stable
as $$
  select coalesce((public.jwt_app() ->> 'email_verified')::boolean, false);
$$;

comment on function public.is_email_verified() is
  'True when the token was minted for an account whose email address the auth server has confirmed. Reads the claim only — no tables, so it is safe inside a policy.';

grant execute on function public.is_email_verified() to authenticated, anon;

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DELIBERATELY *NOT* ADDED TO has_perm().                                  │
 * │                                                                           │
 * │ has_perm() already ANDs in is_approved(), and approval is downstream of   │
 * │ verification in the flow this migration supports: a chef approves an      │
 * │ account after the address is confirmed. Folding the new claim in as well  │
 * │ would change the meaning of every policy in the schema in one line, to    │
 * │ gain nothing an unapproved user could have done anyway.                   │
 * │                                                                           │
 * │ The gate belongs where the flow is — proxy.ts and the (app) layout — and  │
 * │ this function is what both consult.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
