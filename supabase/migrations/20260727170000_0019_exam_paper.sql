-- ═════════════════════════════════════════════════════════════════════════════
-- 0019 — exam_paper: what this exam actually asks
--
-- ONE FUNCTION, TWO SOURCES, and the caller does not have to know which:
--
--   frozen (paper_mode='fixed', published)  → the real exam_questions rows
--   otherwise                               → a representative draw
--
-- A chef looking at an exam asks the same question in both cases — "what will
-- people be asked?" — so making them call different endpoints, or worse read a
-- preview for a published exam and believe it was the paper, is a distinction
-- that serves the schema rather than the person.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE PREVIEW OF A per_attempt EXAM IS NOT ANYBODY'S PAPER.                 │
-- │                                                                           │
-- │ Every candidate draws their own at attempt start, seeded by their attempt │
-- │ id. This returns one draw so a chef can see the shape and difficulty of   │
-- │ what the rules produce. `is_preview` says so in the result, and the UI    │
-- │ must repeat it — a chef who believes they are looking at THE paper will   │
-- │ reasonably conclude the exam is broken when a candidate reports different │
-- │ questions.                                                                │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- SECURITY: snapshots come from question_snapshot() in both branches, which is
-- the one function that builds a candidate-visible payload and never reads
-- question_answer_keys or question_revisions. There is no second path here that
-- could assemble a question with its key attached.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.exam_paper(p_exam_id uuid, p_seed text default null)
returns table (
  section_id        uuid,
  section_title     text,
  question_id       uuid,
  question_revision int,
  -- NOT `position`: it is a reserved word for function parameters in Postgres,
  -- allowed as a table column but not as a RETURNS TABLE output name.
  paper_position    int,
  marks             numeric(6,2),
  negative_marks    numeric(6,2),
  fallback_reason   text,
  snapshot          jsonb,
  is_preview        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_frozen boolean;
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

  select exists (select 1 from public.exam_questions eq where eq.exam_id = p_exam_id)
    into v_frozen;

  if v_frozen then
    -- The real paper. Note this reads the STORED snapshot rather than rebuilding
    -- it: a question edited after publication must not change what the frozen
    -- paper shows, which is the entire point of freezing it.
    return query
      select eq.section_id, s.title, eq.question_id, eq.question_revision,
             eq.position, eq.marks, eq.negative_marks, eq.fallback_reason,
             eq.snapshot, false
        from public.exam_questions eq
        join public.exam_sections s on s.id = eq.section_id
       where eq.exam_id = p_exam_id
       order by eq.position;
  else
    return query
      select d.section_id, s.title, d.question_id, d.question_revision,
             d.position, d.marks, d.negative_marks, d.fallback_reason,
             public.question_snapshot(d.question_id), true
        from public.draw_paper(p_exam_id, coalesce(p_seed, p_exam_id::text)) d
        join public.exam_sections s on s.id = d.section_id
       order by d.position;
  end if;
end;
$$;

grant execute on function public.exam_paper(uuid, text) to authenticated;

comment on function public.exam_paper(uuid, text) is
  'What this exam asks: the frozen exam_questions rows when they exist, otherwise a representative draw with is_preview=true. Reads stored snapshots for a published paper so that editing a question afterwards cannot change what candidates were shown. Never touches question_answer_keys — snapshots come from question_snapshot().';
