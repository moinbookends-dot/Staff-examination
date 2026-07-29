-- ═════════════════════════════════════════════════════════════════════════════
-- 0032 — Authoring question translations
--
-- `question_translations` has existed since 0009 with RLS, a draft/review/
-- published workflow and a partial index, and no code has ever written to it.
-- This is the write path.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ 0009's INVARIANT, MECHANISED.                                             │
-- │                                                                           │
-- │ That migration's comment says a translation holds "display strings keyed  │
-- │ by the base row's ids — never correct answers", so "a bad or malicious    │
-- │ translation cannot change what is correct". Until now that was a comment. │
-- │                                                                           │
-- │ validate_translation_shape() turns it into a CHECK: the content must be   │
-- │ an object whose keys are drawn only from those legal for the format, and  │
-- │ EVERY LEAF MUST BE A STRING. A structure whose leaves are all display     │
-- │ strings keyed by ids has nowhere to put "and this one is right".          │
-- │                                                                           │
-- │ A constraint rather than a validator in the RPC, because the RPC is not   │
-- │ the only writer — psql, a seed, a bulk import and an AI generation pass   │
-- │ all bypass it. This is the same two-tier split 0009 used for question     │
-- │ content: Zod at the boundary for good messages, a CHECK underneath for    │
-- │ everything that skips the boundary.                                       │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Two columns ──────────────────────────────────────────────────────────────

alter table public.question_translations
  -- Denormalised from questions, on purpose: a CHECK cannot subquery, so the
  -- format has to be ON the row for the shape rule to be a constraint at all.
  add column if not exists response_format public.response_format,
  -- The wording this translation was made from. Without it, rewording an
  -- English stem leaves the published Hindi describing text that no longer
  -- exists — delivered with more confidence than the English, and silent.
  add column if not exists base_revision int;

update public.question_translations t
   set response_format = q.response_format,
       base_revision   = coalesce(t.base_revision, q.revision)
  from public.questions q
 where q.id = t.question_id
   and (t.response_format is null or t.base_revision is null);

alter table public.question_translations
  alter column response_format set not null,
  alter column base_revision   set not null,
  drop constraint if exists question_translations_base_revision_positive;
alter table public.question_translations
  add constraint question_translations_base_revision_positive check (base_revision > 0);

comment on column public.question_translations.base_revision is
  'questions.revision at the time this translation was written. A translation whose base_revision is behind the question''s current revision describes wording that no longer exists — stale, and invisible without this column.';

comment on column public.question_translations.response_format is
  'Copied from the parent question so the shape CHECK can see it. A CHECK constraint cannot subquery, and the presentation-only rule is worth more as a constraint than as a comment.';

-- Keeps the copy honest without asking the RPC to remember.
create or replace function public.question_translation_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select q.response_format, coalesce(new.base_revision, q.revision)
    into new.response_format, new.base_revision
    from public.questions q
   where q.id = new.question_id;

  if new.response_format is null then
    raise exception 'question not found' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists question_translations_stamp on public.question_translations;
create trigger question_translations_stamp
  before insert or update of question_id on public.question_translations
  for each row execute function public.question_translation_stamp();

