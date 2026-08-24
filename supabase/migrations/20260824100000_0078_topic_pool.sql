-- ═══════════════════════════════════════════════════════════════════════════
-- 0078 — Topic-aware pool counts, and a draw that can be told which topics
--        to leave out.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ WHY THE GENERATOR HAS TO LEARN ABOUT TOPICS.                              ║
-- ║                                                                           ║
-- ║ 0053 said "nothing downstream reads a topic, so none of that can affect   ║
-- ║ a generated paper", and that was the right call while a topic was only a  ║
-- ║ filing label. It is no longer true of the product: a paper must be able   ║
-- ║ to leave a whole subject out — a section not yet taught, a dish off the   ║
-- ║ menu — and today the only way to do that is to delete the questions.      ║
-- ║                                                                           ║
-- ║ FILTER FIRST, RANDOMISE LAST. The exclusion is a predicate INSIDE the     ║
-- ║ draw, evaluated before `order by random()`. Sampling the whole bank and   ║
-- ║ then discarding the unwanted rows would silently return a short paper,    ║
-- ║ which is the one outcome the generator must never produce.                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- Counts per topic, for one brand and level
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A SIBLING OF bank_pool_counts, NOT AN EXTENSION OF IT.                    │
-- │                                                                           │
-- │ 0057 ends with "Do not add identifying columns", and a topic_id is an     │
-- │ identifying column: joined to question_topics it names what a brand       │
-- │ teaches. So the topic dimension lives in its own function, with its own   │
-- │ guard, and 0057 keeps the contract it published.                          │
-- │                                                                           │
-- │ topic_id IS NULL is a REAL ROW, not an absence. A whole imported bank can │
-- │ carry no topic at all — Capiche's 1,000 questions do — and a picker that  │
-- │ dropped that bucket would offer an empty list and refuse to generate a    │
-- │ paper from a bank that is entirely fine.                                  │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.bank_topic_pool_counts(
  p_brand_id   uuid,
  p_difficulty public.bank_difficulty
)
returns table (
  topic_id uuid,
  qtype    public.bank_question_type,
  n        int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- The permission gate, as the FIRST statement — the shape
  -- tests/integration/function-acl.test.ts enforces. Same pair as 0057: a
  -- chef holds papers.generate and needs these to choose; an Editor holds
  -- bank.read and can already read what this summarises.
  if not (public.has_perm('papers.generate') or public.has_perm('bank.read')) then
    raise exception 'Not permitted to read question pool counts'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select q.topic_id, q.qtype, count(*)::int
    from public.bank_questions q
   where q.company_id = public.my_company()
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     -- ACTIVE only, matching bank_pool_counts and bank_draw_question_ids. All
     -- three count the same population or the screen describes a bank the
     -- draw does not use.
     and q.status = 'active'
     and q.deleted_at is null
     -- The same brand rule as 0057: a pinned chef may not learn the shape of
     -- another brand's bank.
     and (q.brand_id = public.my_brand() or public.brand_unscoped())
   group by q.topic_id, q.qtype;
end;
$$;

revoke execute on function public.bank_topic_pool_counts(uuid, public.bank_difficulty) from public, anon;
grant  execute on function public.bank_topic_pool_counts(uuid, public.bank_difficulty) to authenticated;

comment on function public.bank_topic_pool_counts(uuid, public.bank_difficulty) is
  'Counts of active questions by topic and type for one brand and level, for the Generate screen''s topic picker. A NULL topic_id is the untopiced bucket, not a missing row. Returns COUNTS ONLY — never ids or text. Do not add identifying columns.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The draw, now filterable by topic
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ DROPPED AND RECREATED, NOT `create or replace`.                           │
-- │                                                                           │
-- │ Adding a parameter to a Postgres function does not replace it — it        │
-- │ creates a second function with a different signature. PostgREST would     │
-- │ then have two candidates and bind to whichever matched the arguments      │
-- │ sent, so a caller that forgot the new parameter would silently keep the   │
-- │ old, unfiltered behaviour: a paper containing exactly the topics somebody │
-- │ excluded. Same drop-then-create as 0064 did for publish_paper_as_exam.    │
-- │                                                                           │
-- │ Both new parameters DEFAULT, so every existing caller — including         │
-- │ scripts/generate-first-paper.mjs, which speaks to this function directly  │
-- │ — keeps working untouched and unfiltered.                                 │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

drop function if exists public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int
);

create function public.bank_draw_question_ids(
  p_brand_id        uuid,
  p_difficulty      public.bank_difficulty,
  p_qtype           public.bank_question_type,
  p_count           int,
  -- NULL means "every topic", which is what an unfiltered draw has always
  -- done. An EMPTY array is not the same thing and is not special-cased: it
  -- admits nothing, which is the honest reading of "include none of them".
  p_topic_ids       uuid[] default null,
  -- Carried separately because a NULL topic cannot be named inside a uuid[].
  p_include_no_topic boolean default true
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
     -- ACTIVE only. bank_pool_counts (0057) and bank_topic_pool_counts count
     -- the same population, and the three must agree or the shortfall message
     -- describes a different bank than the draw uses.
     and q.status = 'active'
     and q.deleted_at is null
     -- The exclusion, evaluated BEFORE the sample is taken. This clause is the
     -- whole feature: a question of an excluded topic is never a candidate, so
     -- it cannot be drawn, cannot survive a re-roll, and cannot reach a paper.
     and (
       p_topic_ids is null
       or q.topic_id = any(p_topic_ids)
       or (p_include_no_topic and q.topic_id is null)
     )
   order by random()
   limit p_count;
end;
$$;

revoke execute on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean
) from public, anon;
grant  execute on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean
) to authenticated;

comment on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean
) is
  'A random sample of active question ids for one scope, optionally restricted to a set of topics. SECURITY DEFINER because a Chef may generate papers while holding no read policy on the bank. The topic filter is applied before the sample, never after. May return fewer rows than requested; never pads.';
