-- ═════════════════════════════════════════════════════════════════════════════
-- 0033 — Serving a question in the candidate's language
--
-- MUST BE DEPLOYED AFTER 0031. question_snapshot() is SECURITY DEFINER and
-- reads question_translations with RLS bypassed; on the pre-0031 policies a
-- translation written by another company would go straight into these
-- candidates' browsers.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE SNAPSHOT CARRIES EVERY LANGUAGE, AND PICKS NONE.                      │
-- │                                                                           │
-- │ A `fixed` paper is frozen at publish, before any candidate exists, and    │
-- │ start_attempt copies those rows verbatim. There is therefore no moment at │
-- │ freeze time when "which locale?" has an answer — and a snapshot          │
-- │ specialised to one language could not serve a kitchen where three are    │
-- │ spoken.                                                                   │
-- │                                                                           │
-- │ So the snapshot embeds every PUBLISHED translation, and the locale is     │
-- │ chosen at read time from data that was already frozen. One paper, several │
-- │ renderings: the freeze guarantee 0014 and 0019 went to such lengths to    │
-- │ establish survives intact, and a translation edited mid-exam still cannot │
-- │ change what anybody sees.                                                 │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SQL SELECTS THE LOCALE. TYPESCRIPT MERGES THE SHAPES.                     │
-- │                                                                           │
-- │ The base carries `choices` as an ARRAY of {id, text}; a translation      │
-- │ carries it as an OBJECT of id → text. jsonb's `||` is a shallow merge, so │
-- │ `base || translation` REPLACES the array with the object and every        │
-- │ renderer breaks on `.map`. There is no correct one-liner.                 │
-- │                                                                           │
-- │ Doing it properly in SQL means reimplementing nine content shapes in      │
-- │ PL/pgSQL beside the TypeScript mergeTranslation() the workbench already   │
-- │ uses — and two implementations of "which text goes with which id" drift   │
-- │ into a candidate reading an option whose text no longer matches its id.   │
-- │ So localise_snapshot() picks and strips; getAttemptPaper() merges.        │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ── question_snapshot: one new key ───────────────────────────────────────────
create or replace function public.question_snapshot(p_question_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'question_id',     q.id,
    'revision',        q.revision,
    'type',            q.type,
    'response_format', q.response_format,
    'content_version', q.content_version,
    'stem',            q.stem,
    'content',         q.content,          -- candidate-visible only, by design
    'estimated_seconds', q.estimated_seconds,
    'media', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'kind', m.kind, 'provider', m.provider,
               'storage_path', m.storage_path, 'external_url', m.external_url,
               'mime_type', m.mime_type, 'alt_text', m.alt_text,
               'width', m.width, 'height', m.height,
               'duration_seconds', m.duration_seconds
             ) order by m.sort_order)
        from public.question_media m
       where m.question_id = q.id
    ), '[]'::jsonb),
    -- 0033. Published translations only: a draft is somebody's working copy and
    -- has not been reviewed by anyone.
    --
    -- `explanation` is deliberately ABSENT even though the column exists on
    -- question_translations. The base snapshot omits q.explanation because it
    -- is not candidate-visible during an attempt, and copying all three
    -- translated columns because they happen to sit on one row would leak — to
    -- Hindi speakers only — a field English speakers never see.
    --
    -- `locale <> 'en'` because the base row IS the English one. An 'en'
    -- translation would create a which-wins ambiguity for no benefit.
    'i18n', coalesce((
      select jsonb_object_agg(t.locale,
               jsonb_build_object('stem', t.stem, 'content', t.content))
        from public.question_translations t
       where t.question_id = q.id
         and t.status = 'published'
         and t.locale <> 'en'
    ), '{}'::jsonb)
  )
  from public.questions q
  where q.id = p_question_id
$$;

comment on function public.question_snapshot(uuid) is
  'Builds the candidate-visible payload, now including every PUBLISHED translation under `i18n`. Carries no answer key and no explanation, in any language. The locale is not chosen here: a fixed paper is frozen before any candidate exists, so the snapshot holds them all and delivery picks one.';

-- ── Which languages a reader will accept, in order ───────────────────────────
--
-- Five lines, and the difference between Hinglish being useful and being a
-- column nobody fills: somebody who reads Hinglish reads Hindi, so falling
-- straight to English would waste a translation that exists.
create or replace function public.locale_chain(p_locale text)
returns text[]
language sql
immutable
as $$
  select case p_locale
           when 'hi-Latn' then array['hi-Latn', 'hi']
           when 'hi'      then array['hi']
           when 'gu'      then array['gu']
           else array[]::text[]   -- 'en' and anything unknown: the base row
         end
$$;

