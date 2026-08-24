-- ═══════════════════════════════════════════════════════════════════════════
-- 0079 — Recipes and menu items, and keeping the retired ones off a paper.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ A QUESTION NAMES A DISH, AND UNTIL NOW NOTHING RECORDED WHICH.            ║
-- ║                                                                           ║
-- ║ "How much mozzarella is used in the 15-inch Hulk pizza?" is about the     ║
-- ║ Hulk, and the bank had no way to say so — the dish existed only inside    ║
-- ║ the sentence, three times over in three languages. So a dish coming off   ║
-- ║ the menu could not be kept off an exam without deleting its questions.    ║
-- ║                                                                           ║
-- ║ MANY-TO-MANY, AND THAT IS NOT A GENERALISATION FOR ITS OWN SAKE.          ║
-- ║ 645 of Aiko's questions name two dishes — "Which allergen is common to    ║
-- ║ both X and Y?" — so a single item_id column, the shape topic_id uses,     ║
-- ║ would have to discard one of them. Discarding either is the failure this  ║
-- ║ table exists to prevent: a comparison question mentioning a withdrawn     ║
-- ║ dish is exactly as unusable as a question solely about it.                ║
-- ║                                                                           ║
-- ║ USAGE IS NOT DELETION. Marking an item unused excludes it from FUTURE     ║
-- ║ draws. It never edits a question, never deletes one, and never touches a  ║
-- ║ paper already generated — those stay valid records of what was asked.     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- The items themselves
-- ═════════════════════════════════════════════════════════════════════════════

