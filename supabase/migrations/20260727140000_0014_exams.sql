-- ═════════════════════════════════════════════════════════════════════════════
-- 0014 — Exams: structure, rule-based selection, and the frozen paper
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ M4 OBLIGATIONS — DO NOT SKIP.                                             │
-- │                                                                           │
-- │ 1. attempt_questions. paper_mode='per_attempt' exams draw at attempt      │
-- │    start, into a table keyed by attempt_id. It cannot exist here: it      │
-- │    needs a foreign key to `attempts`, which M4 owns. M4 MUST create it    │
-- │    with the same columns as exam_questions and populate it by calling     │
-- │    draw_paper() — NOT by writing a second selector. Two copies of         │
-- │    "resolve rules into questions" is how the two modes silently diverge.  │
-- │                                                                           │
-- │ 2. Fallback recording. draw_paper() returns fallback_reason per row.      │
-- │    M4 must persist it on attempt_questions, or an administrator's         │
-- │    misconfiguration is invisible after the fact — the candidate sat a     │
-- │    substituted paper and nothing records that they did.                   │
-- │                                                                           │
-- │ 3. attempt_answers.question_revision, still outstanding from 0011.        │
-- │                                                                           │
-- │ 4. exam_sections.duration_minutes is RESERVED here and enforced by M4's   │
-- │    delivery timer. Reserving the column now is free; retrofitting a       │
-- │    per-section timer into a live delivery loop is not.                    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THE TWO PAPER MODES, AND WHY IT IS A COLUMN
--
-- Official/monthly/annual/practical exams freeze one paper at publish, so every
-- candidate sits the same questions and scores are comparable. Practice and quiz
-- kinds draw fresh per attempt, so repeated practice is not repeated
-- memorisation.
--
-- paper_mode is a COLUMN defaulted from kind, not a switch on kind. A switch
-- would scatter the same conditional through the builder, delivery, the grader
-- and every report; a column keeps the rule in one place and lets a chef make a
-- practice exam fixed when they want to compare two cohorts.
-- ═════════════════════════════════════════════════════════════════════════════

create type public.paper_mode as enum ('fixed', 'per_attempt');

-- Who an exam is assigned to. Every one of these is already a JWT claim, which
-- is what lets the candidate-visibility policy join nothing but the assignment
-- table. See the RLS section.
create type public.assignment_target as enum ('outlet', 'department', 'brand', 'role');

-- ── exams ────────────────────────────────────────────────────────────────────
create table public.exams (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  -- null = every brand. An Aiko service exam is irrelevant to Capiche kitchen.
  brand_id    uuid references public.brands(id) on delete restrict,

  title       text not null check (length(btrim(title)) between 3 and 200),
  description text,
  instructions text,

  kind        public.exam_kind   not null default 'official',
  status      public.exam_status not null default 'draft',
  paper_mode  public.paper_mode  not null default 'fixed',

  -- ── Timing ────────────────────────────────────────────────────────────────
  duration_minutes int not null default 30 check (duration_minutes between 1 and 600),
  opens_at    timestamptz,
  closes_at   timestamptz,
  -- Wall-clock, not merely an instant. "Opens 9am Monday" is a commitment to a
  -- local time; storing timestamptz alone cannot render that correctly if the
  -- group ever operates outside IST. Mirrors outlets.timezone (0002).
  timezone    text not null default 'Asia/Kolkata',

  -- ── Attempt policy ────────────────────────────────────────────────────────
  max_attempts      int not null default 1 check (max_attempts between 1 and 10),
  pass_mark_percent numeric(5,2) not null default 60 check (pass_mark_percent between 0 and 100),
  shuffle_questions boolean not null default true,
  -- Shuffling applies in BOTH paper modes. It costs nothing and removes the
  -- over-the-shoulder problem a fixed paper would otherwise have.
  shuffle_options   boolean not null default true,
  allow_backtrack   boolean not null default true,
  negative_marking_enabled boolean not null default false,

  -- ── Evaluation ────────────────────────────────────────────────────────────
  verification_mode public.verification_mode not null default 'dual',
  -- DERIVED at publish from the formats actually drawn, never author-set. An
  -- exam that claims to be auto-gradable while holding essays leaves those
  -- attempts waiting forever for an evaluation queue nobody told about them.
  requires_manual_grading boolean not null default false,

  -- Practice and quiz responses are low-stakes and would poison difficulty
  -- calibration. They still count towards usage_count — a question is exposed
  -- either way — but M7 must exclude them from item statistics.
  counts_towards_analytics boolean not null default true,

  -- ── Stamped at publish ────────────────────────────────────────────────────
  total_marks    numeric(8,2),
  question_count int,

  created_by   uuid not null references public.profiles(id) on delete restrict,
  updated_by   uuid references public.profiles(id) on delete set null,
  published_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint exams_window_ordered check (
    opens_at is null or closes_at is null or closes_at > opens_at
  ),
  -- A published exam without a paper is the failure publish_exam() exists to
  -- prevent; assert it here so no other write path can produce one.
  constraint exams_published_has_paper check (
    status = 'draft' or paper_mode = 'per_attempt'
    or (published_at is not null and question_count is not null and question_count > 0)
  )
);