-- ── Projection: pick one language, remove the rest ───────────────────────────
create or replace function public.localise_snapshot(p_snapshot jsonb, p_locale text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_chain text[] := public.locale_chain(p_locale);
  v_i18n jsonb := coalesce(p_snapshot -> 'i18n', '{}'::jsonb);
  v_locale text;
begin
  -- THE STRIP IS UNCONDITIONAL, and it is both the size fix and a security
  -- property. Other languages never leave the server; doing it in one function
  -- means no call site can forget.
  foreach v_locale in array v_chain loop
    if v_i18n ? v_locale then
      return (p_snapshot - 'i18n')
             || jsonb_build_object('locale', v_locale, 't', v_i18n -> v_locale);
    end if;
  end loop;

  -- No translation for this reader: the base row, which is English.
  return p_snapshot - 'i18n';
end;
$$;

comment on function public.localise_snapshot(jsonb, text) is
  'Removes `i18n` and attaches the first available language from locale_chain as {locale, t}. Does NOT merge the content shapes: the base holds choices as an array and a translation as a map, so jsonb || would replace one with the other. mergeTranslation() in TypeScript does that, and is shared with the authoring preview.';

-- ── attempt_paper gains a locale ─────────────────────────────────────────────
--
-- A DEFAULTED PARAMETER, never an overload — which means DROPPING the one-
-- argument version rather than letting it sit alongside. Leaving it makes
-- `attempt_paper(uuid)` match both signatures, and Postgres refuses an
-- ambiguous call: every existing single-argument caller breaks. PostgREST
-- resolves by argument name and would pick unpredictably besides.
drop function if exists public.attempt_paper(uuid);

create or replace function public.attempt_paper(
  p_attempt_id uuid,
  p_locale text default null
)
returns table (
  section_id     uuid,
  section_title  text,
  question_id    uuid,
  paper_position int,
  marks          numeric(6,2),
  snapshot       jsonb,
  answer         jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_locale text;
begin
  select a.candidate_id into v_owner
    from public.attempts a where a.id = p_attempt_id;

  -- Not "does it exist" but "is it yours" — and the two are deliberately
  -- indistinguishable to the caller.
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'attempt not found' using errcode = '42501';
  end if;

  -- Precedence: the language they are BROWSING in wins over their profile.
  -- Routing is path-based (/gu/attempt/…), so switching language is a
  -- deliberate act and should be honoured over a setting made months ago.
  v_locale := coalesce(
    nullif(p_locale, ''),
    (select p.preferred_locale from public.profiles p where p.id = v_owner),
    'en'
  );

  return query
    select aq.section_id, s.title, aq.question_id, aq.position, aq.marks,
           -- Per question, not per paper: a fifty-question paper with
           -- forty-eight Gujarati translations serves forty-eight in Gujarati.
           public.localise_snapshot(aq.snapshot, v_locale),
           aa.answer
      from public.attempt_questions aq
      left join public.exam_sections s on s.id = aq.section_id
      left join public.attempt_answers aa
             on aa.attempt_id = aq.attempt_id and aa.question_id = aq.question_id
     where aq.attempt_id = p_attempt_id
     order by aq.position;
end;
$$;

grant execute on function public.attempt_paper(uuid, text) to authenticated;

comment on function public.attempt_paper(uuid, text) is
  'The only route by which a candidate reads exam questions, now in their language. The snapshot returned has had every other language removed — see localise_snapshot. section_title is still English: exam_sections.title has no translation mechanism, reported by the translation.section_title advisory rather than half-solved here.';

-- ── exam_paper: the admin preview keeps every language ───────────────────────
--
-- THE OLD TWO-ARGUMENT SIGNATURE IS DROPPED, not left beside this one. Adding a
-- defaulted parameter to a function that already had one creates an OVERLOAD,
-- and `exam_paper(uuid, text)` then matches both — Postgres cannot choose, and
-- every existing two-argument call fails as ambiguous. Dropping first is what
-- makes "a defaulted parameter, never an overload" actually true.
drop function if exists public.exam_paper(uuid, text);

create or replace function public.exam_paper(
  p_exam_id uuid,
  p_seed text default null,
  p_locale text default null
)
returns table (
  section_id        uuid,
  section_title     text,
  question_id       uuid,
  question_revision int,
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

  -- 0019's test, unchanged: whether frozen rows EXIST, not what the exam's
  -- status and paper_mode imply. A published per_attempt exam has no frozen
  -- rows and must still preview, which a status-based condition gets wrong.
  select exists (select 1 from public.exam_questions eq where eq.exam_id = p_exam_id)
    into v_frozen;

  if v_frozen then
    return query
      select eq.section_id, s.title, eq.question_id, eq.question_revision,
             eq.position, eq.marks, eq.negative_marks, eq.fallback_reason,
             -- p_locale null keeps `i18n` intact, and that asymmetry with
             -- attempt_paper is deliberate. The question this screen answers is
             -- "what will candidates be asked?", which for a multilingual
             -- company includes "…and what will the Gujarati speakers be
             -- asked?". This is the one path where every language legitimately
             -- travels, and it is what lets a chef catch a bad translation over
             -- the REAL frozen paper before two hundred people sit it.
             case when p_locale is null then eq.snapshot
                  else public.localise_snapshot(eq.snapshot, p_locale) end,
             false
        from public.exam_questions eq
        join public.exam_sections s on s.id = eq.section_id
       where eq.exam_id = p_exam_id
       order by eq.position;
  else
    return query
      select d.section_id, s.title, d.question_id, d.question_revision,
             d.position, d.marks, d.negative_marks, d.fallback_reason,
             case when p_locale is null then public.question_snapshot(d.question_id)
                  else public.localise_snapshot(public.question_snapshot(d.question_id), p_locale) end,
             true
        from public.draw_paper(p_exam_id, coalesce(p_seed, p_exam_id::text)) d
        join public.exam_sections s on s.id = d.section_id
       order by d.position;
  end if;
end;
$$;

grant execute on function public.exam_paper(uuid, text, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Advisories
-- ═════════════════════════════════════════════════════════════════════════════

-- exam_sections.title is plain text and attempt_paper returns it verbatim, so a
-- fully-Gujarati paper still carries English section headings. NOT solved here:
-- it needs its own table, RLS, authoring surface and status workflow, and a
-- `title_i18n` column bolted onto exam_sections would be a SECOND translation
-- mechanism with different rules from question_translations — which is the
-- thing to avoid. Named so it is not lost.
comment on column public.exam_sections.title is
  'Untranslated. A multilingual paper still shows English section headings; translating them needs its own table and workflow, not a second mechanism bolted on here. Reported by exam_health as translation.section_title.';
