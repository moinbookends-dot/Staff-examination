-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase compatibility shim for bare Postgres (CI only).
--
-- WHY THIS EXISTS: there is no Docker on the dev machine, so `supabase start`
-- is unavailable and migrations cannot be replayed locally. CI replays them
-- against a plain `postgres:17` service container instead. That container has
-- none of the Supabase platform objects our migrations depend on, so we
-- recreate the minimum surface here.
--
-- FIDELITY: auth.jwt() below reads `request.jwt.claims` exactly as Supabase's
-- does, so every RLS helper in src (jwt_app / is_approved / has_perm) behaves
-- identically. What this canNOT verify is that the custom access token hook is
-- actually wired and minting the `app` claim — that is only provable against
-- the real project. See plan §11, tier 2.
--
-- NEVER run this against a real Supabase project. It is CI-only.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── Platform roles ───────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin noinherit createrole;
  end if;
end $$;

-- ── auth schema ──────────────────────────────────────────────────────────────
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

-- Minimal stand-in for auth.users. Migrations FK to this and trigger off it.
-- Only the columns our code actually touches.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- ── Claim accessors — identical semantics to the Supabase originals ──────────
-- Tests impersonate a user with:
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"…","app":{…}}', true);
create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
  language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$$;

create or replace function auth.email() returns text
  language sql stable as $$
  select auth.jwt() ->> 'email'
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
grant select on auth.users to service_role, supabase_auth_admin;
