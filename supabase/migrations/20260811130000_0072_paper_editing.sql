-- ═════════════════════════════════════════════════════════════════════════════
-- 0072 — A generated paper can be reviewed and edited before it is published.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ UNTIL NOW A GENERATED PAPER WAS FINAL THE INSTANT IT EXISTED.             ║
-- ║                                                                           ║
-- ║ save_exam_paper() was the ONLY writer of exam_paper_questions anywhere in ║
-- ║ the schema, there is no UPDATE or DELETE policy on either paper table for ║
-- ║ anybody, and nothing in src/ has ever modified a paper's questions. So if ║
-- ║ the draw produced one question you did not want, the only remedy was to   ║
-- ║ retire the whole paper and generate another — burning a combination and   ║
-- ║ nineteen perfectly good questions to replace one.                         ║
-- ║                                                                           ║
-- ║ This adds exactly one writer, and it re-checks every guarantee            ║
-- ║ save_exam_paper() makes, because a paper edited into an invalid state is  ║
-- ║ indistinguishable from one that was generated wrong.                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ "EDITABLE" IS DERIVED, NOT STORED. NO NEW ENUM VALUE.                     │
-- │                                                                           │
-- │ A paper is editable when its status is 'generated' AND no exam references │
-- │ it. Both facts already exist, so a `draft`/`ready` enum would be a second │
-- │ source of truth that can disagree with the first — and paper_status is a  │
-- │ Postgres enum, where adding a value is easy and removing one is not.      │
-- │                                                                           │
-- │ WHY AN EXAM FREEZES IT, even a scheduled one nobody has sat:              │
-- │ start_attempt() copies exam_paper_questions into attempt_questions AT     │
-- │ ATTEMPT START (0063), not at publish. So editing a published paper would  │
-- │ not "update the exam" — it would give LATER candidates a different paper  │
-- │ from earlier ones, in the same sitting, silently. That is the single most │
-- │ damaging thing this feature could do, so the window is closed before it   │
-- │ can open.                                                                 │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Is this paper still editable?
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.paper_is_editable(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.exam_papers p
     where p.id = p_paper_id
       and p.status = 'generated'
       and not exists (
         select 1 from public.exams e
          where e.paper_id = p.id
            and e.deleted_at is null
       )
  );
$$;

comment on function public.paper_is_editable(uuid) is
  'A paper may be edited while it is still `generated` and no exam references it. Publishing sets status to live; start_attempt copies the questions per attempt, so editing after publication would hand later candidates a different paper.';

