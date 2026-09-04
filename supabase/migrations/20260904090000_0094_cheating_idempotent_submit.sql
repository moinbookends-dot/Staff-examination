-- 0094 — leaving the exam is cheating: idempotent submission, reason surfaced.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE MARKER ALREADY EXISTS; THIS MIGRATION MAKES IT MEAN SOMETHING.        ║
-- ║                                                                           ║
-- ║ attempts.submit_reason = 'tab_switch' is written exactly once, inside     ║
-- ║ grade_and_close_attempt under FOR UPDATE, by a SECURITY DEFINER function  ║
-- ║ that is the table's only writer — no RLS insert/update exists, and no     ║
-- ║ function ever updates the reason afterwards. That makes it a permanent,   ║
-- ║ server-authoritative, client-unforgeable record that the candidate left   ║
-- ║ the active exam. No new status, no new column, no second audit trail:     ║
-- ║ the product treats that recorded fact as CHEATING, and this migration     ║
-- ║ only (a) makes repeated submits idempotent so duplicate visibility        ║
-- ║ events can never double-close or re-stamp an attempt, and (b) carries     ║
-- ║ submit_reason out through the read functions so every surface can show    ║
-- ║ it. 'timer' and 'sweeper' remain ordinary auto-submits, never cheating.  ║
-- ║                                                                           ║
-- ║ The TS-side classification lives in src/lib/attempts/closure.ts — the     ║
-- ║ reason lists there and here must stay in step.                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── 0. A second violation reason: the exam window lost focus ─────────────────
--
-- An Android floating window (a Meet call bubble, a YouTube popup) can cover
-- the exam while the page stays VISIBLE — visibilitychange never fires. What
-- Chrome does emit is window focus loss. The runner enforces it with a grace
-- period; when it submits, the record must be able to say which signal fired,
-- so 'tab_switch' (page hidden) and 'focus_loss' (window unfocused) are kept
-- distinct. Both classify as cheating — src/lib/attempts/closure.ts.
--
-- Comparisons below use ::text so this new value is never instantiated inside
-- this transaction (Postgres forbids using an enum value added in the same
-- transaction; comparing text never touches it).
alter type public.submit_reason add value if not exists 'focus_loss';

