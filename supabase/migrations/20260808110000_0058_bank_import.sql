-- ═════════════════════════════════════════════════════════════════════════════
-- 0058 — Bulk import: the permanent external id, and an ATOMIC commit.
--
-- Phase 4 of the Question Bank. Two things the frozen import contract requires
-- and 0054 does not yet provide.
-- ═════════════════════════════════════════════════════════════════════════════

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE CALLER'S OWN IDENTIFIER, CARRIED FOR THE LIFE OF THE QUESTION.        │
-- │                                                                           │
-- │ src/lib/bank/import/format.ts froze `externalId` as permanent: a          │
-- │ re-import matching one UPDATES that question rather than creating a       │
-- │ second. There was nowhere to keep it, so every re-import would have been  │
-- │ an insert, and the only thing standing between a corrected typo and a     │
-- │ duplicate would have been the English-text unique index — which fires     │
-- │ 23505 precisely when the text CHANGED and not when it did not, i.e. the   │
-- │ exact opposite of what is wanted.                                         │
-- │                                                                           │
-- │ Nullable, because a question typed into the editor by hand has no         │
-- │ external identity and must not be made to invent one.                     │
-- └───────────────────────────────────────────────────────────────────────────┘
alter table public.bank_questions
  add column external_id text
    check (external_id is null or length(btrim(external_id)) between 1 and 100);

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SCOPED TO THE BRAND, NOT THE COMPANY.                                     │
-- │                                                                           │
-- │ 0054 chose brand_id NOT NULL with no "shared across brands", and recorded │
-- │ the accepted cost: a food-safety question that applies to every brand is  │
-- │ entered once PER BRAND. The same curated file is therefore imported into  │
-- │ each brand, carrying the same externalIds each time.                      │
-- │                                                                           │
-- │ A company-scoped index would refuse the second brand's import outright,   │
-- │ and the failure would read as "these questions already exist" when what   │
-- │ it means is "this brand has none of them". Brand scoping also matches     │
-- │ bank_question_texts_dedupe_uq, which is already (brand_id, difficulty,    │
-- │ lower(question)) — so both notions of "the same question" agree.          │
-- │                                                                           │
-- │ company_id is kept in the key so the index is usable as a lookup by the   │
-- │ importer's own tenancy filter, not only as a constraint.                  │
-- └───────────────────────────────────────────────────────────────────────────┘
create unique index bank_questions_external_id_uq
  on public.bank_questions (company_id, brand_id, external_id)
  where external_id is not null;

comment on column public.bank_questions.external_id is
  'The curating process''s own permanent identifier. A re-import matching one updates that question instead of inserting a duplicate. Null for questions written by hand in the editor.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The commit
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ ALL OF IT, OR NONE OF IT — AND WITHOUT SECURITY DEFINER.                  ║
-- ║                                                                           ║
-- ║ The requirement is that malformed input can never partially corrupt the   ║
-- ║ bank. Writing 3,000 questions from the application means 3,000 separate   ║
-- ║ statements over PostgREST, each its OWN transaction, and each question    ║
-- ║ needs three of them (0054's completeness trigger cannot see a question's  ║
-- ║ texts during the parent INSERT, so the sequence is draft → texts →        ║
-- ║ promote). A failure at row 2,847 would leave 2,846 questions written and  ║
-- ║ one half-written, and nothing could undo it: bank_questions HAS NO DELETE ║
-- ║ POLICY, deliberately (0055), so the importer cannot even clean up after   ║
-- ║ itself. The bank would be left in a state nobody could describe.          ║
-- ║                                                                           ║
-- ║ One function call is one transaction, so any failure rolls the whole      ║
-- ║ import back and the bank is exactly as it was.                            ║
-- ║                                                                           ║
-- ║ ────────────────────────────────────────────────────────────────────────  ║
-- ║ THIS FUNCTION IS SECURITY INVOKER. THAT IS THE POINT, NOT AN OMISSION.    ║
-- ║                                                                           ║
-- ║ Atomicity needs a transaction; it does NOT need elevated rights. Every    ║
-- ║ statement below runs as the caller and is filtered by the same RLS        ║
-- ║ policies an ordinary insert would meet — bank_questions_insert still      ║
-- ║ demands bank.write, the caller's company and created_by = auth.uid().     ║
-- ║ A Chef calling this RPC directly inserts nothing, because a Chef holds no ║
-- ║ policy on the bank at all.                                                ║
-- ║                                                                           ║
-- ║ bank_pool_counts (0057) is definer because it deliberately reads PAST     ║
-- ║ RLS to return counts to a Chef who may not read the rows. Nothing here    ║
-- ║ needs to see anything the caller cannot, so nothing here is elevated.     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- The row shape is normalised by src/lib/bank/import/commit.ts before it
-- arrives, so this function does no contract parsing: topic slugs are already
-- slugified with the shared topicSlug(), statuses already downgraded where a
-- required translation is missing, and rejected rows already dropped. What
-- arrives is what the dry-run report said would be written.
create or replace function public.bank_import_commit(
  p_brand_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
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
  v_doc_id     uuid;
  v_doc_page   int;
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

    -- A citation is reference material and nothing reads it during generation,
    -- so an unmatched title drops the reference rather than failing the import.
    -- The page goes with it: bank_q_page_needs_document refuses a page number
    -- attached to no document.
    v_doc_id   := null;
    v_doc_page := null;
    if nullif(btrim(coalesce(v_row->>'referenceTitle', '')), '') is not null then
      select d.id into v_doc_id
        from public.source_documents d
       where d.company_id = v_company
         and d.deleted_at is null
         and lower(btrim(coalesce(d.title, d.original_filename)))
             = lower(btrim(v_row->>'referenceTitle'))
       limit 1;

      if v_doc_id is not null then
        v_doc_page := nullif(v_row->>'referencePage', '')::int;
      end if;
    end if;

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
        correct_option, reference_document_id, reference_page, status, created_by
      ) values (
        v_company, p_brand_id, v_external, v_difficulty, v_qtype, v_topic_id,
        nullif(v_row->>'correctOption', ''), v_doc_id, v_doc_page,
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
             reference_document_id = v_doc_id,
             reference_page        = v_doc_page,
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
$$;

revoke execute on function public.bank_import_commit(uuid, jsonb) from public, anon;
grant  execute on function public.bank_import_commit(uuid, jsonb) to authenticated;

comment on function public.bank_import_commit(uuid, jsonb) is
  'Commits a validated import in ONE transaction: all rows or none. SECURITY INVOKER on purpose — RLS still authorises every write, so this provides atomicity without elevation.';
