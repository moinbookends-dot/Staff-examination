-- ═════════════════════════════════════════════════════════════════════════════
-- 0056 — Generated papers, their blueprint, and the counters behind them
--
-- Four tables and one helper. Nothing here generates anything; 0057 does that.
-- This is the shape the history is kept in, and the shape is what makes
-- "the same paper is never generated twice" enforceable rather than attempted.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- brand_unscoped() — who may work across every brand in their company
--
-- Chefs are pinned to the brand on their profile. Editors and super admins are
-- not: an Editor maintains all the banks, and pinning them would lock them out
-- of the job. That rule is needed by several policies below, so it is named
-- once here rather than spelled out four times and eventually mis-spelled once.
--
-- Keyed on bank.read because that is exactly the population meant: the people
-- who may see the question bank are the people who may see every brand's
-- papers. A chef holds neither.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.brand_unscoped()
returns boolean
language sql
stable
as $$
  select public.is_super_admin() or public.has_perm('bank.read');
$$;

grant execute on function public.brand_unscoped() to authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════════════
-- paper_settings — the blueprint, in one queryable place
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE 80/20 RATIO IS A CONSTRAINT, NOT A CONVENTION.                        │
-- │                                                                           │
-- │ "Never change this ratio" is the kind of rule that survives exactly as    │
-- │ long as the person who read it. Expressed as a CHECK, it survives         │
-- │ everybody — including a future settings screen, a psql session and an     │
-- │ import script.                                                            │
-- │                                                                           │
-- │ Written as integer cross-multiplication rather than `mcq_n = marks * 0.8` │
-- │ on purpose: the float form is exactly true for 20 and 50 and stops being  │
-- │ exactly true for values somebody adds later, and a constraint that is     │
-- │ almost satisfied is a constraint that rejects a legal row.                │
-- │                                                                           │
-- │ WHAT IS ACTUALLY EDITABLE HERE, stated because it is less than it looks:  │
-- │ with the ratio locked and every question worth one mark, a paper size     │
-- │ DETERMINES its own split — 20 can only ever be 16+4, 50 only 40+10. So a  │
-- │ super admin editing "the distribution" has no degrees of freedom at all.  │
-- │ What this table really buys is a new paper SIZE without a migration: a    │
-- │ 25-mark paper would be 20+5 and satisfies every constraint below.         │
-- │ Today exactly two rows are seeded, because the specification allows two.  │
-- │ The Settings screen therefore DISPLAYS this rather than editing it.       │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
create table public.paper_settings (
  company_id uuid not null references public.companies(id) on delete restrict,
  marks      smallint not null check (marks > 0 and marks <= 200),

  mcq_n      smallint not null check (mcq_n   > 0),
  short_n    smallint not null check (short_n > 0),

  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (company_id, marks),

  -- Every question is worth exactly one mark, so the counts and the total are
  -- the same number seen twice. Asserting it stops a blueprint that produces a
  -- 20-question paper worth 22 marks.
  constraint paper_settings_counts_sum check (mcq_n + short_n = marks),

  -- 80% MCQ, 20% short answer. mcq_n * 5 = marks * 4 is "mcq_n = 0.8 × marks"
  -- in integers, and it also refuses any total that cannot split cleanly.
  constraint paper_settings_ratio check (
    mcq_n * 5 = marks * 4 and short_n * 5 = marks * 1
  )
);

create trigger paper_settings_set_updated_at
  before update on public.paper_settings
  for each row execute function public.set_updated_at();

