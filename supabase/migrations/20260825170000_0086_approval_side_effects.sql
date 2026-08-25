-- ═══════════════════════════════════════════════════════════════════════════
-- 0086 — Fold the approval's side effects into the function that owns it.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO 0085.                  ║
-- ║                                                                          ║
-- ║ supabase_migrations.schema_migrations records the STATEMENTS it ran, so   ║
-- ║ rewriting an applied file leaves the history describing something that    ║
-- ║ never executed. Appending is honest; editing would be tidier and false.   ║
-- ║                                                                          ║
-- ║ WHAT WAS MISSING: 0085 moved the profile update off the service key, but  ║
-- ║ approveRegistration also writes a notification and queues an email, and   ║
-- ║ BOTH of those tables are server-written by design — notifications has no  ║
-- ║ insert policy (0007) and email_outbox has no policy at all. So the action ║
-- ║ still had to construct an admin client, and still broke on a host with no ║
-- ║ SUPABASE_SECRET_KEY. Half a fix is not a fix.                             ║
-- ║                                                                          ║
-- ║ Folding them in also makes the whole decision ATOMIC. Previously the      ║
-- ║ update, the notification and the email were three round trips: a failure  ║
-- ║ between them left somebody approved but never told. Now it is one         ║
-- ║ transaction that either happens or does not.                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- With this, src/server/actions/users.ts holds no reference to the admin
-- client, and nothing in the application requires SUPABASE_SECRET_KEY to run.
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

  select id, email, company_id, approval_status
    into v_target
    from public.profiles
   where id = p_user_id;

  -- "Not found" covers another company's applicant too: distinguishing them
  -- would confirm that an account exists to somebody who cannot see it.
  if v_target.id is null or v_target.company_id is distinct from v_company then
    raise exception 'registration not found' using errcode = 'P0002';
  end if;

  if v_target.approval_status <> 'pending' then
    raise exception 'already decided' using errcode = 'P0001';
  end if;

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
     and approval_status = 'pending';   -- two chefs, one queue

  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.notifications (user_id, kind, title, body, link)
    values (
      p_user_id,
      'registration.approved',
      'Your account has been approved',
      'You can now sign in and see your assigned exams.',
      '/dashboard'
    );

    -- Queued, never sent inline: approving a batch of new starters must not
    -- spend the provider's daily quota in one action. The drain sends these.
    insert into public.email_outbox (to_email, to_user_id, subject, template, priority, payload)
    values (
      v_target.email,
      p_user_id,
      'Your Bookends Learning account is ready',
      'registration-approved',
      2,                                      -- 0007's scale: a decision, above results
      jsonb_build_object('dedupe_key', 'registration-approved:' || p_user_id::text)
    )
    -- The dedupe index is partial (unsent rows only). A re-approval after the
    -- first mail already went would otherwise raise and roll back an approval
    -- that is otherwise perfectly valid.
    on conflict do nothing;
  end if;

  return query select v_count;
end;
$$;

revoke all on function public.approve_registration(uuid, uuid, uuid) from public, anon;
grant execute on function public.approve_registration(uuid, uuid, uuid) to authenticated;


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
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
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
         rejection_reason = v_reason
   where id = p_user_id
     and approval_status = 'pending';

  get diagnostics v_count = row_count;

  if v_count > 0 then
    -- No email for a rejection: notifications_self_read has no approval gate
    -- precisely so a rejected person can still read this in the product.
    insert into public.notifications (user_id, kind, title, body)
    values (
      p_user_id,
      'registration.rejected',
      'Your registration was not approved',
      coalesce(v_reason, 'No reason was given.')
    );
  end if;

  return query select v_count;
end;
$$;

revoke all on function public.reject_registration(uuid, text) from public, anon;
grant execute on function public.reject_registration(uuid, text) to authenticated;