-- ═════════════════════════════════════════════════════════════════════════════
-- Tier 1 — structure, as a CHECK
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.validate_translation_shape(
  p_format public.response_format,
  p_content jsonb
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_allowed text[];
  v_key text;
  v_value jsonb;
  v_leaf jsonb;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    return false;
  end if;

  -- Which keys carry translatable display strings, per format. Formats absent
  -- from this list have nothing to translate beyond the stem, and are held to
  -- an empty object — which is itself the proof that a translation of a
  -- true/false question cannot carry an answer.
  v_allowed := case p_format
    when 'choice_single'  then array['choices']
    when 'choice_multi'   then array['choices']
    when 'blanks'         then array['template', 'blankLabels']
    when 'pairs'          then array['left', 'right']
    when 'order'          then array['items']
    when 'evaluator_only' then array['instructions']
    else array[]::text[]
  end;

  for v_key, v_value in select * from jsonb_each(p_content) loop
    if not (v_key = any(v_allowed)) then
      return false;
    end if;

    if v_key in ('template', 'instructions') then
      -- A bare string.
      if jsonb_typeof(v_value) <> 'string' then
        return false;
      end if;
    else
      -- A map of id → display string. Every leaf a string, no exceptions:
      -- this is the clause that makes "cannot express what is correct" true.
      if jsonb_typeof(v_value) <> 'object' then
        return false;
      end if;
      for v_leaf in select value from jsonb_each(v_value) loop
        if jsonb_typeof(v_leaf) <> 'string' then
          return false;
        end if;
      end loop;
    end if;
  end loop;

  return true;
end;
$$;

alter table public.question_translations
  drop constraint if exists question_translations_presentation_only;
alter table public.question_translations
  add constraint question_translations_presentation_only
  check (public.validate_translation_shape(response_format, content));

comment on constraint question_translations_presentation_only on public.question_translations is
  '0009 said a translation holds display strings and never correct answers. This is that sentence as a constraint: keys drawn only from those legal for the format, and every leaf a string. It holds against psql, seeds, bulk import and AI generation, none of which go through the RPC.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Tier 2 — agreement with the base row
--
-- Cross-table, so it cannot be a CHECK. Returns problems rather than raising,
-- so the RPC can report all of them at once instead of the first.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.validate_translation_against_base(
  p_question_id uuid,
  p_content jsonb
)
returns text[]
language plpgsql
stable
-- INVOKER, and deliberately so. It is called from save_question_translation,
-- which is itself invoker precisely to keep 0031's policies in force; a definer
-- helper would both break that composition (the caller has no EXECUTE on a
-- revoked function) and let this confirm the existence of another company's
-- question. Under the caller's own RLS, a question they cannot see is simply
-- "not found" — which is the honest answer and the same one 0010 gives.
security invoker
set search_path = public
as $$
declare
  v_q record;
  v_problems text[] := array[]::text[];
  v_key text;
  v_id text;
  v_base_ids text[];
  v_base_placeholders text[];
  v_t_placeholders text[];
begin
  select q.content, q.response_format into v_q
    from public.questions q where q.id = p_question_id and q.deleted_at is null;

  if v_q is null then
    return array['question not found'];
  end if;

  -- Every translated id must exist on the base row. A translation naming an
  -- option that was deleted renders nothing and looks like a missing string.
  for v_key in select jsonb_object_keys(p_content) loop
    if v_key in ('template', 'instructions') then
      continue;
    end if;

    v_base_ids := case v_key
      when 'choices'     then array(select jsonb_array_elements(v_q.content -> 'choices') ->> 'id')
      when 'left'        then array(select jsonb_array_elements(v_q.content -> 'left') ->> 'id')
      when 'right'       then array(select jsonb_array_elements(v_q.content -> 'right') ->> 'id')
      when 'items'       then array(select jsonb_array_elements(v_q.content -> 'items') ->> 'id')
      when 'blankLabels' then array(select jsonb_array_elements(v_q.content -> 'blanks') ->> 'id')
      else array[]::text[]
    end;

    for v_id in select jsonb_object_keys(p_content -> v_key) loop
      if not (v_id = any(v_base_ids)) then
        v_problems := v_problems || format('%s: no "%s" in the question', v_key, v_id);
      end if;
    end loop;
  end loop;

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ THE ONE THAT MATTERS MOST.                                              │
  -- │                                                                         │
  -- │ A blanks template carries {{id}} placeholders, and the renderer turns   │
  -- │ each into an input box. A translated template that drops one renders    │
  -- │ FEWER BOXES THAN THERE ARE GRADED BLANKS: the candidate cannot answer   │
  -- │ something they are marked on, attempt_answers has no key for it, and    │
  -- │ 0027 scores it wrong. Nothing anywhere reports it. Blocking, not        │
  -- │ advisory.                                                               │
  -- └─────────────────────────────────────────────────────────────────────────┘
  if v_q.response_format = 'blanks' and p_content ? 'template' then
    v_base_placeholders := array(
      select distinct m[1] from regexp_matches(v_q.content ->> 'template', '\{\{(\w+)\}\}', 'g') m
       order by 1);
    v_t_placeholders := array(
      select distinct m[1] from regexp_matches(p_content ->> 'template', '\{\{(\w+)\}\}', 'g') m
       order by 1);

    if v_base_placeholders is distinct from v_t_placeholders then
      v_problems := v_problems || format(
        'template: the blanks must match the question exactly (question has %s, translation has %s)',
        coalesce(array_to_string(v_base_placeholders, ', '), 'none'),
        coalesce(array_to_string(v_t_placeholders, ', '), 'none'));
    end if;
  end if;

  return v_problems;
end;
$$;

-- Granted, unlike the internal helpers of 0020: this one bypasses nothing. It
-- reads `questions` as the caller and returns only a list of problems, so a
-- caller learns nothing they could not learn by selecting the row themselves.
grant execute on function public.validate_translation_against_base(uuid, jsonb)
  to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- save_question_translation — the only write path the application uses
--
-- SECURITY INVOKER, for the same reason save_question is (0013): 0031's
-- policies must still apply. A definer here would silently discard the company
-- scoping this milestone just added.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.save_question_translation(
  p_question_id uuid,
  p_locale      text,
  p_stem        text,
  p_content     jsonb,
  p_explanation text default null,
  p_status      text default 'draft',
  p_source      text default 'human',
  p_expected_updated_at timestamptz default null
)
returns table (question_id uuid, locale text, status text, base_revision int, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
-- The RETURNS TABLE names (question_id, locale, status, …) are also column
-- names on the table being written, so an unqualified reference in RETURNING is
-- ambiguous. Resolve to the column: nothing here reads the output variables.
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_existing record;
  v_problems text[];
  v_status text := p_status;
  v_reviewed_by uuid;
  v_translated_by uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_locale not in ('en', 'hi', 'gu', 'hi-Latn') then
    raise exception 'unknown language: %', p_locale using errcode = '22023';
  end if;
  if p_status not in ('draft', 'review', 'published') then
    raise exception 'unknown status: %', p_status using errcode = '22023';
  end if;

  v_problems := public.validate_translation_against_base(p_question_id, p_content);
  if array_length(v_problems, 1) > 0 then
    raise exception '%', array_to_string(v_problems, '; ') using errcode = '22023';
  end if;

  select * into v_existing
    from public.question_translations t
   where t.question_id = p_question_id and t.locale = p_locale;

  -- Two translators on one primary key is a real collision, not a theoretical
  -- one — the whole point of this screen is that somebody else does the work.
  if p_expected_updated_at is not null
     and v_existing.updated_at is not null
     and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'somebody else saved this translation while you were editing it'
      using errcode = '40001';
  end if;

  -- ── Status transitions ────────────────────────────────────────────────────
  if v_existing is null or v_existing.question_id is null then
    if p_status = 'published' then
      raise exception 'a new translation cannot start published' using errcode = '22023';
    end if;
  elsif v_existing.status = 'draft' and p_status = 'published' then
    raise exception 'a translation must be reviewed before it is published'
      using errcode = '22023';
  elsif v_existing.status = 'published' and p_status = 'published'
        and (v_existing.stem is distinct from p_stem
             or v_existing.content is distinct from p_content) then
    -- THE ROW THAT MAKES 'published' MEAN ANYTHING. Without it a reviewer
    -- approves text, the translator rewrites it, and the row stays green while
    -- serving unreviewed strings to candidates.
    v_status := 'review';
  end if;

  -- First author keeps authorship; the reviewer is whoever moved it to
  -- published, and stops being anybody the moment it leaves that state.
  v_translated_by := coalesce(v_existing.translated_by, v_uid);
  v_reviewed_by := case when v_status = 'published' then v_uid else null end;

  return query
  insert into public.question_translations as t (
    question_id, locale, stem, content, explanation,
    status, source, translated_by, reviewed_by, base_revision
  )
  values (
    p_question_id, p_locale, p_stem, p_content, p_explanation,
    v_status, p_source, v_translated_by, v_reviewed_by,
    (select q.revision from public.questions q where q.id = p_question_id)
  )
  on conflict (question_id, locale) do update
    set stem = excluded.stem,
        content = excluded.content,
        explanation = excluded.explanation,
        status = excluded.status,
        source = excluded.source,
        translated_by = excluded.translated_by,
        reviewed_by = excluded.reviewed_by,
        -- Re-stamped: an edit is a translation OF the current wording.
        base_revision = excluded.base_revision,
        updated_at = now()
  returning t.question_id, t.locale, t.status, t.base_revision, t.updated_at;
end;
$$;

grant execute on function public.save_question_translation(uuid, text, text, jsonb, text, text, text, timestamptz)
  to authenticated;

comment on function public.save_question_translation(uuid, text, text, jsonb, text, text, text, timestamptz) is
  'The application''s write path for translations. SECURITY INVOKER so 0031''s company scoping still applies. Enforces the review workflow: a new row cannot start published, a draft cannot skip review, and editing a published translation demotes it back to review rather than leaving a reviewer''s approval attached to text they never saw.';
