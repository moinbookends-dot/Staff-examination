-- ═══════════════════════════════════════════════════════════════════════════
-- 0088 — Short answers grade themselves; humans handle exceptions, not queues.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE PROBLEM, MEASURED ON THIS DATABASE: every generated paper is 80% MCQ  ║
-- ║ and 20% short answer, grade_answer refused to touch text_short, and       ║
-- ║ grade_and_close therefore routed EVERY submitted attempt to 'evaluating'. ║
-- ║ A fully-correct paper sat in a queue until an admin hand-marked answers   ║
-- ║ like "7" against a model answer of "7". The one attempt published so far  ║
-- ║ needed a manual evaluation pass to release a 3/20.                        ║
-- ║                                                                           ║
-- ║ The machinery already existed: grade_normalise, grade_edit_distance and   ║
-- ║ grade_match_blank were built in 0027 for fill-in-the-blank, and           ║
-- ║ bank_answer_key() emits {format, model} — the same shape of key. This     ║
-- ║ migration points the existing matcher at it.                              ║
-- ║                                                                           ║
-- ║ THE FIRST FUNCTION BELOW IS THE LIVE DEFINITION CAPTURED VERBATIM VIA     ║
-- ║ pg_get_functiondef, WITH EXACTLY ONE BRANCH INSERTED — the text_short     ║
-- ║ block ahead of the manual-format bailout, plus its three declares. Every  ║
-- ║ other format's behaviour is byte-identical, deliberately: grading rules   ║
-- ║ must never change as a side effect of an unrelated edit.                  ║
-- ║                                                                           ║
-- ║ WHAT STILL REACHES A HUMAN, via the existing evaluation queue:            ║
-- ║   · fuzzy near-miss — accepted and scored, flagged needs_review           ║
-- ║   · format mismatch — a data fault, never charged to the candidate        ║
-- ║   · text_long / evaluator_only — essays remain human work                 ║
-- ║   · a text_short key with no model — nothing to match against             ║
-- ║                                                                           ║
-- ║ AND THE TRADE, STATED PLAINLY: a WRONG short answer now scores zero and   ║
-- ║ publishes ("seven" against a model of "7" is wrong to this matcher).      ║
-- ║ Automatic first, admin corrects after — the requester's explicit choice.  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.grade_answer(p_content jsonb, p_key jsonb, p_answer jsonb, p_max numeric, p_negative numeric DEFAULT 0, OUT score numeric, OUT status auto_grade_status, OUT needs_review boolean, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_ts_accept  jsonb;
  v_ts_correct boolean;
  v_ts_review  boolean;
  v_format  text := p_key ->> 'format';
  v_penalty numeric := case when coalesce(p_negative, 0) > 0 then -p_negative else 0 end;
  v_partial boolean := coalesce((p_key ->> 'partialCredit')::boolean, false);

  v_correct     boolean;
  v_hits        int;
  v_misses      int;
  v_all_correct boolean;
  v_correct_n   int;
  v_total       int;
  v_ratio       numeric;
  v_avail       int;
  v_item        jsonb;
  v_outcomes    jsonb := '[]'::jsonb;
  v_any         boolean;
  v_review      boolean := false;
  v_mb          record;
  v_submitted   text;
  v_expected    jsonb;
  v_order       jsonb;
  v_exact       boolean;
  v_pairs       int;
  v_x           int;
  v_y           int;
  i             int;
  j             int;
