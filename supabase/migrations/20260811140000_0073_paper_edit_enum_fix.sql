-- ═════════════════════════════════════════════════════════════════════════════
-- 0073 — 0072 spelled the enum value wrong, and every edit failed because of it.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE VALUE IS 'short_answer'. 0072 WROTE 'short'.                          ║
-- ║                                                                           ║
-- ║ public.bank_question_type has exactly two labels — 'mcq' and              ║
-- ║ 'short_answer' — and edit_paper_questions() counted its short answers as  ║
-- ║                                                                           ║
-- ║   count(*) filter (where section = 'short')                               ║
-- ║                                                                           ║
-- ║ Postgres accepts that at CREATE FUNCTION time, because the literal is not ║
-- ║ cast to the enum until the expression is evaluated. So the migration      ║
-- ║ applied cleanly and the function was broken for every caller:             ║
-- ║                                                                           ║
-- ║   22P02  invalid input value for enum bank_question_type: "short"         ║
-- ║                                                                           ║
-- ║ Nothing could be edited or reordered at all.                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THIS IS A NEW MIGRATION RATHER THAN AN EDIT TO 0072.                  │
-- │                                                                           │
-- │ 0072 has been applied. Rewriting an applied migration makes the file in   │
-- │ the repository disagree with what any database actually ran, and the next │
-- │ person to replay history from scratch gets a different schema from the    │
-- │ one in front of them. 0063, 0066 and 0067 all corrected earlier           │
-- │ migrations this way; this follows them.                                   │
-- │                                                                           │
-- │ HOW IT WAS FOUND: scripts/check-paper-edit.mjs, on its first real run.    │
-- │ Worth recording because the same script also contained a test that PASSED │
-- │ because of this bug — its "an MCQ slot filled with a short answer must be │
-- │ refused" case sent the invalid literal, so the refusal it observed was a  │
-- │ cast error rather than the composition check it meant to exercise. Both   │
-- │ were fixed together.                                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.edit_paper_questions(
  p_paper_id  uuid,
  p_questions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_paper   public.exam_papers%rowtype;
  v_n       int;
  v_mcq     int;
  v_short   int;
  v_valid   int;
  v_hash    bytea;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'You do not have permission to edit papers.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_paper
    from public.exam_papers p
   where p.id = p_paper_id
     and p.company_id = (select public.my_company())
     and (p.brand_id = (select public.my_brand()) or (select public.brand_unscoped()));

  if not found then
    raise exception 'That paper does not exist.' using errcode = 'no_data_found';
  end if;

  if not public.paper_is_editable(p_paper_id) then
    raise exception 'Paper % has been published and can no longer be edited.', v_paper.paper_no
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception 'The question list must be an array.' using errcode = 'invalid_parameter_value';
  end if;

  create temporary table _edit (
    question_id uuid    not null,
    question_no smallint not null,
    section     public.bank_question_type not null
  ) on commit drop;

  insert into _edit (question_id, question_no, section)
  select (e ->> 'questionId')::uuid,
         (e ->> 'questionNo')::smallint,
         (e ->> 'section')::public.bank_question_type
    from jsonb_array_elements(p_questions) e;

  select count(*) into v_n from _edit;

  /*
   * The composition, against the paper's own blueprint. mcq_n and short_n were
   * copied onto exam_papers at generation and are authoritative for this paper
   * forever (0056) — re-deriving them from paper_settings would let a later
   * settings change silently invalidate an existing paper.
   *
   * 'short_answer', NOT 'short'. This line is the whole reason for 0073.
   */
  select count(*) filter (where section = 'mcq'),
         count(*) filter (where section = 'short_answer')
    into v_mcq, v_short
    from _edit;

  if v_mcq <> v_paper.mcq_n or v_short <> v_paper.short_n then
    raise exception
      'Paper % needs % MCQ and % short answers; got % and %.',
      v_paper.paper_no, v_paper.mcq_n, v_paper.short_n, v_mcq, v_short
      using errcode = 'check_violation';
  end if;

  if v_n <> v_paper.marks then
    raise exception 'Paper % is worth % marks but holds % questions.',
      v_paper.paper_no, v_paper.marks, v_n
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from _edit group by question_no having count(*) > 1
  ) or (select count(distinct question_no) from _edit) <> v_n
    or (select min(question_no) from _edit) <> 1
    or (select max(question_no) from _edit) <> v_n
  then
    raise exception 'Question numbers must run from 1 to % with no gaps or repeats.', v_n
      using errcode = 'check_violation';
  end if;

  if (select count(distinct question_id) from _edit) <> v_n then
    raise exception 'A paper cannot contain the same question twice.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_valid
    from _edit e
    join public.bank_questions q on q.id = e.question_id
   where q.company_id = v_paper.company_id
     and q.brand_id   = v_paper.brand_id
     and q.difficulty = v_paper.difficulty
     and q.status     = 'active'
     and q.deleted_at is null
     and q.qtype      = e.section;

  if v_valid <> v_n then
    raise exception
      'Only % of % questions are eligible for this paper (same brand, difficulty and type, and active).',
      v_valid, v_n
      using errcode = 'check_violation';
  end if;

  -- Reproduces src/lib/papers/paper-hash.ts exactly: sha256 over the ids
  -- sorted lexicographically as text, newline-separated. Verified against a
  -- real row before 0072 was written.
  select extensions.digest(
           string_agg(e.question_id::text, chr(10) order by e.question_id::text),
           'sha256'
         )
    into v_hash
    from _edit e;

  delete from public.exam_paper_questions where paper_id = p_paper_id;

  insert into public.exam_paper_questions (paper_id, question_id, question_no, section)
  select p_paper_id, e.question_id, e.question_no, e.section from _edit e;

  begin
    update public.exam_papers
       set combination_hash = v_hash
     where id = p_paper_id;
  exception
    when unique_violation then
      raise exception
        'Those questions are already paper %. Change one and try again.',
        (select p2.paper_no from public.exam_papers p2
          where p2.company_id = v_paper.company_id
            and p2.brand_id = v_paper.brand_id
            and p2.epoch = v_paper.epoch
            and p2.difficulty = v_paper.difficulty
            and p2.marks = v_paper.marks
            and p2.combination_hash = v_hash)
        using errcode = 'unique_violation';
  end;

  return jsonb_build_object(
    'paperId', p_paper_id,
    'paperNo', v_paper.paper_no,
    'questions', v_n,
    'mcq', v_mcq,
    'short', v_short
  );
end;
$$;

comment on function public.edit_paper_questions(uuid, jsonb) is
  'Replaces a generated paper''s question list wholesale, re-checking every guarantee save_exam_paper() makes: composition against the paper''s own mcq_n/short_n, contiguous numbering, no duplicates, every question in scope and active and of the right type, and a recomputed combination_hash so the never-twice index stays true. Refuses once an exam references the paper. (0073 corrected the short_answer enum literal 0072 got wrong.)';
