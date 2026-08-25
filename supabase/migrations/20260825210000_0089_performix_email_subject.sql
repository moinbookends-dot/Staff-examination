-- ═══════════════════════════════════════════════════════════════════════════
-- 0089 — The approval email says Performix.
--
-- The product was renamed: Performix, by Bookends Hospitality. Subjects are
-- written at ENQUEUE time in SQL (the renderer deliberately reuses the stored
-- subject rather than recomposing it — see src/lib/notifications/templates.ts),
-- so the one subject naming the old brand lives here. The exam-assigned and
-- result-published subjects carry no brand and need nothing.
--
-- Live definition captured verbatim via pg_get_functiondef; the subject string
-- is the only change. "Bookends Hospitality" remains the COMPANY everywhere —
-- what changed is the app's name.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.approve_registration(p_user_id uuid, p_outlet_id uuid, p_department_id uuid)
 RETURNS TABLE(approved integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'Your Performix account is ready',
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
$function$
;