create index exams_list_idx on public.exams (company_id, status, kind) where deleted_at is null;
create index exams_brand_idx on public.exams (brand_id) where deleted_at is null;

-- ── exam_sections ────────────────────────────────────────────────────────────
-- An exam is a list of sections and a section owns its rules. A flat exam is
-- ONE IMPLICIT SECTION, created for it — so there is never a second code path
-- for "exam without sections".
create table public.exam_sections (
  id          uuid primary key default gen_random_uuid(),
  exam_id     uuid not null references public.exams(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  description text,
  instructions text,
  sort_order  smallint not null default 0,
  -- RESERVED. Null = shares the exam's overall time. M4's delivery timer
  -- enforces it; nothing does today.
  duration_minutes int check (duration_minutes between 1 and 600),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index exam_sections_exam_idx on public.exam_sections (exam_id, sort_order);

-- ── exam_rules ───────────────────────────────────────────────────────────────
-- The saved filter that selects questions. Chosen over pool membership tables
-- because membership goes stale — a question added next week belongs to no pool
-- until somebody remembers to add it (see CHANGELOG, M2 decisions).
--
-- section_id is NOT NULL: rules belong to sections, never to the exam directly.
-- Allowing both would mean every query that assembles a paper handles two
-- parents.
create table public.exam_rules (
  id         uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.exam_sections(id) on delete cascade,
  sort_order smallint not null default 0,

  category_id          uuid references public.categories(id) on delete restrict,
  -- Categories are a tree (Knives → Sharpening). Defaulting to true matches
  -- what a chef means by "Food Safety questions".
  include_subcategories boolean not null default true,
  tag_ids              uuid[] not null default '{}',
  question_types       public.question_type[],

  difficulty_min smallint not null default 1 check (difficulty_min between 1 and 5),
  difficulty_max smallint not null default 5 check (difficulty_max between 1 and 5),

  question_count     int not null check (question_count between 1 and 200),
  -- Null = use each question's own marks. Set = every question in this rule is
  -- worth the same, which is how most chefs think about a section.
  marks_per_question numeric(6,2) check (marks_per_question > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint exam_rules_difficulty_ordered check (difficulty_max >= difficulty_min)
);

create index exam_rules_section_idx on public.exam_rules (section_id, sort_order);

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_questions — THE FROZEN PAPER
--
-- Written once, by publish_exam(), for paper_mode='fixed'. Never edited: the
-- 0015 lock refuses any write while the parent exam is not draft.
--
-- question_revision is not decoration. Analytics group by
-- (question_id, revision) so two wordings never collapse into one difficulty
-- statistic (0011). A snapshot without it makes that entire migration pointless.
--
-- snapshot is built by question_snapshot() and contains NO ANSWER KEY.
-- ═════════════════════════════════════════════════════════════════════════════
create table public.exam_questions (
  exam_id     uuid not null references public.exams(id) on delete cascade,
  section_id  uuid not null references public.exam_sections(id) on delete cascade,
  rule_id     uuid references public.exam_rules(id) on delete set null,
  question_id uuid not null references public.questions(id) on delete restrict,

  question_revision int not null check (question_revision > 0),
  snapshot          jsonb not null,
  content_version   smallint not null default 1,

  position       int not null,
  marks          numeric(6,2) not null check (marks > 0),
  negative_marks numeric(6,2) not null default 0 check (negative_marks >= 0),
  -- Null when the rule was satisfied exactly. Non-null records that a
  -- substitution happened, so an odd paper can be explained months later.
  fallback_reason text,

  created_at timestamptz not null default now(),

  primary key (exam_id, question_id)
);

create index exam_questions_order_idx on public.exam_questions (exam_id, position);

-- ── exam_assignments ─────────────────────────────────────────────────────────
-- Groups only. Group targeting is what scales to 300 staff.
--
-- KNOWN GAP, STATED NOT HIDDEN: there is no way to give one person a retake.
-- max_attempts applies to the whole cohort. Adding target_kind='user' is a
-- follow-up the schema already accommodates.
create table public.exam_assignments (
  id        uuid primary key default gen_random_uuid(),
  exam_id   uuid not null references public.exams(id) on delete cascade,
  target_kind public.assignment_target not null,

  -- Outlet / department / brand are uuids. ROLE IS A KEY, NOT A UUID:
  -- has_role() reads role keys straight from the JWT, so a uuid here would
  -- force the visibility policy to join user_roles — the per-row three-way
  -- join the whole claims design exists to avoid (see 0004).
  target_id   uuid,
  target_role text,

  assigned_by uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),

  constraint assignment_target_shape check (
    (target_kind = 'role' and target_role is not null and target_id is null)
    or (target_kind <> 'role' and target_id is not null and target_role is null)
  )
);

create unique index exam_assignments_uq
  on public.exam_assignments (exam_id, target_kind, coalesce(target_id::text, target_role));
create index exam_assignments_exam_idx on public.exam_assignments (exam_id);

-- ── updated_at ───────────────────────────────────────────────────────────────
create trigger exams_set_updated_at
  before update on public.exams
  for each row execute function public.set_updated_at();
create trigger exam_sections_set_updated_at
  before update on public.exam_sections
  for each row execute function public.set_updated_at();
create trigger exam_rules_set_updated_at
  before update on public.exam_rules
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- question_snapshot — THE SINGLE MOST SECURITY-SENSITIVE FUNCTION HERE
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ This builds the payload a CANDIDATE receives. Every column is listed      │
-- │ explicitly. It never uses select *, and it never reads                    │
-- │ question_answer_keys or question_revisions.                               │
-- │                                                                           │
-- │ Both writers call it — publish_exam() now, M4's attempt start later — so  │
-- │ there is exactly ONE place an answer key could leak into a candidate's    │
-- │ browser, and exactly one thing to review. A second hand-built snapshot    │
-- │ query is how the second one quietly includes a column it should not.      │
-- │                                                                           │
-- │ If you add a column to questions, think before adding it here.            │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
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
        from public.question_media m where m.question_id = q.id
    ), '[]'::jsonb)
  )
  from public.questions q
  where q.id = p_question_id;