-- The two the specification allows, for every company that exists. A company
-- created later gets its rows from the seed, which is idempotent.
insert into public.paper_settings (company_id, marks, mcq_n, short_n)
select c.id, v.marks, v.mcq_n, v.short_n
  from public.companies c
 cross join (values (20::smallint, 16::smallint, 4::smallint),
                    (50::smallint, 40::smallint, 10::smallint)) as v(marks, mcq_n, short_n)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- paper_counters — paper numbers, and the generation epoch
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A COUNTER ROW, NOT max(paper_no) + 1.                                     │
-- │                                                                           │
-- │ Two chefs pressing Generate at the same moment both read the same max and │
-- │ both write paper 43. The unique index would catch it and one of them      │
-- │ would see an error on an operation that had no reason to fail.            │
-- │                                                                           │
-- │ `update … returning` takes a row lock, so the second transaction waits    │
-- │ and then reads the number the first one wrote. Serialisation by the       │
-- │ database rather than by hoping.                                           │
-- │                                                                           │
-- │ Not a Postgres SEQUENCE, for two reasons: sequences are not transactional │
-- │ so a rolled-back generation would burn a number and leave a permanent     │
-- │ gap in an audit trail people read, and one sequence per company cannot be │
-- │ created without DDL at runtime.                                           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- current_epoch is the reset mechanism, and it exists for one narrow case
-- described in 0058. Papers are never deleted; the epoch is included in the
-- uniqueness rule, so raising it makes previously-issued combinations
-- available again while every historical row stays exactly where it is.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.paper_counters (
  company_id    uuid primary key references public.companies(id) on delete restrict,
  next_paper_no int not null default 1 check (next_paper_no > 0),
  current_epoch int not null default 1 check (current_epoch > 0),
  updated_at    timestamptz not null default now()
);

create trigger paper_counters_set_updated_at
  before update on public.paper_counters
  for each row execute function public.set_updated_at();

insert into public.paper_counters (company_id)
select c.id from public.companies c
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_papers
-- ═════════════════════════════════════════════════════════════════════════════
create table public.exam_papers (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  brand_id   uuid not null references public.brands(id)    on delete restrict,

  -- The handle people quote. Question UUIDs are hidden from everybody but
  -- Editors, so this is the only name a chef has for a paper — which is why it
  -- is a short integer somebody can read down a phone rather than a uuid.
  paper_no   int not null check (paper_no > 0),

  difficulty public.bank_difficulty not null,
  marks      smallint not null,

  -- Copied from paper_settings at generation, never joined to it. The settings
  -- are editable; a paper generated under 16+4 must still report 16+4 after
  -- somebody changes them, or the history quietly rewrites itself.
  mcq_n      smallint not null check (mcq_n > 0),
  short_n    smallint not null check (short_n > 0),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ THE FINGERPRINT OF A COMBINATION. A SET, NOT A SEQUENCE.                │
  -- │                                                                         │
  -- │ sha256 over this paper's question ids, SORTED, so the hash describes    │
  -- │ which questions are on the paper and not the order they were shuffled   │
  -- │ into. Two papers holding the same twenty questions in different orders  │
  -- │ are the same paper, and the specification says so: "if the exact        │
  -- │ combination already exists".                                            │
  -- │                                                                         │
  -- │ bytea rather than hex text: 32 bytes instead of 64, and no case to get  │
  -- │ wrong on the way in — which is a bug source_documents.sha256 needed a   │
  -- │ CHECK and a .toLowerCase() to avoid.                                    │
  -- └─────────────────────────────────────────────────────────────────────────┘
  combination_hash bytea not null check (length(combination_hash) = 32),

  epoch      int not null check (epoch > 0),

  generated_by uuid not null references public.profiles(id) on delete restrict,
  generated_at timestamptz not null default now(),

  -- One sequence per company, as chosen: paper 42 is paper 42 regardless of
  -- brand, level or size, so a number identifies a paper with nothing else
  -- quoted alongside it.
  constraint exam_papers_no_uq unique (company_id, paper_no),

  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ "THE SAME PAPER IS NEVER GENERATED TWICE" — ENFORCED HERE AND NOWHERE   │
  -- │ ELSE.                                                                   │
  -- │                                                                         │
  -- │ Not by the SELECT that 0057 runs before inserting. That select is an    │
  -- │ optimisation; two concurrent generations both pass it. This index is    │
  -- │ what actually holds, and 0057's retry loop exists to answer it.         │
  -- │                                                                         │
  -- │ Scoped per brand because the banks are separate — two brands drawing    │
  -- │ structurally identical papers from different question sets is a         │
  -- │ coincidence, not a repeat. Scoped per epoch because that is what a      │
  -- │ reset moves.                                                            │
  -- └─────────────────────────────────────────────────────────────────────────┘
  constraint exam_papers_combination_uq
    unique (company_id, brand_id, epoch, difficulty, marks, combination_hash)
);

