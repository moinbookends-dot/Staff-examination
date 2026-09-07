-- 0096 — four helper functions lose the accidental anon EXECUTE.
--
-- Postgres auto-grants EXECUTE to PUBLIC on function creation, and these four
-- helpers were created without the revoke boilerplate their siblings carry —
-- caught by tests/integration/function-acl.test.ts, whose freeze list demands
-- that anon-executable functions be a decision, not a default.
--
-- None of them is anon business: they read the caller's claims and exist for
-- RLS policies and views evaluated as an authenticated invoker. Executing
-- them anonymously returns nulls today; the revoke makes the boundary a rule
-- rather than a coincidence of their implementations.
do $$
declare
  v_sig text;
begin
  for v_sig in
    select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('brand_in_my_company', 'brand_unscoped', 'exam_state', 'is_email_verified')
  loop
    execute format('revoke all on function %s from public, anon', v_sig);
    execute format('grant execute on function %s to authenticated, service_role', v_sig);
  end loop;
end $$;
