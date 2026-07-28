-- ═════════════════════════════════════════════════════════════════════════════
-- 0027 — Answering, submitting, and the auto-grader
--
-- 0022 OBLIGATION, DISCHARGED. Grading obtains every key through
-- answer_key_at_revision(question_id, revision) and never reads
-- question_answer_keys. An attempt is marked against the wording it was served.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THE GRADER IS SQL AND NOT THE TYPESCRIPT ENGINE M2 BUILT.             │
-- │                                                                           │
-- │ answer_key_at_revision() is granted to nobody (0022), reachable only from │
-- │ inside another SECURITY DEFINER function. For a TypeScript grader to see  │
-- │ a key, the application would need a service-role client — the first       │
-- │ RLS-bypassing connection in this codebase, introduced for precisely the   │
-- │ operation where key exposure is most costly. That trade is not worth the  │
-- │ convenience of grading in the language the rest of the app is written in. │
-- │                                                                           │
-- │ So the key never leaves the database, and this file is the ONE grader.    │
-- │ src/lib/questions/grading.ts is deleted in the same commit rather than    │
-- │ left in place: two graders that must agree, with nothing forcing them to, │
-- │ is how a scoring rule changes in one and not the other and nobody notices │
-- │ until a candidate disputes a mark.                                        │
-- │                                                                           │
-- │ The semantics ported from it are unchanged and were argued for in the M2  │
-- │ CHANGELOG entry. They are restated at each branch below so the reasoning  │
-- │ survives where the code now lives.                                        │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ONE BEHAVIOURAL CHANGE, STATED RATHER THAN DISCOVERED LATER: regex blanks are
-- now evaluated by Postgres ARE instead of the JavaScript engine. Both support
-- the anchored non-capturing form this uses, and both are case-insensitive
-- here, but they are not the same dialect. Authors writing exotic patterns
-- (lookbehind, \p{...} classes) will see a difference. Anchoring, alternation,
-- character classes and quantifiers — which is what blank keys actually use —
-- behave identically.
-- ═════════════════════════════════════════════════════════════════════════════

-- The per-part breakdown the grader produces. 0025 shipped score, needs_review
-- and grader_note but nowhere to put the detail that makes a score explicable —
-- "you scored 2/5" versus "these three blanks were wrong" is the difference
-- between a mark and a learning moment.
alter table public.attempt_answers
  add column if not exists grade_detail jsonb;

comment on column public.attempt_answers.grade_detail is
  'Per-part grading breakdown from grade_answer(). Contains no answer key: it reports what the candidate submitted and whether each part was correct, never what the correct value was. M5 decides when it is shown to the candidate.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Text comparison primitives
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * Levenshtein distance, hand-rolled rather than taken from fuzzystrmatch.
 *
 * The extension is available on both Supabase and the postgres:17 image CI
 * runs, but it installs into a different schema on each, so the qualified name
 * that works in production would not resolve in CI. This codebase has already
 * been bitten once by CI not matching production — the blanket function grant
 * that masked an anon-reachable draw_paper() for an entire milestone — and a
 * twenty-line pure function is cheaper than that class of bug recurring.
 *
 * Called only for fuzzy blanks, on answers a person typed into a text box, so
 * the O(n·m) cost is irrelevant here.
 */
create or replace function public.grade_edit_distance(a text, b text)
returns int
language plpgsql
immutable
strict
as $$
declare
  la int := length(a);
  lb int := length(b);
  prev int[];
  curr int[];
  i int;
  j int;
  cost int;
