-- ═════════════════════════════════════════════════════════════════════════════
-- 0013 — Authoring: atomic save, and a reachable change_note
--
-- Two problems the application layer cannot solve on its own.
--
-- ── 1. A QUESTION AND ITS ANSWER KEY MUST LAND TOGETHER ──────────────────────
--
-- supabase-js has no transactions. Saving from the editor would be two round
-- trips: insert the question, then insert the key. If the second fails —
-- network, a policy, a bad payload — the bank keeps a question with no answer
-- key. Nothing surfaces that: it lists normally, it edits normally, and it is
-- ungradeable. The failure appears weeks later, mid-exam, as a question worth
-- zero marks for everybody.
--
-- save_question() does both in one function call, therefore one transaction.
--
-- SECURITY INVOKER (the default, stated explicitly here because it is load
-- bearing): every RLS policy from 0010 still applies to the statements inside.
-- questions_insert still asserts created_by = auth.uid(); answer_keys_write
-- still demands questions.create. A SECURITY DEFINER function here would
-- bypass all of it and quietly become the one write path with no authorisation.
--
-- ── 2. question_revisions.change_note IS CURRENTLY UNWRITABLE ────────────────
--
-- 0012 declares the column and its table comment promises it is "surfaced in
-- the history view so a diff does not have to be read". But nothing writes it:
-- history rows are produced by triggers, and a trigger cannot know WHY a chef
-- made an edit. The intent is only available at the call site.
--
-- Passing it as a transaction-local GUC is the only route that does not require
-- either an extra column on `questions` (which would then bump the revision it
-- is describing) or an UPDATE on question_revisions (which has no update policy
-- BY DESIGN — the table is append-only).
--
-- Both set_config() and current_setting() take is_local/missing_ok = true, so
-- the note dies with the transaction and every other writer — seeds, psql, the
-- bulk importer — keeps working with a null note rather than erroring on an
-- unset parameter.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Re-issued from 0012, now reading the note ────────────────────────────────
-- Identical to the original except for the change_note column. Replayed in
-- order, this is the version that survives.
create or replace function public.capture_question_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  jsonb;
  v_note text;
begin
  -- Only snapshot when the revision actually moved. 0011's trigger bumps only
  -- on substantive change, so this inherits that definition rather than
  -- restating it — one place decides what "a different question" means.
  if tg_op = 'UPDATE' and new.revision = old.revision then
    return new;
  end if;

  select answer_key into v_key
    from public.question_answer_keys
   where question_id = new.id;

  -- Set by save_question(). Absent for every other writer, which is fine.
  v_note := nullif(current_setting('app.change_note', true), '');

  insert into public.question_revisions (
    question_id, revision, stem, content, answer_key,
    response_format, question_type, marks, negative_marks, content_version,
    edited_by, change_note
  )
  values (
    new.id, new.revision, new.stem, new.content, v_key,
    new.response_format, new.type, new.marks, new.negative_marks, new.content_version,
    coalesce(new.updated_by, new.created_by), v_note
  )
  -- The answer-key trigger may already have written this revision; whichever
  -- fires second fills in what the first could not see.
  on conflict (question_id, revision) do update
    set stem            = excluded.stem,
        content         = excluded.content,
        answer_key      = coalesce(excluded.answer_key, public.question_revisions.answer_key),
        response_format = excluded.response_format,
        question_type   = excluded.question_type,
        marks           = excluded.marks,
        negative_marks  = excluded.negative_marks,
        content_version = excluded.content_version,
        change_note     = coalesce(excluded.change_note, public.question_revisions.change_note);

  return new;
end;
$$;

-- The answer-key path needs the same treatment: changing only the correct
-- answer bumps the revision (0011) and produces a history row through THIS
-- trigger, not the one above. Without the note here, "fixed the correct answer"
-- — the single most important edit anyone ever makes — would be the one edit
-- with no explanation attached.
create or replace function public.capture_answer_key_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev  int;
  v_note text;
begin
  select revision into v_rev from public.questions where id = new.question_id;
  if v_rev is null then
    return new;
  end if;

  v_note := nullif(current_setting('app.change_note', true), '');

  insert into public.question_revisions (
    question_id, revision, stem, content, answer_key,
    response_format, question_type, marks, negative_marks, content_version,
    edited_by, change_note
  )
  select q.id, q.revision, q.stem, q.content, new.answer_key,
         q.response_format, q.type, q.marks, q.negative_marks, q.content_version,
         coalesce(q.updated_by, q.created_by), v_note
    from public.questions q
   where q.id = new.question_id
  on conflict (question_id, revision) do update
    set answer_key  = excluded.answer_key,
        change_note = coalesce(public.question_revisions.change_note, excluded.change_note);

  return new;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- save_question — the single write path for the editor
