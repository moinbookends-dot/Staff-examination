-- ═════════════════════════════════════════════════════════════════════════════
-- 0040 — Making the question statuses 0037 invented actually mean something
--
-- 0037 added 'review', 'approved', 'archived' and 'deprecated' to
-- question_status. Nothing enforced them, nothing could reach them, and no
-- CHECK constrained them — an enum value with no state machine behind it,
-- which is precisely what 0016 was written to prevent for exams.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE PART THAT WAS ACTUALLY DANGEROUS.                                     │
-- │                                                                           │
-- │ The set of questions an exam may draw is chosen by exactly one predicate, │
-- │ and it asked for exactly 'active'. So the moment anybody set a question   │
-- │ to 'approved' — the status whose entire purpose is to say it is ready to  │
-- │ be used — it would vanish from every paper, every rule count and every    │
-- │ category expansion. Silently: no error and no advisory, just a rule       │
-- │ reporting a shortfall while the chef went looking for questions that were │
-- │ sitting right there.                                                      │
-- │                                                                           │
-- │ 'approved' and 'active' are therefore one drawable state. They cannot be  │
-- │ merged in the type — Postgres has neither DROP VALUE nor RENAME VALUE for │
-- │ enums, so both labels are permanent.                                      │
-- │                                                                           │
-- │ ONE predicate, not three. The obvious reading of the schema is that       │
-- │ `q.status = 'active'` appears in 0014, 0018 and 0024 and all three need   │
-- │ changing. Two of those are dead: 0018 replaced 0014's inline draw with a  │
-- │ delegation to question_pool(), and 0024 replaced 0018's question_pool     │
-- │ with the recursive-category version. draw_paper, exam_rule_counts and     │
-- │ preview_rule_count all route through the one live copy, which is the only │
-- │ thing reproduced below.                                                   │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THE LIFECYCLE, as data rather than as a chain of ifs — same shape as 0016:
--
--     draft ──> review ──> approved ──> active ──> retired ──> archived
--       ^          │                       │                      │
--       └──────────┘ (sent back)           └──> retired           └──> deprecated
--
-- Two deliberate choices:
--
--   · draft -> active stays legal. Authoring a question and using it is the
--     common path in a single-chef outlet, and forcing a two-step review on
--     somebody who is both author and approver is ceremony that gets worked
--     around rather than followed. Review is available, not compulsory.
--
--   · archived and deprecated are terminal. 'retired' is the reversible one
--     (a question pulled for a season comes back); archived and deprecated say
--     this will not be used again. Making them reversible would leave three
--     words for the same state, which is how a vocabulary rots.
--
-- WHAT THIS DOES NOT DO: it does not touch question CONTENT immutability.
-- 0011's revision counter already handles editing — every save bumps a revision
-- and the old one is kept — so unlike an exam, a question does not need its
-- columns frozen by status. Only the status transition itself is constrained.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.question_status_transition_allowed(
  p_from public.question_status,
  p_to   public.question_status
) returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to        then true
    -- Straight to active, or round the review loop.
    when p_from = 'draft'     then p_to in ('review', 'active', 'archived')
    -- Sent back to the author, or approved.
    when p_from = 'review'    then p_to in ('draft', 'approved', 'archived')
    -- Approved is drawable in its own right; going active is a formality.
    when p_from = 'approved'  then p_to in ('active', 'draft', 'retired', 'archived')
    when p_from = 'active'    then p_to in ('retired', 'archived')
    -- Retired is the reversible withdrawal: back into service, filed away, or
    -- reopened for rework. `retired -> draft` is not a nicety — it is the
    -- "Return to draft" button the question editor has always had, and
    -- setQuestionStatus's own docblock describes it as the point of the action.
    -- The first draft of this table omitted it and would have broken a shipped
    -- workflow at the trigger.
    when p_from = 'retired'   then p_to in ('draft', 'active', 'approved', 'archived', 'deprecated')
    -- Terminal.
    when p_from = 'archived'  then p_to = 'deprecated'
    when p_from = 'deprecated' then false
    else false
  end;
$$;

