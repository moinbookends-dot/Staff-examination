-- ═════════════════════════════════════════════════════════════════════════════
-- 0018 — Live rule feedback, and one matching predicate to serve it
--
-- WHAT THE BUILDER NEEDS, AND WHY IT IS TWO NUMBERS
--
-- A chef writing "12 questions from Food Safety at difficulty 4–5" wants to
-- know immediately whether the bank can supply them. But a single number is a
-- trap: two rules can match the same questions, and the second only finds out
-- at publish that the first took them.
--
-- So the builder shows both:
--     available — what this rule matches on its own
--     drawn     — what it actually gets once earlier rules have taken theirs
--
-- "23 available, 4 drawn" tells a chef *why* a rule is short while they are
-- still editing it. A lone "23" would say the rule is fine and let publish
-- refuse them later — the exact failure exam_health() exists to prevent.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE REFACTOR THAT MATTERS MORE THAN THE FEATURE.                          │
-- │                                                                           │
-- │ Answering "how many does this rule match?" needs the same predicate       │
-- │ draw_paper() uses. Writing it a second time would mean two definitions of │
-- │ what a rule selects, and they would drift — the builder would promise 23  │
-- │ questions the draw does not agree exist, and nobody would notice until an │
-- │ exam came out short.                                                      │
-- │                                                                           │
-- │ question_pool() below is that predicate, extracted. draw_paper() is       │
-- │ re-issued to call it, so there is exactly ONE definition of "which        │
-- │ questions does this rule match", used by the draw, the live count and the │
-- │ health check alike.                                                       │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── question_pool — the single matching predicate ────────────────────────────
--
-- Takes rule PARAMETERS rather than a rule id, so the builder can ask about a
-- rule the chef is still typing and has not saved. Scoping (company, brand,
-- active, not deleted) comes from the exam, which is why the exam id is
-- required even for a hypothetical rule.
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
       or q.category_id = p_category_id
       or (coalesce(p_include_sub, true)
           and q.category_id in (select c.id from public.categories c
                                  where c.parent_id = p_category_id
                                    and c.deleted_at is null))
     )
     and (p_types is null or q.type = any(p_types))
     and (
       coalesce(array_length(p_tag_ids, 1), 0) = 0
       or exists (select 1 from public.question_tags qt
                   where qt.question_id = q.id and qt.tag_id = any(p_tag_ids))
     );
$$;

revoke all on function public.question_pool(uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint) from public;

-- ── draw_paper, re-issued to use it ──────────────────────────────────────────
--
-- Identical behaviour to 0014 — exact band first, then nearest adjacent
-- difficulty, seeded tie-break, paper-wide exclusion, never crossing a section
-- boundary. The only change is that the WHERE clause now lives in one place.
create or replace function public.draw_paper(p_exam_id uuid, p_seed text)
returns setof public.drawn_question
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rule  record;
  v_row   record;
  v_taken uuid[] := '{}';
  v_pos   int := 0;
  v_out   public.drawn_question;
begin
  if not exists (select 1 from public.exams e where e.id = p_exam_id and e.deleted_at is null) then
    return;
  end if;

  for v_rule in
    select r.*, s.id as sec_id
      from public.exam_rules r
      join public.exam_sections s on s.id = r.section_id
     where s.exam_id = p_exam_id
     order by s.sort_order, s.created_at, r.sort_order, r.created_at
  loop
    for v_row in
      select p.*
        from public.question_pool(
               p_exam_id, v_rule.category_id, v_rule.include_subcategories,
               v_rule.tag_ids, v_rule.question_types,
               v_rule.difficulty_min, v_rule.difficulty_max) p
       where not (p.question_id = any(v_taken))
       order by
         case when p.in_band then 0
              else least(abs(p.difficulty - v_rule.difficulty_min),
                         abs(p.difficulty - v_rule.difficulty_max))
         end,
         md5(p.question_id::text || p_seed)
       limit v_rule.question_count
    loop
      v_pos   := v_pos + 1;
      v_taken := v_taken || v_row.question_id;

      v_out.section_id        := v_rule.sec_id;
      v_out.rule_id           := v_rule.id;
      v_out.question_id       := v_row.question_id;
      v_out.question_revision := v_row.revision;
      v_out.position          := v_pos;
      v_out.marks             := coalesce(v_rule.marks_per_question, v_row.marks);
      v_out.negative_marks    := v_row.negative_marks;
      v_out.fallback_reason   := case when v_row.in_band then null else 'difficulty_widened' end;
      return next v_out;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.draw_paper(uuid, text) from public;

-- ── exam_rule_counts — what the builder shows beside each saved rule ─────────
create or replace function public.exam_rule_counts(p_exam_id uuid)
returns table (rule_id uuid, available int, drawn int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_perm('exams.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id and e.company_id = public.my_company() and e.deleted_at is null
  ) then
    raise exception 'exam not found' using errcode = '42501';
  end if;

  return query
  with drawn_rows as (
    select d.rule_id, count(*)::int as n
      from public.draw_paper(p_exam_id, p_exam_id::text) d
     group by d.rule_id
  )
  select r.id,
         -- IN BAND ONLY. question_pool deliberately returns out-of-band
         -- questions so the draw can widen to adjacent difficulty, but a chef
         -- asking "how many match this rule?" means the rule as they wrote it.
         -- Counting the widened pool would make the difficulty control look
         -- inert — narrow it from 1–5 to 3–3 and the number would not move.
         (select count(*)::int
            from public.question_pool(
                   p_exam_id, r.category_id, r.include_subcategories,
                   r.tag_ids, r.question_types, r.difficulty_min, r.difficulty_max) p
           where p.in_band),
         coalesce(dr.n, 0)
    from public.exam_rules r
    join public.exam_sections s on s.id = r.section_id and s.exam_id = p_exam_id
    left join drawn_rows dr on dr.rule_id = r.id;
end;
$$;

grant execute on function public.exam_rule_counts(uuid) to authenticated;

-- ── preview_rule_count — for a rule the chef has not saved yet ───────────────
--
-- The "available" half only. A hypothetical rule has no position in the running
-- order, so "drawn" is not a question that can be answered about it — and
-- inventing an answer would be worse than omitting one.
create or replace function public.preview_rule_count(
  p_exam_id      uuid,
  p_category_id  uuid    default null,
  p_include_sub  boolean default true,
  p_tag_ids      uuid[]  default '{}',
  p_types        public.question_type[] default null,
  p_difficulty_min smallint default 1,
  p_difficulty_max smallint default 5
)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not public.has_perm('exams.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id and e.company_id = public.my_company() and e.deleted_at is null
  ) then
    raise exception 'exam not found' using errcode = '42501';
  end if;

  -- In band only, for the same reason as exam_rule_counts: this number moves
  -- when the chef moves the difficulty slider, which is the whole point of
  -- showing it while they edit.
  select count(*)::int into v_n
    from public.question_pool(p_exam_id, p_category_id, p_include_sub,
                              p_tag_ids, p_types, p_difficulty_min, p_difficulty_max) p
   where p.in_band;
  return v_n;
end;
$$;

grant execute on function public.preview_rule_count(
  uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint
) to authenticated;

comment on function public.question_pool(uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint) is
  'THE single definition of which questions a rule matches. draw_paper(), exam_rule_counts() and preview_rule_count() all call it. A second copy of this predicate would let the builder promise questions the draw does not agree exist.';
comment on function public.exam_rule_counts(uuid) is
  'Per rule: how many questions it matches on its own, and how many it actually gets once earlier rules have taken theirs. The second number is why publish does not surprise anybody.';