$$;

-- NOT granted to authenticated. It is a building block for the two writers, not
-- an API — a candidate calling it directly would be reading the bank.
revoke all on function public.question_snapshot(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- draw_paper — ONE SELECTOR, TWO WRITERS
--
-- Returns the draw; it writes nothing. publish_exam() inserts exam_questions
-- from it; M4's attempt start will insert attempt_questions from it. Keeping
-- selection in one function is the only thing stopping the two paper modes
-- diverging.
--
-- THE FALLBACK STRATEGY IS ONE ORDER BY, NOT A WIDENING LOOP:
--
--   · exact difficulty band first          (distance 0)
--   · then the nearest adjacent difficulty (distance 1, 2, …)
--   · ties broken by md5(id || seed) — seeded, so a paper is reproducible
--
-- The other two guarantees are structural rather than conditional:
--   · NO DUPLICATES — a running exclusion list spans the whole paper, so a
--     question drawn in section 1 cannot reappear in section 3.
--   · NEVER CROSSES A SECTION BOUNDARY — widening moves along difficulty only,
--     never into another rule's category, so a section cannot borrow from
--     another's pool.
--
-- SEED: the exam id at publish, the attempt id at attempt start. Different per
-- candidate with no extra machinery, and reproducible in tests.
-- ═════════════════════════════════════════════════════════════════════════════
create type public.drawn_question as (
  section_id        uuid,
  rule_id           uuid,
  question_id       uuid,
  question_revision int,
  position          int,
  marks             numeric(6,2),
  negative_marks    numeric(6,2),
  fallback_reason   text
);

create or replace function public.draw_paper(p_exam_id uuid, p_seed text)
returns setof public.drawn_question
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rule    record;
  v_row     record;
  v_taken   uuid[] := '{}';
  v_pos     int := 0;
  v_out     public.drawn_question;
  v_company uuid;
  v_brand   uuid;
begin
  select company_id, brand_id into v_company, v_brand
    from public.exams where id = p_exam_id and deleted_at is null;
  if v_company is null then
    return;
  end if;

  for v_rule in
    select r.*, s.id as sec_id
      from public.exam_rules r
      join public.exam_sections s on s.id = r.section_id
     where s.exam_id = p_exam_id
     order by s.sort_order, s.created_at, r.sort_order, r.created_at
  loop
    for v_row in
      select q.id, q.revision, q.marks, q.negative_marks,
             (q.difficulty between v_rule.difficulty_min and v_rule.difficulty_max) as in_band
        from public.questions q
       where q.deleted_at is null
         and q.status = 'active'
         and q.company_id = v_company
         -- A null brand on the question means "shared"; a null brand on the
         -- exam means "any brand".
         and (q.brand_id is null or v_brand is null or q.brand_id = v_brand)
         and not (q.id = any(v_taken))
         and (
           v_rule.category_id is null
           or q.category_id = v_rule.category_id
           or (v_rule.include_subcategories
               and q.category_id in (select c.id from public.categories c
                                      where c.parent_id = v_rule.category_id
                                        and c.deleted_at is null))
         )
         and (v_rule.question_types is null or q.type = any(v_rule.question_types))
         and (
           coalesce(array_length(v_rule.tag_ids, 1), 0) = 0
           or exists (select 1 from public.question_tags qt
                       where qt.question_id = q.id and qt.tag_id = any(v_rule.tag_ids))
         )
       order by
         case when q.difficulty between v_rule.difficulty_min and v_rule.difficulty_max then 0
              else least(abs(q.difficulty - v_rule.difficulty_min),
                         abs(q.difficulty - v_rule.difficulty_max))
         end,
         md5(q.id::text || p_seed)
       limit v_rule.question_count
    loop
      v_pos   := v_pos + 1;
      v_taken := v_taken || v_row.id;

      v_out.section_id        := v_rule.sec_id;
      v_out.rule_id           := v_rule.id;
      v_out.question_id       := v_row.id;
      v_out.question_revision := v_row.revision;
      v_out.position          := v_pos;
      v_out.marks             := coalesce(v_rule.marks_per_question, v_row.marks);
      v_out.negative_marks    := v_row.negative_marks;
      v_out.fallback_reason   := case when v_row.in_band then null else 'difficulty_widened' end;
      return next v_out;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.draw_paper(uuid, text) from public;

comment on function public.draw_paper(uuid, text) is
  'The single rule resolver. publish_exam() writes exam_questions from it; M4 must write attempt_questions from it too rather than reimplementing selection. Fallback prefers adjacent difficulty, never duplicates within a paper, never crosses a section boundary. Seeded so a draw is reproducible.';

-- ── exam_audience ────────────────────────────────────────────────────────────
-- Who an exam's assignments actually reach.
--
-- Extracted because three callers need the same answer — publish (notifications
-- and email), the health check's translation warning, and M7's reporting — and
-- three copies of this join would drift. The brand case reads the outlet's
-- brand rather than a column on profiles, because brand is a property of where
-- someone works, not of the person.
create or replace function public.exam_audience(p_exam_id uuid)
returns table (id uuid, email text, preferred_locale text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct p.id, p.email, p.preferred_locale
    from public.profiles p
    join public.exams e on e.id = p_exam_id
    join public.exam_assignments a on a.exam_id = e.id
   where p.deleted_at is null
     and p.approval_status = 'approved'
     and p.company_id = e.company_id
     and (
       (a.target_kind = 'outlet'     and a.target_id = p.outlet_id)
    or (a.target_kind = 'department' and a.target_id = p.department_id)
    or (a.target_kind = 'brand'      and a.target_id = (
          select o.brand_id from public.outlets o where o.id = p.outlet_id))
    or (a.target_kind = 'role'       and exists (
          select 1 from public.user_roles ur
            join public.roles ro on ro.id = ur.role_id
           where ur.user_id = p.id and ro.key = a.target_role))
     );
$$;

revoke all on function public.exam_audience(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- exam_health — the pre-publish validator
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THIS IS SQL AND NOT TYPESCRIPT.                                       │
-- │                                                                           │
-- │ It must run the REAL DRAW. Two rules can match the same question, and     │
-- │ deduping means the second falls short even though counting each rule      │
-- │ independently says both are satisfiable. A validator that counts per-rule │
-- │ passes and then publish fails — exactly the failure it exists to prevent. │
-- │                                                                           │
-- │ And publish_exam() calls this same function, so the screen a chef reads   │
-- │ and the gate that refuses them cannot disagree.                           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- blocking = the paper is unanswerable or wrong. advisory = a judgement call.
-- A chef may publish over a warning; they may not publish something broken.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.exam_health(p_exam_id uuid)
returns table (
  code       text,
  severity   text,
  section_id uuid,
  rule_id    uuid,
  message    text,
  detail     jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exam record;
begin
  select * into v_exam from public.exams e
   where e.id = p_exam_id and e.deleted_at is null
     and e.company_id = public.my_company();

  if v_exam is null then
    raise exception 'exam not found' using errcode = '42501';
  end if;
  if not public.has_perm('exams.update') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- ONE statement, ONE draw, every check reading the same CTE. Not a temp table
  -- (DDL inside a STABLE function is asking for trouble) and not nine separate
  -- calls to draw_paper() — nine draws of the same seed agree, but the cost is
  -- pointless and a future non-deterministic tweak would make the report
  -- describe a paper publish never produces.
  return query
  with drawn as (
    select * from public.draw_paper(p_exam_id, p_exam_id::text)
  ),
  drawn_q as (
    select d.*, q.type, q.difficulty, q.estimated_seconds, q.stem
      from drawn d join public.questions q on q.id = d.question_id
  ),
  audience_locales as (
    select distinct a.preferred_locale as locale
      from public.exam_audience(p_exam_id) a
     where a.preferred_locale <> 'en'
  )

  -- ── blocking: structure ───────────────────────────────────────────────────
  select 'structure.no_sections'::text, 'blocking'::text, null::uuid, null::uuid,
         'This exam has no sections, so there is nothing to draw.'::text,
         '{}'::jsonb
   where not exists (select 1 from public.exam_sections s where s.exam_id = p_exam_id)

  union all
  select 'structure.no_rules', 'blocking', s.id, null::uuid,
         format('Section "%s" has no selection rules.', s.title),
         '{}'::jsonb
    from public.exam_sections s
   where s.exam_id = p_exam_id
     and not exists (select 1 from public.exam_rules r where r.section_id = s.id)

  -- ── blocking: a rule could not be satisfied ───────────────────────────────
  -- Named and quantified, because "publishing failed" on its own leaves a chef
  -- guessing which of nine rules to loosen.
  union all
  select 'rule.short', 'blocking', r.section_id, r.id,
         format('Rule asked for %s question(s); the bank could supply %s.',
                r.question_count, coalesce(d.drawn, 0)),
         jsonb_build_object('requested', r.question_count,
                            'drawn', coalesce(d.drawn, 0),
                            'missing', r.question_count - coalesce(d.drawn, 0))
    from public.exam_rules r
    join public.exam_sections s on s.id = r.section_id and s.exam_id = p_exam_id
    left join (select dr.rule_id, count(*)::int as drawn from drawn dr group by dr.rule_id) d
           on d.rule_id = r.id
   where coalesce(d.drawn, 0) < r.question_count

  -- ── blocking: an assertion against a draw bug ─────────────────────────────
  union all
  select 'paper.duplicate', 'blocking', null::uuid, null::uuid,
         'The same question was drawn more than once.',
         jsonb_build_object('question_id', dr.question_id)
    from drawn dr
   group by dr.question_id
  having count(*) > 1

  -- ── blocking: the paper is worth nothing ──────────────────────────────────
  union all
  select 'marks.zero', 'blocking', null::uuid, null::uuid,
         'The paper totals zero marks.',
         jsonb_build_object('total_marks', coalesce((select sum(marks) from drawn), 0))
   where coalesce((select sum(marks) from drawn), 0) <= 0

  -- ── blocking: a stimulus-based question with no stimulus ──────────────────
  -- An image question with no image is simply unanswerable.
  union all
  select 'media.missing', 'blocking', dq.section_id, dq.rule_id,
         format('A %s question has no media attached, so it cannot be answered.', dq.type),
         jsonb_build_object('question_id', dq.question_id, 'stem', left(dq.stem, 120))
    from drawn_q dq
   where dq.type in ('image', 'video', 'audio', 'document')
     and not exists (select 1 from public.question_media m where m.question_id = dq.question_id)

  -- ── advisory: every question at one difficulty ────────────────────────────
  union all
  select 'difficulty.narrow', 'advisory', null::uuid, null::uuid,
         'Every question on this paper is the same difficulty.',
         jsonb_build_object('difficulty', min(dq.difficulty))
    from drawn_q dq
  having count(distinct dq.difficulty) = 1 and count(*) > 1

  -- ── advisory: the clock does not match the paper ──────────────────────────
  -- Only fires when the authors bothered to estimate. ±40% is loose on purpose:
  -- a warning that cries wolf gets ignored, and then so do the real ones.
  union all
  select 'duration.mismatch', 'advisory', null::uuid, null::uuid,
         format('About %s minutes of questions against a %s minute limit.',
                round(sum(dq.estimated_seconds) / 60.0), v_exam.duration_minutes),
         jsonb_build_object('estimated_minutes', round(sum(dq.estimated_seconds) / 60.0),
                            'duration_minutes', v_exam.duration_minutes)
    from drawn_q dq
   where dq.estimated_seconds is not null
  having count(*) > 0
     and (sum(dq.estimated_seconds) > v_exam.duration_minutes * 60 * 1.4
       or sum(dq.estimated_seconds) < v_exam.duration_minutes * 60 * 0.6)

  -- ── advisory: the audience cannot read it ─────────────────────────────────
  -- Locales come from the profiles the assignments actually reach, so this stays
  -- quiet for an all-English outlet and speaks up for a Gujarati one.
  union all
  select 'translation.missing', 'advisory', null::uuid, null::uuid,
         format('%s question(s) have no published %s translation.', count(*), al.locale),
         jsonb_build_object('locale', al.locale, 'question_count', count(*))
    from drawn dr
    cross join audience_locales al
   where not exists (
     select 1 from public.question_translations t
      where t.question_id = dr.question_id
        and t.locale = al.locale
        and t.status = 'published'
   )
   group by al.locale;

  return;
end;
$$;

grant execute on function public.exam_health(uuid) to authenticated;

comment on function public.exam_health(uuid) is
  'Pre-publish validation, run against the REAL draw rather than per-rule counts — two rules matching an overlapping pool make the second fall short in a way independent counting cannot see. publish_exam() calls this same function, so the screen and the gate cannot disagree. blocking rows refuse publication; advisory rows do not.';

-- ═════════════════════════════════════════════════════════════════════════════
-- publish_exam — freeze the paper, in one transaction
--
-- Same reasoning as save_question(): a half-frozen paper is worse than none.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.publish_exam(p_exam_id uuid)
returns table (question_count int, total_marks numeric, requires_manual_grading boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam    record;
  v_blocking jsonb;
  v_count   int;
  v_marks   numeric;
  v_manual  boolean;
  v_uid     uuid := auth.uid();
begin
  if not public.has_perm('exams.publish') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_exam from public.exams e
   where e.id = p_exam_id and e.deleted_at is null
     and e.company_id = public.my_company();
  if v_exam is null then
    raise exception 'exam not found or not editable' using errcode = '42501';
  end if;
  if v_exam.status <> 'draft' then
    raise exception 'this exam is already published' using errcode = '22023';
  end if;

  -- The gate. Blocking rows come back to the caller as JSON so the UI can list
  -- exactly which rule failed and by how many, rather than "publish failed".
  select jsonb_agg(jsonb_build_object(
           'code', h.code, 'section_id', h.section_id, 'rule_id', h.rule_id,
           'message', h.message, 'detail', h.detail))
    into v_blocking
    from public.exam_health(p_exam_id) h
   where h.severity = 'blocking';

  if v_blocking is not null then
    raise exception 'exam has blocking issues: %', v_blocking::text
      using errcode = '23514';
  end if;

  -- per_attempt exams freeze nothing now; the draw happens at attempt start.
  -- Health still had to pass, which is the point of validating against a real
  -- draw even when the result is thrown away.
  if v_exam.paper_mode = 'fixed' then
    insert into public.exam_questions (
      exam_id, section_id, rule_id, question_id, question_revision,
      snapshot, content_version, position, marks, negative_marks, fallback_reason
    )
    select p_exam_id, d.section_id, d.rule_id, d.question_id, d.question_revision,
           public.question_snapshot(d.question_id),
           q.content_version, d.position, d.marks, d.negative_marks, d.fallback_reason
      from public.draw_paper(p_exam_id, p_exam_id::text) d
      join public.questions q on q.id = d.question_id;

    select count(*)::int, sum(eq.marks) into v_count, v_marks
      from public.exam_questions eq where eq.exam_id = p_exam_id;

    select bool_or(q.response_format in ('text_short', 'text_long', 'evaluator_only'))
      into v_manual
      from public.exam_questions eq
      join public.questions q on q.id = eq.question_id
     where eq.exam_id = p_exam_id;

    -- M2 debt discharged: a question's exposure count only means anything once
    -- something increments it.
    update public.questions q
       set usage_count = q.usage_count + 1
      from public.exam_questions eq
     where eq.exam_id = p_exam_id and q.id = eq.question_id;
  else
    -- Nothing is frozen: the draw happens at attempt start. The figures still
    -- have to be right, so they come from the RULES plus one representative
    -- draw — one call, not three, because a future non-deterministic tweak to
    -- draw_paper would otherwise have three answers disagree.
    select coalesce(sum(r.question_count), 0)::int into v_count
      from public.exam_rules r
      join public.exam_sections s on s.id = r.section_id
     where s.exam_id = p_exam_id;

    select coalesce(sum(d.marks), 0),
           coalesce(bool_or(q.response_format in ('text_short','text_long','evaluator_only')), false)
      into v_marks, v_manual
      from public.draw_paper(p_exam_id, p_exam_id::text) d
      join public.questions q on q.id = d.question_id;
  end if;

  update public.exams e
     set status = 'scheduled',
         published_by = v_uid,
         published_at = now(),
         updated_by = v_uid,
         question_count = v_count,
         total_marks = coalesce(v_marks, 0),
         requires_manual_grading = coalesce(v_manual, false)
   where e.id = p_exam_id;

  -- Tell the audience. Queued, never sent inline — publishing an exam for 300
  -- staff must not blow the 100/day provider quota (plan §10).
  insert into public.notifications (user_id, kind, title, body, link)
  select p.id, 'exam.assigned', 'A new exam has been assigned to you',
         v_exam.title, '/exams/' || p_exam_id::text
    from public.exam_audience(p_exam_id) p
  on conflict do nothing;

  insert into public.email_outbox (to_email, to_user_id, subject, template, priority, payload)
  select p.email, p.id, 'You have a new exam: ' || v_exam.title,
         'exam-assigned', 4,
         jsonb_build_object('dedupe_key', 'exam-assigned:' || p_exam_id::text || ':' || p.id::text)
    from public.exam_audience(p_exam_id) p;

  return query
    select v_count, coalesce(v_marks, 0), coalesce(v_manual, false);
end;
$$;

grant execute on function public.publish_exam(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- duplicate_exam — MANDATORY, not a convenience
--
-- Published exams are immutable (0015). Without a duplicate action, correcting
-- one typo means rebuilding a 40-question exam by hand — which nobody will do.
-- They will edit the database directly instead, and then the lock protects
-- nothing.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.duplicate_exam(p_exam_id uuid, p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new   uuid;
  v_uid   uuid := auth.uid();
  v_src   record;
  v_sec   record;
  v_newsec uuid;
begin
  if not public.has_perm('exams.create') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_src from public.exams e
   where e.id = p_exam_id and e.deleted_at is null
     and e.company_id = public.my_company();
  if v_src is null then
    raise exception 'exam not found' using errcode = '42501';
  end if;

  insert into public.exams (
    company_id, brand_id, title, description, instructions, kind, status, paper_mode,
    duration_minutes, timezone, max_attempts, pass_mark_percent,
    shuffle_questions, shuffle_options, allow_backtrack, negative_marking_enabled,
    verification_mode, counts_towards_analytics, created_by
  )
  values (
    v_src.company_id, v_src.brand_id,
    coalesce(p_title, v_src.title || ' (copy)'),
    v_src.description, v_src.instructions, v_src.kind, 'draft', v_src.paper_mode,
    v_src.duration_minutes, v_src.timezone, v_src.max_attempts, v_src.pass_mark_percent,
    v_src.shuffle_questions, v_src.shuffle_options, v_src.allow_backtrack,
    v_src.negative_marking_enabled, v_src.verification_mode,
    v_src.counts_towards_analytics, v_uid
  )
  returning id into v_new;

  -- Sections and their rules. The frozen paper is deliberately NOT copied: the
  -- copy is a draft, and a draft's paper is drawn fresh at its own publish —
  -- otherwise the duplicate would inherit a paper its rules no longer justify.
  for v_sec in
    select * from public.exam_sections s where s.exam_id = p_exam_id order by s.sort_order
  loop
    insert into public.exam_sections (exam_id, title, description, instructions, sort_order, duration_minutes)
    values (v_new, v_sec.title, v_sec.description, v_sec.instructions, v_sec.sort_order, v_sec.duration_minutes)
    returning id into v_newsec;

    insert into public.exam_rules (
      section_id, sort_order, category_id, include_subcategories, tag_ids,
      question_types, difficulty_min, difficulty_max, question_count, marks_per_question
    )
    select v_newsec, r.sort_order, r.category_id, r.include_subcategories, r.tag_ids,
           r.question_types, r.difficulty_min, r.difficulty_max, r.question_count, r.marks_per_question
      from public.exam_rules r where r.section_id = v_sec.id order by r.sort_order;
  end loop;

  -- Assignments are NOT copied. Silently re-assigning 300 people to a copy
  -- somebody made to experiment with is the kind of helpfulness nobody wants.
  return v_new;
end;
$$;

grant execute on function public.duplicate_exam(uuid, text) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.exams            enable row level security;
alter table public.exam_sections    enable row level security;
alter table public.exam_rules       enable row level security;
alter table public.exam_questions   enable row level security;
alter table public.exam_assignments enable row level security;

comment on table public.exam_questions is
  'The frozen paper for paper_mode=fixed. Written once by publish_exam() and immutable thereafter (0015). snapshot is built by question_snapshot() and contains NO answer key. question_revision is required: analytics group by (question_id, revision) so two wordings never merge into one statistic.';
comment on column public.exams.paper_mode is
  'fixed = one paper drawn at publish, identical for every candidate, comparable scores. per_attempt = drawn fresh at attempt start. A column rather than a switch on kind so the rule lives in one place.';
