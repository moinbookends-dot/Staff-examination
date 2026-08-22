-- ═════════════════════════════════════════════════════════════════════════════
-- 0016 — Published exams are immutable
--
-- THE RULE: once an exam leaves 'draft', its paper, sections and rules are
-- frozen. Only operational fields may still move — the closing time, the status
-- along its lifecycle, and assignments.
--
-- WHY IT IS A TRIGGER AND NOT A UI CONVENTION. A UI that hides fields is a
-- suggestion. This has to hold against psql, a bulk import, a future admin
-- script and anything else that reaches the database, because the thing it
-- protects is an attempt already in flight: a candidate answering question 7 of
-- a paper somebody just redrew is being graded against a paper that no longer
-- exists, and no amount of care afterwards can reconstruct what they saw.
--
-- THE COROLLARY, ALREADY BUILT: duplicate_exam() in 0014. Locking without a
-- copy action means fixing one typo requires rebuilding a 40-question exam by
-- hand — which nobody will do. They will edit the database directly, and then
-- this trigger protects nothing.
--
-- WHY closes_at IS ALLOWED. Extending a window because a shift ran late is
-- routine, harmless and frequent. It changes nothing about what was asked or
-- how it scores. Bringing it forward is equally permitted: an exam pulled early
-- is a management decision, not a data-integrity problem.
-- ═════════════════════════════════════════════════════════════════════════════

-- Valid transitions. 'cancelled' is reachable from scheduled or active because
-- an exam sometimes has to be pulled before or during its window; forcing that
-- through 'archived' would corrupt reporting, since archived implies it ran
-- (see the exam_status comment in 0001).
create or replace function public.exam_status_transition_allowed(
  p_from public.exam_status,
  p_to   public.exam_status
) returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to               then true
    when p_from = 'draft'            then p_to in ('scheduled', 'cancelled')
    when p_from = 'scheduled'        then p_to in ('active', 'cancelled')
    when p_from = 'active'           then p_to in ('completed', 'cancelled')
    when p_from = 'completed'        then p_to = 'archived'
    when p_from = 'cancelled'        then p_to = 'archived'
    else false
  end;
$$;

-- ── The exam row itself ──────────────────────────────────────────────────────
create or replace function public.enforce_exam_immutability()
returns trigger
language plpgsql
as $$
begin
  if not public.exam_status_transition_allowed(old.status, new.status) then
    raise exception 'cannot move an exam from % to %', old.status, new.status
      using errcode = '23514';
  end if;

  -- Drafts are freely editable. Everything below applies only afterwards.
  if old.status = 'draft' then
    return new;
  end if;

  -- The allowlist, stated positively: reset every other column to its old value
  -- and then compare. Written this way on purpose — a blocklist would silently
  -- permit any column added to `exams` in a later migration, which is exactly
  -- the kind of gap that opens years later and surprises everybody.
  if (new.title,            new.description,      new.instructions,
      new.kind,             new.paper_mode,       new.brand_id,
      new.duration_minutes, new.opens_at,         new.timezone,
      new.max_attempts,     new.pass_mark_percent,
      new.shuffle_questions, new.shuffle_options, new.allow_backtrack,
      new.negative_marking_enabled, new.verification_mode,
      new.counts_towards_analytics, new.total_marks, new.question_count,
      new.requires_manual_grading, new.company_id, new.created_by)
     is distinct from
     (old.title,            old.description,      old.instructions,
      old.kind,             old.paper_mode,       old.brand_id,
      old.duration_minutes, old.opens_at,         old.timezone,
      old.max_attempts,     old.pass_mark_percent,
      old.shuffle_questions, old.shuffle_options, old.allow_backtrack,
      old.negative_marking_enabled, old.verification_mode,
      old.counts_towards_analytics, old.total_marks, old.question_count,
      old.requires_manual_grading, old.company_id, old.created_by)
  then
    raise exception
      'this exam is published; only its closing time, status and assignments can change. Duplicate it to make other edits.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger exams_enforce_immutability
  before update on public.exams
  for each row execute function public.enforce_exam_immutability();

-- ── Sections, rules and the frozen paper ─────────────────────────────────────
--
-- One trigger function for all three, resolving the parent exam per table. The
-- alternative — three near-identical functions — is three places to forget.
create or replace function public.enforce_exam_child_immutability()
returns trigger
language plpgsql
as $$
declare
  v_rec     record;
  v_exam_id uuid;
  v_status  public.exam_status;
begin
  -- NEW is unset on DELETE, OLD on INSERT.
  if tg_op = 'DELETE' then v_rec := old; else v_rec := new; end if;

  -- IF/ELSIF, NOT a CASE expression. A CASE compiles every branch, so
  -- `v_rec.section_id` would be resolved even for exam_sections — which has no
  -- such column — and every insert would fail with `record "new" has no field
  -- "section_id"`. Only the branch that runs is compiled here.
  if tg_table_name = 'exam_rules' then
    select s.exam_id into v_exam_id
      from public.exam_sections s where s.id = v_rec.section_id;
  else
    v_exam_id := v_rec.exam_id;
  end if;

  select e.status into v_status from public.exams e where e.id = v_exam_id;

  -- The parent is already gone (cascade delete of the whole exam). Nothing to
  -- protect, and blocking here would make an exam undeletable.
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status <> 'draft' then
    raise exception
      'this exam is published; its questions and rules cannot change. Duplicate it to make edits.'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger exam_sections_enforce_immutability
  before insert or update or delete on public.exam_sections
  for each row execute function public.enforce_exam_child_immutability();

create trigger exam_rules_enforce_immutability
  before insert or update or delete on public.exam_rules
  for each row execute function public.enforce_exam_child_immutability();

-- exam_questions is written by publish_exam(), which runs while the exam is
-- still 'draft' and flips the status afterwards. That ordering is load-bearing:
-- reverse it and publish would be blocked by its own trigger.
create trigger exam_questions_enforce_immutability
  before insert or update or delete on public.exam_questions
  for each row execute function public.enforce_exam_child_immutability();

comment on function public.enforce_exam_immutability() is
  'Published exams accept changes to closes_at, status and updated_by/at only. The check is an allowlist rather than a blocklist so a column added by a future migration is locked by default instead of silently editable.';
