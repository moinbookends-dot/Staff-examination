-- ═════════════════════════════════════════════════════════════════════════════
-- 0052 — A company's own words for how hard a question is
--
-- Chefs do not think in "difficulty 4". They think "Advanced", or "Commis
-- level", or whatever their kitchen actually says out loud. This gives each
-- company its own vocabulary without touching the number underneath it.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ LABELS OVER THE 1-5 SCALE. THE SCALE DOES NOT MOVE.                       │
-- │                                                                           │
-- │ The obvious request — "let me define my own difficulty levels" — reads as │
-- │ "replace 1-5 with my list". That would break, at minimum:                 │
-- │                                                                           │
-- │   questions.difficulty        0009, smallint CHECK between 1 and 5        │
-- │   exam_rules.difficulty_min   0014, same CHECK, and .._max beside it      │
-- │   draw_paper()                0014, selects on                            │
-- │                                 `q.difficulty between min and max`,       │
-- │                               and its FALLBACK ranks candidates by        │
-- │                               `abs(q.difficulty - difficulty_min)` —      │
-- │                               arithmetic that needs an ordered number,    │
-- │                               not a label                                 │
-- │   question_stats()            0030, groups and compares on it             │
-- │   observed_difficulty_band()  0044, maps facility onto exactly 1..5 and   │
-- │                               is what `misrated` is computed from         │
-- │                                                                           │
-- │ So the number stays and the NAMES become the company's. A level is a      │
-- │ named band over 1-5: picking "Advanced" sets a rule's difficulty_min and  │
-- │ difficulty_max to that band's ends, and draw_paper runs exactly as it     │
-- │ always has. Nothing downstream learns a new concept.                      │
-- │                                                                           │
-- │ What this deliberately does NOT do is add a difficulty_level_id to        │
-- │ exam_rules. A rule would then carry the same fact twice — the level and   │
-- │ the numbers — and the two would disagree the first time somebody renamed  │
-- │ a band or nudged a number. The level is an input to the numbers, not a    │
-- │ second copy of them.                                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ BANDS MAY OVERLAP, AND THAT IS NOT A BUG TO CONSTRAIN AWAY.               │
-- │                                                                           │
-- │ A company may reasonably want                                             │
-- │                                                                           │
-- │     Easy        1-2                                                       │
-- │     Foundation  1-3                                                       │
-- │     Advanced    4-5                                                       │
-- │                                                                           │
-- │ "Easy" and "Foundation" overlap and neither is wrong: they are two ways   │
-- │ of asking for an overlapping set of questions, the way "this week" and    │
-- │ "this month" overlap. Forbidding it — an exclusion constraint over the    │
-- │ range — would be the schema inventing a rule nobody asked for, and the    │
-- │ first person to hit it would have no idea why.                            │
-- │                                                                           │
-- │ Nor is full coverage of 1-5 required. A company that never writes trivial │
-- │ questions has no level containing 1, and a paper built from levels simply │
-- │ never asks for one. Requiring coverage would force a name onto a band the │
-- │ company does not use.                                                     │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.difficulty_levels (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  name text not null check (length(btrim(name)) between 1 and 40),

  -- The band, in the units everything downstream already speaks.
  min_level smallint not null check (min_level between 1 and 5),
  max_level smallint not null check (max_level between 1 and 5),

  -- Display order. Not derived from min_level: a company may want a level that
  -- spans the whole range ("Any") listed first or last regardless of where its
  -- band starts, and sorting by min_level would put it wherever the arithmetic
  -- happened to land.
  sort_order smallint not null default 0,

  -- What a new rule starts on. At most one per company — enforced by the
  -- partial unique index below rather than a trigger, because "at most one row
  -- where a flag is true" is exactly what a partial unique index is for.
  is_default boolean not null default false,

  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint difficulty_levels_ordered check (max_level >= min_level),
  -- Same shape as exam_rules_difficulty_ordered (0014). A band whose end is
  -- below its start matches nothing, and a rule built from it would draw an
  -- empty paper for a reason nobody could see on the screen.

  constraint difficulty_levels_name_per_company unique (company_id, name)
);

create unique index difficulty_levels_one_default
  on public.difficulty_levels (company_id) where is_default;

create index difficulty_levels_company_idx
  on public.difficulty_levels (company_id, sort_order, name);

