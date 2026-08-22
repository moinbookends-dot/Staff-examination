-- ═════════════════════════════════════════════════════════════════════════════
-- 0059 — Paper generation: the write surface 0056 promised and never got.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0056 CREATED FIVE TABLES WITH NO WAY TO WRITE TO ANY OF THEM.             ║
-- ║                                                                           ║
-- ║ exam_papers, exam_paper_questions and exam_paper_files carry SELECT        ║
-- ║ policies only. 0056's own comments say "0057's generate_exam_paper() is   ║
-- ║ SECURITY DEFINER and is the whole write surface" — but 0057 turned out to ║
-- ║ be bank_pool_counts, a read-only counter. The writer was never written,   ║
-- ║ so exam_papers has been unwritable from every path since it was created   ║
-- ║ and holds zero rows.                                                      ║
-- ║                                                                           ║
-- ║ This migration supplies it, as three functions rather than one:           ║
-- ║   bank_draw_question_ids  — the sample a chef cannot take for themselves  ║
-- ║   paper_generation_state  — epoch + how many papers exist in it           ║
-- ║   save_exam_paper         — the atomic persist, duplicate-aware           ║
-- ║                                                                           ║
-- ║ THREE, NOT ONE, BECAUSE src/lib/papers/generate.ts ALREADY OWNS THE       ║
-- ║ ALGORITHM and is unit-tested. PaperRepository (repository.ts) declares    ║
-- ║ exactly these operations; collapsing them into a single do-everything     ║
-- ║ SQL function would re-implement shortfall detection, exhaustion and the   ║
-- ║ retry loop in a second place, untested, and leave the tested copy dead.   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- WHY SECURITY DEFINER IS UNAVOIDABLE HERE, unlike bank_import_commit (0058):
-- a Chef holds papers.generate and NO bank.* permission whatsoever — 0055
-- grants them no policy on bank_questions at all. They therefore cannot read a
-- single question, yet drawing a paper means selecting twenty of them. The
-- elevation is the point, and it is why every function below re-checks the
-- caller and re-validates its inputs rather than trusting them.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- P1 fix — brand_id was never checked against the caller's company
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ MEASURED, NOT SUSPECTED. An Editor inserted a bank_question with          │
-- │ company_id = their own and brand_id = ANOTHER COMPANY'S BRAND, and got    │
-- │ HTTP 201. The row was written.                                            │
-- │                                                                           │
-- │ bank_questions_insert (0055) checks has_perm, company_id and created_by.  │
-- │ It never asks whether brand_id belongs to that company, and the foreign   │
-- │ key only proves the brand exists SOMEWHERE. RLS on brands correctly hides │
-- │ other tenants' brands from reads, so this is corruption rather than       │
-- │ disclosure — a question filed under a brand its company does not own —    │
-- │ but it is exactly the class of hole 0031 was written to close.            │
-- │                                                                           │
-- │ 0058 already closed it for the import path in application code            │
-- │ (bank_import_commit raises 'Unknown brand'). Putting it in the POLICY     │
-- │ closes it for every path at once, including saveQuestion and any future   │
-- │ caller, which is where a tenancy rule belongs.                            │
-- └───────────────────────────────────────────────────────────────────────────┘

create or replace function public.brand_in_my_company(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.brands b
     where b.id = p_brand_id
       and b.company_id = public.my_company()
       and b.deleted_at is null
  );
$$;

comment on function public.brand_in_my_company(uuid) is
  'Does this brand belong to the caller''s company? SECURITY DEFINER so it can answer for a brand the caller cannot read, which is the case a tenancy check must cover.';

grant execute on function public.brand_in_my_company(uuid) to authenticated;

drop policy if exists bank_questions_insert on public.bank_questions;
create policy bank_questions_insert on public.bank_questions
  for insert to authenticated
  with check (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
    and created_by = (select auth.uid())
    -- The addition. Everything above is 0055 verbatim.
    and public.brand_in_my_company(brand_id)
  );

