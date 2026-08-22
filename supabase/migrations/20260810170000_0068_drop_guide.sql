-- ═════════════════════════════════════════════════════════════════════════════
-- 0068 — Remove the document library.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THIS DESTROYS DATA, AND THE MEASUREMENT THAT JUSTIFIED IT IS RECORDED     ║
-- ║ HERE.                                                                     ║
-- ║                                                                           ║
-- ║ Counted on the live database on 10 Aug 2026, before writing this:         ║
-- ║                                                                           ║
-- ║     source_documents       1 row  (one uploaded cookbook PDF)             ║
-- ║     document_pages         0 rows                                         ║
-- ║     import_batches         0 rows                                         ║
-- ║     jobs                   0 rows                                         ║
-- ║     bank_questions citing a document   0 of 199                           ║
-- ║                                                                           ║
-- ║ The Guide was a pipeline for turning cookbooks into draft questions. The  ║
-- ║ owner supplies questions directly through the JSON import, so nothing     ║
-- ║ downstream of it was ever built and nothing upstream depends on it.       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE IMPORT CONTRACT IS NOT CHANGED, AND THAT IS DELIBERATE.               │
-- │                                                                           │
-- │ bank_import_commit still ACCEPTS `referenceTitle` and `referencePage` on  │
-- │ every row, and now ignores both. Stated plainly: a reference sent in is   │
-- │ accepted and discarded, and does not come back on export. The shape       │
-- │ survives; the behaviour does not.                                         │
-- │                                                                           │
-- │ The function below is the LIVE definition with only the document lookup,  │
-- │ its two locals and the four column references removed — not a rewrite.    │
-- │ Its permission key, brand gate, draft→promote ordering and error indexing │
-- │ are untouched.                                                            │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- Ordered so nothing is dropped while something still points at it: the bank's
-- columns first (they carry the FK), then jobs (whose FKs cascade from all
-- three tables), then the tables, then storage.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The bank stops citing documents
-- ═════════════════════════════════════════════════════════════════════════════

-- Both CHECKs go: one tied a page to a document, the other bounded the page.
alter table public.bank_questions
  drop constraint if exists bank_q_page_needs_document,
  drop constraint if exists bank_questions_reference_page_check;

drop index if exists public.bank_questions_reference_idx;

