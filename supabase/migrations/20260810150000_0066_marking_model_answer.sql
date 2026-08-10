-- ═════════════════════════════════════════════════════════════════════════════
-- 0066 — The marking view: make it work, then make it useful.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE MARKING VIEW WAS BROKEN FOR EVERY PAPER-BACKED ATTEMPT, AND NOTHING   ║
-- ║ HAD EXERCISED IT.                                                         ║
-- ║                                                                           ║
-- ║ attempt_evaluation_items() fetched its guidance with                      ║
-- ║ answer_key_at_revision(), which reads question_revisions and RAISES when  ║
-- ║ there is no row. A bank question never has one. Measured against the      ║
-- ║ live database, a Chef opening a submitted paper got:                      ║
-- ║                                                                           ║
-- ║   500  P0002  no revision 1 recorded for question 6cb8d8a3… —             ║
-- ║                cannot grade an answer against a paper that was never      ║
-- ║                captured                                                   ║
-- ║                                                                           ║
-- ║ Every paper carries short answers by blueprint, so EVERY submission stops ║
-- ║ at `evaluating` and every one of them was unmarkable. The results would   ║
-- ║ never have come out.                                                      ║
-- ║                                                                           ║
-- ║ This is the same fault 0063 fixed in grade_and_close_attempt. That fix    ║
-- ║ did not reach here because grading and marking read the key by different  ║
-- ║ routes, and only the grading route had a test.                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ AND THE MODEL ANSWER, WHICH HAS BEEN SITTING THERE UNREAD.                │
-- │                                                                           │
-- │ 0063 froze the bank's answer_text onto attempt_questions.answer_key as    │
-- │ `model` at the moment the candidate started — so the marker was already   │
-- │ recorded against the attempt, exactly as it stood when the paper was sat. │
-- │ Nothing surfaced it, so a Chef marked "What is the danger zone?" from     │
-- │ memory.                                                                   │
-- │                                                                           │
-- │ It is returned as its OWN column rather than folded into `guidance`:      │
-- │ guidance is the legacy rubric/keywords object the authoring tools write,  │
-- │ and a consumer that has to guess which shape it received is how a rubric  │
-- │ ends up rendered as prose.                                                │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHY THIS CANNOT REACH A CANDIDATE.                                        ║
-- ║                                                                           ║
-- ║ The model answer lives in attempt_questions.answer_key — a COLUMN, not a  ║
-- ║ field inside snapshot. 0062 put it there for exactly this reason:         ║
-- ║ attempt_paper() hands the whole snapshot to the candidate, and a key      ║
-- ║ stored inside it would be handed over with everything else.               ║
-- ║                                                                           ║
-- ║ Nothing candidate-facing selects that column. attempt_paper() returns     ║
-- ║ snapshot only; attempt_review() returns stem, marks, score, answer,       ║
-- ║ grade_detail and grader_note; and attempt_questions has ONE policy, which ║
-- ║ requires attempts.read_all or attempts.read_team — neither of which a     ║
-- ║ candidate holds, as their own attempt returning [] already demonstrates.  ║
-- ║                                                                           ║
-- ║ This function adds no new path: it is SECURITY DEFINER and its first act  ║
-- ║ is to require evaluation.evaluate, which only a Chef holds.               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═════════════════════════════════════════════════════════════════════════════

-- The RETURNS TABLE gains a column, so the old signature has to go first.
drop function if exists public.attempt_evaluation_items(uuid);

create or replace function public.attempt_evaluation_items(p_attempt_id uuid)
returns table(
  question_id       uuid,
  paper_position    integer,
  stem              text,
  response_format   text,
  marks             numeric,
  answer            jsonb,
  score             numeric,
  grader_note       text,
  auto_grade_status public.auto_grade_status,
  guidance          jsonb,
  model_answer      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attempt record;
begin
  -- Unchanged, and the whole authorisation story: only an evaluator, only in
  -- their own company, only while the paper is actually awaiting marking.
  if not public.has_perm('evaluation.evaluate') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select a.* into v_attempt from public.attempts a where a.id = p_attempt_id;

  if v_attempt.id is null or v_attempt.company_id <> public.my_company() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  if v_attempt.status not in ('evaluating', 'returned') then
    raise exception 'this attempt is not awaiting evaluation' using errcode = '22023';
  end if;

  return query
    select aq.question_id, aq.position, aq.snapshot ->> 'stem',
           aq.snapshot ->> 'response_format', aq.marks,
           aa.answer, aa.score, aa.grader_note,
           coalesce(aa.auto_grade_status, 'pending'::public.auto_grade_status),
           /*
            * GUIDANCE — the legacy rubric and keyword list.
            *
            * The bank branch comes FIRST and returns null, which is what stops
            * the raise: a CASE evaluates its branches in order and only the
            * matching result expression is computed, so answer_key_at_revision()
            * is never reached for a bank question. Ordering is load-bearing
            * here, not stylistic.
            *
            * A bank question genuinely has no rubric — the bank stores one
            * model answer per question and no marking scheme — so null is the
            * honest answer rather than a gap to fill later.
            */
           case
             when (aq.snapshot ->> 'response_format')
                    not in ('text_short', 'text_long', 'evaluator_only') then null
             when aq.source = 'bank' then null
             else public.answer_key_at_revision(aq.question_id, aq.question_revision)
           end,
           /*
            * MODEL ANSWER — frozen onto the attempt when the candidate started,
            * so editing the bank afterwards cannot change what the marker is
            * shown for a paper that has already been sat.
            *
            * Manual formats only. An auto-graded MCQ flagged for review reaches
            * this list too, and handing over `correct` would turn a request to
            * confirm the machine's reading into a prompt to agree with it.
            */
           case
             when (aq.snapshot ->> 'response_format')
                    not in ('text_short', 'text_long', 'evaluator_only') then null
             when aq.source = 'bank' then nullif(btrim(coalesce(aq.answer_key ->> 'model', '')), '')
             else null
           end
      from public.attempt_questions aq
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
       -- Only what a human has to decide: the manual formats, plus anything the
       -- auto-grader flagged as a near-miss it wanted confirmed.
       and (
         (aq.snapshot ->> 'response_format') in ('text_short', 'text_long', 'evaluator_only')
         or coalesce(aa.needs_review, false)
       )
     order by aq.position;
end;
$$;

revoke execute on function public.attempt_evaluation_items(uuid) from public, anon;
grant  execute on function public.attempt_evaluation_items(uuid) to authenticated;

comment on function public.attempt_evaluation_items(uuid) is
  'The marking view for one attempt. Requires evaluation.evaluate and company membership. Returns the model answer for bank-backed short answers, frozen onto the attempt at start; no candidate-facing function selects attempt_questions.answer_key.';
