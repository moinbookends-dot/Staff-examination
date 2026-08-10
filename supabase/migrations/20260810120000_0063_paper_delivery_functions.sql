-- ═════════════════════════════════════════════════════════════════════════════
-- 0063 — Sitting a generated paper.
--
-- 0062 built the bridge; this drives across it. Three things happen here:
--
--   1. Two helpers turn a bank question into the snapshot shape the delivery
--      stack already speaks.
--   2. start_attempt learns to freeze a paper-backed exam, and
--      grade_and_close_attempt learns where a bank question's key lives.
--   3. publish_paper_as_exam() creates the exam.
--
-- Everything else — save_answer, submit_attempt, attempt_paper, attempt_review,
-- my_attempt_state, the evaluation chain, every RLS policy — is untouched and
-- works unchanged, because none of it ever looked at public.questions.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- A bank question, in the shape the delivery stack speaks
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE i18n KEY IS THE WHOLE REASON THIS FITS.                               │
 * │                                                                           │
 * │ localise_snapshot() picks one language out of `i18n` and strips the rest  │
 * │ before the row leaves the server, and getAttemptPaper() merges the        │
 * │ result over the base by id. That is exactly the shape bank_question_texts │
 * │ already stores — one row per locale, options keyed a–d — so a trilingual  │
 * │ bank question becomes a trilingual sitting with no new machinery.         │
 * │                                                                           │
 * │ THERE IS NO ANSWER KEY IN HERE, and there must never be. attempt_paper()  │
 * │ hands this entire object to the candidate. The key goes in the            │
 * │ attempt_questions.answer_key COLUMN, which no candidate-facing function   │
 * │ selects.                                                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create or replace function public.bank_question_snapshot(p_question_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'stem',            en.question,
    'type',            case when b.qtype = 'mcq' then 'mcq_single' else 'short_answer' end,
    'media',           '[]'::jsonb,
    'revision',        1,
    'question_id',     b.id,
    'content_version', 1,
    'response_format', case when b.qtype = 'mcq' then 'choice_single' else 'text_short' end,
    'estimated_seconds', case when b.qtype = 'mcq' then 45 else 90 end,
    'content', case
      when b.qtype = 'mcq' then jsonb_build_object(
        'format', 'choice_single',
        'choices', jsonb_build_array(
          jsonb_build_object('id', 'a', 'text', en.option_a),
          jsonb_build_object('id', 'b', 'text', en.option_b),
          jsonb_build_object('id', 'c', 'text', en.option_c),
          jsonb_build_object('id', 'd', 'text', en.option_d)))
      else jsonb_build_object('format', 'text_short')
    end,
    'i18n', coalesce((
      select jsonb_object_agg(
               t.locale,
               jsonb_build_object(
                 'stem', t.question,
                 'content', case
                   when b.qtype = 'mcq' then jsonb_build_object(
                     'choices',
                     -- strip_nulls: a locale that translated the stem but not
                     -- the options must fall back to English per option, which
                     -- mergeTranslation does by absence, not by null.
                     jsonb_strip_nulls(jsonb_build_object(
                       'a', t.option_a, 'b', t.option_b,
                       'c', t.option_c, 'd', t.option_d)))
                   else '{}'::jsonb
                 end))
        from public.bank_question_texts t
       where t.question_id = b.id
         and t.locale <> 'en'), '{}'::jsonb)
  )
  from public.bank_questions b
  join public.bank_question_texts en
    on en.question_id = b.id and en.locale = 'en'
  where b.id = p_question_id;
$$;

comment on function public.bank_question_snapshot(uuid) is
  'One bank question rendered into the legacy snapshot contract, with every non-English locale under i18n for localise_snapshot() to choose from. Carries NO answer key — attempt_paper() returns this object to the candidate.';

/*
 * The key, frozen onto the attempt.
 *
 * correct_option is char(1) and UPPERCASE ('A'..'D'); the snapshot's choice ids
 * are lowercase, and grade_answer compares `answer.choice = key.correct` as
 * text. lower() is the entire mapping.
 *
 * Short answers get a key whose format alone tells grade_answer to stand down:
 * it returns 'not_applicable' for text_short and the attempt routes to a human.
 * `model` rides along for that human — it is never shown to the candidate,
 * because nothing candidate-facing reads this column.
 */
