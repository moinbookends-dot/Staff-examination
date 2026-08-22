-- ═════════════════════════════════════════════════════════════════════════════
-- 0042 — Changing many questions at once, without changing anything else
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY NOT save_question() IN A LOOP.                                        │
-- │                                                                           │
-- │ save_question is a FULL-RECORD WRITE. It overwrites stem, content, marks,  │
-- │ difficulty, explanation, reference_note and bloom_level with whatever the  │
-- │ caller passed, and every one of those has a default of null. A bulk "set   │
-- │ category on 200 questions" routed through it would blank the Bloom level,  │
-- │ the explanation and the reference note on all 200 — silently, because      │
-- │ each individual call did exactly what it was asked.                        │
-- │                                                                           │
-- │ That is asserted in scripts/walkthrough.mjs so it cannot be rediscovered   │
-- │ the hard way.                                                             │
-- │                                                                           │
-- │ These functions are the opposite shape: PARTIAL by construction. Every     │
-- │ column is written as `case when <caller named it> then <new> else <old>    │
-- │ end`, so a column nobody mentioned is written back to itself. Adding a     │
-- │ column to public.questions cannot silently start clearing it here,         │
-- │ because a column that is not a parameter is not in the SET list at all.    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SECURITY INVOKER, LIKE save_question, AND FOR THE SAME REASON.            │
-- │                                                                           │
-- │ 0013 puts it best: a SECURITY DEFINER function here "would bypass all of   │
-- │ it and quietly become the one write path with no authorisation". Running   │
-- │ as the caller means 0010's questions_update policy scopes every row to     │
-- │ the caller's company for free, and 0041's questions_restore governs the    │
-- │ restore. Nothing below re-implements a company check, because nothing      │
-- │ below needs to.                                                           │
-- │                                                                           │
-- │ ONE THING RLS DOES NOT DO, which is why the brand predicate is explicit:   │
-- │ questions_read is brand-scoped, questions_update is NOT. A caller holding  │
-- │ ids obtained elsewhere could otherwise update a row in their company but   │
-- │ another brand — invisible to them, and editable. The WHERE clause below    │
-- │ adds what the policy omits.                                               │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SKIPPED, NOT FATAL.                                                       │
-- │                                                                           │
-- │ 0040's trigger raises 23514 on an illegal status transition, which would   │
-- │ abort the whole statement — one archived question in a selection of two    │
-- │ hundred and nobody gets published, with an error naming a row the chef     │
-- │ cannot identify.                                                          │
-- │                                                                           │
-- │ So the WHERE clause consults question_status_transition_allowed() directly │
-- │ and simply does not match rows that cannot move. The trigger still fires   │
-- │ per row as a backstop — it is not being worked around, it is being agreed  │
-- │ with in advance — and each id comes back with whether it applied and why   │
-- │ not, so the UI can say "180 updated, 20 skipped" instead of "error".       │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- WHAT IS DELIBERATELY NOT A PARAMETER:
--
--   source, imported_from   Provenance. A bulk edit must not be able to relabel
--                           240 imported questions as hand-written. Not being
--                           expressible is a stronger guarantee than a rule.
--   usage_count             A hand-incremented exposure counter with exactly one
--                           writer (publish_exam, fixed-mode only) and no way to
--                           recompute it. Touching it would be unrecoverable.
--   stem, content,          Changing what a question ASKS is not a bulk
--   answer_key              operation. It goes through save_question, one at a
--                           time, where it bumps a revision and keeps history.
-- ═════════════════════════════════════════════════════════════════════════════

-- The first draft took smallint here. Dropped explicitly rather than left as an
-- overload: two functions differing only in a numeric width is an ambiguity
-- waiting for a caller that happens to send the other one.
drop function if exists public.bulk_update_questions(
  uuid[], public.question_status, uuid, boolean, smallint,
  public.bloom_taxonomy, boolean, uuid[], uuid[]
);

