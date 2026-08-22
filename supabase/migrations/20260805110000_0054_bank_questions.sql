-- ═════════════════════════════════════════════════════════════════════════════
-- 0054 — The examination question bank
--
-- Two tables. bank_questions holds everything that is not language;
-- bank_question_texts holds one row per question per language.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ correct_option LIVES ON THE PARENT, AND IT IS THE MOST IMPORTANT LINE     ║
-- ║ IN THIS FILE.                                                             ║
-- ║                                                                           ║
-- ║ The correct answer to an MCQ is a POSITION — A, B, C or D — not a string. ║
-- ║ So it is a single column on the language-neutral row, and there is        ║
-- ║ nowhere in bank_question_texts to say "and this one is right".            ║
-- ║                                                                           ║
-- ║ A translation therefore CANNOT change what is correct. Not by mistake,    ║
-- ║ not by a bad importer, not by a malicious translator. It is not a rule    ║
-- ║ anybody enforces; it is a place that does not exist.                      ║
-- ║                                                                           ║
-- ║ The old bank needed a separate question_answer_keys table (0009) and a    ║
-- ║ CHECK constraint on translation shape (0032) to secure the same property, ║
-- ║ because there the answer was text and text is translatable. Here it falls ║
-- ║ out of the shape.                                                         ║
-- ║                                                                           ║
-- ║ WHAT THIS COSTS, said plainly: option ORDER is fixed across languages.    ║
-- ║ The Hindi option B must be the translation of the English option B. That  ║
-- ║ is a constraint on translators, and it is the correct trade — the         ║
-- ║ alternative is a per-language correct answer, which is precisely the      ║
-- ║ hole this design closes.                                                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ONE TABLE WITH A LEVEL COLUMN, NOT THREE TABLES.                          │
-- │                                                                           │
-- │ The specification asks for three independent banks. "A question belongs   │
-- │ to exactly one level" is what that means, and a single NOT NULL enum      │
-- │ column says it exactly: a row has one value and cannot have two.          │
-- │                                                                           │
-- │ Three tables would mean three sets of RLS policies, three CRUD paths, and │
-- │ a generator that switches on a table name — with nothing keeping the      │
-- │ three schemas in step. 0009 rejected fourteen per-type tables for the     │
-- │ same reason and it was right then.                                        │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.bank_questions (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ NOT NULL, AND THERE IS NO "SHARED ACROSS BRANDS".                       │
  -- │                                                                         │
  -- │ public.questions.brand_id is nullable and null means shared. This one    │
  -- │ is not, deliberately: each brand keeps its own bank of 1,000 questions   │
  -- │ per level, and a nullable column would make "how many Easy questions     │
  -- │ does AIKO have?" mean "its own, plus the shared ones" — a sum that then  │
  -- │ has to appear in every pool count, every shortfall message and every     │
  -- │ exhaustion calculation, and be got right in all of them.                 │
  -- │                                                                         │
  -- │ The cost is duplication: a food-safety question that applies to every    │
  -- │ brand is entered once per brand. That is a known, accepted cost.         │
  -- └─────────────────────────────────────────────────────────────────────────┘
  brand_id   uuid not null references public.brands(id) on delete restrict,

  difficulty public.bank_difficulty    not null,
  qtype      public.bank_question_type not null,

  topic_id   uuid references public.question_topics(id) on delete restrict,

  -- MCQ only. Enforced against qtype below, so a short answer cannot carry one
  -- and an MCQ cannot lack one.
  correct_option char(1) check (correct_option in ('A', 'B', 'C', 'D')),

  -- Where an Editor found this. Reference only — nothing in paper generation
  -- reads it, and no question needs one.
  reference_document_id uuid references public.source_documents(id) on delete set null,
  reference_page        int check (reference_page > 0),

  status     public.bank_question_status not null default 'draft',

  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An MCQ has a correct option; a short answer does not. Both directions, so
  -- neither a keyless MCQ nor a short answer claiming option C can exist.
  constraint bank_q_correct_option_matches_type check (
    (qtype = 'mcq') = (correct_option is not null)
  ),

  -- A page number without a document is a citation of nothing. The reverse is
  -- fine: "it is in the Capiche manual somewhere" is a legitimate half-answer.
  constraint bank_q_page_needs_document check (
    reference_page is null or reference_document_id is not null
  ),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ THE ANCHOR FOR THE COMPOSITE FOREIGN KEY BELOW. NOT REDUNDANT.          │
  -- │                                                                         │
  -- │ id is already unique, so this looks like a wasted index. It exists       │
  -- │ because a FOREIGN KEY may only reference a set of columns carrying a     │
  -- │ unique constraint, and bank_question_texts references all four of these  │
  -- │ together.                                                               │
  -- │                                                                         │
  -- │ That is what lets the child table hold its own copies of brand,          │
  -- │ difficulty and type and have those copies be PROVABLY correct — the FK   │
  -- │ refuses any row that disagrees, and ON UPDATE CASCADE rewrites the       │
  -- │ children when an Editor reclassifies a question. No trigger, no drift.   │
  -- │ Why the child needs them is argued at the constraints that use them.     │
  -- └─────────────────────────────────────────────────────────────────────────┘
  constraint bank_questions_fk_anchor unique (id, brand_id, difficulty, qtype)
);