revoke execute on function public.paper_is_editable(uuid) from public, anon;
grant execute on function public.paper_is_editable(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The one writer
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHOLE-LIST REPLACEMENT, NOT add/remove/move VERBS.                        │
 * │                                                                           │
 * │ The caller sends the paper it wants; this function makes that true or     │
 * │ refuses entirely. Three reasons:                                          │
 * │                                                                           │
 * │ 1. question_no is PART OF THE PRIMARY KEY (paper_id, question_no). A      │
 * │    "swap 3 and 7" update collides with itself mid-statement. Deleting the │
 * │    lot and re-inserting sidesteps that without needing a deferrable       │
 * │    constraint.                                                            │
 * │                                                                           │
 * │ 2. The invariants are about the WHOLE paper — the MCQ/short split, the    │
 * │    total, no duplicates. Per-question verbs would have to re-validate the │
 * │    whole paper anyway, and could leave it invalid between two calls.      │
 * │                                                                           │
 * │ 3. It matches how the screen works: edits accumulate in the browser and   │
 * │    are saved once, deliberately. No request per reorder.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
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
  -- ── Who ──────────────────────────────────────────────────────────────────
  if not public.has_perm('papers.generate') then
    raise exception 'You do not have permission to edit papers.'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── Which paper, and may this caller see it ──────────────────────────────
  select * into v_paper
    from public.exam_papers p
   where p.id = p_paper_id
     and p.company_id = (select public.my_company())
     and (p.brand_id = (select public.my_brand()) or (select public.brand_unscoped()));

  if not found then
    raise exception 'That paper does not exist.' using errcode = 'no_data_found';
  end if;

  -- ── Is it still editable ─────────────────────────────────────────────────
  if not public.paper_is_editable(p_paper_id) then
    raise exception 'Paper % has been published and can no longer be edited.', v_paper.paper_no
      using errcode = 'check_violation';
  end if;

  -- ── Shape of the payload ─────────────────────────────────────────────────
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
   * THE COMPOSITION, CHECKED AGAINST THE PAPER'S OWN BLUEPRINT.
   *
   * mcq_n and short_n were copied onto exam_papers at generation and are
   * authoritative for this paper forever (0056). Re-deriving them from
   * paper_settings would let a later settings change silently invalidate an
   * existing paper — which is the reason they were copied in the first place.
   */
  select count(*) filter (where section = 'mcq'),
         count(*) filter (where section = 'short')
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

  -- Positions must be exactly 1..n, each once. The primary key would catch a
  -- duplicate but not a gap, and a gap means a paper that prints 1,2,4.
  if exists (
    select 1 from _edit group by question_no having count(*) > 1
  ) or (select count(distinct question_no) from _edit) <> v_n
    or (select min(question_no) from _edit) <> 1
    or (select max(question_no) from _edit) <> v_n
  then
    raise exception 'Question numbers must run from 1 to % with no gaps or repeats.', v_n
      using errcode = 'check_violation';
  end if;

  -- The same question twice. exam_paper_questions_once would catch it, but a
  -- named error is worth more than a constraint violation to the screen.
  if (select count(distinct question_id) from _edit) <> v_n then
    raise exception 'A paper cannot contain the same question twice.'
      using errcode = 'check_violation';
  end if;

  /*
   * EVERY QUESTION RE-VALIDATED AGAINST SCOPE, STATUS AND TYPE.
   *
   * Identical to the check save_exam_paper() performs at generation, and for
   * the identical reason: the ids arrive from a browser. Without this a caller
   * could put another company's question, an archived one, or a short answer
   * in an MCQ slot onto a paper simply by naming its uuid.
   */
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

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ THE FINGERPRINT IS RECOMPUTED, AND THAT IS WHAT KEEPS "NEVER THE SAME    ║
   * ║ PAPER TWICE" MEANING ANYTHING.                                           ║
   * ║                                                                           ║
   * ║ exam_papers_combination_uq is a unique index over the hash. Edit a paper  ║
   * ║ without updating the hash and the index now describes a set of questions  ║
   * ║ the paper no longer holds — so the generator could later draw exactly     ║
   * ║ this paper and be told it was new.                                        ║
   * ║                                                                           ║
   * ║ The expression reproduces src/lib/papers/paper-hash.ts EXACTLY: sha256    ║
   * ║ over the ids sorted lexicographically as text, newline-separated. That    ║
   * ║ was verified against a real row before this migration was written —       ║
   * ║ stored and recomputed hashes matched digit for digit. If it did not, the  ║
   * ║ generator and the editor would maintain two different notions of "the     ║
   * ║ same paper" and neither would be right.                                   ║
   * ║                                                                           ║
   * ║ A collision here means the edit would turn this paper into a duplicate of ║
   * ║ an existing one. The unique index raises, and the message says so.        ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  select extensions.digest(
           string_agg(e.question_id::text, chr(10) order by e.question_id::text),
           'sha256'
         )
    into v_hash
    from _edit e;

  -- ── Write ────────────────────────────────────────────────────────────────
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
  'Replaces a generated paper''s question list wholesale, re-checking every guarantee save_exam_paper() makes: composition against the paper''s own mcq_n/short_n, contiguous numbering, no duplicates, every question in scope and active and of the right type, and a recomputed combination_hash so the never-twice index stays true. Refuses once an exam references the paper.';

revoke execute on function public.edit_paper_questions(uuid, jsonb) from public, anon;
grant execute on function public.edit_paper_questions(uuid, jsonb) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. What may go on this paper — the picker
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS A FUNCTION AND NOT A PostgREST QUERY.                         │
 * │                                                                           │
 * │ "Eligible" means: same company, brand, difficulty and type as the paper,  │
 * │ active, not deleted — AND NOT ALREADY ON IT. That last clause is a        │
 * │ correlated NOT EXISTS against exam_paper_questions, which PostgREST       │
 * │ cannot express; doing it in the client would mean fetching candidates and │
 * │ filtering in JavaScript, which is how a picker silently offers a question │
 * │ that is already question 4.                                               │
 * │                                                                           │
 * │ It returns the English text so the screen can show what it is offering.   │
 * │ That is safe HERE and only here: the caller must already hold             │
 * │ papers.generate, and since 0071 the role that holds it also holds         │
 * │ bank.read. Before 0071 this function could not have existed — a Chef      │
 * │ could not see question text at all, which is exactly why paper editing    │
 * │ waited for the role merge.                                                │
 * │                                                                           │
 * │ NO ANSWER TEXT. Not the correct option, not the model answer. The picker  │
 * │ needs to identify a question, not to reveal it.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
create or replace function public.paper_eligible_questions(
  p_paper_id uuid,
  p_topic_id uuid default null,
  p_qtype    public.bank_question_type default null,
  p_search   text default null,
  p_limit    int default 50,
  p_offset   int default 0
)
returns table (
  question_id uuid,
  qtype       public.bank_question_type,
  topic_id    uuid,
  topic_name  text,
  question    text,
  locales     text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_paper public.exam_papers%rowtype;
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

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Ask for between 1 and 200 questions.' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select q.id,
           q.qtype,
           q.topic_id,
           t.name,
           coalesce(txt.question, ''),
           coalesce(
             (select array_agg(x.locale order by x.locale)
                from public.bank_question_texts x
               where x.question_id = q.id),
             '{}'::text[]
           )
      from public.bank_questions q
      left join public.question_topics t on t.id = q.topic_id
      left join public.bank_question_texts txt
             on txt.question_id = q.id and txt.locale = 'en'
     where q.company_id = v_paper.company_id
       and q.brand_id   = v_paper.brand_id
       -- The paper's difficulty is fixed at generation and is not a filter the
       -- user may change: a paper is one difficulty by product decision.
       and q.difficulty = v_paper.difficulty
       and q.status     = 'active'
       and q.deleted_at is null
       and (p_topic_id is null or q.topic_id = p_topic_id)
       and (p_qtype    is null or q.qtype    = p_qtype)
       and (
         p_search is null
         or p_search = ''
         or txt.question ilike '%' || p_search || '%'
       )
       -- The clause PostgREST cannot express.
       and not exists (
         select 1 from public.exam_paper_questions epq
          where epq.paper_id = p_paper_id
            and epq.question_id = q.id
       )
     order by t.name nulls last, txt.question
     limit p_limit offset p_offset;
end;
$$;

comment on function public.paper_eligible_questions(uuid, uuid, public.bank_question_type, text, int, int) is
  'Questions that could be added to this paper: same company, brand and difficulty, active, of the requested type, and NOT already on the paper. Returns identifying text only — never an answer, a correct option or a model answer.';

revoke execute on function public.paper_eligible_questions(uuid, uuid, public.bank_question_type, text, int, int)
  from public, anon;
grant execute on function public.paper_eligible_questions(uuid, uuid, public.bank_question_type, text, int, int)
  to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. The paper as it stands, for the review screen
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * exam_paper_content() (0060) already returns a paper as printed text — but it
 * deliberately returns NO question_id, and the review screen cannot offer a
 * "replace this one" button without knowing which one. That omission is a
 * security property of the PRINTING path and is left exactly as it is; this is
 * a separate function for a separate caller, gated on papers.generate.
 */
create or replace function public.paper_review_questions(p_paper_id uuid)
returns table (
  question_no smallint,
  question_id uuid,
  section     public.bank_question_type,
  topic_id    uuid,
  topic_name  text,
  question    text,
  locales     text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'You do not have permission to review papers.'
      using errcode = 'insufficient_privilege';
  end if;

  select exists (
    select 1 from public.exam_papers p
     where p.id = p_paper_id
       and p.company_id = (select public.my_company())
       and (p.brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
  ) into v_ok;

  if not v_ok then
    raise exception 'That paper does not exist.' using errcode = 'no_data_found';
  end if;

  return query
    select epq.question_no,
           epq.question_id,
           epq.section,
           q.topic_id,
           t.name,
           coalesce(txt.question, ''),
           coalesce(
             (select array_agg(x.locale order by x.locale)
                from public.bank_question_texts x
               where x.question_id = q.id),
             '{}'::text[]
           )
      from public.exam_paper_questions epq
      join public.bank_questions q on q.id = epq.question_id
      left join public.question_topics t on t.id = q.topic_id
      left join public.bank_question_texts txt
             on txt.question_id = q.id and txt.locale = 'en'
     where epq.paper_id = p_paper_id
     order by epq.question_no;
end;
$$;

comment on function public.paper_review_questions(uuid) is
  'The paper''s current questions WITH their ids, for the review and edit screen. Distinct from exam_paper_content(), which omits ids on purpose because it feeds the printed paper. Identifying text only — no answers.';

revoke execute on function public.paper_review_questions(uuid) from public, anon;
grant execute on function public.paper_review_questions(uuid) to authenticated;
