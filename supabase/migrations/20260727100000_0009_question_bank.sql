-- ═════════════════════════════════════════════════════════════════════════════
-- 0009 — Question bank
--
-- STORAGE MODEL: one `questions` table, common metadata as real columns, the
-- format-specific payload as JSONB. Not 14 tables, and not the PRD's
-- `question_options` child table.
--
-- Rejected alternatives, and why:
--   · 14 per-type tables → 14× RLS policies, 14× CRUD, and every exam query
--     becomes a 14-way join. Untenable for one developer.
--   · A normalised question_options table → works for choice formats, collapses
--     for blanks (N blanks each with an accepted-answer array and a match mode),
--     pairs (a mapping) and order (a sequence). You end up adding a `meta` JSONB
--     column to question_options anyway — JSONB *plus* a join. Worst of both.
--
-- Cost of JSONB, and the mitigations applied here: no FK integrity inside the
-- payload, so Zod validates at every write boundary (src/lib/questions/schemas.ts)
-- and validate_question_content() enforces structural invariants in the database
-- as a backstop. Shape migrations need a data script rather than ALTER TABLE,
-- hence content_version from day one.
--
-- ANSWER KEYS LIVE IN A SEPARATE TABLE. This is the single most important
-- decision in the file — see the block above question_answer_keys.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── categories ───────────────────────────────────────────────────────────────
-- Self-referencing for sub-categories (Knives → Sharpening).
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  parent_id   uuid references public.categories(id) on delete restrict,
  name        text not null,
  slug        text not null,
  description text,
  sort_order  smallint not null default 0,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index categories_slug_uq
  on public.categories (company_id, slug) where deleted_at is null;
create index categories_parent_idx on public.categories (parent_id) where deleted_at is null;

-- ── tags ─────────────────────────────────────────────────────────────────────
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now()
);

create unique index tags_slug_uq on public.tags (company_id, slug);

-- ── questions ────────────────────────────────────────────────────────────────
create table public.questions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  -- null = shared across brands. A Capiche pasta question is irrelevant to
  -- Aiko staff, so the bank is brand-scoped by default.
  brand_id         uuid references public.brands(id) on delete restrict,

  type             public.question_type    not null,   -- PRD-facing label, 14 values
  response_format  public.response_format  not null,   -- drives storage/grading, 9 values
  content_version  smallint not null default 1,

  stem             text not null check (length(btrim(stem)) between 3 and 4000),
  content          jsonb not null default '{}'::jsonb,  -- candidate-visible ONLY

  category_id      uuid references public.categories(id) on delete set null,
  difficulty       smallint not null default 3 check (difficulty between 1 and 5),
  marks            numeric(6,2) not null default 1 check (marks > 0),
  negative_marks   numeric(6,2) not null default 0 check (negative_marks >= 0),
  estimated_seconds int check (estimated_seconds between 5 and 3600),

  explanation      text,
  reference_note   text,                                -- cookbook / SOP citation
  status           public.question_status not null default 'draft',
  source           text not null default 'manual' check (source in ('manual','import','ai')),
  usage_count      int not null default 0,

  created_by       uuid not null references public.profiles(id) on delete restrict,
  updated_by       uuid references public.profiles(id) on delete set null,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- 'simple' rather than 'english': the bank holds Hindi and Gujarati stems,
  -- and English stemming would mangle them. Simple does no stemming and works
  -- acceptably across all four locales.
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(stem, '') || ' ' || coalesce(explanation, ''))
  ) stored,

  -- Mirrors TYPE_FORMATS in src/lib/questions/schemas.ts. The two MUST agree,
  -- or a question the UI accepts is rejected on insert.
  constraint q_format_matches_type check (
    case type
      when 'mcq_single'   then response_format = 'choice_single'
      when 'mcq_multi'    then response_format = 'choice_multi'
      when 'true_false'   then response_format = 'boolean'
      when 'fill_blank'   then response_format = 'blanks'
      when 'match'        then response_format = 'pairs'
      when 'sequence'     then response_format = 'order'
      when 'short_answer' then response_format = 'text_short'
      when 'essay'        then response_format = 'text_long'
      when 'practical'    then response_format = 'evaluator_only'
      when 'viva'         then response_format = 'evaluator_only'
      -- image / video / audio / document are stimulus modifiers and may take
      -- any response format. That is the whole point of the two-axis model.
      else true
    end
  )
);

-- Supports the exam builder's rule-based random selection: pick N active
-- questions in this brand, category and difficulty.
create index questions_pick_idx
  on public.questions (company_id, brand_id, category_id, difficulty, status)
  where deleted_at is null;