begin
  score        := 0;
  needs_review := false;

  /*
   * ── text_short: 0088 ─────────────────────────────────────────────────────
   * Handled BEFORE the manual bailout. bank_answer_key() emits
   * {format:'text_short', model:text}; an optional 'accept' array of extra
   * correct spellings is honoured. Matching is grade_match_blank's 'fuzzy'
   * contract — the matcher fill-in-the-blank has always used — so a
   * near-miss (edit distance 1, word of 4+) is accepted but flagged
   * needs_review and grade_and_close routes it to a human. A key with
   * neither model nor accept falls through to not_applicable: inventing a
   * zero would charge the candidate for an authoring gap.
   */
  if v_format = 'text_short' and (p_key ? 'model' or p_key ? 'accept') then
    if p_answer is null or jsonb_typeof(p_answer) = 'null'
       or btrim(coalesce(p_answer ->> 'text', '')) = '' then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_ts_accept := coalesce(p_key -> 'accept', '[]'::jsonb);
    if p_key ? 'model' then
      v_ts_accept := v_ts_accept || jsonb_build_array(p_key ->> 'model');
    end if;

    select mb.correct, mb.review
      into v_ts_correct, v_ts_review
      from public.grade_match_blank(p_answer ->> 'text', v_ts_accept, 'fuzzy', 1) mb;

    score        := case when v_ts_correct then p_max else 0 end;
    status       := 'graded';
    needs_review := coalesce(v_ts_review, false);
    -- The model answer is deliberately NOT in the detail: grade_detail lives
    -- on a candidate-owned row, and a key must never travel on one.
    detail := jsonb_build_object(
      'correct',  v_ts_correct,
      'fuzzy',    coalesce(v_ts_review, false),
      'answered', true
    );
    return;
  end if;

  if v_format in ('text_short', 'text_long', 'evaluator_only') then
    status := 'not_applicable';
    return;
  end if;

  if p_answer is null or jsonb_typeof(p_answer) = 'null' then
    status := 'graded';
    detail := jsonb_build_object('answered', false);
    return;
  end if;

  if (p_answer ->> 'format') is distinct from v_format
     or (p_content ->> 'format') is distinct from v_format then
    status       := 'needs_review';
    needs_review := true;
    detail := jsonb_build_object('reason', 'format mismatch between question, key and answer');
    return;
  end if;

  if v_format = 'choice_single' then
    if (p_answer ->> 'choice') is null then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_correct := (p_answer ->> 'choice') = (p_key ->> 'correct');
    score  := case when v_correct then p_max else v_penalty end;
    status := 'graded';
    detail := jsonb_build_object('correct', v_correct, 'selected', p_answer ->> 'choice');
    return;

  elsif v_format = 'choice_multi' then
    if jsonb_array_length(coalesce(p_answer -> 'choices', '[]'::jsonb)) = 0 then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    select count(*) filter (where p_key -> 'correct' ? (c #>> '{}')),
           count(*) filter (where not (p_key -> 'correct' ? (c #>> '{}')))
      into v_hits, v_misses
      from jsonb_array_elements(p_answer -> 'choices') c;

    v_total       := jsonb_array_length(p_key -> 'correct');
    v_all_correct := v_hits = v_total and v_misses = 0;

    if not v_partial then
      score  := case when v_all_correct then p_max else v_penalty end;
      status := 'graded';
      detail := jsonb_build_object('correct', v_all_correct, 'hits', v_hits, 'misses', v_misses);
      return;
    end if;

    v_avail := jsonb_array_length(p_content -> 'choices') - v_total;
    v_ratio := greatest(
      0,
      (v_hits::numeric / nullif(v_total, 0))
        - case when v_avail > 0 then v_misses::numeric / v_avail else 0 end
    );

    score  := round(v_ratio * p_max, 2);
    status := 'graded';
    detail := jsonb_build_object('hits', v_hits, 'misses', v_misses,
                                 'ratio', round(v_ratio, 2), 'correct', v_all_correct);
    return;

  elsif v_format = 'boolean' then
    if (p_answer ->> 'value') is null then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_correct := (p_answer ->> 'value')::boolean = (p_key ->> 'correct')::boolean;
    score  := case when v_correct then p_max else v_penalty end;
    status := 'graded';
    detail := jsonb_build_object('correct', v_correct);
    return;

  elsif v_format = 'blanks' then
    v_any       := false;
    v_correct_n := 0;
    v_total     := 0;

    for v_item in select * from jsonb_array_elements(p_key -> 'blanks') loop
      v_total     := v_total + 1;
      v_submitted := coalesce(p_answer -> 'values' ->> (v_item ->> 'id'), '');

      select * into v_mb from public.grade_match_blank(
        v_submitted,
        -- 0034: the base list plus every language's, so a candidate who
        -- answers in the language the question was asked in — or in the
        -- language the kitchen actually uses — is marked correct.
        public.blank_accept_list(v_item),
        v_item ->> 'match',
        (v_item ->> 'tolerance')::int
      );

      if btrim(v_submitted) <> '' then v_any := true; end if;
      if v_mb.correct then v_correct_n := v_correct_n + 1; end if;
      if v_mb.review  then v_review := true; end if;

      v_outcomes := v_outcomes || jsonb_build_object(
        'id', v_item ->> 'id', 'submitted', v_submitted,
        'correct', v_mb.correct, 'review', v_mb.review
      );
    end loop;

    if not v_any then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_all_correct := v_correct_n = v_total;
    score := case
               when v_partial then round((v_correct_n::numeric / nullif(v_total, 0)) * p_max, 2)
               when v_all_correct then p_max
               else v_penalty
             end;
    status       := case when v_review then 'needs_review' else 'graded' end;
    needs_review := v_review;
    detail := jsonb_build_object('blanks', v_outcomes,
                                 'correctCount', v_correct_n, 'total', v_total);
    return;

  elsif v_format = 'pairs' then
    if (select count(*) from jsonb_object_keys(coalesce(p_answer -> 'mapping', '{}'::jsonb))) = 0 then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_correct_n := 0;
    v_total     := 0;

    for v_item in
      select jsonb_build_object('left', k, 'expected', p_key -> 'correct' ->> k)
        from jsonb_object_keys(p_key -> 'correct') k
    loop
      v_total     := v_total + 1;
      v_submitted := p_answer -> 'mapping' ->> (v_item ->> 'left');
      v_correct   := v_submitted is not null and v_submitted = (v_item ->> 'expected');
      if v_correct then v_correct_n := v_correct_n + 1; end if;

      v_outcomes := v_outcomes || (v_item || jsonb_build_object(
        'submitted', to_jsonb(v_submitted), 'correct', v_correct
      ));
    end loop;

    v_all_correct := v_correct_n = v_total;
    score := case
               when v_partial then round((v_correct_n::numeric / nullif(v_total, 0)) * p_max, 2)
               when v_all_correct then p_max
               else v_penalty
             end;
    status := 'graded';
    detail := jsonb_build_object('pairs', v_outcomes,
                                 'correctCount', v_correct_n, 'total', v_total);
    return;

  elsif v_format = 'order' then
    v_order    := coalesce(p_answer -> 'order', '[]'::jsonb);
    v_expected := p_key -> 'correct';

    if jsonb_array_length(v_order) = 0 then
      status := 'graded';
      detail := jsonb_build_object('answered', false);
      return;
    end if;

    v_exact := v_order = v_expected;

    if (p_key ->> 'scoring') = 'exact' then
      score  := case when v_exact then p_max else v_penalty end;
      status := 'graded';
      detail := jsonb_build_object('correct', v_exact, 'scoring', 'exact');
      return;
    end if;

    if (p_key ->> 'scoring') = 'adjacent' then
      v_pairs := jsonb_array_length(v_expected) - 1;
      v_hits  := 0;

      for i in 0 .. jsonb_array_length(v_order) - 2 loop
        select min(idx) into v_x from (
          select ordinality - 1 as idx
            from jsonb_array_elements(v_expected) with ordinality e(val, ordinality)
           where e.val = v_order -> i) s;
        select min(idx) into v_y from (
          select ordinality - 1 as idx
            from jsonb_array_elements(v_expected) with ordinality e(val, ordinality)
           where e.val = v_order -> (i + 1)) s;

        if v_x is not null and v_y is not null and v_y = v_x + 1 then
          v_hits := v_hits + 1;
        end if;
      end loop;

      v_ratio := case when v_pairs > 0 then v_hits::numeric / v_pairs else 0 end;
      score   := round(v_ratio * p_max, 2);
      status  := 'graded';
      detail  := jsonb_build_object('scoring', 'adjacent', 'adjacentCorrect', v_hits,
                                    'adjacentTotal', v_pairs, 'correct', v_exact);
      return;
    end if;

    v_hits  := 0;
    v_total := 0;

    for i in 0 .. jsonb_array_length(v_expected) - 1 loop
      for j in i + 1 .. jsonb_array_length(v_expected) - 1 loop
        select min(idx) into v_x from (
          select ordinality - 1 as idx
            from jsonb_array_elements(v_order) with ordinality e(val, ordinality)
           where e.val = v_expected -> i) s;
        select min(idx) into v_y from (
          select ordinality - 1 as idx
            from jsonb_array_elements(v_order) with ordinality e(val, ordinality)
           where e.val = v_expected -> j) s;

        if v_x is null or v_y is null then continue; end if;
        v_total := v_total + 1;
        if v_x < v_y then v_hits := v_hits + 1; end if;
      end loop;
    end loop;

    v_ratio := case when v_total > 0 then v_hits::numeric / v_total else 0 end;
    score   := round(v_ratio * p_max, 2);
    status  := 'graded';
    detail  := jsonb_build_object('scoring', 'kendall', 'concordant', v_hits,
                                  'total', v_total, 'correct', v_exact);
    return;
  end if;

  status       := 'needs_review';
  needs_review := true;
  detail := jsonb_build_object('reason', 'no grader for this format');
end;
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- Routing — 'evaluating' only when a human is genuinely required.
-- Verbatim live definition with two surgical edits, marked 0088 inline.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.grade_and_close_attempt(p_attempt_id uuid, p_reason submit_reason)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  v_next := case
              when v_manual or coalesce(v_review, false)
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
$function$
;