comment on function public.question_status_transition_allowed(public.question_status, public.question_status) is
  'The question lifecycle as data. draft -> review -> approved -> active -> retired, with archived and deprecated terminal. draft -> active is deliberately legal: review is available, not compulsory, because a chef who is both author and approver will otherwise work around it.';

create or replace function public.enforce_question_status_transition()
returns trigger
language plpgsql
as $$
begin
  if not public.question_status_transition_allowed(old.status, new.status) then
    raise exception 'cannot move a question from % to %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists question_status_transition on public.questions;
create trigger question_status_transition
  before update of status on public.questions
  for each row
  when (old.status is distinct from new.status)
  execute function public.enforce_question_status_transition();

-- ═════════════════════════════════════════════════════════════════════════════
-- Drawability, widened to include 'approved'.
--
-- question_pool() has to be reproduced whole — a function body cannot be
-- patched — so the substantive change is one line inside a copy of 0024's
-- definition, and everything else is byte-for-byte what was there.
-- ═════════════════════════════════════════════════════════════════════════════

-- A named predicate rather than a literal, so the next person to add a status
-- has one place to decide "is this drawable?" instead of a grep that, as this
-- migration found out, returns two dead matches for every live one.
create or replace function public.question_is_drawable(p_status public.question_status)
returns boolean
language sql
immutable
as $$
  select p_status in ('active', 'approved');
$$;

comment on function public.question_is_drawable(public.question_status) is
  'Whether a question in this status may be drawn onto a paper. Called from question_pool(), which every drawing path routes through. Exists as a named function rather than an inline `status = ''active''` so that adding a status is a decision taken in one place — 0037 added ''approved'' to the enum and it was silently undrawable until 0040.';

-- ── question_pool, reproduced from 0024 with one predicate changed ──────────
-- Every drawing path goes through this one function: draw_paper (0018),
-- exam_rule_counts and preview_rule_count all delegate to it. 0018 also
-- defined a question_pool, but 0024 superseded it with the recursive category
-- walk below, so this is the only live copy.
create or replace function public.question_pool(
  p_exam_id      uuid,
  p_category_id  uuid,
  p_include_sub  boolean,
  p_tag_ids      uuid[],
  p_types        public.question_type[],
  p_difficulty_min smallint,
  p_difficulty_max smallint
)
returns table (
  question_id    uuid,
  revision       int,
  marks          numeric(6,2),
  negative_marks numeric(6,2),
  difficulty     smallint,
  in_band        boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive category_tree as (
    -- The category itself. Only walked when the caller asked for descendants;
    -- otherwise the tree is just this node and the behaviour is unchanged.
    select c.id
      from public.categories c
     where c.id = p_category_id
       and c.deleted_at is null

    union   -- deduplicating: terminates even if somebody builds a cycle

    select c.id
      from public.categories c
      join category_tree t on c.parent_id = t.id
     where c.deleted_at is null
       and coalesce(p_include_sub, true)
  )
  select q.id, q.revision, q.marks, q.negative_marks, q.difficulty,
         (q.difficulty between p_difficulty_min and p_difficulty_max)
    from public.questions q
    join public.exams e on e.id = p_exam_id and e.deleted_at is null
   where q.deleted_at is null
     and public.question_is_drawable(q.status)
     and q.company_id = e.company_id
     -- A null brand on the question means "shared"; null on the exam means
     -- "any brand".
     and (q.brand_id is null or e.brand_id is null or q.brand_id = e.brand_id)
     and (
       p_category_id is null
       or q.category_id in (select id from category_tree)
     )
     and (p_types is null or q.type = any(p_types))
     and (
       coalesce(array_length(p_tag_ids, 1), 0) = 0
       or exists (select 1 from public.question_tags qt
                   where qt.question_id = q.id and qt.tag_id = any(p_tag_ids))
     );
$$;
-- question_pool is INTERNAL: it returns the question ids a paper would draw, so
-- it is reachable by nobody and callable only from the SECURITY DEFINER
-- functions above it. CREATE OR REPLACE preserves the existing ACL, but the
-- revoke is re-issued rather than assumed — tests/integration/function-acl.test.ts
-- lists this function by name and a silently widened grant is the one thing that
-- file exists to catch.
revoke all on function public.question_pool(
  uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint
) from public, anon, authenticated;
