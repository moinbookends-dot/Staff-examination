-- ═════════════════════════════════════════════════════════════════════════════
-- 0060 — exam_paper_content(): the read 0056 promised and never got.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WITHOUT THIS, A CHEF'S PAPER RENDERS WITH ZERO QUESTIONS ON IT.           ║
-- ║                                                                           ║
-- ║ Rendering a paper needs each question's TEXT. Those live in               ║
-- ║ bank_question_texts, whose read policy is gated on bank.read (0055) — and ║
-- ║ a Chef deliberately holds no bank.* permission at all. RLS refuses by     ║
-- ║ FILTERING, so the query returns zero rows rather than an error, and the   ║
-- ║ PDF would come out perfectly valid and completely empty.                  ║
-- ║                                                                           ║
-- ║ The Chef is the one role the paper generator exists for, so this is not   ║
-- ║ an edge case — it is the main path.                                       ║
-- ║                                                                           ║
-- ║ 0056:342 already names this function: the Details screen "calls           ║
-- ║ exam_paper_content(), which returns text and omits the ids entirely".     ║
-- ║ It was never written. This is that function.                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ IT RETURNS NO question_id, AND THAT OMISSION IS THE SECURITY PROPERTY.    │
-- │                                                                           │
-- │ This function is SECURITY DEFINER, so it reads past the very policies     │
-- │ that keep a Chef out of the bank. Handing back ids would give them a      │
-- │ durable handle on individual bank questions — 0055 calls the ids "opaque  │
-- │ tokens that unlock nothing" precisely because nothing ever discloses them │
-- │ alongside content. src/lib/pdf/types.ts carries no id field for the same  │
-- │ reason.                                                                   │
-- │                                                                           │
-- │ What a caller gets is what goes on the printed page, and nothing more.    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- The answer-key columns (correct_option, answer_text, explanation) are returned
-- unconditionally: the caller decides which document to render, and
-- renderQuestionPaper() ignores all three by design so passing the full set to
-- the wrong function cannot print answers onto a candidate's paper.
create or replace function public.exam_paper_content(
  p_paper_id uuid,
  p_locale   text
)
returns table (
  question_no    smallint,
  section        public.bank_question_type,
  question       text,
  option_a       text,
  option_b       text,
  option_c       text,
  option_d       text,
  correct_option char(1),
  answer_text    text,
  explanation    text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_perm('papers.read_history') then
    raise exception 'Not permitted to read papers.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_locale not in ('en', 'hi', 'gu') then
    raise exception 'Unknown locale %.', p_locale
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * The same visibility rule exam_papers_read applies (0056), restated because
   * this function bypasses it: the paper must belong to the caller's company,
   * and to their brand unless they are brand-unscoped. A caller who cannot see
   * the paper gets nothing back rather than an error — identical to what RLS
   * would have done, so this function cannot be used to probe which paper ids
   * exist.
   */
  return query
  select q.question_no,
         q.section,
         t.question,
         t.option_a,
         t.option_b,
         t.option_c,
         t.option_d,
         bq.correct_option,
         t.answer_text,
         t.explanation
    from public.exam_papers p
    join public.exam_paper_questions q on q.paper_id = p.id
    join public.bank_questions bq      on bq.id = q.question_id
    -- LEFT, not INNER: a paper drawn before a translation existed still has to
    -- print. The missing language surfaces as blank text on the page, which is
    -- visible and fixable, rather than as a silently shorter paper.
    left join public.bank_question_texts t
           on t.question_id = q.question_id
          and t.locale = p_locale
   where p.id = p_paper_id
     and p.company_id = public.my_company()
     and (p.brand_id = public.my_brand() or public.brand_unscoped())
   order by q.question_no;
end;
$$;

revoke execute on function public.exam_paper_content(uuid, text) from public, anon;
grant  execute on function public.exam_paper_content(uuid, text) to authenticated;

comment on function public.exam_paper_content(uuid, text) is
  'One paper''s questions as printed text, in one locale. SECURITY DEFINER because bank_question_texts requires bank.read and a Chef holds none — without it their paper renders empty. Deliberately returns no question_id.';