--
-- Insert and update in one function because the editor does not distinguish
-- them: "save" is one button, and splitting it would duplicate the tag-set and
-- answer-key logic across two functions that must not drift.
--
-- p_id null  → create. created_by is auth.uid(), never a parameter: the RLS
--              policy asserts it, and accepting it would invite a client to
--              claim someone else's authorship.
-- p_id given → update. company_id and created_by are never touched.
--
-- Content is validated by Zod at the action boundary and by the q_content_valid
-- CHECK here. Both are deliberately draft-level: a half-written question must
-- be savable. Publishing is the strict gate, and lives in TypeScript
-- (src/lib/questions/publish.ts) because it needs cross-table validation the
-- CHECK cannot express.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.save_question(
  p_id              uuid,
  p_type            public.question_type,
  p_response_format public.response_format,
  p_stem            text,
  p_content         jsonb,
  p_answer_key      jsonb,
  p_brand_id        uuid    default null,
  p_category_id     uuid    default null,
  p_difficulty      smallint default 3,
  p_marks           numeric  default 1,
  p_negative_marks  numeric  default 0,
  p_estimated_seconds int    default null,
  p_explanation     text    default null,
  p_reference_note  text    default null,
  p_tag_ids         uuid[]  default '{}',
  p_change_note     text    default null
)
returns table (id uuid, revision int, status public.question_status)
language plpgsql
security invoker            -- LOAD BEARING. See the header.
set search_path = public
as $$
declare
  v_id  uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Transaction-local, read by both capture triggers. Cleared automatically at
  -- commit, so a later statement in another transaction cannot inherit it.
  perform set_config('app.change_note', coalesce(p_change_note, ''), true);

  if p_id is null then
    insert into public.questions (
      company_id, brand_id, type, response_format, stem, content,
      category_id, difficulty, marks, negative_marks, estimated_seconds,
      explanation, reference_note, created_by
    )
    values (
      public.my_company(), p_brand_id, p_type, p_response_format, p_stem, p_content,
      p_category_id, p_difficulty, p_marks, p_negative_marks, p_estimated_seconds,
      p_explanation, p_reference_note, v_uid
    )
    returning questions.id into v_id;
  else
    update public.questions q
       set type              = p_type,
           response_format   = p_response_format,
           stem              = p_stem,
           content           = p_content,
           brand_id          = p_brand_id,
           category_id       = p_category_id,
           difficulty        = p_difficulty,
           marks             = p_marks,
           negative_marks    = p_negative_marks,
           estimated_seconds = p_estimated_seconds,
           explanation       = p_explanation,
           reference_note    = p_reference_note,
           updated_by        = v_uid
     where q.id = p_id
     returning q.id into v_id;

    -- Null means RLS returned no row: wrong company, soft-deleted, or the
    -- caller lacks questions.update. Indistinguishable on purpose — telling a
    -- caller which one confirms the question exists.
    if v_id is null then
      raise exception 'question not found or not editable' using errcode = '42501';
    end if;
  end if;

  insert into public.question_answer_keys (question_id, answer_key)
  values (v_id, p_answer_key)
  on conflict (question_id) do update
    set answer_key = excluded.answer_key
  -- Skip the write entirely when the key is unchanged. Without this, every
  -- save of an unrelated field (a typo in the explanation) would fire
  -- bump_revision_from_answer_key and invent a revision — fragmenting exactly
  -- the analytics 0011 exists to protect.
  where public.question_answer_keys.answer_key is distinct from excluded.answer_key;

  -- Tags are a replace-set, not a merge: the editor sends the complete list, so
  -- a merge would make removing a tag impossible.
  delete from public.question_tags qt
   where qt.question_id = v_id
     and (p_tag_ids is null or not (qt.tag_id = any(p_tag_ids)));

  if p_tag_ids is not null and array_length(p_tag_ids, 1) > 0 then
    insert into public.question_tags (question_id, tag_id)
    select v_id, unnest(p_tag_ids)
    on conflict do nothing;
  end if;

  return query
    select q.id, q.revision, q.status from public.questions q where q.id = v_id;
end;
$$;

grant execute on function public.save_question(
  uuid, public.question_type, public.response_format, text, jsonb, jsonb,
  uuid, uuid, smallint, numeric, numeric, int, text, text, uuid[], text
) to authenticated;

comment on function public.save_question(
  uuid, public.question_type, public.response_format, text, jsonb, jsonb,
  uuid, uuid, smallint, numeric, numeric, int, text, text, uuid[], text
) is
  'Single write path for the question editor. Question, answer key and tag set in one transaction, because a question saved without its key is ungradeable and nothing surfaces that until an exam runs. SECURITY INVOKER so every 0010 policy still applies. p_change_note travels to the capture triggers via a transaction-local GUC.';
