-- ═════════════════════════════════════════════════════════════════════════════
-- 0043 — Saved filters, and an index for the sort the bank has always used
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY A TABLE STORING A QUERY STRING, AND NOT PARSED COLUMNS.               │
-- │                                                                           │
-- │ The obvious design is a column per filter — status, category_id,          │
-- │ difficulty, bloom_level — and it is wrong here. questionFiltersSchema      │
-- │ (src/lib/questions/filters.ts) is already the single definition of what a │
-- │ filter means, and 0037 has just demonstrated what happens when a second   │
-- │ copy of an enum falls behind: `?status=approved` parsed as invalid and    │
-- │ silently discarded the search term, the category and the difficulty along │
-- │ with it.                                                                  │
-- │                                                                           │
-- │ A saved filter is a BOOKMARK. Storing the query string means a saved      │
-- │ filter naming something that no longer exists degrades exactly like a     │
-- │ bookmark does — parseQuestionFilters drops the offending key and keeps    │
-- │ the rest — instead of becoming a row whose shape no longer typechecks.    │
-- │ It also means adding a filter next month requires no migration.          │
-- │                                                                           │
-- │ The cost is that these cannot be queried by facet in SQL. Nothing wants   │
-- │ to. They are a list in a dropdown.                                        │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ PRIVATE MEANS PRIVATE.                                                    │
-- │                                                                           │
-- │ Every policy below is `owner_id = auth.uid()`, with no has_perm escape    │
-- │ and no admin read. This is the one table in the schema where a Super      │
-- │ Admin is not privileged, and that is deliberate: a saved filter is a note │
-- │ someone wrote to themselves about their own work in progress. It is not   │
-- │ company data, and there is no operational reason for anyone else to read  │
-- │ it.                                                                       │
-- │                                                                           │
-- │ company_id is carried anyway, for two reasons: a saved filter must die    │
-- │ with the company that scoped it, and the product decision to keep these   │
-- │ private was explicitly "for now" — sharing with an outlet later needs a   │
-- │ policy, not a data migration.                                            │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.question_saved_filters (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  owner_id   uuid not null references public.profiles(id) on delete cascade,

  name       text not null check (length(btrim(name)) between 1 and 80),

  -- The URL query string, without the leading '?'. Bounded because it is
  -- attacker-controlled text that is read straight back into a link: 2000 is
  -- comfortably above any filter combination this schema can produce and far
  -- below anything that would make the dropdown a payload.
  query      text not null check (length(query) <= 2000),

  created_at timestamptz not null default now(),

  -- Saving over a name replaces rather than accumulates. Without this, "Needs
  -- Bloom" saved four times is four identical entries in the menu.
  unique (owner_id, name)
);

create index question_saved_filters_owner_idx
  on public.question_saved_filters (owner_id, name);

alter table public.question_saved_filters enable row level security;

-- ── Policies ─────────────────────────────────────────────────────────────────
--
-- One per verb rather than one FOR ALL, so the WITH CHECK on insert and update
-- can constrain company_id — which USING cannot, because on INSERT there is no
-- old row and on UPDATE it is evaluated against the old one.

create policy question_saved_filters_read on public.question_saved_filters
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy question_saved_filters_insert on public.question_saved_filters
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    -- Pinned to the caller's own company rather than trusted from the client.
    -- Nothing here is dangerous today; it is what stops a saved filter from
    -- outliving the company it belongs to via the ON DELETE CASCADE above.
    and company_id = (select public.my_company())
  );

create policy question_saved_filters_update on public.question_saved_filters
  for update to authenticated
  using      (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid())
              and company_id = (select public.my_company()));

create policy question_saved_filters_delete on public.question_saved_filters
  for delete to authenticated
  using (owner_id = (select auth.uid()));

comment on table public.question_saved_filters is
  'A chef''s own saved question-bank filters. Stores the URL query string rather than parsed columns: questionFiltersSchema is already the one definition of what a filter means, and a saved filter naming a since-removed value should degrade like a stale bookmark, not become an unparseable row. Private to the owner with no admin read — this is a note someone wrote to themselves, not company data.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The index the list has always needed
--
-- listQuestions has ordered by `updated_at desc` on every call since 0009, and
-- nothing indexed it: questions_pick_idx is (company_id, brand_id, category_id,
-- difficulty, status) for the exam builder's draw, and the other three are GIN
-- and created_by. So the default view of the bank has always been a sort over
-- the whole company's questions.
--
-- It went unnoticed because the bank is small. Making the columns sortable is
-- about to multiply how often that sort runs, so it is worth fixing before
-- rather than after.
--
-- company_id leads because RLS puts an equality predicate on it in every single
-- query; updated_at follows in the direction the list actually reads it. The
-- partial clause matches the `is null` filter listQuestions always applies.
--
-- The OTHER sortable columns are deliberately left unindexed. A few thousand
-- rows sorts in single-digit milliseconds, and an index per sortable column is
-- eight indexes to maintain on every write to serve a click nobody may make.
-- ═════════════════════════════════════════════════════════════════════════════
create index questions_updated_idx
  on public.questions (company_id, updated_at desc)
  where deleted_at is null;