drop policy if exists bank_questions_update on public.bank_questions;
create policy bank_questions_update on public.bank_questions
  for update to authenticated
  using (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
  )
  with check (
    company_id = (select public.my_company())
    -- Also on UPDATE: without it a question could be MOVED to a foreign brand
    -- after the fact, which reaches the same corrupt state by another route.
    and public.brand_in_my_company(brand_id)
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- The draw
--
-- Returns a random sample WITHOUT replacement, and may return fewer rows than
-- asked for. PaperRepository.drawQuestionIds documents that contract exactly:
-- "It must not pad, retry or substitute." A short return is how the caller
-- learns the pool cannot fill a paper, and padding here would turn a reportable
-- shortfall into a silently wrong paper.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.bank_draw_question_ids(
  p_brand_id   uuid,
  p_difficulty public.bank_difficulty,
  p_qtype      public.bank_question_type,
  p_count      int
)
returns table (id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to generate papers.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_company is null then
    raise exception 'No company context.' using errcode = 'insufficient_privilege';
  end if;

  if not public.brand_in_my_company(p_brand_id) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  -- Bounded so a caller cannot ask for the entire bank in one call. The largest
  -- real request is 40 (a 50-mark paper's MCQ half).
  if p_count is null or p_count < 0 or p_count > 500 then
    raise exception 'Draw size out of range.' using errcode = 'invalid_parameter_value';
  end if;

  return query
  select q.id
    from public.bank_questions q
   where q.company_id = v_company
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.qtype      = p_qtype
     -- ACTIVE only. bank_pool_counts (0057) counts the same population, and the
     -- two must agree or the shortfall message describes a different bank than
     -- the draw uses.
     and q.status = 'active'
     and q.deleted_at is null
   order by random()
   limit p_count;
end;
$$;

revoke execute on function public.bank_draw_question_ids(uuid, public.bank_difficulty, public.bank_question_type, int) from public, anon;
grant  execute on function public.bank_draw_question_ids(uuid, public.bank_difficulty, public.bank_question_type, int) to authenticated;

comment on function public.bank_draw_question_ids(uuid, public.bank_difficulty, public.bank_question_type, int) is
  'A random sample of active question ids for one scope. SECURITY DEFINER because a Chef may generate papers while holding no read policy on the bank. May return fewer rows than requested; never pads.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Epoch and how full it is
--
-- paper_counters has RLS enabled and NO policies at all, so it is reachable
-- only from a definer function — deliberate in 0056, and the reason this
-- exists rather than the app reading the table.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.paper_generation_state(
  p_brand_id   uuid,
  p_difficulty public.bank_difficulty,
  p_marks      smallint
)
returns table (epoch int, generated int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
  v_epoch   int;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to generate papers.'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.brand_in_my_company(p_brand_id) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  select c.current_epoch into v_epoch
    from public.paper_counters c
   where c.company_id = v_company;

  -- A company with no counter row has generated nothing and starts at epoch 1.
  v_epoch := coalesce(v_epoch, 1);

  return query
  select v_epoch,
         (select count(*)::int
            from public.exam_papers p
           where p.company_id  = v_company
             and p.brand_id    = p_brand_id
             and p.difficulty  = p_difficulty
             and p.marks       = p_marks
             and p.epoch       = v_epoch);
end;
$$;

revoke execute on function public.paper_generation_state(uuid, public.bank_difficulty, smallint) from public, anon;
grant  execute on function public.paper_generation_state(uuid, public.bank_difficulty, smallint) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- The persist
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ A DUPLICATE IS A RETURN VALUE, NOT AN EXCEPTION.                          ║
-- ║                                                                           ║
-- ║ repository.ts states the rule: "MUST be atomic and MUST rely on the       ║
-- ║ unique index rather than a preceding SELECT. Two chefs generating         ║
-- ║ simultaneously both pass any check performed before the insert."          ║
-- ║                                                                           ║
-- ║ So the insert is attempted and 23505 on exam_papers_combination_uq is     ║
-- ║ caught and reported as {"status":"duplicate"}, which generate.ts answers  ║
-- ║ by drawing again. Raising instead would make the caller parse a Postgres  ║
-- ║ error code to tell "try again" from "something is broken".                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- p_questions is [{"questionId": uuid, "questionNo": int, "section": qtype}, …]
-- rather than parallel arrays, which cannot fall out of step with each other.
create or replace function public.save_exam_paper(
  p_brand_id         uuid,
  p_difficulty       public.bank_difficulty,
  p_marks            smallint,
  p_mcq_n            smallint,
  p_short_n          smallint,
  p_epoch            int,
  p_combination_hash bytea,
  p_questions        jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company  uuid := public.my_company();
  v_paper_no int;
  v_paper_id uuid;
  v_n        int;
  v_valid    int;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to generate papers.'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.brand_in_my_company(p_brand_id) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(p_questions) <> 'array' then
    raise exception 'Questions must be a JSON array.' using errcode = 'invalid_parameter_value';
  end if;

  v_n := jsonb_array_length(p_questions);

  -- The blueprint has to match what is actually being written. 0056 constrains
  -- mcq_n + short_n = marks on paper_settings; this is the same rule applied to
  -- the rows themselves, so a caller cannot persist a 20-mark paper holding
  -- nineteen questions.
  if v_n <> p_mcq_n + p_short_n or v_n <> p_marks then
    raise exception 'Paper holds % questions but claims % marks (% + %).',
      v_n, p_marks, p_mcq_n, p_short_n
      using errcode = 'check_violation';
  end if;

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ EVERY QUESTION IS RE-VALIDATED AGAINST THE SCOPE. THIS IS NOT PARANOIA. │
   * │                                                                         │
   * │ The function is SECURITY DEFINER, so whatever ids arrive here get       │
   * │ written with RLS bypassed. A Chef — who cannot read the bank at all —   │
   * │ could otherwise post arbitrary uuids and assemble a paper from another  │
   * │ brand's questions, another difficulty's, or drafts.                     │
   * │                                                                         │
   * │ Counting the ids that ARE in scope and comparing to the total is one    │
   * │ statement and refuses the whole paper if a single id fails.             │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  select count(*)::int into v_valid
    from jsonb_array_elements(p_questions) as e
    join public.bank_questions q
      on q.id = (e->>'questionId')::uuid
   where q.company_id = v_company
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.status     = 'active'
     and q.deleted_at is null
     and q.qtype      = (e->>'section')::public.bank_question_type;

  if v_valid <> v_n then
    raise exception 'A question on this paper is not an active question of this brand, level and type.'
      using errcode = 'foreign_key_violation';
  end if;

  -- Allocated from the counter, not a sequence: 0056 chose a counter so that a
  -- rolled-back generation gives the number back instead of leaving a gap in an
  -- audit trail people read. Inside this transaction, a later failure undoes it.
  update public.paper_counters
     set next_paper_no = next_paper_no + 1
   where company_id = v_company
  returning next_paper_no - 1 into v_paper_no;

  if v_paper_no is null then
    insert into public.paper_counters (company_id, next_paper_no)
    values (v_company, 2)
    returning 1 into v_paper_no;
  end if;

  begin
    insert into public.exam_papers (
      company_id, brand_id, paper_no, difficulty, marks, mcq_n, short_n,
      combination_hash, epoch, generated_by
    ) values (
      v_company, p_brand_id, v_paper_no, p_difficulty, p_marks, p_mcq_n, p_short_n,
      p_combination_hash, p_epoch, auth.uid()
    )
    returning id into v_paper_id;
  exception when unique_violation then
    -- exam_papers_combination_uq. This combination has been issued before in
    -- this epoch: the never-repeat rule doing its job.
    return jsonb_build_object('status', 'duplicate');
  end;

  insert into public.exam_paper_questions (paper_id, question_id, question_no, section)
  select v_paper_id,
         (e->>'questionId')::uuid,
         (e->>'questionNo')::smallint,
         (e->>'section')::public.bank_question_type
    from jsonb_array_elements(p_questions) as e;

  return jsonb_build_object(
    'status',  'saved',
    'paperId', v_paper_id,
    'paperNo', v_paper_no
  );
end;
$$;

revoke execute on function public.save_exam_paper(uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb) from public, anon;
grant  execute on function public.save_exam_paper(uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb) to authenticated;

comment on function public.save_exam_paper(uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb) is
  'Persists one drawn paper and its questions atomically. Returns {"status":"duplicate"} on the combination unique index rather than raising, because the caller answers that by drawing again. Re-validates every question id against the scope: it writes with RLS bypassed.';