create index questions_search_idx  on public.questions using gin (search_tsv);
create index questions_content_idx on public.questions using gin (content jsonb_path_ops);
create index questions_created_by_idx on public.questions (created_by) where deleted_at is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- question_answer_keys
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SEPARATE TABLE, DELIBERATELY. If correct answers lived in questions.content│
-- │ then any client that can read a question can read the answers — and during │
-- │ an exam the candidate's browser must read the question.                    │
-- │                                                                           │
-- │ RLS is ROW-level. It cannot hide a column. There is no policy that says    │
-- │ "you may read this row but not that field", so the split is the only       │
-- │ structural fix.                                                           │
-- │                                                                           │
-- │ Defence in depth: this table's policies grant read to question authors     │
-- │ only, AND exam papers are served through a server route that never selects │
-- │ from here. Either alone would be enough; both cost nothing.                │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
create table public.question_answer_keys (
  question_id uuid primary key references public.questions(id) on delete cascade,
  answer_key  jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── question_media ───────────────────────────────────────────────────────────
-- Stays relational: media has a lifecycle JSONB cannot manage — storage path,
-- byte size (needed to account against the 1 GB free-tier cap), provider,
-- orphan cleanup, reuse across questions.
create table public.question_media (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,

  kind        text not null check (kind in ('image','audio','video','document')),
  -- 'external' is how video stays affordable: 5 GB monthly egress is 300 staff
  -- watching one 15 MB clip once. Video is an unlisted YouTube/Vimeo link, not
  -- a file we host. See plan §10.
  provider    text not null default 'supabase' check (provider in ('supabase','r2','external')),

  storage_path text,          -- provider = supabase | r2
  external_url text,          -- provider = external
  mime_type    text,
  bytes        int check (bytes >= 0),
  width        int,
  height       int,
  duration_seconds int,
  alt_text     text,          -- required for images; accessibility + OCR fallback
  sort_order   smallint not null default 0,
  created_at   timestamptz not null default now(),

  constraint media_location check (
    (provider in ('supabase','r2') and storage_path is not null)
    or (provider = 'external' and external_url is not null)
  )
);

create index question_media_question_idx on public.question_media (question_id);

-- ── question_tags ────────────────────────────────────────────────────────────
create table public.question_tags (
  question_id uuid not null references public.questions(id) on delete cascade,
  tag_id      uuid not null references public.tags(id) on delete cascade,
  primary key (question_id, tag_id)
);

create index question_tags_tag_idx on public.question_tags (tag_id);

-- ── question_translations ────────────────────────────────────────────────────
-- PRESENTATION ONLY. `content` here holds display strings keyed by the base
-- row's ids — {"choices": {"c1": "…"}} — never correct answers. A bad or
-- malicious translation therefore cannot change what is correct.
create table public.question_translations (
  question_id uuid not null references public.questions(id) on delete cascade,
  locale      text not null check (locale in ('en','hi','gu','hi-Latn')),
  stem        text not null,
  content     jsonb not null default '{}'::jsonb,
  explanation text,
  status      text not null default 'draft' check (status in ('draft','review','published')),
  source      text not null default 'human' check (source in ('human','ai')),
  translated_by uuid references public.profiles(id) on delete set null,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (question_id, locale)
);

create index question_translations_lookup_idx
  on public.question_translations (question_id, locale) where status = 'published';

-- ═════════════════════════════════════════════════════════════════════════════
-- validate_question_content — structural backstop
--
-- Zod at the application boundary is the primary validation and produces far
-- better messages. This exists because the application is not the only writer:
-- bulk import, seed scripts, AI generation (Phase 3) and psql all bypass it.
-- A CHECK constraint cannot be bypassed by any code path.
--
-- Kept intentionally shallow — shape and arity only. Cross-table invariants
-- (does the answer key reference a real option?) live in validateQuestion() in
-- TypeScript, because a CHECK on `questions` cannot see question_answer_keys.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.validate_question_content(
  fmt public.response_format,
  c   jsonb
) returns boolean
language plpgsql
immutable
as $$
begin
  if c is null or jsonb_typeof(c) <> 'object' then
    return false;
  end if;

  case fmt
    when 'choice_single' then
      return jsonb_typeof(c -> 'choices') = 'array'
         and jsonb_array_length(c -> 'choices') between 2 and 6;

    when 'choice_multi' then
      return jsonb_typeof(c -> 'choices') = 'array'
         and jsonb_array_length(c -> 'choices') between 2 and 8;

    when 'boolean' then
      return true;   -- no payload; the two options are implied

    when 'blanks' then
      return jsonb_typeof(c -> 'blanks') = 'array'
         and jsonb_array_length(c -> 'blanks') between 1 and 20
         and coalesce(length(c ->> 'template'), 0) > 0;

    when 'pairs' then
      return jsonb_typeof(c -> 'left') = 'array'
         and jsonb_typeof(c -> 'right') = 'array'
         and jsonb_array_length(c -> 'left') >= 2
         and jsonb_array_length(c -> 'right') >= 2;

    when 'order' then
      return jsonb_typeof(c -> 'items') = 'array'
         and jsonb_array_length(c -> 'items') between 2 and 12;

    when 'text_short', 'text_long' then
      return true;

    when 'evaluator_only' then
      return true;   -- rubric lives on the answer key, not the content

    else
      return false;  -- unknown format: fail closed
  end case;
exception when others then
  -- Malformed JSON of any shape is invalid, never an insert-time crash.
  return false;
end;
$$;

alter table public.questions
  add constraint q_content_valid
  check (public.validate_question_content(response_format, content));

-- ── updated_at triggers ──────────────────────────────────────────────────────
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();
create trigger questions_set_updated_at
  before update on public.questions
  for each row execute function public.set_updated_at();
create trigger question_answer_keys_set_updated_at
  before update on public.question_answer_keys
  for each row execute function public.set_updated_at();
create trigger question_translations_set_updated_at
  before update on public.question_translations
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.categories            enable row level security;
alter table public.tags                  enable row level security;
alter table public.questions             enable row level security;
alter table public.question_answer_keys  enable row level security;
alter table public.question_media        enable row level security;
alter table public.question_tags         enable row level security;
alter table public.question_translations enable row level security;

comment on table public.question_answer_keys is
  'Correct answers, kept OUT of questions.content because RLS is row-level and cannot hide a column from a candidate who must read the question. Never selected by exam delivery.';
comment on function public.validate_question_content(public.response_format, jsonb) is
  'Structural backstop mirroring src/lib/questions/schemas.ts. Exists because import, seeds, AI generation and psql all bypass application validation.';
