-- ═════════════════════════════════════════════════════════════════════════════
-- 0029 — The candidate's results, and being told they exist
--
-- M4 left a published result sitting in the database with nobody told and
-- nowhere to look at it. This closes both halves.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE NOTIFICATION IS A TRIGGER, NOT A CALL IN EACH PUBLISHER.              │
-- │                                                                           │
-- │ Four functions can move an attempt to 'published':                        │
-- │                                                                           │
-- │   grade_and_close_attempt   auto-graded, exam wants no sign-off (0028)    │
-- │   complete_evaluation       marked, verification_mode = 'auto'            │
-- │   verify_attempt            the last signature lands                      │
-- │   publish_attempt           somebody releases a held paper                │
-- │                                                                           │
-- │ Writing the notification into all four is how three of them keep it and   │
-- │ the fourth quietly loses it. Firing on the TRANSITION covers every path    │
-- │ by construction, including any fifth one added later — which is the same  │
-- │ reasoning that made draw_paper() one selector with two writers.           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- IDEMPOTENCY comes from two independent places, deliberately. The status graph
-- (0028) lets an attempt enter 'published' at most once in its life — the only
-- move out of it is to 'voided', and 'voided' goes nowhere. That alone makes a
-- duplicate impossible. The unique index below makes it impossible a second
-- time, so that widening the graph later cannot silently start double-sending.
-- ═════════════════════════════════════════════════════════════════════════════

-- publish_exam has been writing notifications with `on conflict do nothing`
-- since 0014 against no unique index at all, which does nothing. This is the
-- constraint that clause has been waiting for.
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, kind, (data ->> 'dedupe_key'))
  where data ? 'dedupe_key';

comment on index public.notifications_dedupe_idx is
  'At-most-once delivery for any notification carrying a dedupe_key. Unconditional on purpose: email_outbox scopes its equivalent to unsent rows so a digest can legitimately repeat, but a result is published once and telling somebody twice is always a defect.';

create or replace function public.notify_attempt_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person record;
  v_title  text;
begin
  select p.id, p.email, p.email_opt_in
    into v_person
    from public.profiles p
   where p.id = new.candidate_id and p.deleted_at is null;

  -- A deleted profile is not an error worth failing a publication over.
  if v_person.id is null then
    return new;
  end if;

  select e.title into v_title from public.exams e where e.id = new.exam_id;

  insert into public.notifications (user_id, kind, title, body, link, data)
  values (
    v_person.id,
    'result.published',
    'Your exam result is ready',
    v_title,
    '/results/' || new.id::text,
    jsonb_build_object(
      'dedupe_key', 'attempt-published:' || new.id::text,
      'attempt_id', new.id,
      'exam_id', new.exam_id
    )
  )
  on conflict do nothing;

  -- The in-app notification is written regardless; only the email honours the
  -- opt-out. Someone who asked for no email did not ask to be kept in the dark
  -- inside the product they have to use.
  if coalesce(v_person.email_opt_in, true) then
    insert into public.email_outbox (
      to_email, to_user_id, subject, template, priority, payload
    )
    values (
      v_person.email,
      v_person.id,
      'Your result for ' || coalesce(v_title, 'your exam'),
      'result-published',
      3,   -- 0007's scale: below a password reset, above an exam assignment
      jsonb_build_object(
        'dedupe_key', 'attempt-published:' || new.id::text,
        'attempt_id', new.id,
        'exam_title', v_title
      )
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.notify_attempt_published() from public, anon, authenticated;

drop trigger if exists attempts_notify_published on public.attempts;
create trigger attempts_notify_published
  after update of status on public.attempts
  for each row
  when (new.status = 'published' and old.status is distinct from 'published')
  execute function public.notify_attempt_published();

-- ═════════════════════════════════════════════════════════════════════════════
-- What a candidate may read about their own results
--
-- Same rule as 0028 and for the same reason: a policy picks rows and cannot
-- withhold a column, so every score below is behind a CASE on 'published'
-- rather than behind a WHERE that a future edit could widen.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.my_results()
returns table (
  attempt_id        uuid,
  exam_id           uuid,
  exam_title        text,
  exam_kind         public.exam_kind,
  status            public.attempt_status,
  started_at        timestamptz,
  submitted_at      timestamptz,
  published_at      timestamptz,
  score             numeric,
  max_score         numeric,
  percent           numeric,
  passed            boolean,
  pass_mark_percent numeric,
  published         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.exam_id, e.title, e.kind, a.status,
         a.started_at, a.submitted_at,
         case when a.status = 'published' then a.published_at end,
         case when a.status = 'published' then a.score     end,
         case when a.status = 'published' then a.max_score end,
         case when a.status = 'published' and coalesce(a.max_score, 0) > 0
              then round((a.score / a.max_score) * 100, 1) end,
         case when a.status = 'published' then a.passed    end,
         e.pass_mark_percent,
         a.status = 'published'
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.candidate_id = auth.uid()
     -- A paper still being sat belongs on /my-exams, and a voided one is
     -- excluded from every report by the rule 0025 set out.
     and a.status not in ('in_progress', 'voided')
   order by a.submitted_at desc nulls last
$$;

grant execute on function public.my_results() to authenticated;

/**
 * The header of one result.
 *
 * NAMES THE PEOPLE, NOT WHAT THEY SAID. 0028 gave candidates no policy on
 * attempt_verifications because the notes verifiers write to each other are an
 * internal conversation. Who marked and who signed off is a different thing —
 * it is the accountability that makes a disputed mark answerable — so the names
 * are returned and the notes never are.
 */
create or replace function public.my_result_detail(p_attempt_id uuid)
returns table (
  attempt_id        uuid,
  exam_title        text,
  started_at        timestamptz,
  submitted_at      timestamptz,
  published_at      timestamptz,
  score             numeric,
  max_score         numeric,
  percent           numeric,
  passed            boolean,
  pass_mark_percent numeric,
  evaluator_name    text,
  verifier_names    text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
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
           );
end;
$$;

grant execute on function public.my_result_detail(uuid) to authenticated;

comment on function public.my_result_detail(uuid) is
  'One published result, for the candidate it belongs to. Returns who evaluated and who verified, and never what they wrote — 0028 keeps verifier notes out of a candidate''s reach, and this does not reopen that.';
