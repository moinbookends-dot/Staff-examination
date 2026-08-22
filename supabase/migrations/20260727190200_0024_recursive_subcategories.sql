-- ═════════════════════════════════════════════════════════════════════════════
-- 0024 — include_subcategories descends the whole tree, not one level
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT WAS WRONG                                                            │
-- │                                                                           │
-- │ question_pool matched sub-categories with                                 │
-- │                                                                           │
-- │     q.category_id in (select id from categories where parent_id = X)      │
-- │                                                                           │
-- │ — exactly ONE level. categories.parent_id is self-referencing with no     │
-- │ depth limit, createCategory accepts any parentId, and the seed ALREADY    │
-- │ ships two levels (Food Safety → Temperature Control). So a chef who adds  │
-- │ "Fridge Checks" under "Temperature Control" has questions that            │
-- │ "Food Safety, include sub-categories" silently will not draw.             │
-- │                                                                           │
-- │ Silently is the problem. The rule looks satisfied, the builder's count is │
-- │ lower than the chef expects for reasons they cannot see, and if it drops  │
-- │ below the requested count the paper is short with no indication why.      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- UNION, NOT UNION ALL, in the recursive term. parent_id has no cycle
-- constraint, so A→B→A is representable. UNION deduplicates the working table,
-- which makes the recursion terminate on a cycle instead of spinning forever
-- and taking the connection with it. The self-parent CHECK below removes the
-- one-node case outright; UNION covers the rest.
-- ═════════════════════════════════════════════════════════════════════════════

-- A category cannot be its own parent. Cheap, and it removes the shortest cycle
-- before it can be created.
alter table public.categories
  add constraint categories_not_self_parent check (parent_id is null or parent_id <> id);

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
     and q.status = 'active'
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

revoke all on function public.question_pool(
  uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint
) from public, anon, authenticated;

comment on function public.question_pool(uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint) is
  'THE single definition of which questions a rule matches. draw_paper(), exam_rule_counts() and preview_rule_count() all call it. Descends the category tree to any depth when include_subcategories is set — a single-level join silently excluded questions filed two levels down, which the seed already ships. INTERNAL: granted to nobody.';