create or replace function public.bank_answer_key(p_question_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when b.qtype = 'mcq'
      then jsonb_build_object('format', 'choice_single', 'correct', lower(b.correct_option))
    else jsonb_strip_nulls(jsonb_build_object('format', 'text_short', 'model', en.answer_text))
  end
  from public.bank_questions b
  join public.bank_question_texts en
    on en.question_id = b.id and en.locale = 'en'
  where b.id = p_question_id;
$$;

comment on function public.bank_answer_key(uuid) is
  'The answer key for a bank question, in grade_answer''s contract. Stored on attempt_questions.answer_key at start_attempt so a later edit to the bank cannot change how an already-sat paper is marked.';

-- ═════════════════════════════════════════════════════════════════════════════
-- start_attempt — one new branch
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.start_attempt(p_exam_id uuid)
returns table(attempt_id uuid, expires_at timestamptz, question_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam    record;
  v_uid     uuid := auth.uid();
  v_taken   int;
  v_open    uuid;
  v_attempt uuid;
  v_expires timestamptz;
  v_count   int;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.has_perm('attempts.take') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_exam from public.exams e
   where e.id = p_exam_id and e.deleted_at is null;

  -- Assignment is the gate, and it is checked here rather than trusted from the
  -- caller: this function runs as owner, so RLS will not do it for us.
  if v_exam is null or not public.is_exam_assigned_to_me(p_exam_id) then
    raise exception 'exam not found' using errcode = '42501';
  end if;
  if v_exam.status not in ('scheduled', 'active') then
    raise exception 'this exam is not open' using errcode = '22023';
  end if;
  if v_exam.opens_at is not null and now() < v_exam.opens_at then
    raise exception 'this exam has not opened yet' using errcode = '22023';
  end if;
  if v_exam.closes_at is not null and now() >= v_exam.closes_at then
    raise exception 'this exam has closed' using errcode = '22023';
  end if;

  -- Resume rather than start again. Returning the existing attempt makes a
  -- reload idempotent; creating a second one would split the answers and the
  -- partial unique index would refuse it anyway.
  select a.id into v_open
    from public.attempts a
   where a.exam_id = p_exam_id and a.candidate_id = v_uid and a.status = 'in_progress';

  if v_open is not null then
    return query
      select a.id, a.expires_at,
             (select count(*)::int from public.attempt_questions aq where aq.attempt_id = a.id)
        from public.attempts a where a.id = v_open;
    return;
  end if;

  select count(*)::int into v_taken
    from public.attempts a
   where a.exam_id = p_exam_id and a.candidate_id = v_uid and a.status <> 'voided';

  if v_taken >= v_exam.max_attempts then
    raise exception 'no attempts remaining' using errcode = '22023';
  end if;

  -- The earlier of the personal deadline and the exam window. An attempt that
  -- outlived its exam would keep accepting answers after everyone else stopped.
  v_expires := least(
    now() + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.closes_at, 'infinity'::timestamptz)
  );

  insert into public.attempts (
    exam_id, candidate_id, company_id, attempt_number,
    expires_at, requires_manual_grading
  )
  values (
    p_exam_id, v_uid, v_exam.company_id, v_taken + 1,
    v_expires, v_exam.requires_manual_grading
  )
  returning id into v_attempt;

  -- ── Freeze this candidate's paper ────────────────────────────────────────
  if v_exam.paper_id is not null then
    /*
     * A GENERATED PAPER. Every candidate gets the same questions in the same
     * printed order, because some of them may be sitting the paper copy of
     * this exact paper in the same room. section_id stays null — a generated
     * paper's sections are a property of the paper, not rows in exam_sections
     * — and one mark per question is the product rule the generator enforces.
     *
     * The key is copied onto the row NOW. Editing the bank tomorrow must not
     * change how today's attempt is marked.
     */
    insert into public.attempt_questions (
      attempt_id, section_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks,
      source, answer_key
    )
    select v_attempt, null, pq.question_id, 1,
           public.bank_question_snapshot(pq.question_id), 1,
           pq.question_no, 1, 0,
           'bank', public.bank_answer_key(pq.question_id)
      from public.exam_paper_questions pq
     where pq.paper_id = v_exam.paper_id;

  elsif v_exam.paper_mode = 'fixed' then
    -- Copy the exam's frozen rows verbatim. Re-drawing would hand two
    -- candidates different papers for an exam whose whole point is that they
    -- sit the same one.
    insert into public.attempt_questions (
      attempt_id, section_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks, fallback_reason
    )
    select v_attempt, eq.section_id, eq.question_id, eq.question_revision,
           eq.snapshot, eq.content_version, eq.position, eq.marks,
           eq.negative_marks, eq.fallback_reason
      from public.exam_questions eq
     where eq.exam_id = p_exam_id;
  else
    -- Seeded on the ATTEMPT id, so this candidate's draw is their own and is
    -- reproducible if anybody ever needs to explain it.
    insert into public.attempt_questions (
      attempt_id, section_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks, fallback_reason
    )
    select v_attempt, d.section_id, d.question_id, d.question_revision,
           public.question_snapshot(d.question_id), q.content_version,
           d.position, d.marks, d.negative_marks, d.fallback_reason
      from public.draw_paper(p_exam_id, v_attempt::text) d
      join public.questions q on q.id = d.question_id;
  end if;

  select count(*)::int into v_count
    from public.attempt_questions aq where aq.attempt_id = v_attempt;

  if v_count = 0 then
    raise exception 'this exam has no questions' using errcode = '22023';
  end if;

  update public.attempts a
     set max_score = (select sum(aq.marks) from public.attempt_questions aq
                       where aq.attempt_id = v_attempt)
   where a.id = v_attempt;

  return query select v_attempt, v_expires, v_count;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- grade_and_close_attempt — where the key comes from
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * The ONLY change from 0022's version is the key expression, and it is a CASE
 * rather than a coalesce() on purpose: answer_key_at_revision() RAISES when a
 * question has no captured revision, and a bank question never will have one.
 * coalesce() would be relying on argument-evaluation order to avoid an
 * exception, which is far too subtle a thing to leave load-bearing.
 */
create or replace function public.grade_and_close_attempt(p_attempt_id uuid, p_reason public.submit_reason)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt record;
  v_row     record;
  v_grade   record;
  v_score   numeric;
  v_review  boolean;
  v_manual  boolean;
  v_next    public.attempt_status;
begin
  select a.*, e.pass_mark_percent, e.verification_mode
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
       and (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
  ) into v_manual;

  v_next := case
              when v_attempt.requires_manual_grading or v_manual or coalesce(v_review, false)
                then 'evaluating'
              when v_attempt.verification_mode = 'auto'
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
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Closing the gap 0062 opened in the immutability allowlist
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ paper_id JOINS THE FROZEN LIST, AND THIS IS THE FLAW ITS OWN COMMENT      │
 * │ WARNED ABOUT.                                                             │
 * │                                                                           │
 * │ The tuple below names the columns a published exam may not change.        │
 * │ Anything NOT named is implicitly mutable — so 0062's new paper_id column  │
 * │ arrived unprotected, and a Chef holding exams.update could have repointed │
 * │ a running exam at a different paper. Every attempt started afterwards     │
 * │ would freeze different questions from the ones already sat.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create or replace function public.enforce_exam_immutability()
returns trigger
language plpgsql
as $$
begin
  if not public.exam_status_transition_allowed(old.status, new.status) then
    raise exception 'cannot move an exam from % to %', old.status, new.status
      using errcode = '23514';
  end if;

  -- Drafts are freely editable. Everything below applies only afterwards.
  if old.status = 'draft' then
    return new;
  end if;

  if (new.title,            new.description,      new.instructions,
      new.kind,             new.paper_mode,       new.brand_id,
      new.duration_minutes, new.opens_at,         new.timezone,
      new.max_attempts,     new.pass_mark_percent,
      new.shuffle_questions, new.shuffle_options, new.allow_backtrack,
      new.negative_marking_enabled, new.verification_mode,
      new.counts_towards_analytics, new.total_marks, new.question_count,
      new.requires_manual_grading, new.company_id, new.created_by,
      new.paper_id)
     is distinct from
     (old.title,            old.description,      old.instructions,
      old.kind,             old.paper_mode,       old.brand_id,
      old.duration_minutes, old.opens_at,         old.timezone,
      old.max_attempts,     old.pass_mark_percent,
      old.shuffle_questions, old.shuffle_options, old.allow_backtrack,
      old.negative_marking_enabled, old.verification_mode,
      old.counts_towards_analytics, old.total_marks, old.question_count,
      old.requires_manual_grading, old.company_id, old.created_by,
      old.paper_id)
  then
    raise exception
      'this exam is published; only its closing time, status and assignments can change. Duplicate it to make other edits.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Publishing
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS CREATES A 'scheduled' EXAM DIRECTLY, WHICH setExamStatus IS          ║
 * ║ DELIBERATELY FORBIDDEN FROM DOING. THE DIFFERENCE MATTERS.                ║
 * ║                                                                           ║
 * ║ src/server/actions/exams.ts refuses 'scheduled' because publish_exam() is ║
 * ║ the only route that runs exam_health() — and skipping it once put an exam ║
 * ║ live with no rules and no validation.                                     ║
 * ║                                                                           ║
 * ║ exam_health() cannot run here, and does not need to. It validates a       ║
 * ║ RULE-DRAWN paper: enough questions in each pool, a captured answer key    ║
 * ║ per revision, translations present, marks adding up. A generated paper    ║
 * ║ has no rules to check, and save_exam_paper() already refused to store it  ║
 * ║ unless it held exactly mcq_n + short_n active bank questions, each with   ║
 * ║ its texts. The checks are done; they were done at generation.             ║
 * ║                                                                           ║
 * ║ What this route does NOT skip is authorisation: exams.publish is required ║
 * ║ here exactly as publish_exam() requires it.                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
create or replace function public.publish_paper_as_exam(
  p_paper_id          uuid,
  p_title             text,
  p_duration_minutes  int,
  p_opens_at          timestamptz,
  p_closes_at         timestamptz,
  p_max_attempts      int,
  p_pass_mark_percent int,
  p_instructions      text default null
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

  -- The same visibility rule exam_papers_read applies, restated because this
  -- function bypasses RLS. A caller who cannot see the paper is told it was not
  -- found rather than refused, so this cannot enumerate paper ids.
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

  if p_closes_at is not null and p_opens_at is not null and p_closes_at <= p_opens_at then
    raise exception 'The closing time must be after the opening time.'
      using errcode = 'check_violation';
  end if;

  insert into public.exams (
    company_id, brand_id, title, instructions,
    kind, status, paper_mode, paper_id,
    duration_minutes, opens_at, closes_at,
    max_attempts, pass_mark_percent,
    -- BOTH SHUFFLES OFF. Some of these candidates may be sitting the printed
    -- copy of this same paper in the same room, and question 7 has to be
    -- question 7 on every desk.
    shuffle_questions, shuffle_options,
    total_marks, question_count,
    -- The blueprint always carries short answers, so a human always finishes
    -- the marking. Said from the paper rather than assumed.
    requires_manual_grading,
    -- 'single': one evaluator signs the paper off and releases it. 'dual' adds
    -- a separate verifier, which a kitchen team of this size does not have.
    verification_mode,
    created_by, published_by, published_at
  )
  values (
    v_paper.company_id, v_paper.brand_id, p_title, p_instructions,
    'official', 'scheduled', 'fixed', p_paper_id,
    p_duration_minutes, p_opens_at, p_closes_at,
    p_max_attempts, p_pass_mark_percent,
    false, false,
    v_paper.marks, v_paper.mcq_n + v_paper.short_n,
    v_paper.short_n > 0,
    'single',
    auth.uid(), auth.uid(), now()
  )
  returning id into v_exam;

  -- A paper being sat is a paper in use. 0062 widened `live` to cover exactly
  -- this; a paper already live simply stays live.
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

revoke execute on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text) from public, anon;
grant  execute on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text) to authenticated;

revoke execute on function public.bank_question_snapshot(uuid) from public, anon;
revoke execute on function public.bank_answer_key(uuid) from public, anon;

comment on function public.publish_paper_as_exam(uuid, text, int, timestamptz, timestamptz, int, int, text) is
  'Publishes a generated paper as a scheduled online exam. Creates the exams row only — the audience is set afterwards through the existing exam_assignments path, and until it is set the exam is invisible to everyone, which is the safe default.';
