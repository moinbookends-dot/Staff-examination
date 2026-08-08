-- ═════════════════════════════════════════════════════════════════════════════
-- 0053 — Examination vocabulary: difficulty, question type, status, topics
--
-- The first migration of the new examination system. It declares the three
-- closed vocabularies the bank keys on, creates the one taxonomy table that is
-- genuinely company data, and finishes removing Hinglish.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ENUMS FOR TWO OF THESE, A TABLE FOR THE THIRD. THE LINE IS "MAY A         │
-- │ COMPANY EDIT IT?"                                                         │
-- │                                                                           │
-- │ The specification asked for tables named question_status and difficulty.  │
-- │ They are enums here, and the reason is not tidiness.                      │
-- │                                                                           │
-- │ "Only Active questions may appear in exams" is the load-bearing rule of   │
-- │ the whole product, and generate_exam_paper() has to name the status it    │
-- │ draws on. A table means a company can rename 'active', add a fourth       │
-- │ status, or delete the row — and the generator then either draws nothing   │
-- │ or draws questions nobody approved. The same argument applies to          │
-- │ difficulty: three levels are what the paper blueprint, the pool counts    │
-- │ and the exhaustion arithmetic are all written against.                    │
-- │                                                                           │
-- │ An enum makes "there are exactly three levels, and a question has exactly │
-- │ one" true by construction rather than by a foreign key somebody could     │
-- │ point at a fourth row.                                                    │
-- │                                                                           │
-- │ Topics ARE a table, because a topic list genuinely differs between        │
-- │ companies and nothing in the generator depends on which topics exist.     │
-- │ That is the whole distinction.                                            │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- NOT REUSED, and worth saying explicitly: public.question_status already
-- exists with seven values, and public.questions.difficulty is a 1-5 smallint.
-- Neither is widened or narrowed here. They belong to the old bank, which is
-- dropped whole in a later migration; touching them now would mean editing a
-- vocabulary forty migrations depend on in order to serve a table that does
-- not exist yet.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The three levels ─────────────────────────────────────────────────────────
-- Declared easy → hard so `order by difficulty` sorts the way a person expects
-- and the dashboard's three counters come out in the right order without a
-- CASE expression. Postgres orders an enum by declaration position.
create type public.bank_difficulty as enum ('easy', 'medium', 'hard');

-- ── The two question types ───────────────────────────────────────────────────
-- 'short_answer' rather than 'one_line', matching the label the UI uses. The
-- one-to-two-line limit is enforced as a length CHECK on the answer text in
-- 0054, which is where a limit measured in characters belongs.
create type public.bank_question_type as enum ('mcq', 'short_answer');

-- ── The three statuses ───────────────────────────────────────────────────────
--
-- draft    — being written; may be incomplete in any language
-- active   — written in every REQUIRED language (exam_settings.required_locales
--            below), and therefore drawable onto a paper
-- archived — withdrawn from the pool, still visible to Editors, restorable
--
-- Deletion is NOT a status. It is deleted_at on the row, because a deleted
-- question must still render on every paper that already contains it.
create type public.bank_question_status as enum ('draft', 'active', 'archived');

-- ═════════════════════════════════════════════════════════════════════════════
-- question_topics
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ORGANISATIONAL LABELS, OWNED BY EDITORS. NOTHING DEPENDS ON THEM.         │
-- │                                                                           │
-- │ A topic files a question so an Editor can find it again. That is the      │
-- │ whole job. generate_exam_paper() does not read this table, the paper does │
-- │ not print a topic, and no count, quota or ratio is expressed in topics —  │
-- │ so renaming one, merging two or adding a fifteenth cannot affect a single │
-- │ generated paper.                                                          │
-- │                                                                           │
-- │ That is exactly why Editors may manage them and why the write policies    │
-- │ below are keyed on bank.write rather than settings.manage. A taxonomy the │
-- │ person filling the bank cannot extend is one they work around by putting  │
-- │ questions under the nearest wrong label, which is worse than an untidy    │
-- │ list.                                                                     │
-- │                                                                           │
-- │ CONTRAST WITH difficulty AND status, deliberately: those two are enums    │
-- │ precisely because the generator DOES name them, so a company editing them │
-- │ breaks paper generation. The line between "enum" and "table" in this      │
-- │ schema is whether the generator depends on the value.                     │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
create table public.question_topics (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,

  name       text not null check (length(btrim(name)) between 1 and 80),
  -- The stable handle. Renaming a topic for presentation must not silently
  -- become a different topic to anything holding a reference, and an import
  -- file naming topics by slug keeps working across a rename.
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  sort_order smallint not null default 0,

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index question_topics_slug_uq
  on public.question_topics (company_id, slug) where deleted_at is null;

create index question_topics_company_idx
  on public.question_topics (company_id, sort_order) where deleted_at is null;

create trigger question_topics_set_updated_at
  before update on public.question_topics
  for each row execute function public.set_updated_at();

alter table public.question_topics enable row level security;

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Read is keyed on bank.read, NOT on a permission a chef holds. A chef never
-- sees a question, so a chef has no use for the list of topics questions are
-- filed under — and every extra reader of a company-scoped table is one more
-- thing to reason about when the UUID boundary is being argued.
create policy question_topics_read on public.question_topics
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('bank.read'))
    and company_id = (select public.my_company())
  );