begin
  if a = b then return 0; end if;
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;

  -- prev[k] holds the distance for the first (k-1) characters of b, so the
  -- array is one longer than the string it indexes.
  prev := array(select generate_series(0, lb));

  for i in 1..la loop
    curr := array_fill(0, array[lb + 1]);
    curr[1] := i;
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      curr[j + 1] := least(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    end loop;
    prev := curr;
  end loop;

  return prev[lb + 1];
end;
$$;

/*
 * Normalisation applied before every non-exact comparison.
 *
 * NFKC first: Devanagari and Gujarati have multiple valid encodings for the
 * same visible character, so the same word typed on a different keyboard would
 * otherwise compare unequal. Then case-fold, collapse internal whitespace, and
 * trim — trailing-space answers are the most common false negative in any
 * fill-in-the-blank system.
 */
create or replace function public.grade_normalise(v text)
returns text
language sql
immutable
strict
as $$
  select trim(regexp_replace(lower(normalize(v, nfkc)), '\s+', ' ', 'g'))
$$;

/*
 * Matches one blank against its accepted values.
 *
 * Returns correct AND review separately: a fuzzy near-miss is credited but
 * flagged, because across four languages a near-match is far more often a
 * spelling variant than a wrong answer, and silently failing it would be both
 * unfair and invisible.
 */
create or replace function public.grade_match_blank(
  p_submitted text,
  p_accept    jsonb,
  p_mode      text,
  p_tolerance int,
  out correct boolean,
  out review  boolean
)
language plpgsql
immutable
as $$
declare
  v_raw    text := coalesce(p_submitted, '');
  v_norm   text;
  v_target text;
  v_limit  int := coalesce(p_tolerance, 1);
  v_item   jsonb;
begin
  correct := false;
  review  := false;

  if btrim(v_raw) = '' then
    return;
  end if;

  if p_mode = 'exact' then
    -- jsonb ? tests membership of a string in a top-level array.
    correct := p_accept ? v_raw;
    return;
  end if;

  if p_mode = 'ci' then
    v_norm := public.grade_normalise(v_raw);
    for v_item in select * from jsonb_array_elements(p_accept) loop
      if public.grade_normalise(v_item #>> '{}') = v_norm then
        correct := true;
        return;
      end if;
    end loop;
    return;
  end if;

  if p_mode = 'regex' then
    for v_item in select * from jsonb_array_elements(p_accept) loop
      begin
        -- Anchored. An unanchored /74/ would accept "not 74", which is the
        -- opposite of the intended answer.
        if btrim(v_raw) ~* ('^(?:' || (v_item #>> '{}') || ')$') then
          correct := true;
          return;
        end if;
      exception when others then
        -- An invalid pattern is an authoring fault. The candidate must not be
        -- marked wrong for it, so it goes to a human instead.
        correct := false;
        review  := true;
        return;
      end;
    end loop;
    return;
  end if;

  if p_mode = 'fuzzy' then
    v_norm := public.grade_normalise(v_raw);
    for v_item in select * from jsonb_array_elements(p_accept) loop
      v_target := public.grade_normalise(v_item #>> '{}');

      if v_target = v_norm then
        correct := true;
        return;
      end if;

      -- Short words are excluded: distance 1 from "rib" reaches "rub" and
      -- "ribs", which are different answers. Fuzziness is only allowed where a
      -- typo is the likelier explanation than a wrong answer.
      if length(v_target) >= 4
         and public.grade_edit_distance(v_norm, v_target) <= v_limit then
        correct := true;
        review  := true;
        return;
      end if;
    end loop;
    return;
  end if;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- grade_answer — the dispatcher
--
-- Contract, unchanged from the engine it replaces:
--   · An unanswered question scores 0 and NEVER incurs negative marks.
--     Penalising a skip makes guessing strictly better than admitting
--     ignorance, which inverts what the assessment measures.
--   · Manual formats return 'not_applicable' — a human decides.
--   · A mismatch between question, key and answer returns 'needs_review'
--     rather than 0: that is an authoring or data fault and must not be
--     charged to the candidate.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.grade_answer(
  p_content  jsonb,
  p_key      jsonb,
  p_answer   jsonb,
  p_max      numeric,
  p_negative numeric default 0,
  out score        numeric,
  out status       public.auto_grade_status,
  out needs_review boolean,
  out detail       jsonb
)
language plpgsql
immutable
as $$
declare
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

  -- Manual formats. Kept as a literal list rather than a lookup so that adding
  -- a format without deciding how it grades fails here, loudly.
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

  -- ── Single choice ──────────────────────────────────────────────────────────
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

  -- ── Multiple choice ────────────────────────────────────────────────────────
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

    -- Proportional, penalising wrong selections at the same weight as right
    -- ones. Without the penalty, ticking every box scores full marks and the
    -- question measures nothing.
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

  -- ── True / false ───────────────────────────────────────────────────────────
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

  -- ── Fill in the blanks ─────────────────────────────────────────────────────
  elsif v_format = 'blanks' then
    v_any       := false;
    v_correct_n := 0;
    v_total     := 0;

    for v_item in select * from jsonb_array_elements(p_key -> 'blanks') loop
      v_total     := v_total + 1;
      v_submitted := coalesce(p_answer -> 'values' ->> (v_item ->> 'id'), '');

      select * into v_mb from public.grade_match_blank(
        v_submitted,
        v_item -> 'accept',
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

  -- ── Match the following ────────────────────────────────────────────────────
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

  -- ── Sequence / ordering ────────────────────────────────────────────────────
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
      -- Credit per correctly-ordered adjacent pair. Right for procedures:
      -- getting the first steps of a recipe in order is worth something even if
      -- two later steps are swapped.
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

    -- Kendall tau: the proportion of item pairs in the correct relative order.
    -- Rewards broadly-right sequences that exact matching scores zero.
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

  -- Unreachable: manual formats returned above and every gradable format has a
  -- branch. Present so that adding a format without a grader fails loudly
  -- rather than silently scoring zero.
  status       := 'needs_review';
  needs_review := true;
  detail := jsonb_build_object('reason', 'no grader for this format');
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- save_answer — the only writer of attempt_answers
--
-- 0026 gave attempt_answers no insert or update policy for anybody, which is
-- what makes this the only route. A row-level policy cannot express "and the
-- clock has not run out" without re-reading the parent on every write, so a
-- candidate who could UPDATE directly would simply keep answering.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.save_answer(
  p_attempt_id  uuid,
  p_question_id uuid,
  p_answer      jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt record;
  v_aq      record;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.id, a.candidate_id, a.status, a.expires_at
    into v_attempt
    from public.attempts a where a.id = p_attempt_id;

  -- Not "does it exist" but "is it yours", and the two are deliberately
  -- indistinguishable to the caller.
  if v_attempt.candidate_id is null or v_attempt.candidate_id <> v_uid then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'this attempt has already been submitted' using errcode = '22023';
  end if;

  -- THE SERVER'S CLOCK, not the browser's. Checked on every write rather than
  -- once at submit: without this, a tab left open past the deadline keeps
  -- saving answers and only the final submit would notice.
  if now() >= v_attempt.expires_at then
    raise exception 'time is up for this attempt' using errcode = '22023';
  end if;

  -- The question must be on THIS candidate's paper. Otherwise a candidate could
  -- answer a question they were never served — harmless for scoring, since
  -- grading iterates the paper, but it would corrupt the per-question analytics
  -- M7 builds on.
  select aq.question_id, aq.question_revision, aq.snapshot
    into v_aq
    from public.attempt_questions aq
   where aq.attempt_id = p_attempt_id and aq.question_id = p_question_id;

  if v_aq.question_id is null then
    raise exception 'question not in this paper' using errcode = '42501';
  end if;

  if (p_answer ->> 'format') is distinct from (v_aq.snapshot ->> 'response_format') then
    raise exception 'answer format does not match the question' using errcode = '22023';
  end if;

  insert into public.attempt_answers (
    attempt_id, question_id, question_revision, answer, auto_grade_status
  )
  values (
    p_attempt_id, p_question_id, v_aq.question_revision, p_answer, 'pending'
  )
  on conflict (attempt_id, question_id) do update
    set answer = excluded.answer,
        -- The revision is NOT refreshed: it records the wording this candidate
        -- was served, which cannot change mid-attempt.
        auto_grade_status = 'pending',
        updated_at = now();

  -- Returned so the client can resynchronise its countdown against the server
  -- on every save, rather than trusting the clock it started with.
  return v_attempt.expires_at;
end;
$$;

grant execute on function public.save_answer(uuid, uuid, jsonb) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- grade_and_close_attempt — grading and closing, with no authorisation check
--
-- INTERNAL, granted to nobody. Two callers need identical behaviour and
-- different authorisation: submit_attempt() checks the attempt is the caller's,
-- expire_attempts() runs with no caller at all. Putting the shared work here is
-- the same reasoning that made draw_paper() one selector with two writers — the
-- alternative is two closing paths that drift until a swept attempt is scored
-- differently from a submitted one.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.grade_and_close_attempt(
  p_attempt_id uuid,
  p_reason     public.submit_reason
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt record;
  v_pass_mark numeric;
  v_row     record;
  v_grade   record;
  v_score   numeric;
  v_review  boolean;
begin
  select a.*, e.pass_mark_percent
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

  -- ── Grade every answer on record ─────────────────────────────────────────
  -- Iterating attempt_answers, not attempt_questions: an unanswered question
  -- has no row, contributes nothing, and incurs no penalty. That is the skip
  -- rule, expressed by the absence of a row rather than by a special case.
  for v_row in
    select aa.question_id, aa.question_revision, aa.answer,
           aq.snapshot, aq.marks, aq.negative_marks
      from public.attempt_answers aa
      join public.attempt_questions aq
        on aq.attempt_id = aa.attempt_id and aq.question_id = aa.question_id
     where aa.attempt_id = p_attempt_id
  loop
    select * into v_grade from public.grade_answer(
      v_row.snapshot -> 'content',
      -- 0022: the key as it was at the revision this candidate was served,
      -- never the live one in question_answer_keys.
      public.answer_key_at_revision(v_row.question_id, v_row.question_revision),
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

  -- A negatively-marked paper can total below zero. Floored here rather than
  -- per question, so that one wrong answer cannot cancel a correct one it has
  -- nothing to do with, while the paper as a whole never reports a negative.
  select greatest(coalesce(sum(aa.score), 0), 0),
         bool_or(aa.needs_review)
    into v_score, v_review
    from public.attempt_answers aa
   where aa.attempt_id = p_attempt_id;

  v_pass_mark := v_attempt.pass_mark_percent;

  update public.attempts a
     set submitted_at   = now(),
         submit_reason  = p_reason,
         score          = v_score,
         auto_graded_at = now(),
         -- A paper carrying essays, or one where the grader flagged a fuzzy
         -- near-miss, is not finished. Only a fully machine-graded paper gets
         -- a verdict here; everything else waits for M5's evaluation queue.
         -- Cast each branch: a CASE over bare literals is typed text, which
         -- will not assign to an attempt_status column.
         status = case
                    when v_attempt.requires_manual_grading or coalesce(v_review, false)
                      then 'evaluating'::public.attempt_status
                    else 'auto_graded'::public.attempt_status
                  end,
         passed = case
                    when v_attempt.requires_manual_grading or coalesce(v_review, false)
                      then null
                    when coalesce(a.max_score, 0) = 0 then false
                    else (v_score / a.max_score) * 100 >= v_pass_mark
                  end
   where a.id = p_attempt_id;
end;
$$;

revoke all on function public.grade_and_close_attempt(uuid, public.submit_reason)
  from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- submit_attempt — the candidate's route
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.submit_attempt(
  p_attempt_id uuid,
  p_reason     public.submit_reason default 'user'
)
returns table (status public.attempt_status, score numeric, max_score numeric, passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.candidate_id into v_owner
    from public.attempts a where a.id = p_attempt_id;

  if v_owner is null or v_owner <> v_uid then
    raise exception 'attempt not found' using errcode = '42501';
  end if;

  -- A candidate may declare that they finished, that their timer ran out, or
  -- that they switched tabs. They may not declare that a sweeper or an
  -- administrator closed their attempt — those are the server's to claim, and
  -- accepting them here would let a candidate forge the audit trail.
  if p_reason not in ('user', 'timer', 'tab_switch') then
    raise exception 'invalid submit reason' using errcode = '22023';
  end if;

  perform public.grade_and_close_attempt(p_attempt_id, p_reason);

  return query
    select a.status, a.score, a.max_score, a.passed
      from public.attempts a where a.id = p_attempt_id;
end;
$$;

grant execute on function public.submit_attempt(uuid, public.submit_reason) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- expire_attempts — the sweeper
--
-- An abandoned attempt would otherwise sit in_progress forever, holding the
-- partial unique index that stops the candidate starting another one and never
-- appearing in anyone's results. 0025 created attempts_expiry_idx for exactly
-- this query.
--
-- INTERNAL, granted to nobody: scheduled from pg_cron, which runs as the
-- database owner. Nothing a client can reach.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.expire_attempts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  for v_id in
    select a.id from public.attempts a
     where a.status = 'in_progress' and a.expires_at <= now()
     order by a.expires_at
  loop
    -- Each attempt closed independently: one that fails to grade must not
    -- prevent every other expired attempt from closing.
    begin
      perform public.grade_and_close_attempt(v_id, 'sweeper');
      v_n := v_n + 1;
    exception when others then
      raise warning 'sweeper could not close attempt %: %', v_id, sqlerrm;
    end;
  end loop;

  return v_n;
end;
$$;

revoke all on function public.expire_attempts() from public, anon, authenticated;

-- ── Internal grading primitives: reachable only from the functions above ─────
revoke all on function public.grade_edit_distance(text, text) from public, anon, authenticated;
revoke all on function public.grade_normalise(text) from public, anon, authenticated;
revoke all on function public.grade_match_blank(text, jsonb, text, int) from public, anon, authenticated;
revoke all on function public.grade_answer(jsonb, jsonb, jsonb, numeric, numeric) from public, anon, authenticated;

comment on function public.grade_answer(jsonb, jsonb, jsonb, numeric, numeric) is
  'THE auto-grader. The only implementation — src/lib/questions/grading.ts was deleted when this landed, because two graders with nothing forcing them to agree is how a scoring rule changes in one and not the other. Takes the key as an argument; grade_and_close_attempt() is what obtains it, through answer_key_at_revision().';

comment on function public.save_answer(uuid, uuid, jsonb) is
  'The only writer of attempt_answers. Enforces the server clock on every write, not just at submit. attempt_answers has no insert or update policy for anybody (0026), which is what makes this the only route.';

comment on function public.submit_attempt(uuid, public.submit_reason) is
  'Closes and grades an attempt on the candidate''s behalf. Accepts only the reasons a candidate can honestly claim — user, timer, tab_switch — because sweeper and admin are the server''s to assert.';