-- The draw. generate_exam_paper() asks for active, undeleted questions of one
-- type, in one brand, at one level — this index is that question exactly.
create index bank_questions_pick_idx
  on public.bank_questions (company_id, brand_id, difficulty, qtype, status)
  where deleted_at is null;

create index bank_questions_topic_idx
  on public.bank_questions (company_id, topic_id) where deleted_at is null;

-- "Which questions cite this cookbook?" — shown on the document in the library,
-- and the reason a document with citations cannot be quietly removed.
create index bank_questions_reference_idx
  on public.bank_questions (reference_document_id)
  where reference_document_id is not null and deleted_at is null;

-- The recycle bin, ordered the way it is read: most recently deleted first.
create index bank_questions_deleted_idx
  on public.bank_questions (company_id, brand_id, deleted_at)
  where deleted_at is not null;

create trigger bank_questions_set_updated_at
  before update on public.bank_questions
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- bank_question_texts — one row per question per language
-- ═════════════════════════════════════════════════════════════════════════════
create table public.bank_question_texts (
  question_id uuid not null,

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ THREE COLUMNS COPIED FROM THE PARENT, AND THE FK MAKES THE COPIES TRUE. │
  -- │                                                                         │
  -- │ Denormalisation normally means a trigger and a hope. Here the composite  │
  -- │ FK below references bank_questions (id, brand_id, difficulty, qtype)     │
  -- │ as a unit, so a row whose copies disagree with its parent cannot be      │
  -- │ inserted at all, and ON UPDATE CASCADE keeps them in step when a         │
  -- │ question is reclassified.                                               │
  -- │                                                                         │
  -- │ They earn their place by turning the two rules that matter most into    │
  -- │ ordinary constraints instead of trigger code:                            │
  -- │                                                                         │
  -- │  · qtype  → the MCQ shape CHECK below can be a CHECK. Without it, "an   │
  -- │    MCQ has four options" would have to be a trigger reading the parent,  │
  -- │    which means a window where it is not true.                            │
  -- │  · brand_id + difficulty → duplicate refusal can be a UNIQUE INDEX.      │
  -- │    Without them it would be a SELECT-then-INSERT, which two concurrent   │
  -- │    imports race straight through.                                       │
  -- └─────────────────────────────────────────────────────────────────────────┘
  brand_id    uuid                      not null,
  difficulty  public.bank_difficulty    not null,
  qtype       public.bank_question_type not null,

  -- Exactly the three the product supports. Not a reference to a locales table:
  -- a company cannot add a fourth without 6,000 translations, so this is a
  -- product decision rather than configuration.
  locale      text not null check (locale in ('en', 'hi', 'gu')),

  question    text not null check (length(btrim(question)) between 3 and 2000),

  option_a    text,
  option_b    text,
  option_c    text,
  option_d    text,

  -- "Around two lines." A hard cap in the database rather than a hint on the
  -- form, because the importer never sees the form — and 6,000 rows arriving
  -- from a spreadsheet is exactly where a three-paragraph answer gets in.
  answer_text text check (length(btrim(answer_text)) between 1 and 400),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ WHY THE ANSWER IS RIGHT. OPTIONAL, AND IT IS NOT A THIRD QUESTION TYPE. │
  -- │                                                                         │
  -- │ Per-language, because an explanation is prose and prose is translated —  │
  -- │ it sits beside the text it explains rather than on the parent row.       │
  -- │                                                                         │
  -- │ IT NEVER REACHES A CANDIDATE. The question paper does not print it; the │
  -- │ ANSWER KEY does, where it is genuinely useful — the person marking a     │
  -- │ paper is often not the person who wrote the question, and "74°C because │
  -- │ that is the pasteurisation point for poultry" is what lets them handle a │
  -- │ near-miss answer consistently. src/lib/pdf/paper.tsx reads it behind the │
  -- │ same `isKey` guard as correct_option and answer_text.                    │
  -- │                                                                         │
  -- │ Longer than answer_text on purpose: the answer is capped at two lines    │
  -- │ because a candidate writes it in a box, while an explanation is read by  │
  -- │ a marker off a key and has no such constraint.                          │
  -- │                                                                         │
  -- │ Optional in every language independently — a question may be explained   │
  -- │ in English and not yet in Gujarati, and that must not block activation.  │
  -- │ bank_question_missing_locales() keys on `question` alone for exactly     │
  -- │ this reason.                                                            │
  -- └─────────────────────────────────────────────────────────────────────────┘
  explanation text check (length(btrim(explanation)) <= 2000),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 'simple', not 'english': this column holds Hindi and Gujarati, and English
  -- stemming would mangle both. 0009 made the same call for the same reason.
  -- The explanation is deliberately NOT indexed. Search exists so an Editor can
  -- find a question they half-remember; matching on rationale text would return
  -- questions whose stem has nothing to do with the search term, which makes
  -- the result list harder to trust rather than more complete.
  search_tsv tsvector generated always as (
    to_tsvector('simple',
      coalesce(question, '') || ' ' ||
      coalesce(option_a, '') || ' ' || coalesce(option_b, '') || ' ' ||
      coalesce(option_c, '') || ' ' || coalesce(option_d, '') || ' ' ||
      coalesce(answer_text, ''))
  ) stored,

  primary key (question_id, locale),

  constraint bank_question_texts_parent_fk
    foreign key (question_id, brand_id, difficulty, qtype)
    references public.bank_questions (id, brand_id, difficulty, qtype)
    on update cascade
    on delete cascade,

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ THE SHAPE OF A QUESTION, IN BOTH DIRECTIONS.                            │
  -- │                                                                         │
  -- │ An MCQ has four non-blank options and no answer text. A short answer     │
  -- │ has answer text and no options. Stating only the first half would admit  │
  -- │ a short answer carrying four stray options from a mis-mapped import      │
  -- │ column, which renders as an MCQ with no correct answer.                  │
  -- │                                                                         │
  -- │ btrim, not just NOT NULL: a spreadsheet cell containing a single space   │
  -- │ is not an option, and it is what a half-filled import row actually       │
  -- │ contains.                                                               │
  -- └─────────────────────────────────────────────────────────────────────────┘
  constraint bank_question_texts_shape check (
    case qtype
      when 'mcq' then
             length(btrim(coalesce(option_a, ''))) > 0
         and length(btrim(coalesce(option_b, ''))) > 0
         and length(btrim(coalesce(option_c, ''))) > 0
         and length(btrim(coalesce(option_d, ''))) > 0
         and answer_text is null
      when 'short_answer' then
             answer_text is not null
         and option_a is null and option_b is null
         and option_c is null and option_d is null
    end
  )
);

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ DUPLICATE REFUSAL. A UNIQUE INDEX, NOT A LOOKUP.                          │
-- │                                                                           │
-- │ The same question text, in the same brand at the same level, is refused   │
-- │ outright — a 23505 the importer reports per row rather than a check it     │
-- │ performs and two concurrent imports both pass.                            │
-- │                                                                           │
-- │ SCOPED TO ENGLISH, because English is the language every question is      │
-- │ authored and imported in, and two questions with identical English are    │
-- │ the same question however their translations differ. Indexing all three   │
-- │ locales would additionally refuse a Hindi translation that legitimately   │
-- │ matches another question's — different English, same Hindi rendering —    │
-- │ which is a real thing translators do and not a duplicate.                 │
-- │                                                                           │
-- │ NOT scoped to undeleted rows, and that is deliberate. A deleted question  │
-- │ keeps its slot, so re-adding it comes back "already in the bank" and      │
-- │ points at the recycle bin — the same behaviour source_documents chose for │
-- │ its (company_id, sha256) constraint, and for the same reason: silently    │
-- │ admitting a second copy is worse than telling somebody where the first    │
-- │ one went. Restore it or purge it; do not shadow it.                       │
-- └───────────────────────────────────────────────────────────────────────────┘
create unique index bank_question_texts_dedupe_uq
  on public.bank_question_texts (brand_id, difficulty, lower(btrim(question)))
  where locale = 'en';