-- The history screen: newest first, filtered by brand, level and size.
create index exam_papers_history_idx
  on public.exam_papers (company_id, brand_id, generated_at desc);

-- The exhaustion count in 0057: how many papers exist for this combination
-- in the current epoch.
create index exam_papers_epoch_idx
  on public.exam_papers (company_id, brand_id, epoch, difficulty, marks);

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_paper_questions
-- ═════════════════════════════════════════════════════════════════════════════
create table public.exam_paper_questions (
  paper_id    uuid not null references public.exam_papers(id) on delete cascade,

  -- ╔═══════════════════════════════════════════════════════════════════════╗
  -- ║ ON DELETE RESTRICT, AND IT IS WHY "DELETE QUESTION" IS A SOFT DELETE.  ║
  -- ║                                                                       ║
  -- ║ "Never lose history" and "Editors can delete questions" are only       ║
  -- ║ compatible if deletion does not remove the row. This constraint is     ║
  -- ║ what makes that structural: a hard DELETE on a question that has ever  ║
  -- ║ appeared on a paper is refused by the database, so the soft delete is  ║
  -- ║ not a convention the application follows — it is the only thing that   ║
  -- ║ works.                                                                 ║
  -- ║                                                                       ║
  -- ║ The paper therefore renders correctly forever, including for questions ║
  -- ║ that were deleted from the bank years earlier.                         ║
  -- ╚═══════════════════════════════════════════════════════════════════════╝
  question_id uuid not null references public.bank_questions(id) on delete restrict,

  -- 1-based, and unique per paper: this is the number printed beside the
  -- question, so it is the shared vocabulary between the paper and its key.
  --
  -- Named question_no rather than `position`, which is a SQL keyword. Postgres
  -- does accept it as a column name, but it is also a function — POSITION(x IN
  -- y) — so every bare use sits next to an ambiguity, and a column that has to
  -- be quoted to be safe is a column that will eventually be written unquoted.
  question_no smallint not null check (question_no > 0),

  -- Which half of the paper. Same enum as the question's own type, because a
  -- section IS a type here — Section A is the MCQs, Section B the short
  -- answers — and a separate vocabulary would be two names for one fact.
  section     public.bank_question_type not null,

  primary key (paper_id, question_no),

  -- A question cannot appear twice on one paper. The draw uses a random sample
  -- without replacement so this should be unreachable; it is declared because
  -- "should be unreachable" is not a guarantee and a duplicated question on a
  -- printed exam is not recoverable after it has been sat.
  constraint exam_paper_questions_once unique (paper_id, question_id)
);