create table public.bank_items (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,

  /*
   * BRAND-SCOPED, unlike question_topics.
   *
   * A topic is a filing label both restaurants share — both file questions
   * under Allergens. A dish is not: Aiko's Shoyu Ramen and Capiche's
   * Margherita are different menus, and "Margherita" appearing in Aiko's
   * picker would be an item that can never match one of its questions.
   */
  brand_id   uuid not null references public.brands(id) on delete restrict,

  name       text not null check (length(btrim(name)) between 1 and 120),
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  /*
   * IN USE / NOT IN USE — the whole point of the table.
   *
   * A column rather than a row in some settings blob, because it is asked
   * about on every draw and has to be indexable. Default true: an item that
   * has just been discovered is on the menu until somebody says otherwise.
   */
  in_use     boolean not null default true,

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bank_items_slug_uq
  on public.bank_items (company_id, brand_id, slug) where deleted_at is null;

create index bank_items_brand_idx
  on public.bank_items (company_id, brand_id) where deleted_at is null;

comment on table public.bank_items is
  'A recipe or menu item questions can be about. in_use = false excludes it from future paper draws; it never alters or deletes a question.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Which questions mention which items
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ON DELETE RESTRICT ON THE ITEM, CASCADE ON THE QUESTION.                  │
-- │                                                                           │
-- │ Deleting a question should take its associations with it — they describe  │
-- │ nothing once it is gone. Deleting an ITEM that questions still reference  │
-- │ must fail loudly: the way to retire a dish is in_use = false, and         │
-- │ silently dropping the links would turn a reversible product decision into │
-- │ an irreversible data loss.                                                │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create table public.bank_question_items (
  question_id uuid not null references public.bank_questions(id) on delete cascade,
  item_id     uuid not null references public.bank_items(id)     on delete restrict,
  created_at  timestamptz not null default now(),

  primary key (question_id, item_id)
);

-- The draw asks "which questions mention any of these items", which reads the
-- item side; the primary key already covers the question side.
create index bank_question_items_item_idx
  on public.bank_question_items (item_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — the same rules the topic vocabulary uses
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.bank_items          enable row level security;
alter table public.bank_question_items enable row level security;

create policy bank_items_read on public.bank_items
  for select to authenticated
  using (
    deleted_at is null
    and (select public.has_perm('bank.read'))
    and company_id = (select public.my_company())
    and (brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
  );

create policy bank_items_write on public.bank_items
  for all to authenticated
  using (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
    and (brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
  )
  with check (
    (select public.has_perm('bank.write'))
    and company_id = (select public.my_company())
    and (brand_id = (select public.my_brand()) or (select public.brand_unscoped()))
  );

-- The join carries no facts of its own; it is readable and writable exactly
-- where the question it points at is.
create policy bank_question_items_read on public.bank_question_items
  for select to authenticated
  using (
    (select public.has_perm('bank.read'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = question_id and q.company_id = (select public.my_company())
    )
  );

create policy bank_question_items_write on public.bank_question_items
  for all to authenticated
  using (
    (select public.has_perm('bank.write'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = question_id and q.company_id = (select public.my_company())
    )
  )
  with check (
    (select public.has_perm('bank.write'))
    and exists (
      select 1 from public.bank_questions q
       where q.id = question_id and q.company_id = (select public.my_company())
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Counts per item, for the Recipe / Item Usage picker
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THESE COUNTS OVERLAP, AND THE UI MUST NOT SUM THEM.                       │
-- │                                                                           │
-- │ A question naming two dishes is counted under both, so adding every row   │
-- │ up exceeds the size of the bank. The figures are honest per item — "how   │
-- │ many questions mention this" — and the ELIGIBLE total is computed by      │
-- │ bank_eligible_counts below, which counts questions rather than mentions.  │
-- │ Subtracting these from the total would silently over-count every dish     │
-- │ that appears in a comparison.                                             │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.bank_item_pool_counts(
  p_brand_id   uuid,
  p_difficulty public.bank_difficulty
)
returns table (
  item_id uuid,
  qtype   public.bank_question_type,
  n       int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_perm('papers.generate') or public.has_perm('bank.read')) then
    raise exception 'Not permitted to read question pool counts'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  -- A NULL item_id row is the questions that mention no known item at all.
  -- It is a real bucket the picker offers, not an absence.
  select qi.item_id, q.qtype, count(*)::int
    from public.bank_questions q
    left join public.bank_question_items qi on qi.question_id = q.id
   where q.company_id = public.my_company()
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.status = 'active'
     and q.deleted_at is null
     and (q.brand_id = public.my_brand() or public.brand_unscoped())
   group by qi.item_id, q.qtype;
end;
$$;

revoke execute on function public.bank_item_pool_counts(uuid, public.bank_difficulty) from public, anon;
grant  execute on function public.bank_item_pool_counts(uuid, public.bank_difficulty) to authenticated;

comment on function public.bank_item_pool_counts(uuid, public.bank_difficulty) is
  'Questions mentioning each item, by type, for one brand and level. Counts OVERLAP — a question naming two items is counted under both — so they must not be summed; use bank_eligible_counts for a total. NULL item_id is the no-item bucket. Counts only, never ids or text.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The eligible pool under the whole filter
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ COMPUTED, NEVER SUBTRACTED.                                               │
-- │                                                                           │
-- │ With topics this could be arithmetic: one topic per question, so removing │
-- │ a topic removed a known number. Items overlap, so "total minus excluded"  │
-- │ double-counts every question naming two withdrawn dishes and reports a    │
-- │ pool smaller than the one the draw will find. This asks the same question │
-- │ the draw asks, with the same predicates, and counts DISTINCT questions.   │
-- │                                                                           │
-- │ It is the number the Generate button is enabled against, so it has to be  │
-- │ the number the draw would produce — not an estimate of it.                │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.bank_eligible_counts(
  p_brand_id         uuid,
  p_difficulty       public.bank_difficulty,
  p_topic_ids        uuid[]  default null,
  p_include_no_topic boolean default true,
  p_exclude_item_ids uuid[]  default null,
  p_include_no_item  boolean default true
)
returns table (
  qtype public.bank_question_type,
  n     int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_perm('papers.generate') or public.has_perm('bank.read')) then
    raise exception 'Not permitted to read question pool counts'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select q.qtype, count(*)::int
    from public.bank_questions q
   where q.company_id = public.my_company()
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.status = 'active'
     and q.deleted_at is null
     and (q.brand_id = public.my_brand() or public.brand_unscoped())
     and (
       p_topic_ids is null
       or q.topic_id = any(p_topic_ids)
       or (p_include_no_topic and q.topic_id is null)
     )
     -- ANY excluded item disqualifies the question. A comparison question
     -- naming a withdrawn dish alongside a current one is still a question
     -- about the withdrawn dish.
     and not exists (
       select 1 from public.bank_question_items qi
        where qi.question_id = q.id
          and qi.item_id = any(coalesce(p_exclude_item_ids, '{}'::uuid[]))
     )
     and (
       p_include_no_item
       or exists (select 1 from public.bank_question_items qi where qi.question_id = q.id)
     )
   group by q.qtype;
end;
$$;

revoke execute on function public.bank_eligible_counts(
  uuid, public.bank_difficulty, uuid[], boolean, uuid[], boolean
) from public, anon;
grant  execute on function public.bank_eligible_counts(
  uuid, public.bank_difficulty, uuid[], boolean, uuid[], boolean
) to authenticated;

comment on function public.bank_eligible_counts(
  uuid, public.bank_difficulty, uuid[], boolean, uuid[], boolean
) is
  'Distinct active questions per type that survive the topic and item filters — the pool bank_draw_question_ids will actually draw from. Counts only. Use this rather than subtracting item counts, which overlap.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The draw learns about items
--
-- Dropped and recreated for the same reason 0078 did it: extra parameters make
-- a new function rather than replacing the old one, and two overloads let a
-- caller that forgot the new arguments silently draw unfiltered — which here
-- means a paper full of the dishes somebody withdrew.
-- ═════════════════════════════════════════════════════════════════════════════

drop function if exists public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean
);

create function public.bank_draw_question_ids(
  p_brand_id         uuid,
  p_difficulty       public.bank_difficulty,
  p_qtype            public.bank_question_type,
  p_count            int,
  p_topic_ids        uuid[]  default null,
  p_include_no_topic boolean default true,
  p_exclude_item_ids uuid[]  default null,
  p_include_no_item  boolean default true
)
returns table (id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to generate papers.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_company is null then
    raise exception 'No company context.' using errcode = 'insufficient_privilege';
  end if;

  if not public.brand_in_my_company(p_brand_id) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  if p_count is null or p_count < 0 or p_count > 500 then
    raise exception 'Draw size out of range.' using errcode = 'invalid_parameter_value';
  end if;

  return query
  select q.id
    from public.bank_questions q
   where q.company_id = v_company
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.qtype      = p_qtype
     and q.status = 'active'
     and q.deleted_at is null
     and (
       p_topic_ids is null
       or q.topic_id = any(p_topic_ids)
       or (p_include_no_topic and q.topic_id is null)
     )
     /*
      * THE EXCLUSION, BEFORE THE SAMPLE.
      *
      * Both clauses sit in the same WHERE as `order by random()` below, so a
      * withdrawn dish is never a candidate — it cannot be drawn, cannot
      * survive a re-roll, and cannot be filtered out afterwards leaving a
      * paper one question short.
      */
     and not exists (
       select 1 from public.bank_question_items qi
        where qi.question_id = q.id
          and qi.item_id = any(coalesce(p_exclude_item_ids, '{}'::uuid[]))
     )
     and (
       p_include_no_item
       or exists (select 1 from public.bank_question_items qi where qi.question_id = q.id)
     )
   order by random()
   limit p_count;
end;
$$;

revoke execute on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean, uuid[], boolean
) from public, anon;
grant  execute on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean, uuid[], boolean
) to authenticated;

comment on function public.bank_draw_question_ids(
  uuid, public.bank_difficulty, public.bank_question_type, int, uuid[], boolean, uuid[], boolean
) is
  'A random sample of active question ids for one scope, restricted by topic and by item usage. Both filters are applied before the sample, never after. May return fewer rows than requested; never pads.';

-- ═════════════════════════════════════════════════════════════════════════════
-- What a paper was generated with
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ONE NULLABLE COLUMN, NOT A SECOND CONFIGURATION SYSTEM.                   │
-- │                                                                           │
-- │ exam_papers already records brand, difficulty, marks and the section      │
-- │ split; what it could not answer was "why is there no Hulk question on     │
-- │ this paper" — because the filters were never written down. This holds     │
-- │ the selection as it stood at generation: topics kept, items excluded,     │
-- │ counts requested.                                                         │
-- │                                                                           │
-- │ NULLABLE because every paper generated before today has no configuration  │
-- │ to record, and inventing one for them would be a fabricated audit trail.  │
-- │ The detail screen says "not recorded" for those, which is the truth.      │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.exam_papers
  add column if not exists generation_config jsonb;

comment on column public.exam_papers.generation_config is
  'The filters this paper was generated with — topics included, items excluded, counts requested — as they stood at generation. NULL for papers generated before the generator recorded it; never back-filled.';

-- ═════════════════════════════════════════════════════════════════════════════
-- save_exam_paper records the configuration
--
-- Dropped and recreated, same reasoning as the draw: a defaulted extra
-- parameter would otherwise leave two overloads, and the one PostgREST picked
-- would decide whether a paper remembered how it was made.
-- ═════════════════════════════════════════════════════════════════════════════

drop function if exists public.save_exam_paper(
  uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb
);

create function public.save_exam_paper(
  p_brand_id         uuid,
  p_difficulty       public.bank_difficulty,
  p_marks            smallint,
  p_mcq_n            smallint,
  p_short_n          smallint,
  p_epoch            int,
  p_combination_hash bytea,
  p_questions        jsonb,
  p_config           jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company  uuid := public.my_company();
  v_paper_no int;
  v_paper_id uuid;
  v_n        int;
  v_valid    int;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to generate papers.' using errcode = 'insufficient_privilege';
  end if;

  if not public.brand_in_my_company(p_brand_id) then
    raise exception 'Unknown brand.' using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(p_questions) <> 'array' then
    raise exception 'Questions must be a JSON array.' using errcode = 'invalid_parameter_value';
  end if;

  v_n := jsonb_array_length(p_questions);

  if v_n <> p_mcq_n + p_short_n or v_n <> p_marks then
    raise exception 'Paper holds % questions but claims % marks (% + %).',
      v_n, p_marks, p_mcq_n, p_short_n using errcode = 'check_violation';
  end if;

  select count(*)::int into v_valid
    from jsonb_array_elements(p_questions) as e
    join public.bank_questions q
      on q.id = (e->>'questionId')::uuid
   where q.company_id = v_company
     and q.brand_id   = p_brand_id
     and q.difficulty = p_difficulty
     and q.status     = 'active'
     and q.deleted_at is null
     and q.qtype      = (e->>'section')::public.bank_question_type;

  if v_valid <> v_n then
    raise exception 'A question on this paper is not an active question of this brand, level and type.'
      using errcode = 'foreign_key_violation';
  end if;

  /*
   * THE CONFIGURATION IS RE-CHECKED AGAINST THE PAPER IT CLAIMS TO DESCRIBE.
   *
   * A stored config nobody verified is worse than none: it would answer "why
   * is there no Hulk question here" with a sentence that might be false. So a
   * config naming excluded items is only accepted if no question on the paper
   * actually mentions one of them.
   */
  if p_config ? 'excludedItemIds' then
    select count(*)::int into v_valid
      from jsonb_array_elements(p_questions) as e
      join public.bank_question_items qi
        on qi.question_id = (e->>'questionId')::uuid
     where qi.item_id in (
       select (value #>> '{}')::uuid
         from jsonb_array_elements(p_config->'excludedItemIds')
     );

    if v_valid > 0 then
      raise exception 'This paper contains % question(s) about an item the configuration excludes.', v_valid
        using errcode = 'check_violation';
    end if;
  end if;

  update public.paper_counters
     set next_paper_no = next_paper_no + 1
   where company_id = v_company
  returning next_paper_no - 1 into v_paper_no;

  if v_paper_no is null then
    insert into public.paper_counters (company_id, next_paper_no)
    values (v_company, 2) returning 1 into v_paper_no;
  end if;

  begin
    insert into public.exam_papers (
      company_id, brand_id, paper_no, difficulty, marks, mcq_n, short_n,
      combination_hash, epoch, generated_by, generation_config
    ) values (
      v_company, p_brand_id, v_paper_no, p_difficulty, p_marks, p_mcq_n, p_short_n,
      p_combination_hash, p_epoch, auth.uid(), p_config
    )
    returning id into v_paper_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate');
  end;

  insert into public.exam_paper_questions (paper_id, question_id, question_no, section)
  select v_paper_id,
         (e->>'questionId')::uuid,
         (e->>'questionNo')::smallint,
         (e->>'section')::public.bank_question_type
    from jsonb_array_elements(p_questions) as e;

  return jsonb_build_object('status', 'saved', 'paperId', v_paper_id, 'paperNo', v_paper_no);
end;
$$;

revoke execute on function public.save_exam_paper(
  uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb, jsonb
) from public, anon;
grant  execute on function public.save_exam_paper(
  uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb, jsonb
) to authenticated;

comment on function public.save_exam_paper(
  uuid, public.bank_difficulty, smallint, smallint, smallint, int, bytea, jsonb, jsonb
) is
  'Persists one generated paper and its questions, and records the filters it was generated with. Returns {status:duplicate} rather than raising when the combination already exists. Refuses a configuration that disagrees with the paper.';