create trigger difficulty_levels_set_updated_at
  before update on public.difficulty_levels
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS
--
-- Read is questions.read: anyone who can see the bank sees the vocabulary its
-- difficulty is described in, or the labels would be missing exactly where the
-- questions are.
--
-- Writes are exams.update, not a new permission. Levels exist to build papers
-- with, and whoever builds papers is who needs to name the bands they build
-- from. Inventing a `difficulty.manage` permission would add a row to every
-- role's grant list to express a capability that already travels with exam
-- authoring.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.difficulty_levels enable row level security;

create policy difficulty_levels_read on public.difficulty_levels
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
  );

create policy difficulty_levels_insert on public.difficulty_levels
  for insert to authenticated
  with check (
    (select public.has_perm('exams.update'))
    and company_id = (select public.my_company())
    and created_by = (select auth.uid())
  );

create policy difficulty_levels_update on public.difficulty_levels
  for update to authenticated
  using (
    (select public.has_perm('exams.update'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A DELETE POLICY, WHICH MOST TABLES HERE DO NOT GET.                       │
-- │                                                                           │
-- │ questions, exams and source_documents all refuse DELETE because something │
-- │ else points at them and would be left unexplainable — an attempt citing a │
-- │ vanished question, a result citing a vanished exam.                       │
-- │                                                                           │
-- │ Nothing points at a difficulty level. It is read to fill in two numbers   │
-- │ on a rule and is not referenced again; exam_rules stores the numbers, not │
-- │ the level (see the header). So deleting "Advanced" leaves every rule ever │
-- │ built from it working exactly as before, and the row really is disposable │
-- │ in the way those others are not.                                          │
-- │                                                                           │
-- │ That is only true while no column references this table. A future         │
-- │ difficulty_level_id anywhere makes this policy wrong, and the header      │
-- │ explains why that column should not exist.                                │
-- └───────────────────────────────────────────────────────────────────────────┘
create policy difficulty_levels_delete on public.difficulty_levels
  for delete to authenticated
  using (
    (select public.has_perm('exams.update'))
    and company_id = (select public.my_company())
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- A starting vocabulary, per company
--
-- Seeded so the picker is never empty on the day this ships — an empty list
-- would read as a broken feature rather than one nobody has configured. These
-- five are a STARTING POINT and are expected to be renamed and rebanded; the
-- names are deliberately ordinary rather than kitchen-specific, because a
-- guess at somebody's house vocabulary is worse than a plain word they will
-- replace.
--
-- INSERT ... SELECT over companies, so every existing tenant gets them and a
-- single-tenant assumption is not baked in. created_by is the company's oldest
-- approved profile: the column is NOT NULL and there is no system actor in this
-- schema, so a real person has to own the row. Companies with no profile yet
-- get no levels and pick them up when someone creates one by hand.
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.difficulty_levels
  (company_id, name, min_level, max_level, sort_order, is_default, created_by)
select c.id, v.name, v.min_level, v.max_level, v.sort_order, v.is_default, p.id
  from public.companies c
  cross join (values
    ('Beginner',     1::smallint, 1::smallint, 1::smallint, false),
    ('Easy',         2::smallint, 2::smallint, 2::smallint, false),
    ('Medium',       3::smallint, 3::smallint, 3::smallint, true),
    ('Hard',         4::smallint, 4::smallint, 4::smallint, false),
    ('Expert',       5::smallint, 5::smallint, 5::smallint, false)
  ) as v(name, min_level, max_level, sort_order, is_default)
  cross join lateral (
    select pr.id from public.profiles pr
     where pr.company_id = c.id and pr.approval_status = 'approved'
     order by pr.created_at
     limit 1
  ) p
on conflict (company_id, name) do nothing;

comment on table public.difficulty_levels is
  'A company''s own names for bands of the 1-5 difficulty scale. The scale itself does not change: questions.difficulty, exam_rules.difficulty_min/max, draw_paper()''s selection AND its fallback arithmetic, question_stats() and observed_difficulty_band() all key on the number, and draw_paper ranks fallback candidates by abs(difficulty - difficulty_min), which needs an ordered number rather than a label. Picking a level sets a rule''s two numbers; exam_rules deliberately does NOT store a level id, because a rule holding both the level and the numbers would carry the same fact twice and they would disagree the first time a band was renamed. Bands may overlap and need not cover 1-5 — both are legitimate ways for a company to describe its own questions.';