-- "Has this question ever been used?" — needed to decide whether a purge is
-- allowed, and to show usage in the Editor.
create index exam_paper_questions_question_idx
  on public.exam_paper_questions (question_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_paper_files — six rows per paper
--
-- Three languages × (paper, answer key). A row exists only once its object is
-- really in the bucket, so the history screen can offer a download that works
-- rather than a link that 404s — the same rule finaliseUpload applies to a
-- source document.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.exam_paper_files (
  paper_id     uuid not null references public.exam_papers(id) on delete cascade,
  locale       text not null check (locale in ('en', 'hi', 'gu')),
  kind         text not null check (kind in ('paper', 'key')),

  storage_path text not null unique,
  byte_size    bigint check (byte_size > 0),

  created_at   timestamptz not null default now(),

  primary key (paper_id, locale, kind)
);

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ READ-ONLY TO EVERY CLIENT. THE GENERATOR IS THE ONLY WRITER.              │
-- │                                                                           │
-- │ There is no insert or update policy on any table below, for anybody. A    │
-- │ client able to write exam_papers directly could choose its own paper      │
-- │ number, its own combination hash — the one field the never-twice rule     │
-- │ depends on — or its own epoch, and could write exam_paper_questions       │
-- │ rows that disagree with the hash beside them.                             │
-- │                                                                           │
-- │ 0057's generate_exam_paper() is SECURITY DEFINER and is the whole write   │
-- │ surface, exactly as start_attempt() was for attempts in 0025.             │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.paper_settings       enable row level security;
alter table public.paper_counters       enable row level security;
alter table public.exam_papers          enable row level security;
alter table public.exam_paper_questions enable row level security;
alter table public.exam_paper_files     enable row level security;

-- Anyone who may generate needs to know what a paper is made of, and the
-- Generate screen shows the split before it draws anything.
create policy paper_settings_read on public.paper_settings
  for select to authenticated
  using (
    (select public.has_perm('papers.generate'))
    and company_id = (select public.my_company())
  );

create policy paper_settings_update on public.paper_settings
  for update to authenticated
  using (
    (select public.has_perm('settings.manage'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- paper_counters has NO read policy at all. next_paper_no leaks how many papers
-- a company has generated and current_epoch leaks that a reset happened;
-- neither is anybody's business through PostgREST, and both are read inside
-- SECURITY DEFINER functions that do not consult policies.

create policy exam_papers_read on public.exam_papers
  for select to authenticated
  using (
    (select public.has_perm('papers.read_history'))
    and company_id = (select public.my_company())
    -- Chefs see their own brand's papers; Editors and super admins see all.
    and (brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
  );

/*
 * The questions ON a paper are readable by anyone who can read the paper —
 * including a chef, who needs them for the Exam Details screen.
 *
 * THIS IS NOT A HOLE IN THE UUID RULE, because of what is and is not here.
 * This table holds question_id, and a chef reading it learns a set of uuids.
 * What they cannot do is resolve one into a question: bank_questions and
 * bank_question_texts are closed to them (0055), so the ids are opaque tokens
 * that unlock nothing.
 *
 * Even so, the Details screen does not go through this table — it calls
 * exam_paper_content(), which returns text and omits the ids entirely. This
 * policy exists so the paper's question COUNT can be read without a definer
 * function, and it is the narrowest thing that achieves that.
 */
create policy exam_paper_questions_read on public.exam_paper_questions
  for select to authenticated
  using (
    exists (
      select 1 from public.exam_papers p
       where p.id = exam_paper_questions.paper_id
         and (select public.has_perm('papers.read_history'))
         and p.company_id = (select public.my_company())
         and (p.brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
    )
  );

create policy exam_paper_files_read on public.exam_paper_files
  for select to authenticated
  using (
    exists (
      select 1 from public.exam_papers p
       where p.id = exam_paper_files.paper_id
         and (select public.has_perm('papers.read_history'))
         and p.company_id = (select public.my_company())
         and (p.brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
    )
  );

-- ── Comments ─────────────────────────────────────────────────────────────────
comment on table public.paper_settings is
  'The paper blueprint. The 80/20 ratio is a CHECK, not a convention. With one mark per question a size determines its own split, so this table buys new paper SIZES rather than new ratios.';
comment on column public.exam_papers.combination_hash is
  'sha256 of the SORTED question ids. A set, not a sequence — the same questions shuffled differently are the same paper.';
comment on constraint exam_papers_combination_uq on public.exam_papers is
  'The never-twice rule. The generator''s pre-check is an optimisation; this index is what actually holds under concurrency.';
comment on table public.exam_paper_questions is
  'ON DELETE RESTRICT against bank_questions is what makes "delete a question" necessarily a soft delete — history cannot lose the questions it names.';