create or replace function public.bulk_update_questions(
  p_ids            uuid[],
  p_set_status     public.question_status default null,
  p_set_category   uuid                   default null,
  -- null already means "not requested", so clearing needs its own flag. Without
  -- these, a chef could never remove a category or a Bloom level in bulk.
  p_clear_category boolean                default false,
  -- int, not smallint: PostgREST sends a JS number as integer, and Postgres
  -- will not implicitly narrow it during named-argument resolution — the call
  -- fails with 'function does not exist', which reads like a missing migration.
  p_set_difficulty int                    default null,
  p_set_bloom      public.bloom_taxonomy  default null,
  p_clear_bloom    boolean                default false,
  p_add_tags       uuid[]                 default null,
  p_remove_tags    uuid[]                 default null
)
returns table (question_id uuid, applied boolean, reason text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated uuid[];
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  if p_set_difficulty is not null and (p_set_difficulty < 1 or p_set_difficulty > 5) then
    raise exception 'difficulty must be between 1 and 5' using errcode = '23514';
  end if;

  -- ── The one statement ─────────────────────────────────────────────────────
  with moved as (
    update public.questions q
       set status = case when p_set_status is not null then p_set_status else q.status end,
           category_id = case
                           when p_clear_category then null
                           when p_set_category is not null then p_set_category
                           else q.category_id
                         end,
           difficulty = case when p_set_difficulty is not null then p_set_difficulty::smallint
                             else q.difficulty end,
           bloom_level = case
                           when p_clear_bloom then null
                           when p_set_bloom is not null then p_set_bloom
                           else q.bloom_level
                         end,
           updated_by = auth.uid()
     where q.id = any(p_ids)
       and q.deleted_at is null
       -- What questions_update does not check. See the header.
       and (q.brand_id is null
            or q.brand_id = public.my_brand()
            or public.is_super_admin())
       -- Agreeing with 0040 in advance rather than being refused by it.
       and (p_set_status is null
            or public.question_status_transition_allowed(q.status, p_set_status))
    returning q.id
  )
  select array_agg(moved.id) into v_updated from moved;

  v_updated := coalesce(v_updated, '{}'::uuid[]);

  -- ── Tags, as set operations on the rows that survived ─────────────────────
  --
  -- Scoped to v_updated, not to p_ids: a row RLS refused, or one whose status
  -- move was illegal, must not quietly have its tags rewritten. The tag write
  -- follows the question write rather than running beside it.
  if p_remove_tags is not null and array_length(p_remove_tags, 1) is not null then
    delete from public.question_tags qt
     where qt.question_id = any(v_updated)
       and qt.tag_id = any(p_remove_tags);
  end if;

  if p_add_tags is not null and array_length(p_add_tags, 1) is not null then
    insert into public.question_tags (question_id, tag_id)
    select u.id, t.tag_id
      from unnest(v_updated) as u(id)
     cross join unnest(p_add_tags) as t(tag_id)
    on conflict do nothing;
  end if;

  -- ── One row per id the caller asked about ─────────────────────────────────
  --
  -- Including the ones that did not apply. A bulk operation that reports only
  -- its successes is one a chef cannot audit: "I selected 200, it said done,
  -- and 20 of them did not move" has to be answerable from the response.
  return query
  select i.id,
         i.id = any(v_updated),
         case
           when i.id = any(v_updated) then null
           when not exists (select 1 from public.questions q where q.id = i.id)
             then 'not found, already removed, or not yours'
           when p_set_status is not null then 'that status change is not allowed from where this question is'
           else 'not updated'
         end
    from unnest(p_ids) as i(id);
end;
$$;

grant execute on function public.bulk_update_questions(
  uuid[], public.question_status, uuid, boolean, int,
  public.bloom_taxonomy, boolean, uuid[], uuid[]
) to authenticated;

comment on function public.bulk_update_questions(
  uuid[], public.question_status, uuid, boolean, int,
  public.bloom_taxonomy, boolean, uuid[], uuid[]
) is
  'Partial, set-based update of many questions in one statement. Every column is written as case-when-requested-else-itself, so a column the caller did not name is written back to itself — unlike save_question, which is a full-record write and would blank the Bloom level, explanation and reference note of every row in a bulk category change. source and imported_from are not parameters, so provenance cannot be rewritten. SECURITY INVOKER: 0010 scopes rows to the caller''s company, and the brand predicate here adds what questions_update omits. Illegal status transitions are skipped and reported rather than aborting the batch on 0040''s trigger.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Removal and its undo.
--
-- Separate from the function above because it is a different operation with a
-- different permission and a different policy behind it: removal runs under
-- 0010's questions_update, restoration under 0041's questions_restore. Folding
-- "archive these" and "delete these" into one call would also make an
-- accidental combination expressible, and there is no reason to want one.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.bulk_set_question_deleted(
  p_ids     uuid[],
  p_deleted boolean
)
returns table (question_id uuid, applied boolean, reason text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated uuid[];
begin
  if p_ids is null or array_length(p_ids, 1) is null or p_deleted is null then
    return;
  end if;

  with moved as (
    update public.questions q
       set deleted_at = case when p_deleted then now() else null end,
           updated_by = auth.uid()
     where q.id = any(p_ids)
       -- The predicate that makes this idempotent AND makes the count honest:
       -- deleting an already-deleted row matches nothing, so it is reported as
       -- skipped rather than counted as done.
       and (case when p_deleted then q.deleted_at is null else q.deleted_at is not null end)
       and (q.brand_id is null
            or q.brand_id = public.my_brand()
            or public.is_super_admin())
    returning q.id
  )
  select array_agg(moved.id) into v_updated from moved;

  v_updated := coalesce(v_updated, '{}'::uuid[]);

  return query
  select i.id,
         i.id = any(v_updated),
         case
           when i.id = any(v_updated) then null
           when p_deleted then 'already removed, not found, or not yours'
           else 'not removed, not found, or not yours'
         end
    from unnest(p_ids) as i(id);
end;
$$;

grant execute on function public.bulk_set_question_deleted(uuid[], boolean) to authenticated;

comment on function public.bulk_set_question_deleted(uuid[], boolean) is
  'Soft-remove or restore many questions. Restoration is only reachable at all because 0041 added questions_restore — 0010''s policies both carry `deleted_at is null` and an UPDATE''s USING is evaluated against the OLD row, so removal used to be one-way. SECURITY INVOKER, so questions.retire and the company scope are enforced by policy rather than re-checked here. Never touches usage_count: it is a hand-incremented exposure counter with one writer and no way to recompute it, and a restored question keeps the exposure it earned.';
