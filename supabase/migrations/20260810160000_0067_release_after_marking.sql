-- ═════════════════════════════════════════════════════════════════════════════
-- 0067 — Let a marked paper actually reach the candidate.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ I SET verification_mode WRONG IN 0063, AND IT WOULD HAVE STRANDED EVERY   ║
-- ║ RESULT.                                                                   ║
-- ║                                                                           ║
-- ║ publish_paper_as_exam set 'single' with a comment claiming it meant "one  ║
-- ║ evaluator signs the paper off and releases it". It does not. In           ║
-- ║ complete_evaluation, ANY mode other than 'auto' sends the attempt to      ║
-- ║ `verifying` to await a SECOND person — and verify_attempt refuses the     ║
-- ║ evaluator as their own verifier.                                          ║
-- ║                                                                           ║
-- ║ In a kitchen there is no second person. Measured end to end: the Chef     ║
-- ║ marked every question, complete_evaluation returned `verifying`, and the  ║
-- ║ candidate's result sat there with nobody in the company able to release   ║
-- ║ it.                                                                       ║
-- ║                                                                           ║
-- ║ 'auto' is what this product means: the person who marks the paper decides ║
-- ║ the result. Legacy rule-drawn exams keep whatever they were configured    ║
-- ║ with — this changes the value publish_paper_as_exam WRITES, not the       ║
-- ║ meaning of the column.                                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ BUT 'auto' ALONE WOULD HAVE BROKEN THE OTHER HALF.                       │
-- │                                                                           │
-- │ complete_evaluation publishes immediately under 'auto', which silently    │
-- │ defeats results_release = 'on_close': the whole point of that setting is  │
-- │ that nobody sees a result until the deadline, and marking a paper early   │
-- │ would have released it early.                                            │
-- │                                                                           │
-- │ So complete_evaluation now stops at `evaluated` — a real state, already   │
-- │ permitted to move to `published` by the transition trigger — when the     │
-- │ exam is paper-backed, set to on_close, and still open. release_due_results│
-- │ picks it up once the deadline passes.                                     │
-- │                                                                           │
-- │ EVERY OTHER PATH IS UNCHANGED. A legacy exam has paper_id null, so the    │
-- │ new branch cannot fire for one.                                          │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.complete_evaluation(p_attempt_id uuid)
returns public.attempt_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt record;
  v_mode public.verification_mode;
  v_outstanding int;
  v_score numeric;
  v_next public.attempt_status;
  v_hold boolean;
