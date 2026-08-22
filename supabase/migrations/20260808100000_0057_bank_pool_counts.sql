-- ═════════════════════════════════════════════════════════════════════════════
-- 0057 — bank_pool_counts()
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE ONE THING A CHEF NEEDS FROM THE BANK, AND THE ONLY THING THEY GET.    ║
-- ║                                                                           ║
-- ║ The Generate screen must say how many questions are available before      ║
-- ║ somebody presses the button. That number lives in bank_questions, which   ║
-- ║ 0055 opens only to bank.read — a permission the chef role deliberately    ║
-- ║ does not hold, because holding it would expose question ids and text.     ║
-- ║                                                                           ║
-- ║ So the screen was showing zero to the exact person it exists for, and     ║
-- ║ saying "the bank is empty" when it was not.                               ║
-- ║                                                                           ║
-- ║ THIS FUNCTION RETURNS COUNTS. Three columns: level, type, how many. No    ║
-- ║ id, no stem, no option, no answer, no topic, no reference. There is       ║
-- ║ nothing in the result set a caller could assemble into a question, which  ║
-- ║ is what makes it safe to expose where the table is not.                   ║
-- ║                                                                           ║
-- ║ WHAT MUST NOT HAPPEN LATER: columns must not be added to this return      ║
-- ║ type as a convenience. The moment it returns anything identifying, it     ║
-- ║ becomes a way to read the bank without bank.read, and the UUID boundary   ║
-- ║ that the whole permission design rests on is gone — through a function    ║
-- ║ that looks like a reporting helper.                                       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- SECURITY DEFINER, so it sees past the RLS on bank_questions. That makes the
-- guard below load-bearing rather than decorative: it is the only thing
-- standing between an authenticated stranger and these counts.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.bank_pool_counts(p_brand_id uuid default null)
returns table (
  difficulty public.bank_difficulty,
  qtype      public.bank_question_type,
  n          int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  /*
   * The permission gate, as the FIRST statement — the shape
   * tests/integration/function-acl.test.ts enforces for every definer
   * function in this schema.
   *
   * Either permission is enough and that is deliberate: a chef holds
   * papers.generate and needs the counts to generate; an Editor holds
   * bank.read and can already read the table this summarises, so denying them
   * the summary would be pointless.
   */
  if not (public.has_perm('papers.generate') or public.has_perm('bank.read')) then
    raise exception 'Not permitted to read question pool counts'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select q.difficulty, q.qtype, count(*)::int
    from public.bank_questions q
   where q.company_id = public.my_company()
     -- Only what a paper can actually be drawn from. A draft counted here
     -- would promise questions the generator then refuses to use, which is
     -- the shortfall message contradicting the screen that led to it.
     and q.status = 'active'
     and q.deleted_at is null
     /*
      * Brand scoping, twice over.
      *
      * The optional argument narrows to one brand for the selector. The
      * my_brand() clause is the SECURITY one: a chef is pinned to their own
      * brand and must not learn the size of another brand's bank, while
      * Editors and super admins move freely. Mirrors brand_unscoped() in 0056
      * and the exam_papers read policy, so the same rule governs the counts
      * and the papers drawn from them.
      */
     and (p_brand_id is null or q.brand_id = p_brand_id)
     and (q.brand_id = public.my_brand() or public.brand_unscoped())
   group by q.difficulty, q.qtype;
end;
$$;

-- `authenticated` only. anon has no company and no permission, so the guard
-- would refuse it anyway — but a function that anon may not call cannot be
-- probed at all, and 0044/0045 shipped anon-executable by relying on the
-- guard alone.
revoke execute on function public.bank_pool_counts(uuid) from public, anon;
grant  execute on function public.bank_pool_counts(uuid) to authenticated;

comment on function public.bank_pool_counts(uuid) is
  'Counts of active questions by level and type, for the Generate screen. Returns COUNTS ONLY — never ids or text — so a chef may read it without bank.read. Do not add identifying columns.';
