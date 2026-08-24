-- ═══════════════════════════════════════════════════════════════════════════
-- 0080 — A re-import in another language finds the question it belongs to.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE IMPORTER COULD ONLY RECOGNISE A QUESTION BY ITS externalId.           ║
-- ║                                                                           ║
-- ║ That is fine for a corpus generated with ids. It is useless for one       ║
-- ║ imported without them — Capiche's 1,000 questions all carry               ║
-- ║ external_id = NULL — because there is then nothing to match on. Every row ║
-- ║ of a re-import read as NEW, the insert collided with the English-text     ║
-- ║ unique index, and the whole batch rolled back with a message about the    ║
-- ║ recycle bin. Adding Hindi to an existing English bank was impossible.     ║
-- ║                                                                           ║
-- ║ THE FALLBACK IS THE INDEX ITSELF.                                         ║
-- ║ bank_question_texts_dedupe_uq is (brand_id, difficulty,                   ║
-- ║ lower(btrim(question))) WHERE locale = 'en'. Matching on exactly that     ║
-- ║ expression means the lookup and the constraint can never disagree: any    ║
-- ║ row the index would refuse as a duplicate is a row this finds and         ║
-- ║ updates instead.                                                          ║
-- ║                                                                           ║
-- ║ NOT qtype. The index does not include it, so matching on it would         ║
-- ║ classify a type-changed row as new, insert it, and hit the very           ║
-- ║ constraint this exists to avoid. A type mismatch is refused by name.      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.bank_import_commit(p_brand_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_row      jsonb;
  v_text     jsonb;
  v_index    int := 0;
  v_inserted int := 0;
  v_updated  int := 0;

  v_company    uuid := public.my_company();
  v_external   text;
  v_qid        uuid;
  v_found      public.bank_question_type;
  v_english    text;
  v_difficulty public.bank_difficulty;
  v_qtype      public.bank_question_type;
  v_status     public.bank_question_status;
  v_topic_id   uuid;
  v_topic_slug text;
  v_locales    text[];
begin
  if not public.has_perm('bank.write') then
    raise exception 'Not permitted to import questions.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_company is null then
    raise exception 'No company context.' using errcode = 'insufficient_privilege';
  end if;

  if not (p_brand_id = public.my_brand() or public.brand_unscoped()) then
    raise exception 'Not permitted to import into that brand.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.brands b
     where b.id = p_brand_id and b.company_id = v_company and b.deleted_at is null
  ) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array.' using errcode = 'invalid_parameter_value';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;

    v_external   := nullif(btrim(coalesce(v_row->>'externalId', '')), '');
    v_difficulty := (v_row->>'difficulty')::public.bank_difficulty;
    v_qtype      := (v_row->>'qtype')::public.bank_question_type;
    v_status     := (v_row->>'status')::public.bank_question_status;
    v_topic_slug := nullif(btrim(coalesce(v_row->>'topicSlug', '')), '');

    -- The English text this row carries, normalised the way the unique index
    -- normalises what it stores. NFC as well as lower/btrim: two spellings of
    -- the same accented word are the same question to a reader, and should be
    -- to the importer.
    select normalize(lower(btrim(t->>'question')), NFC)
      into v_english
      from jsonb_array_elements(v_row->'texts') as t
     where t->>'locale' = 'en'
     limit 1;

    v_topic_id := null;
    if v_topic_slug is not null then
      select t.id into v_topic_id
        from public.question_topics t
       where t.company_id = v_company
         and t.slug = v_topic_slug
         and t.deleted_at is null;

      if v_topic_id is null then
        raise exception 'Row %: unknown topic "%".', v_index, v_topic_slug
          using errcode = 'foreign_key_violation';
      end if;
    end if;

    -- ── Does it already exist? ───────────────────────────────────────────────
    v_qid := null;
    v_found := null;

    if v_external is not null then
      select q.id, q.qtype into v_qid, v_found
        from public.bank_questions q
       where q.company_id = v_company
         and q.brand_id   = p_brand_id
         and q.external_id = v_external;
    end if;

    /*
     * THE TEXT FALLBACK — how a translation finds its question.
     *
     * Deliberately NOT filtered on deleted_at. The unique index is not either,
     * so a soft-deleted question still holds this English text and an insert
     * would collide with a row nobody can see. Matching it and clearing
     * deleted_at below restores it instead of failing the batch, which is the
     * only outcome that leaves the bank consistent with what the index allows.
     */
    if v_qid is null and v_english is not null then
      select q.id, q.qtype into v_qid, v_found
        from public.bank_question_texts t
        join public.bank_questions q on q.id = t.question_id
       where t.brand_id   = p_brand_id
         and t.locale     = 'en'
         and t.difficulty = v_difficulty
         and normalize(lower(btrim(t.question)), NFC) = v_english
         and q.company_id = v_company
       limit 1;
    end if;

    /*
     * A match whose type disagrees is refused BY NAME rather than converted.
     *
     * Changing qtype on an existing question cascades through
     * bank_question_texts_parent_fk into child rows that still hold the old
     * content, and bank_question_texts_shape then refuses them — an MCQ row
     * needs four options and no answer. The failure would arrive as a
     * constraint violation naming none of this. The dry run rejects these
     * rows before they are ever sent; this is the guard for a bank that
     * changed in between.
     */
    if v_qid is not null and v_found is not null and v_found <> v_qtype then
      raise exception
        'Row %: this question already exists at this level as a % and the file calls it a %.',
        v_index, v_found, v_qtype
        using errcode = 'check_violation';
    end if;

    if v_qid is null then
      insert into public.bank_questions (
        company_id, brand_id, external_id, difficulty, qtype, topic_id,
        correct_option, status, created_by
      ) values (
        v_company, p_brand_id, v_external, v_difficulty, v_qtype, v_topic_id,
        nullif(v_row->>'correctOption', ''),
        'draft', auth.uid()
      )
      returning id into v_qid;

      v_inserted := v_inserted + 1;
    else
      update public.bank_questions
         set status = 'draft'
       where id = v_qid;

      update public.bank_questions
         set difficulty     = v_difficulty,
             qtype          = v_qtype,
             topic_id       = v_topic_id,
             correct_option = nullif(v_row->>'correctOption', ''),
             /*
              * An id is adopted, never dropped. A bank imported without
              * externalIds gets them the first time a file supplies one, so
              * every later import can match on the id directly instead of
              * falling back to the text.
              */
             external_id    = coalesce(v_external, external_id),
             updated_by     = auth.uid(),
             -- Matching a soft-deleted question restores it. See the box above.
             deleted_at     = null
       where id = v_qid;

      v_updated := v_updated + 1;
    end if;

    -- ── The texts ────────────────────────────────────────────────────────────
    v_locales := array[]::text[];

    for v_text in select value from jsonb_array_elements(v_row->'texts') loop
      v_locales := v_locales || (v_text->>'locale');

      insert into public.bank_question_texts (
        question_id, brand_id, difficulty, qtype, locale,
        question, option_a, option_b, option_c, option_d, answer_text, explanation
      ) values (
        v_qid, p_brand_id, v_difficulty, v_qtype, v_text->>'locale',
        v_text->>'question',
        nullif(v_text->>'optionA', ''), nullif(v_text->>'optionB', ''),
        nullif(v_text->>'optionC', ''), nullif(v_text->>'optionD', ''),
        nullif(v_text->>'answerText', ''), nullif(v_text->>'explanation', '')
      )
      on conflict (question_id, locale) do update
        set question    = excluded.question,
            option_a    = excluded.option_a,
            option_b    = excluded.option_b,
            option_c    = excluded.option_c,
            option_d    = excluded.option_d,
            answer_text = excluded.answer_text,
            explanation = excluded.explanation;
    end loop;

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ LANGUAGES MERGE. THEY USED TO BE REPLACED, AND THAT DELETED WORK.     │
     * │                                                                       │
     * │ This once deleted every locale the file did not mention, so that a    │
     * │ bad translation could be retracted by re-importing without it. The    │
     * │ cost was far higher than the benefit: importing an en+hi file onto a  │
     * │ fully translated bank silently destroyed every Gujarati translation   │
     * │ it did not mention — thousands of rows, with no warning and no undo.  │
     * │                                                                       │
     * │ A file now says what it KNOWS, not what should exist. Languages it    │
     * │ carries are written; languages it is silent about are left alone.     │
     * │ Retracting a translation is the editor's job, where it is one         │
     * │ question at a time and visible.                                       │
     * └───────────────────────────────────────────────────────────────────────┘
     */

    -- ── Promote ──────────────────────────────────────────────────────────────
    if v_status <> 'draft' then
      update public.bank_questions
         set status = v_status
       where id = v_qid;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'total',    v_inserted + v_updated
  );
end;
$function$;

comment on function public.bank_import_commit(uuid, jsonb) is
  'Commits an import batch. Recognises an existing question by externalId, then by brand + level + English text — the same expression as bank_question_texts_dedupe_uq — so a re-import in another language updates the question it belongs to rather than colliding with it. Languages merge; a locale the file omits is left untouched. Accepts and ignores referenceTitle/referencePage.';