begin
  if v_uid is null or not public.has_perm('evaluation.evaluate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- paper_id, closes_at and results_release joined in for the hold decision.
  select a.*, e.verification_mode, e.pass_mark_percent,
         e.paper_id, e.closes_at, e.results_release
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
   for update of a;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('evaluating', 'returned') then
    raise exception 'this attempt is not awaiting evaluation' using errcode = '22023';
  end if;

  select count(*)::int into v_outstanding
    from public.attempt_questions aq
    left join public.attempt_answers aa
           on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
   where aq.attempt_id = p_attempt_id
     and (
       (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
       or coalesce(aa.needs_review, false)
     )
     -- NOT "score is null". 0027's grader already wrote score 0 and status
     -- 'not_applicable' against every manual question, so a null check would
     -- see an essay nobody has read as finished. What marks it done is a human
     -- having set it to 'graded' — which is exactly what save_evaluation does.
     and (
       coalesce(aa.auto_grade_status, 'pending'::public.auto_grade_status)
         in ('pending', 'not_applicable')
       or coalesce(aa.needs_review, false)
     );

  if v_outstanding > 0 then
    raise exception 'this attempt has % question(s) still awaiting a mark', v_outstanding
      using errcode = '22023';
  end if;

  select greatest(coalesce(sum(aa.score), 0), 0) into v_score
    from public.attempt_answers aa where aa.attempt_id = p_attempt_id;

  v_mode := v_attempt.verification_mode;

  /*
   * Hold this result back? Only for a paper-backed exam that says on_close and
   * has not closed yet. release_due_results() releases it at the deadline.
   */
  v_hold := v_attempt.paper_id is not null
        and v_attempt.results_release = 'on_close'
        and (v_attempt.closes_at is null or now() < v_attempt.closes_at);

  -- 'auto' means nobody has to counter-sign, so the result is final here —
  -- unless the exam is holding results until it closes.
  v_next := case
              when v_mode <> 'auto' then 'verifying'
              when v_hold then 'evaluated'
              else 'published'
            end;

  update public.attempts a
     set status       = 'evaluated',
         score        = v_score,
         passed       = case when coalesce(a.max_score, 0) = 0 then false
                             else (v_score / a.max_score) * 100 >= v_attempt.pass_mark_percent end,
         evaluated_by = v_uid,
         evaluated_at = now()
   where a.id = p_attempt_id;

  -- Skipped when the row is already in the state it wants: 'evaluated' to
  -- 'evaluated' is not a transition the trigger admits.
  if v_next <> 'evaluated' then
    update public.attempts a
       set status = v_next,
           published_at = case when v_next = 'published' then now() else a.published_at end
     where a.id = p_attempt_id;
  end if;

  return v_next;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Publishing writes 'auto' from now on
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.publish_paper_as_exam(
  p_paper_id          uuid,
  p_title             text,
  p_duration_minutes  int,
  p_opens_at          timestamptz,
  p_closes_at         timestamptz,
  p_max_attempts      int,
  p_pass_mark_percent int,
  p_instructions      text default null,
  p_results_release   public.results_release default 'immediate'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
  v_paper   record;
  v_exam    uuid;
begin
  if not (public.has_perm('exams.create') and public.has_perm('exams.publish')) then
    raise exception 'Not permitted to publish an exam.'
      using errcode = 'insufficient_privilege';
  end if;

  select p.* into v_paper
    from public.exam_papers p
   where p.id = p_paper_id
     and p.company_id = v_company
     and (p.brand_id = public.my_brand() or public.brand_unscoped());

  if v_paper.id is null then
    raise exception 'That paper could not be found.'
      using errcode = 'no_data_found';
  end if;

  if v_paper.status = 'retired' then
    raise exception 'That paper has been retired and cannot be published.'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.exams e
     where e.paper_id = p_paper_id
       and e.deleted_at is null
       and e.status in ('draft', 'scheduled', 'active')
  ) then
    raise exception 'That paper is already published as an open exam.'
      using errcode = 'unique_violation';
  end if;

  -- ── The publish validation, stated once, here ───────────────────────────
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'Give the exam a name.' using errcode = 'check_violation';
  end if;
  if p_duration_minutes is null or p_duration_minutes < 5 or p_duration_minutes > 480 then
    raise exception 'The time allowed must be between 5 and 480 minutes.' using errcode = 'check_violation';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'Attempts allowed must be between 1 and 10.' using errcode = 'check_violation';
  end if;
  if p_pass_mark_percent is null or p_pass_mark_percent < 1 or p_pass_mark_percent > 100 then
    raise exception 'The pass mark must be between 1 and 100 percent.' using errcode = 'check_violation';
  end if;
  if p_closes_at is null then
    raise exception 'Give the exam a closing time.' using errcode = 'check_violation';
  end if;
  if p_opens_at is not null and p_closes_at <= p_opens_at then
    raise exception 'The closing time must be after the opening time.'
      using errcode = 'check_violation';
  end if;
  if p_closes_at <= now() then
    raise exception 'The closing time has already passed.' using errcode = 'check_violation';
  end if;

  insert into public.exams (
    company_id, brand_id, title, instructions,
    kind, status, paper_mode, paper_id,
    duration_minutes, opens_at, closes_at,
    max_attempts, pass_mark_percent,
    shuffle_questions, shuffle_options,
    total_marks, question_count,
    requires_manual_grading,
    verification_mode,
    results_release,
    created_by, published_by, published_at
  )
  values (
    v_paper.company_id, v_paper.brand_id, p_title, p_instructions,
    'official', 'scheduled', 'fixed', p_paper_id,
    p_duration_minutes, p_opens_at, p_closes_at,
    p_max_attempts, p_pass_mark_percent,
    -- BOTH SHUFFLES OFF. Some of these candidates may be sitting the printed
    -- copy of this same paper in the same room, and question 7 has to be
    -- question 7 on every desk.
    false, false,
    v_paper.marks, v_paper.mcq_n + v_paper.short_n,
    v_paper.short_n > 0,
    /*
     * 'auto' — the marker's decision is the result.
     *
     * This was 'single' and that was a mistake: 'single' requires a SECOND
     * person to counter-sign, and verify_attempt refuses the evaluator as
     * their own verifier, so nobody in a one-chef kitchen could ever release
     * a mark. See the box at the top of this migration.
     *
     * Results timing is results_release's job, not verification's.
     */
    'auto',
    p_results_release,
    auth.uid(), auth.uid(), now()
  )
  returning id into v_exam;

  if v_paper.status = 'generated' then
    update public.exam_papers
       set status = 'live', status_changed_at = now(), status_changed_by = auth.uid()
     where id = p_paper_id;
  end if;

  return jsonb_build_object(
    'examId',  v_exam,
    'paperNo', v_paper.paper_no,
    'marks',   v_paper.marks
  );
end;
$$;

comment on function public.complete_evaluation(uuid) is
  'Finishes marking one attempt. Publishes immediately under verification_mode auto, holds at `evaluated` when a paper-backed exam releases on_close, and routes to `verifying` for the legacy single/dual modes.';