create index bank_question_texts_search_idx
  on public.bank_question_texts using gin (search_tsv);

-- Reading one paper in one language: fifty questions, one locale.
create index bank_question_texts_locale_idx
  on public.bank_question_texts (locale, question_id);

create trigger bank_question_texts_set_updated_at
  before update on public.bank_question_texts
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- Completeness — 'active' means written in every REQUIRED language
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THIS IS WORTH A TRIGGER.                                              │
-- │                                                                           │
-- │ A generated paper is produced in every required language from one set of  │
-- │ questions. A question missing one of them would render as a blank line on │
-- │ that language's paper — not an error, not a warning, a gap in a printed   │
-- │ exam somebody is sitting.                                                 │
-- │                                                                           │
-- │ Enforcing it here rather than in the pool query also keeps the language   │
-- │ banks IDENTICAL IN SIZE. Pool counts, shortfall messages and the          │
-- │ exhaustion arithmetic then mean the same thing whichever language is      │
-- │ being asked about — instead of a chef being told 40 MCQs are available    │
-- │ and finding out at generation that only 12 have Gujarati.                 │
-- │                                                                           │
-- │ WHICH languages are required is exam_settings.required_locales, not a     │
-- │ constant — {en} while the bank is being written in English, {en,hi,gu}    │
-- │ once it is translated. The RULE is fixed; the SET is configuration. See   │
-- │ the box on that column in 0053.                                           │
-- │                                                                           │
-- │ It is a trigger and not a CHECK because the fact spans rows: no CHECK on  │
-- │ bank_questions can count its children. Two triggers, because there are    │
-- │ two ways to break it — promoting an incomplete question, and removing a   │
-- │ language from one already promoted.                                       │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

