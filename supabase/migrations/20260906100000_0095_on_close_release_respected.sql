-- 0095 — auto-verified grading respects results_release.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE BUG: verification_mode 'auto' published AT SUBMISSION, unconditionally.║
-- ║                                                                           ║
-- ║ grade_and_close_attempt's v_next branch (0028, carried through 0088)      ║
-- ║ never looked at exams.results_release. An exam configured 'on_close' —    ║
-- ║ results held until the window shuts, so early finishers cannot hand the   ║
-- ║ verdict to candidates still sitting — leaked every result the moment      ║
-- ║ each candidate pressed Submit. release_due_results() (0067) exists to     ║
-- ║ lift the hold and already publishes 'auto_graded' rows once due; nothing  ║
-- ║ was ever held for it to lift.                                             ║
-- ║                                                                           ║
-- ║ THE FIX: the auto branch publishes only when release is due NOW — the     ║
-- ║ same predicate release_due_results() applies, kept in step — and          ║
-- ║ otherwise stops at 'auto_graded', which that function lifts at close.     ║
-- ║ Found by scripts/check-live-exams.mjs once its own 0088-era expectations  ║
-- ║ were corrected.                                                           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Verbatim from the live definition (pg_get_functiondef, 2026-09-06) with two
-- changes: the exam's results_release and closes_at join the record, and the
-- v_next case gains the due test.
create or replace function public.grade_and_close_attempt(p_attempt_id uuid, p_reason submit_reason)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_attempt record;
  v_row     record;
  v_grade   record;
  v_score   numeric;
  v_review  boolean;
  v_manual  boolean;
  v_next    public.attempt_status;
begin
  select a.*, e.pass_mark_percent, e.verification_mode, e.results_release, e.closes_at
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
   for update of a;

  if v_attempt.id is null then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'this attempt has already been submitted' using errcode = '22023';
  end if;

  -- Iterating attempt_answers, not attempt_questions: an unanswered question
  -- has no row, contributes nothing, and incurs no penalty. That is the skip
  -- rule, expressed by the absence of a row rather than by a special case.
  for v_row in
    select aa.question_id, aa.question_revision, aa.answer,
           aq.snapshot, aq.marks, aq.negative_marks, aq.source, aq.answer_key
      from public.attempt_answers aa
      join public.attempt_questions aq
        on aq.attempt_id = aa.attempt_id and aq.question_id = aa.question_id
     where aa.attempt_id = p_attempt_id
  loop
    select * into v_grade from public.grade_answer(
      v_row.snapshot -> 'content',
      case
        when v_row.source = 'bank' then v_row.answer_key
        -- 0022: the key as it was at the revision this candidate was served.
        else public.answer_key_at_revision(v_row.question_id, v_row.question_revision)
      end,
      v_row.answer,
      v_row.marks,
      v_row.negative_marks
    );

    update public.attempt_answers aa
       set score             = v_grade.score,
           auto_grade_status = v_grade.status,
           needs_review      = v_grade.needs_review,
           grade_detail      = v_grade.detail
     where aa.attempt_id = p_attempt_id and aa.question_id = v_row.question_id;
  end loop;

  select greatest(coalesce(sum(aa.score), 0), 0), bool_or(aa.needs_review)
    into v_score, v_review
    from public.attempt_answers aa
   where aa.attempt_id = p_attempt_id;

  -- Does the PAPER contain anything a machine cannot mark? Asked of the paper
  -- rather than of the answers, because an unanswered essay still needs a human
  -- to record the zero.
  select exists (
    select 1 from public.attempt_questions aq
     where aq.attempt_id = p_attempt_id
       -- 0088: text_short is no longer here — it grades itself. Only formats
       -- a machine cannot mark keep an attempt from publishing.
       and (aq.snapshot ->> 'response_format') in ('text_long', 'evaluator_only')
  ) into v_manual;

  /*
   * 0088: requires_manual_grading is gone from this decision. It is a PAPER
   * flag meaning "contains short answers" (publish_paper_as_exam sets it from
   * short_n > 0), and short answers now grade themselves — keeping it would
   * queue every attempt for no reason. The decision now rests on what the
   * answers actually needed: an essay on the paper, a grader flag, or an
   * answer left not_applicable (a text_short whose key had no model — an
   * authoring gap a human must resolve, not a zero to publish).
   */
  select exists (
    select 1 from public.attempt_answers aa2
     where aa2.attempt_id = p_attempt_id
       and aa2.auto_grade_status = 'not_applicable'
  ) or coalesce(v_manual, false)
    into v_manual;

  /*
   * 0095: 'auto' publishes only when release is DUE — the same predicate
   * release_due_results() uses, kept in step. An 'on_close' exam still open
   * grades to 'auto_graded' and is lifted to 'published' by that function
   * once the window shuts; before this, the hold policy was leaked past at
   * the moment of submission.
   */
  v_next := case
              when v_manual or coalesce(v_review, false)
                then 'evaluating'
              when v_attempt.verification_mode = 'auto'
                and (    v_attempt.results_release = 'immediate'
                      or (v_attempt.results_release = 'on_close'
                          and v_attempt.closes_at is not null
                          and now() >= v_attempt.closes_at))
                then 'published'
              else 'auto_graded'
            end;

  update public.attempts a
     set submitted_at   = now(),
         submit_reason  = p_reason,
         score          = v_score,
         auto_graded_at = now(),
         published_at   = case when v_next = 'published' then now() else a.published_at end,
         status         = v_next,
         -- A verdict only where the machine finished the job. Anything going to
         -- an evaluator has no result yet, and recording one would publish a
         -- fail nobody agreed to.
         passed = case
                    when v_next = 'evaluating' then null
                    when coalesce(a.max_score, 0) = 0 then false
                    else (v_score / a.max_score) * 100 >= v_attempt.pass_mark_percent
                  end
   where a.id = p_attempt_id;
end;
$function$;