alter table public.bank_questions
  drop column if exists reference_document_id,
  drop column if exists reference_page;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. bank_import_commit stops resolving titles
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bank_import_commit(p_brand_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_row      jsonb;
  v_text     jsonb;
  v_index    int := 0;
  v_inserted int := 0;
  v_updated  int := 0;

  v_company    uuid := public.my_company();
  v_external   text;
  v_qid        uuid;
  v_difficulty public.bank_difficulty;
  v_qtype      public.bank_question_type;
  v_status     public.bank_question_status;
  v_topic_id   uuid;
  v_topic_slug text;
  v_locales    text[];
begin
  -- Checked explicitly so the caller gets a sentence rather than "0 rows
  -- imported", which is what RLS alone would produce — a silent no-op is the
  -- worst possible answer to a 3,000-row import.
  if not public.has_perm('bank.write') then
    raise exception 'Not permitted to import questions.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_company is null then
    raise exception 'No company context.' using errcode = 'insufficient_privilege';
  end if;

  -- The brand gate RLS does not carry: bank_questions_insert checks the
  -- company but not the brand, so without this an Editor pinned to one brand
  -- could import into another brand's bank.
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

    -- Matched, never created. The dry run rejects unknown topics precisely so
    -- a typo cannot quietly become a fifteenth topic; re-deriving that rule
    -- here would be a second place for it to drift.
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

    /*
     * referenceTitle and referencePage are READ AND DISCARDED.
     *
     * They used to resolve against source_documents, which 0068 dropped along
     * with the two columns they filled. The keys stay in the import format
     * because it was frozen with them and a 3,000-question corpus is being
     * generated against that contract — a schema that started rejecting an
     * accepted key would fail every one of those files at once.
     */

    -- ── Does it already exist? ───────────────────────────────────────────────
    v_qid := null;
    if v_external is not null then
      select q.id into v_qid
        from public.bank_questions q
       where q.company_id = v_company
         and q.brand_id   = p_brand_id
         and q.external_id = v_external;
    end if;

    if v_qid is null then
      /*
       * INSERTED AS A DRAFT WHATEVER THE ROW ASKED FOR, then promoted at the
       * end of the row. bank_questions_completeness is a BEFORE INSERT trigger
       * that calls bank_question_missing_locales(new.id) — and on an INSERT no
       * text rows exist yet, so a question inserted directly as 'active' is
       * refused as missing every required language. The editor's saveQuestion
       * does the same three-step dance for the same reason.
       */
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
      /*
       * An update moves the question to DRAFT first, and that is load-bearing.
       *
       * bank_question_texts_completeness fires AFTER UPDATE OR DELETE on the
       * child and refuses to leave an ACTIVE question missing a required
       * language. Rewriting the texts of an active question therefore has to
       * happen while the parent is a draft, or replacing a translation trips a
       * guard against a state that exists only mid-rewrite.
       */
      update public.bank_questions
         set status = 'draft'
       where id = v_qid;

      update public.bank_questions
         set difficulty            = v_difficulty,
             qtype                 = v_qtype,
             topic_id              = v_topic_id,
             correct_option        = nullif(v_row->>'correctOption', ''),
             updated_by            = auth.uid(),
             deleted_at            = null
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

    -- A language removed from the source file is removed from the bank, or a
    -- re-import could never retract a bad translation. Safe here because the
    -- parent is a draft at this point.
    delete from public.bank_question_texts
     where question_id = v_qid
       and not (locale = any (v_locales));

    -- ── Promote ──────────────────────────────────────────────────────────────
    -- Now that the texts exist, the completeness guard can actually evaluate
    -- the question. analyse.ts has already downgraded rows missing a required
    -- language, so this should not raise — and if it does, the whole import
    -- rolls back rather than leaving a half-written bank.
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
  'Commits an import batch. Accepts and ignores referenceTitle/referencePage: the import format was frozen with them and 0068 removed the document library they pointed at.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The library itself
--
-- `jobs` first — 0051 gave it FKs to all three tables below with ON DELETE
-- CASCADE. It was infrastructure for a pipeline that no longer exists, and
-- nothing in src/ has ever referenced it.
-- ═════════════════════════════════════════════════════════════════════════════

drop function if exists public.claim_job(text, text[]);

drop table if exists public.jobs cascade;
drop table if exists public.document_pages cascade;
drop table if exists public.import_batches cascade;
drop table if exists public.source_documents cascade;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Storage
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE POLICIES GO HERE. THE BUCKET AND ITS FILES DO NOT, AND CANNOT.        ║
-- ║                                                                           ║
-- ║ This migration first tried to `delete from storage.objects` and Supabase  ║
-- ║ refused it outright:                                                      ║
-- ║                                                                           ║
-- ║   ERROR: Direct deletion from storage tables is not allowed.              ║
-- ║          Use the Storage API instead. (SQLSTATE 42501)                    ║
-- ║                                                                           ║
-- ║ That guard is right: the rows are an index of objects the storage service ║
-- ║ owns, and deleting them in SQL would orphan the bytes rather than free    ║
-- ║ them. The whole migration rolled back, which is how this was found.       ║
-- ║                                                                           ║
-- ║ So the bucket is emptied and removed by scripts/drop-guide-storage.mjs,   ║
-- ║ which goes through the Storage API. Run it AFTER this migration.          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Dropping the policies here is still correct and still matters: with the
-- tables gone, the has_perm() checks in them refer to a permission nothing
-- grants, and an orphaned policy on storage.objects is a rule nobody can read
-- the purpose of later.
-- ═════════════════════════════════════════════════════════════════════════════

drop policy if exists source_documents_storage_read   on storage.objects;
drop policy if exists source_documents_storage_insert on storage.objects;
drop policy if exists source_documents_storage_update on storage.objects;