/**
 * Which REQUIRED languages this question is still missing.
 *
 * Returns the shortfall rather than a count, because the caller has to name
 * them: "write the Gujarati" is actionable and "2 of 3 present" is not.
 *
 * The required set comes from exam_settings (0053), not from a constant here.
 * The bank is being written in English first and translated later, so today
 * that set is {en}; when the translations land it becomes {en,hi,gu} with one
 * UPDATE and this trigger starts refusing untranslated questions from that
 * moment. See the box on required_locales in 0053.
 *
 * btrim: a row holding an empty string is not a translation. The column CHECK
 * already refuses a blank question, so this guards a future column added and
 * forgotten here.
 */
create or replace function public.bank_question_missing_locales(p_question_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(needed.locale order by needed.locale), array[]::text[])
    from public.bank_questions q
   cross join lateral unnest(public.required_locales_for(q.company_id)) as needed(locale)
   where q.id = p_question_id
     and not exists (
       select 1
         from public.bank_question_texts t
        where t.question_id = q.id
          and t.locale = needed.locale
          and length(btrim(t.question)) > 0
     );
$$;

revoke execute on function public.bank_question_missing_locales(uuid)
  from public, anon, authenticated;

create or replace function public.bank_question_completeness_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text[];
begin
  if new.status <> 'active' then
    return new;
  end if;

  -- Unchanged status on an already-active row still passes through here, and
  -- that is correct: an edit to an active question must not be able to leave
  -- it active and incomplete either.
  v_missing := public.bank_question_missing_locales(new.id);

  if array_length(v_missing, 1) > 0 then
    raise exception
      'A question cannot be made active until it is written in every required language. Missing: %',
      array_to_string(v_missing, ', ')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bank_questions_completeness
  before insert or update on public.bank_questions
  for each row execute function public.bank_question_completeness_guard();

/*
 * The other direction: taking a language away from an active question.
 *
 * AFTER, not BEFORE — the row has to be gone before the count is meaningful,
 * and raising in an AFTER trigger still rolls the statement back.
 */
create or replace function public.bank_question_texts_completeness_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status  public.bank_question_status;
  v_id      uuid := coalesce(old.question_id, new.question_id);
  v_missing text[];
begin
  select q.status into v_status
    from public.bank_questions q
   where q.id = v_id;

  -- The parent is on its way out too (ON DELETE CASCADE): nothing to protect.
  if v_status is null then
    return null;
  end if;

  if v_status <> 'active' then
    return null;
  end if;

  v_missing := public.bank_question_missing_locales(v_id);

  if array_length(v_missing, 1) > 0 then
    raise exception
      'An active question must keep every required language. Move it to draft first. Missing: %',
      array_to_string(v_missing, ', ')
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create trigger bank_question_texts_completeness
  after delete or update on public.bank_question_texts
  for each row execute function public.bank_question_texts_completeness_guard();

alter table public.bank_questions      enable row level security;
alter table public.bank_question_texts enable row level security;

-- ── Comments ─────────────────────────────────────────────────────────────────
comment on table public.bank_questions is
  'The examination question bank. One row per question; language-neutral. Correct answers are stored as a POSITION (correct_option) so no translation can change what is correct.';
comment on column public.bank_questions.correct_option is
  'A|B|C|D. A position, never text — which is why bank_question_texts has nowhere to record a correct answer.';
comment on column public.bank_questions.brand_id is
  'NOT NULL. Each brand keeps its own bank; there is no shared question. A question applying to every brand is entered once per brand.';
comment on table public.bank_question_texts is
  'One row per question per language. brand_id, difficulty and qtype are copies of the parent, held true by a composite FK so duplicate refusal and MCQ shape can be constraints rather than triggers.';
comment on index public.bank_question_texts_dedupe_uq is
  'Refuses the same English question twice in one brand at one level. Includes deleted rows on purpose: the tombstone keeps the slot so a re-add points at the recycle bin.';
