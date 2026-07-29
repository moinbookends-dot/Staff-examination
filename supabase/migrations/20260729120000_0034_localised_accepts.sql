-- ═════════════════════════════════════════════════════════════════════════════
-- 0034 — Accepting an answer in the language it was asked in
--
-- 0033 lets a Gujarati speaker READ a fill-in-the-blank in Gujarati. They then
-- type the answer in Gujarati and are marked wrong, because the answer key
-- holds one list of accepted strings and it is in English. This closes that.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE ACCEPTS LIVE IN THE ANSWER KEY, NOT IN THE TRANSLATION.               │
-- │                                                                           │
-- │ question_translations is presentation-only — 0009 said so and 0032 made   │
-- │ it a CHECK. Putting accepted answers there would be exactly the thing     │
-- │ that constraint exists to prevent: a translator deciding what is correct. │
-- │                                                                           │
-- │ So `acceptByLocale` sits inside each blank of the answer key, beside the  │
-- │ `accept` list it extends — nested rather than parallel, because a         │
-- │ parallel structure's failure mode is a key on a blank id that no longer   │
-- │ exists, contributing silently nothing. Nesting makes that unrepresentable.│
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE GRADER TAKES THE UNION OF EVERY LANGUAGE, AND ASKS FOR NONE.          │
-- │                                                                           │
-- │ It could have been scoped: grade a Gujarati candidate against the         │
-- │ Gujarati list only. Three reasons not to, and the third decides it.       │
-- │                                                                           │
-- │ 1. The key the grader reads is FROZEN (answer_key_at_revision). Threading │
-- │    a locale into grading means a candidate who switched language          │
-- │    mid-attempt, or whose profile changed afterwards, is marked against a  │
-- │    different truth than they were served — and a regrade stops being      │
-- │    deterministic.                                                         │
-- │ 2. Nothing records which language an answer was typed in, and adding that │
-- │    is a column on every answer for a question nobody asked.               │
-- │ 3. CANDIDATES CODE-SWITCH CONSTANTLY. A Gujarati-speaking cook types      │
-- │    `74` in Latin digits, or types the English word because that is what   │
-- │    the kitchen calls it. Locale-scoped grading marks that wrong. That     │
-- │    false negative is the failure this migration exists to prevent, and    │
-- │    only the union fixes it.                                               │
-- │                                                                           │
-- │ Union is also monotone: adding a translation can only turn a wrong answer │
-- │ right, never the reverse. Safe against attempts already sat, and trivial  │
-- │ to reason about.                                                          │
-- │                                                                           │
-- │ THE COST, STATED: a word correct in Hindi and wrong in Gujarati is now    │
-- │ accepted from a Gujarati candidate. Across four languages in a            │
-- │ fill-in-the-blank knowledge check that is far rarer than the false        │
-- │ negative, and worth it.                                                   │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- KNOWN LIMITATION, made loud by 0035's advisory rather than hidden: writing
-- accepts bumps questions.revision (0011's trigger), and exam_questions freezes
-- the revision at publish. Accepts added AFTER an exam is published therefore
-- never reach that exam's frozen key. The remedy is to re-publish, which is how
-- every other frozen-versus-current gap in this codebase is handled.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The matcher: one bad pattern must not condemn the whole blank ────────────
--
-- PRE-EXISTING BUG, and the union makes it much worse. 0027's regex branch does
-- `review := true; return` on an invalid pattern, abandoning the loop — so one
-- unusable pattern sent that blank to manual review for everybody. With several
-- languages' patterns in one list, a single bad Gujarati pattern would send
-- EVERY candidate's blank to review, English speakers included.
--
-- Skip the bad pattern, flag it, and keep looking. Strictly better even without
-- translations: a candidate who matched a later, valid pattern is now marked
-- correct instead of being queued behind somebody else's typo.
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
          review  := false;
          return;
        end if;
      exception when others then
        -- An authoring fault. Flag it for a human, then CARRY ON: another
        -- pattern in the list may be perfectly good, and under 0034 it may
        -- well belong to a different language.
        review := true;
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
      -- "ribs", which are different answers.
      --
      -- Note for the multilingual case: the length test counts codepoints
      -- after NFKC, and Devanagari carries combining matras — so a
      -- three-syllable Hindi word is six or more codepoints and clears this
      -- guard where its English equivalent would not. Fuzzy is therefore more
      -- permissive in Hindi than in English at the same tolerance. Left as is,
      -- because it errs toward `review` — which is flagged and seen — rather
      -- than toward silently correct.
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

revoke all on function public.grade_match_blank(text, jsonb, text, int)
  from public, anon, authenticated;

-- ── The union, built at the call site ────────────────────────────────────────
--
-- Assembled in grade_answer rather than inside grade_match_blank, so the
-- matcher keeps one job and its existing tests keep meaning what they meant.
create or replace function public.blank_accept_list(p_blank jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(p_blank -> 'accept', '[]'::jsonb)
      || coalesce((
           select jsonb_agg(a)
             from jsonb_each(coalesce(p_blank -> 'acceptByLocale', '{}'::jsonb)) e(loc, list),
                  jsonb_array_elements(list) a
         ), '[]'::jsonb)
$$;

revoke all on function public.blank_accept_list(jsonb) from public, anon, authenticated;

comment on function public.blank_accept_list(jsonb) is
  'Every string that counts as right for one blank: the base list plus every language''s. Union rather than locale-scoped, because candidates code-switch and the frozen key carries no locale — see 0034''s header.';

-- ── Rewire the blanks branch of the grader ───────────────────────────────────
--
-- Only the accept list changes. The rest of grade_answer is 0027's, unchanged,
-- because a rewrite of a working grader to add one field is how the semantics
-- that milestone argued for get lost.
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
$$;

revoke all on function public.grade_answer(jsonb, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated;

-- ── Writing accepts without holding questions.update ─────────────────────────
--
-- answer_keys_write demands questions.update, so a holder of questions.translate
-- alone — an agency, a bilingual cook, the whole reason that permission is
-- separate — could translate the stem and NOT supply the answers that decide
-- marks. That is half a job.
--
-- SECURITY DEFINER because it must write a table the caller has no policy on,
-- and it earns that by touching exactly one field: it reads the current key and
-- writes only blanks[].acceptByLocale[locale]. `accept`, `match`, `tolerance`
-- and every other format's key are unreachable from here.
create or replace function public.save_blank_accepts(
  p_question_id uuid,
  p_locale      text,
  p_accepts     jsonb   -- {blankId: ["…", "…"]}
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key jsonb;
  v_blanks jsonb := '[]'::jsonb;
  v_blank jsonb;
  v_list jsonb;
begin
  if auth.uid() is null or not public.has_perm('questions.translate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_locale not in ('en', 'hi', 'gu', 'hi-Latn') then
    raise exception 'unknown language: %', p_locale using errcode = '22023';
  end if;

  -- The company check this function bypasses RLS to make, made explicitly.
  if not exists (
    select 1 from public.questions q
     where q.id = p_question_id
       and q.company_id = public.my_company()
       and q.deleted_at is null
  ) then
    raise exception 'question not found' using errcode = '42501';
  end if;

  select k.answer_key into v_key
    from public.question_answer_keys k where k.question_id = p_question_id;

  if v_key is null or (v_key ->> 'format') <> 'blanks' then
    raise exception 'this question has no blanks to accept answers for'
      using errcode = '22023';
  end if;

  for v_blank in select * from jsonb_array_elements(v_key -> 'blanks') loop
    v_list := p_accepts -> (v_blank ->> 'id');

    if v_list is not null and jsonb_typeof(v_list) = 'array' then
      -- Built by merging rather than with jsonb_set, because create_missing
      -- only creates the LAST element of a path: on a blank that has no
      -- acceptByLocale yet, jsonb_set(…, '{acceptByLocale, gu}', …, true)
      -- silently returns the blank unchanged. Merging the map creates it.
      v_blank := v_blank || jsonb_build_object(
        'acceptByLocale',
        coalesce(v_blank -> 'acceptByLocale', '{}'::jsonb)
          || jsonb_build_object(p_locale, v_list)
      );
    end if;

    v_blanks := v_blanks || v_blank;
  end loop;

  -- Only `blanks` is replaced: partialCredit, format and anything else on the
  -- key survive untouched.
  update public.question_answer_keys
     set answer_key = jsonb_set(v_key, '{blanks}', v_blanks)
   where question_id = p_question_id;
end;
$$;

grant execute on function public.save_blank_accepts(uuid, text, jsonb) to authenticated;

comment on function public.save_blank_accepts(uuid, text, jsonb) is
  'Writes per-language accepted answers into blanks[].acceptByLocale and nothing else. Exists because answer_keys_write demands questions.update, which a dedicated translator does not hold — without it they could translate the question and not the answers, which is the half that decides marks.';
