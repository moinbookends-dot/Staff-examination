-- ═════════════════════════════════════════════════════════════════════════════
-- 0038 — M8 Enhanced save_question RPC
--
-- Replaces save_question to include the new metadata fields from 0037.
-- ═════════════════════════════════════════════════════════════════════════════

-- We must drop the old function first because the signature changes.
drop function if exists public.save_question(uuid, public.question_type, public.response_format, text, jsonb, jsonb, uuid, uuid, smallint, numeric, numeric, int, text, text, uuid[], text);

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
  p_change_note     text    default null,
  p_bloom_level     public.bloom_taxonomy default null,
  p_source          text    default 'manual',
  p_imported_from   text    default null
)
returns table (id uuid, revision int, status public.question_status)
language plpgsql
security invoker            
set search_path = public
as $$
declare
  v_id  uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  perform set_config('app.change_note', coalesce(p_change_note, ''), true);

  if p_id is null then
    insert into public.questions (
      company_id, brand_id, type, response_format, stem, content,
      category_id, difficulty, marks, negative_marks, estimated_seconds,
      explanation, reference_note, created_by,
      bloom_level, source, imported_from
    )
    values (
      public.my_company(), p_brand_id, p_type, p_response_format, p_stem, p_content,
      p_category_id, p_difficulty, p_marks, p_negative_marks, p_estimated_seconds,
      p_explanation, p_reference_note, v_uid,
      p_bloom_level, p_source, p_imported_from
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
           updated_by        = v_uid,
           bloom_level       = p_bloom_level,
           source            = coalesce(p_source, source),
           imported_from     = p_imported_from
     where q.id = p_id
     returning q.id into v_id;

    if v_id is null then
      raise exception 'question not found or not editable' using errcode = '42501';
    end if;
  end if;

  insert into public.question_answer_keys (question_id, answer_key)
  values (v_id, p_answer_key)
  on conflict (question_id) do update
    set answer_key = excluded.answer_key
  where public.question_answer_keys.answer_key is distinct from excluded.answer_key;

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
  uuid, uuid, smallint, numeric, numeric, int, text, text, uuid[], text,
  public.bloom_taxonomy, text, text
) to authenticated;
