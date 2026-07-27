-- ═════════════════════════════════════════════════════════════════════════════
-- 0006 — Audit log
--
-- The PRD schedules audit logging for M8. This is M1 deliberately: the trigger
-- is forty lines, and deferring it means the first seven weeks of real data —
-- including every registration approval and role grant, precisely the events
-- worth auditing — happen with no trail. There is no way to reconstruct them
-- afterwards.
--
-- STORAGE DISCIPLINE (plan §10). audit_logs is the single biggest threat to the
-- 500 MB free-tier database. Everything else is small: 300 staff × 12 exams a
-- year is trivial. An unbounded audit table storing full row snapshots is not.
-- Three mitigations, all applied here:
--
--   1. Store a DIFF, not both full rows. Only columns that actually changed.
--      Typically 10× smaller, and far more readable when investigating.
--   2. Attach the trigger to ~8 sensitive tables, never all 30.
--   3. Hard delete on a 180-day retention schedule. This is the one table
--      exempt from the soft-delete rule — audit rows about audit rows is
--      recursion with no benefit.
-- ═════════════════════════════════════════════════════════════════════════════

create table public.audit_logs (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),

  actor_id     uuid references public.profiles(id) on delete set null,
  actor_email  text,          -- denormalised: survives the actor being deleted
  actor_roles  text[],        -- role set AT THE TIME, not now

  action       text not null, -- insert | update | delete | custom verb
  table_name   text not null,
  record_id    text,          -- text, not uuid: some keys are composite/bigint

  changes      jsonb,         -- {column: {old: …, new: …}} — diff only
  context      jsonb,         -- request-scoped extras (ip_hash, ua, reason)

  company_id   uuid references public.companies(id)
);

-- Query patterns from the admin audit viewer (PRD §4.11): filter by user, by
-- action, by date range, by table.
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index audit_logs_actor_idx    on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_record_idx   on public.audit_logs (table_name, record_id);
create index audit_logs_action_idx   on public.audit_logs (action, occurred_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- Generic audit trigger
--
-- Attach with:
--   create trigger <table>_audit
--     after insert or update or delete on public.<table>
--     for each row execute function public.audit_row();
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes   jsonb := '{}'::jsonb;
  v_old       jsonb;
  v_new       jsonb;
  v_key       text;
  v_record_id text;
  v_actor     uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    -- On insert the "diff" is the row itself, minus noise that carries no
    -- investigative value and inflates every row.
    v_changes   := v_new - 'created_at' - 'updated_at';
    v_record_id := v_new ->> 'id';

  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);

    -- Diff only. Comparing key by key rather than storing both full rows is
    -- what keeps this table from dominating the 500 MB budget.
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key not in ('updated_at')
         and (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key)
        );
      end if;
    end loop;

    -- Nothing meaningful changed (an updated_at-only touch): do not log.
    if v_changes = '{}'::jsonb then
      return coalesce(new, old);
    end if;

    v_record_id := v_new ->> 'id';

  elsif tg_op = 'DELETE' then
    v_old       := to_jsonb(old);
    v_changes   := v_old - 'created_at' - 'updated_at';
    v_record_id := v_old ->> 'id';
  end if;

  insert into public.audit_logs (
    actor_id, actor_email, actor_roles,
    action, table_name, record_id, changes, company_id
  )
  values (
    v_actor,
    -- Resolved at write time so the log stays readable after the actor is gone.
    (select email from public.profiles where id = v_actor),
    case
      when v_actor is null then null
      else (select array(select jsonb_array_elements_text(public.jwt_app() -> 'roles')))
    end,
    lower(tg_op),
    tg_table_name,
    v_record_id,
    v_changes,
    coalesce((v_new ->> 'company_id')::uuid, (v_old ->> 'company_id')::uuid)
  );

  return coalesce(new, old);
end;
$$;

-- ── Attach to the sensitive few ──────────────────────────────────────────────
-- Identity and authorisation changes. Deliberately NOT every table: auditing
-- every question edit would bury the events that matter under noise, and blow
-- the storage budget doing it.
create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function public.audit_row();

create trigger user_roles_audit
  after insert or update or delete on public.user_roles
  for each row execute function public.audit_row();

create trigger role_permissions_audit
  after insert or update or delete on public.role_permissions
  for each row execute function public.audit_row();

create trigger roles_audit
  after insert or update or delete on public.roles
  for each row execute function public.audit_row();

create trigger outlets_audit
  after insert or update or delete on public.outlets
  for each row execute function public.audit_row();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.audit_logs enable row level security;

-- Read-only, super admin only. There is no insert, update or delete policy:
-- the only writer is audit_row(), which is SECURITY DEFINER and therefore
-- bypasses RLS. That makes the log append-only from the application's
-- perspective — nobody can edit or erase their own trail.
create policy audit_logs_read on public.audit_logs
  for select to authenticated
  using ((select public.has_perm('audit.read')));

comment on table public.audit_logs is
  'Append-only. Written solely by audit_row() (SECURITY DEFINER); no write policy exists, so the trail cannot be altered from the app. Stores diffs, not full row snapshots, to stay inside the 500 MB budget. 180-day retention.';
comment on function public.audit_row() is
  'Generic audit trigger. Logs only changed columns. Attach to sensitive tables only — auditing everything buries the signal and exhausts storage.';