-- Editors own the taxonomy. See the box above for why that is safe here and
-- would not be for difficulty or status.
create policy question_topics_insert on public.question_topics
  for insert to authenticated
  with check (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
  );

create policy question_topics_update on public.question_topics
  for update to authenticated
  using (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ NO DELETE POLICY, AND A read_deleted ONE INSTEAD.                         │
-- │                                                                           │
-- │ bank_questions.topic_id is ON DELETE RESTRICT, so a hard delete of a used │
-- │ topic is refused by the database anyway — and refusing it with a foreign  │
-- │ key violation is a poor way to tell an Editor "forty questions are filed  │
-- │ under this". Removal is deleted_at, which leaves those questions pointing │
-- │ at a topic that simply stops being offered on new ones.                   │
-- │                                                                           │
-- │ The read_deleted policy is not optional decoration: without a select      │
-- │ policy that matches the row AFTER deleted_at is set, the UPDATE that sets │
-- │ it is itself refused. 0048 proved that by experiment; 0055 relies on the  │
-- │ same rule for questions.                                                  │
-- └───────────────────────────────────────────────────────────────────────────┘
create policy question_topics_read_deleted on public.question_topics
  for select to authenticated
  using (
    deleted_at is not null
    and (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- The starting taxonomy
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A STARTING POINT, NOT A SPECIFICATION.                                    │
-- │                                                                           │
-- │ Fourteen labels covering the two shapes a restaurant question takes: the  │
-- │ dishes a kitchen makes, and the practices it runs on. Editors add,        │
-- │ rename and retire them from the Question Bank screen — nothing downstream │
-- │ reads a topic, so none of that can affect a generated paper.              │
-- │                                                                           │
-- │ Seeded for EVERY company rather than only the seeded one, because a       │
-- │ company with an empty taxonomy has an unusable bank: 6,000 questions with │
-- │ no topic are 6,000 questions nobody can find again, and the first Editor  │
-- │ would have to invent a taxonomy before writing anything. 0009 seeded its  │
-- │ categories for the same reason and said so.                               │
-- │                                                                           │
-- │ Brand-neutral on purpose: a topic is a filing label, and both Capiche and │
-- │ AIKO file questions under Food Safety even though only one of them makes  │
-- │ pizza. An unused label costs nothing; a missing one costs an Editor a     │
-- │ decision every time they hit it.                                          │
-- │                                                                           │
-- │ sort_order in tens so a fifteenth topic can be slotted between two        │
-- │ existing ones without renumbering the list.                               │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.question_topics (company_id, name, slug, sort_order)
select c.id, t.name, t.slug, t.sort_order
  from public.companies c
 cross join (values
   -- What the kitchen makes
   ('Pizza',              'pizza',              10),
   ('Pasta',              'pasta',              20),
   ('Burger',             'burger',             30),
   ('Salad',              'salad',              40),
   ('Sauces',             'sauces',             50),
   ('Desserts',           'desserts',           60),
   -- How the kitchen runs
   ('Kitchen Hygiene',    'kitchen-hygiene',    70),
   ('Food Safety',        'food-safety',        80),
   ('Preparation',        'preparation',        90),
   ('Storage',            'storage',           100),
   ('Cleaning',           'cleaning',          110),
   ('Kitchen Equipment',  'kitchen-equipment', 120),
   ('Recipes',            'recipes',           130),
   ('Cooking Techniques', 'cooking-techniques',140)
 ) as t(name, slug, sort_order)
 where c.deleted_at is null
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_settings — the per-company knobs, in one row
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ required_locales IS THE MOST IMPORTANT COLUMN HERE, AND IT EXISTS         ║
-- ║ BECAUSE THE PRODUCT IS BEING BUILT IN PHASES.                             ║
-- ║                                                                           ║
-- ║ The rule is that a question cannot be made ACTIVE — cannot reach a paper  ║
-- ║ — until it is written in every language a paper will be printed in. That  ║
-- ║ rule is not negotiable: a question missing its Gujarati renders as a      ║
-- ║ blank line on the Gujarati paper, in a printed exam somebody is sitting.  ║
-- ║                                                                           ║
-- ║ What IS negotiable is which languages that means today. The question bank ║
-- ║ is being written in English first and translated later, so requiring all  ║
-- ║ three now would mean 3,000 questions that are all permanently drafts and  ║
-- ║ a system that can never generate a paper.                                 ║
-- ║                                                                           ║
-- ║ So the SET is configuration and the RULE is not. Today {en}. When the     ║
-- ║ translations land, this becomes {en,hi,gu} — one UPDATE — and from that   ║
-- ║ moment the trigger refuses to activate anything untranslated. No schema   ║
-- ║ change, no migration, no code edit.                                       ║
-- ║                                                                           ║
-- ║ WHAT MUST NOT HAPPEN: widening this to a language the PDF renderer has no ║
-- ║ font for, or narrowing it while active questions exist that only satisfy  ║
-- ║ the wider set. The first prints blank glyphs; the second is harmless but  ║
-- ║ leaves rows nothing re-checks. The CHECK below covers the first.          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- One row per company, created by the insert below and never by the app —
-- there is no INSERT policy, so "settings" cannot be multiplied into several
-- disagreeing rows.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.exam_settings (
  company_id uuid primary key references public.companies(id) on delete restrict,

  -- Which languages a question must be written in before it can go active.
  required_locales text[] not null default array['en'],

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ DISPLAY NAMES FOR THE THREE LEVELS — PRESENTATION ONLY.                 │
  -- │                                                                         │
  -- │ The enum values easy/medium/hard are what the generator, the pool       │
  -- │ counts and every index are written against, and they never change.      │
  -- │ These are what a person SEES, so a company calling them Level 1/2/3 or  │
  -- │ Commis/Chef de Partie/Sous can do that without touching a single query. │
  -- │                                                                         │
  -- │ This is the enum-versus-table line drawn earlier in this file, applied  │
  -- │ to a third case: the VALUE is fixed because code depends on it; the     │
  -- │ LABEL is data because nothing does.                                     │
  -- │                                                                         │
  -- │ NOTE these are labels and nothing more. What makes a question Easy      │
  -- │ rather than Hard is defined in a separate document owned by the         │
  -- │ customer, and no column here encodes any part of it.                    │
  -- └─────────────────────────────────────────────────────────────────────────┘
  label_easy   text not null default 'Easy'   check (length(btrim(label_easy))   between 1 and 40),
  label_medium text not null default 'Medium' check (length(btrim(label_medium)) between 1 and 40),
  label_hard   text not null default 'Hard'   check (length(btrim(label_hard))   between 1 and 40),

  -- Printed at the top and bottom of every generated paper. Null means "use
  -- the company name", which is what the renderer falls back to — an empty
  -- header is a worse default than a sensible one.
  pdf_header text check (length(btrim(pdf_header)) <= 200),
  pdf_footer text check (length(btrim(pdf_footer)) <= 200),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ A PERCENTAGE, NOT A MARK COUNT.                                         │
  -- │                                                                         │
  -- │ Papers come in two sizes. "Pass mark 12" means 60% of a 20-mark paper   │
  -- │ and 24% of a 50-mark one, so a single number of marks is wrong for one  │
  -- │ of the two the moment it is set. A percentage is right for both, and    │
  -- │ the printed figure is computed per paper.                               │
  -- │                                                                         │
  -- │ Nullable: a company that does not want a pass mark printed leaves it    │
  -- │ empty, and the renderer omits the line rather than printing "0%".       │
  -- └─────────────────────────────────────────────────────────────────────────┘
  passing_percent smallint check (passing_percent between 1 and 100),

  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Non-empty, and drawn only from the locales the bank and the PDF renderer
  -- both support. An empty array would make every question trivially complete;
  -- an unsupported locale would make every question impossible to complete.
  constraint exam_settings_required_locales_valid check (
    array_length(required_locales, 1) >= 1
    and required_locales <@ array['en', 'hi', 'gu']
  )
);

create trigger exam_settings_set_updated_at
  before update on public.exam_settings
  for each row execute function public.set_updated_at();

insert into public.exam_settings (company_id)
select c.id from public.companies c where c.deleted_at is null
on conflict do nothing;

alter table public.exam_settings enable row level security;

-- Readable by anyone who can work with the bank or generate a paper: the
-- editor form needs required_locales to know when to enable Publish, and the
-- generator needs the labels and the pass mark to render a paper.
create policy exam_settings_read on public.exam_settings
  for select to authenticated
  using (
    company_id = (select public.my_company())
    and (
      (select public.has_perm('bank.read'))
      or (select public.has_perm('papers.generate'))
      or (select public.has_perm('papers.read_history'))
    )
  );

-- Changing required_locales decides whether 3,000 questions are usable, and
-- changing the pass mark changes what every future paper says. Administrative,
-- not editorial.
create policy exam_settings_update on public.exam_settings
  for update to authenticated
  using (
    (select public.has_perm('settings.manage'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

/**
 * The set of locales a question must have, for one company.
 *
 * A function rather than a join at each call site, because the completeness
 * trigger in 0054 needs it and triggers cannot see RLS-filtered rows the way a
 * query would. SECURITY DEFINER and revoked: it is reached only from inside
 * other definer functions, exactly as answer_key_at_revision was in 0022.
 *
 * Falls back to {en} when a company has no settings row rather than returning
 * NULL — a missing row must not silently make every question complete, and it
 * must not make every question impossible either. English is the language the
 * bank is authored in, so it is the safe floor.
 */
create or replace function public.required_locales_for(p_company_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.required_locales from public.exam_settings s where s.company_id = p_company_id),
    array['en']
  );
$$;

revoke execute on function public.required_locales_for(uuid) from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Finishing the Hinglish removal
--
-- src/lib/i18n/routing.ts no longer serves 'hi-Latn', so a profile still
-- carrying it would resolve to a locale that does not exist. next-intl answers
-- an unknown locale with a 404, so the symptom is a user who can sign in and
-- then cannot load a single page — and only that user, which is the kind of
-- fault that survives a release because nobody testing has that row.
--
-- Order matters: move the data, then tighten the constraint. Reversed, the
-- ALTER fails against any existing 'hi-Latn' row and the migration aborts.
--
-- 'hi' is the right destination rather than 'en'. Hinglish is Hindi written in
-- Latin script, so a Hinglish reader reads Hindi — the same fallback rule
-- 0033's locale_chain used when it sent hi-Latn to hi before English.
-- ═════════════════════════════════════════════════════════════════════════════
update public.profiles
   set preferred_locale = 'hi'
 where preferred_locale = 'hi-Latn';

alter table public.profiles
  drop constraint if exists profiles_preferred_locale_check;

alter table public.profiles
  add constraint profiles_preferred_locale_check
  check (preferred_locale in ('en', 'hi', 'gu'));

-- handle_new_user() (0003) copies a locale out of raw_user_meta_data when it
-- recognises one, and its allowlist still contains 'hi-Latn' — so a signup
-- carrying that value would insert a row the constraint above now refuses,
-- turning a legal registration into a failed trigger. Nobody would see it but
-- the person trying to register.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ REPRODUCED VERBATIM FROM 0003, WITH EXACTLY ONE LIST CHANGED.             │
-- │                                                                           │
-- │ plpgsql has no partial replace, so changing four characters means         │
-- │ restating fifty lines. The first draft of this block was written from the │
-- │ function's SIGNATURE rather than its body and silently lost the           │
-- │ employee-role grant at the bottom — every new user would have registered  │
-- │ successfully and held no role at all, which fails no constraint and       │
-- │ raises no error.                                                          │
-- │                                                                           │
-- │ That is 0039's `set_config` all over again, and it is why the assertion   │
-- │ below exists rather than a comment promising care. It checks the          │
-- │ SURVIVING function for the two things a retype loses quietly: the role    │
-- │ assignment, and the pending approval status.                              │
-- └───────────────────────────────────────────────────────────────────────────┘
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role_id    uuid;
begin
  -- Single-tenant today: attach to the only company. When multi-tenant, this
  -- resolves from an invite token, never from client-supplied metadata.
  select id into v_company_id
    from public.companies
   where deleted_at is null
   order by created_at
   limit 1;

  insert into public.profiles (
    id, company_id, email, full_name, phone, preferred_locale, approval_status
  )
  values (
    new.id,
    v_company_id,
    new.email,
    -- Display fields only. Fall back to the email local-part so full_name's
    -- NOT NULL can never fail and block signup.
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
             split_part(coalesce(new.email, 'user'), '@', 1)),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    case
      -- THE ONE SUBSTITUTION: 'hi-Latn' removed. Everything else in this
      -- function is 0003's, character for character.
      when new.raw_user_meta_data ->> 'locale' in ('en', 'hi', 'gu')
        then new.raw_user_meta_data ->> 'locale'
      else 'en'
    end,
    'pending'::public.approval_status   -- HARD-CODED. See the box in 0003.
  );

  -- Everyone starts as an employee. Elevation is an explicit admin action,
  -- audited, never a signup-time claim.
  select id into v_role_id
    from public.roles
   where key = 'employee' and company_id is null
   limit 1;

  if v_role_id is not null then
    insert into public.user_roles (user_id, role_id)
    values (new.id, v_role_id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

-- The tripwire for the paragraph above. Reads the function back out of the
-- catalogue and fails the migration if the retype dropped either of the two
-- things whose absence is silent.
do $$
declare
  v_src  text;
  v_code text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';

  if v_src is null then
    raise exception '0053: handle_new_user() is missing after replacement';
  end if;

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ COMMENTS ARE STRIPPED BEFORE ANY OF THESE CHECKS, AND THAT IS NOT       │
   * │ COSMETIC — IT IS THE BUG THIS BLOCK ALREADY HIT ONCE.                   │
   * │                                                                         │
   * │ pg_get_functiondef() returns the definition INCLUDING its comments. The │
   * │ replacement above carries a comment naming the locale tag it removed, so │
   * │ the final assertion matched that comment and aborted the migration —     │
   * │ reporting that the function still admitted the tag when the code did      │
   * │ not. The push failed at this statement and rolled the whole migration    │
   * │ back.                                                                    │
   * │                                                                         │
   * │ The assertion is about CODE. Stripping line comments first is what makes │
   * │ it test the thing it names, and it stops any future comment in this      │
   * │ function from tripping it again.                                        │
   * │                                                                         │
   * │ 'gn' — global, newline-sensitive, so `.` stops at end of line and only   │
   * │ the comment is removed rather than the rest of the definition.           │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  v_code := regexp_replace(v_src, '--.*', '', 'gn');

  if v_code not like '%user_roles%' or v_code not like '%employee%' then
    raise exception
      '0053: handle_new_user() lost the employee role assignment in the retype';
  end if;

  if v_code not like '%pending%' then
    raise exception
      '0053: handle_new_user() lost the pending approval status in the retype';
  end if;

  if v_code like '%hi-Latn%' then
    raise exception
      '0053: handle_new_user() still admits the Hinglish locale in its allowlist, which the CHECK now refuses';
  end if;
end;
$$;

-- ── Comments ─────────────────────────────────────────────────────────────────
comment on type public.bank_difficulty is
  'The three examination levels. An enum rather than a table because generate_exam_paper() names them and the paper blueprint is written against exactly three.';
comment on type public.bank_question_status is
  'draft | active | archived. Deletion is deleted_at on the row, not a status, because a deleted question must still render on papers that already contain it.';
comment on table public.question_topics is
  'Organisational labels for the question bank, managed by Editors. Nothing downstream reads a topic — the generator does not, and papers do not print one — which is why this is an editable table while difficulty and status are enums.';
comment on column public.question_topics.slug is
  'The stable handle. Import files may name topics by slug so a rename for presentation does not silently become a different topic.';