-- ── 1. submit_attempt: first closer wins, everyone after gets the truth ──────
--
-- Verbatim from the live definition (pg_get_functiondef, 2026-09-04) with two
-- additions: the owner select also reads status, and a closed attempt returns
-- its final row instead of raising. The inner exception handler covers the
-- race the pre-check cannot: two closers passing the check together — the
-- loser's grade_and_close_attempt raises against the FOR UPDATE row, and that
-- specific refusal is swallowed because the attempt IS closed, which is all
-- the caller asked for. The recorded reason is whichever closer won; nothing
-- ever overwrites it, so a cheating mark cannot be laundered by re-submitting
-- with reason 'user'.
create or replace function public.submit_attempt(p_attempt_id uuid, p_reason submit_reason default 'user'::submit_reason)
 returns table(status attempt_status, score numeric, max_score numeric, passed boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_status public.attempt_status;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.candidate_id, a.status into v_owner, v_status
    from public.attempts a where a.id = p_attempt_id;

  if v_owner is null or v_owner <> v_uid then
    raise exception 'attempt not found' using errcode = '42501';
  end if;

  -- A candidate may declare that they finished, that their timer ran out,
  -- that the page was hidden, or that the exam window lost focus. They may
  -- not declare that a sweeper or an administrator closed their attempt —
  -- those are the server's to claim, and accepting them here would let a
  -- candidate forge the audit trail. (::text so 'focus_loss', added above in
  -- this same migration, is compared without instantiating the enum value.)
  if p_reason::text not in ('user', 'timer', 'tab_switch', 'focus_loss') then
    raise exception 'invalid submit reason' using errcode = '22023';
  end if;

  if v_status = 'in_progress' then
    begin
      perform public.grade_and_close_attempt(p_attempt_id, p_reason);
    exception when others then
      if sqlerrm = 'this attempt has already been submitted' then
        -- Lost the closing race to the timer, the sweeper, or a duplicate
        -- visibility event. The attempt is closed, which is what was asked.
        null;
      else
        raise;
      end if;
    end;
  end if;

  return query
    select a.status, a.score, a.max_score, a.passed
      from public.attempts a where a.id = p_attempt_id;
end;
$function$;

-- ── 2. exam_participants: carry the reason to the monitoring table ───────────
--
-- Verbatim from the live definition; one column appended (submit_reason text)
-- so the participant table can distinguish a cheating closure from a timer or
-- sweeper one. Appended last so every existing consumer keeps its columns.
drop function if exists public.exam_participants(uuid);

create function public.exam_participants(p_exam_id uuid)
 returns table(employee_id uuid, full_name text, email text, department text, outlet text, started_at timestamp with time zone, submitted_at timestamp with time zone, expires_at timestamp with time zone, state text, auto_submitted boolean, attempt_id uuid, attempt_no integer, answered_n integer, question_n integer, last_activity timestamp with time zone, score numeric, max_score numeric, passed boolean, released boolean, submit_reason text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_company uuid := public.my_company();
begin
  if auth.uid() is null
     or not public.has_perm('exams.read')
     or not (public.has_perm('attempts.read_all') or public.has_perm('attempts.read_team')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id and e.company_id = v_company and e.deleted_at is null
  ) then
    raise exception 'exam not found' using errcode = 'no_data_found';
  end if;

  return query
  with audience as (
    select a.id from public.exam_audience(p_exam_id) a
  ),
  best as (
    -- The attempt that represents this candidate: the latest non-voided one.
    select distinct on (t.candidate_id)
           t.id, t.candidate_id, t.started_at, t.submitted_at, t.expires_at,
           t.status, t.submit_reason, t.attempt_number,
           t.score, t.max_score, t.passed
      from public.attempts t
     where t.exam_id = p_exam_id and t.status <> 'voided'
     order by t.candidate_id, t.started_at desc
  ),
  progress as (
    -- One aggregate pass over the represented attempts, not a count per row.
    select aa.attempt_id,
           count(*) filter (where aa.answer is not null
                              and jsonb_typeof(aa.answer) <> 'null')::int as answered_n,
           max(greatest(aa.answered_at, aa.updated_at))                   as last_activity
      from public.attempt_answers aa
     where aa.attempt_id in (select best.id from best)
     group by aa.attempt_id
  ),
  sizes as (
    select aq.attempt_id, count(*)::int as question_n
      from public.attempt_questions aq
     where aq.attempt_id in (select best.id from best)
     group by aq.attempt_id
  )
  select
    p.id,
    p.full_name,
    p.email,
    d.name,
    o.name,
    b.started_at,
    b.submitted_at,
    b.expires_at,
    case
      when b.candidate_id is null        then 'not_started'
      when b.status = 'in_progress'      then 'in_progress'
      when b.status = 'expired'          then 'expired'
      when b.status = 'published'        then 'released'
      else 'submitted'
    end,
    -- The candidate did not press Submit themselves: the clock, a violation,
    -- or the sweeper closed the paper. 'user' and null both mean a real press.
    -- Kept in step with isAutoSubmitted() in src/lib/attempts/closure.ts.
    coalesce(b.submit_reason::text in ('timer', 'tab_switch', 'focus_loss', 'sweeper'), false),
    b.id,
    b.attempt_number,
    coalesce(pr.answered_n, 0),
    coalesce(sz.question_n, 0),
    coalesce(pr.last_activity, b.started_at),
    -- Withheld until released, exactly as my_attempts() does for the candidate.
    -- A monitoring screen showing a score the candidate has not been given
    -- would make the release policy meaningless.
    case when b.status = 'published' then b.score end,
    b.max_score,
    case when b.status = 'published' then b.passed end,
    coalesce(b.status = 'published', false),
    -- The raw reason, so the UI can name a tab_switch closure for what it is.
    -- Not withheld with the score: HOW an attempt closed is monitoring truth,
    -- not a result.
    b.submit_reason::text
    from audience a
    join public.profiles p on p.id = a.id
    left join public.departments d on d.id = p.department_id
    left join public.outlets o     on o.id = p.outlet_id
    left join best b     on b.candidate_id = p.id
    left join progress pr on pr.attempt_id = b.id
    left join sizes sz    on sz.attempt_id = b.id
   order by p.full_name nulls last, p.email;
end;
$function$;

revoke execute on function public.exam_participants(uuid) from public, anon;
grant execute on function public.exam_participants(uuid) to authenticated, service_role;

-- ── 3. candidate_attempt_history: the reason follows into history ────────────
--
-- Verbatim from the live definition; submit_reason appended so a cheated
-- attempt stays marked in /users/[id] history and everywhere HistoryRow goes.
drop function if exists public.candidate_attempt_history(uuid);

create function public.candidate_attempt_history(p_candidate_id uuid default null::uuid)
 returns table(attempt_id uuid, exam_id uuid, exam_title text, attempt_no integer, started_at timestamp with time zone, submitted_at timestamp with time zone, minutes integer, score numeric, max_score numeric, percent numeric, passed boolean, submit_reason text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_candidate_id, auth.uid());
  v_scope  text := public.analytics_scope();
begin
  if v_uid is null or v_scope = 'none' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_target <> v_uid then
    if v_scope = 'own' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.profiles p
       where p.id = v_target
         and p.company_id = public.my_company()
         and (v_scope = 'all' or p.outlet_id = public.my_outlet())
    ) then
      raise exception 'candidate not found' using errcode = '42501';
    end if;
  end if;

  return query
    select aa.attempt_id,
           aa.exam_id,
           e.title,
           t.attempt_number,
           aa.started_at,
           aa.submitted_at,
           case when aa.submitted_at is not null and aa.started_at is not null
                then greatest(1, round(extract(epoch from aa.submitted_at - aa.started_at) / 60))::int
           end,
           aa.score,
           aa.max_score,
           aa.percent,
           aa.passed,
           t.submit_reason::text
      from public.analytics_attempts aa
      join public.exams e    on e.id = aa.exam_id
      join public.attempts t on t.id = aa.attempt_id
     where aa.candidate_id = v_target
     order by aa.submitted_at desc nulls last, aa.started_at desc;
end;
$function$;

revoke execute on function public.candidate_attempt_history(uuid) from public, anon;
grant execute on function public.candidate_attempt_history(uuid) to authenticated, service_role;

-- ── 4. my_attempt_state: the runner's page learns how the attempt closed ─────
--
-- Verbatim from the live definition; submit_reason appended. The reason is the
-- candidate's own recorded act — unlike the score it is never withheld,
-- because the cheating notice must be shown the moment they return.
drop function if exists public.my_attempt_state(uuid);

create function public.my_attempt_state(p_attempt_id uuid)
 returns table(attempt_id uuid, status attempt_status, expires_at timestamp with time zone, submitted_at timestamp with time zone, answered_count integer, exam_title text, allow_backtrack boolean, submit_reason text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  return query
    select a.id, a.status, a.expires_at, a.submitted_at,
           (select count(*)::int from public.attempt_answers aa where aa.attempt_id = a.id),
           e.title, e.allow_backtrack,
           a.submit_reason::text
      from public.attempts a
      join public.exams e on e.id = a.exam_id
     where a.id = p_attempt_id
       and a.candidate_id = auth.uid();
end;
$function$;

-- ── 5. my_attempts: same, for the result card lookup ─────────────────────────
drop function if exists public.my_attempts();

create function public.my_attempts()
 returns table(attempt_id uuid, exam_id uuid, status attempt_status, started_at timestamp with time zone, submitted_at timestamp with time zone, expires_at timestamp with time zone, score numeric, max_score numeric, passed boolean, published boolean, submit_reason text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select a.id, a.exam_id, a.status, a.started_at, a.submitted_at, a.expires_at,
         case when a.status = 'published' then a.score     end,
         case when a.status = 'published' then a.max_score end,
         case when a.status = 'published' then a.passed    end,
         a.status = 'published',
         a.submit_reason::text
    from public.attempts a
   where a.candidate_id = auth.uid()
$function$;

-- ── 6. my_result_detail: the released result names the closure too ───────────
drop function if exists public.my_result_detail(uuid);

create function public.my_result_detail(p_attempt_id uuid)
 returns table(attempt_id uuid, exam_title text, started_at timestamp with time zone, submitted_at timestamp with time zone, published_at timestamp with time zone, score numeric, max_score numeric, percent numeric, passed boolean, pass_mark_percent numeric, evaluator_name text, verifier_names text[], submit_reason text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_attempt record;
begin
  select a.*, e.title, e.pass_mark_percent
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id;

  if v_attempt.id is null or v_attempt.candidate_id <> auth.uid() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status <> 'published' then
    raise exception 'this result has not been released yet' using errcode = '22023';
  end if;

  return query
    select v_attempt.id,
           v_attempt.title,
           v_attempt.started_at,
           v_attempt.submitted_at,
           v_attempt.published_at,
           v_attempt.score,
           v_attempt.max_score,
           case when coalesce(v_attempt.max_score, 0) > 0
                then round((v_attempt.score / v_attempt.max_score) * 100, 1) end,
           v_attempt.passed,
           v_attempt.pass_mark_percent,
           (select p.full_name from public.profiles p where p.id = v_attempt.evaluated_by),
           coalesce(
             (select array_agg(p.full_name order by v.created_at)
                from public.attempt_verifications v
                join public.profiles p on p.id = v.verifier_id
               where v.attempt_id = p_attempt_id
                 and v.decision = 'verified'
                 -- The round that actually stands. Approvals discarded by a
                 -- return are history, not signatories.
                 and v.round = v_attempt.returned_count + 1),
             array[]::text[]
           ),
           v_attempt.submit_reason::text;
end;
$function$;
