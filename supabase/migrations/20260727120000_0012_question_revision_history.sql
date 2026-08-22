-- ═════════════════════════════════════════════════════════════════════════════
-- 0012 — Question revision history
--
-- WHAT 0011 LEFT UNSOLVED
--
-- 0011 added questions.revision, a counter. It lets analytics segment responses
-- so two different wordings never collapse into one statistic. But editing still
-- OVERWRITES content, so:
--
--   · revision 3 cannot be rendered once revision 4 is saved — the text is gone
--   · attempt replay would show a candidate the CURRENT wording, not the one
--     they actually answered
--   · "old revisions must stay renderable after future schema changes" is
--     impossible, because there is nothing to render
--
-- exam_questions.snapshot (M3) covers official exam papers only. It does not
-- cover practice mode, revision browsing, or any question edited outside an
-- exam context.
--
-- THE FIX: an append-only history row per revision.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ SECURITY: THIS TABLE STORES ANSWER KEYS.                                  │
-- │                                                                           │
-- │ It therefore carries exactly the same lockdown as question_answer_keys:   │
-- │ authors only, employees denied by default, and exam delivery must NEVER   │
-- │ read from it. It would otherwise be a second, less obvious way for a      │
-- │ candidate to reach the answers — the kind of gap that opens because the   │
-- │ table looks like history rather than like secrets.                        │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- BACKWARD COMPATIBILITY: every row carries the content_version it was written
-- with. A renderer dispatches on that, so a future shape change adds a v2 branch
-- instead of invalidating history. Without it, changing the JSONB shape would
-- silently break every stored revision.
--
-- COST: ~2 KB per revision. 500 questions averaging 5 revisions ≈ 5 MB against
-- a 500 MB budget. Not a concern; the growth risk in this system is audit_logs.
-- ═════════════════════════════════════════════════════════════════════════════

create table public.question_revisions (
  question_id     uuid not null references public.questions(id) on delete cascade,
  revision        int  not null check (revision > 0),

  -- Full point-in-time copy. Denormalised on purpose: the whole value of this
  -- table is that it does not change when `questions` does.
  stem            text not null,
  content         jsonb not null,
  answer_key      jsonb,
  response_format public.response_format not null,
  question_type   public.question_type   not null,
  marks           numeric(6,2) not null,
  negative_marks  numeric(6,2) not null,
  content_version smallint not null default 1,

  edited_by       uuid references public.profiles(id) on delete set null,
  edited_at       timestamptz not null default now(),
  -- Free-text note from the chef ("clarified the temperature"), surfaced in the
  -- history view so a diff does not have to be read to understand a change.
  change_note     text,

  primary key (question_id, revision)
);

-- History browsing: newest first for a given question.
create index question_revisions_recent_idx
  on public.question_revisions (question_id, revision desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- Capture
--
-- Fires AFTER the 0011 trigger has computed the new revision number, so the two
-- always agree. Ordering between triggers on the same table is alphabetical by
-- trigger name, hence the leading z_ here versus questions_bump_revision.
--
-- Captures on INSERT too: revision 1 must exist in history, or the first
-- edit leaves the original wording unrecoverable — the exact failure this
-- migration exists to prevent.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.capture_question_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key jsonb;
begin
  -- Only snapshot when the revision actually moved. 0011's trigger bumps only
  -- on substantive change, so this inherits that definition rather than
  -- restating it — one place decides what "a different question" means.
  if tg_op = 'UPDATE' and new.revision = old.revision then
    return new;
  end if;

  select answer_key into v_key
    from public.question_answer_keys
   where question_id = new.id;

  insert into public.question_revisions (
    question_id, revision, stem, content, answer_key,
    response_format, question_type, marks, negative_marks, content_version,
    edited_by
  )
  values (
    new.id, new.revision, new.stem, new.content, v_key,
    new.response_format, new.type, new.marks, new.negative_marks, new.content_version,
    coalesce(new.updated_by, new.created_by)
  )
  -- The answer-key trigger may already have written this revision; whichever
  -- fires second fills in what the first could not see.
  on conflict (question_id, revision) do update
    set stem            = excluded.stem,
        content         = excluded.content,
        answer_key      = coalesce(excluded.answer_key, public.question_revisions.answer_key),
        response_format = excluded.response_format,
        question_type   = excluded.question_type,
        marks           = excluded.marks,
        negative_marks  = excluded.negative_marks,
        content_version = excluded.content_version;

  return new;
end;
$$;

create trigger z_questions_capture_revision
  after insert or update on public.questions
  for each row execute function public.capture_question_revision();

-- ── Answer-key edits ─────────────────────────────────────────────────────────
--
-- 0011 bumps questions.revision when a key changes, which fires the trigger
-- above — but that runs from the `questions` UPDATE and may read the OLD key,
-- depending on statement order. This writes the key into the history row
-- directly, after the fact, so the stored revision always reflects the key that
-- was actually in force.
create or replace function public.capture_answer_key_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev int;
begin
  select revision into v_rev from public.questions where id = new.question_id;
  if v_rev is null then
    return new;
  end if;

  insert into public.question_revisions (
    question_id, revision, stem, content, answer_key,
    response_format, question_type, marks, negative_marks, content_version, edited_by
  )
  select q.id, q.revision, q.stem, q.content, new.answer_key,
         q.response_format, q.type, q.marks, q.negative_marks, q.content_version,
         coalesce(q.updated_by, q.created_by)
    from public.questions q
   where q.id = new.question_id
  on conflict (question_id, revision) do update
    set answer_key = excluded.answer_key;

  return new;
end;
$$;

create trigger z_answer_keys_capture_revision
  after insert or update on public.question_answer_keys
  for each row execute function public.capture_answer_key_revision();

-- ═════════════════════════════════════════════════════════════════════════════
-- Backfill
--
-- Questions created before this migration have no history row. Without this,
-- their current wording is missing from history and the first edit loses it.
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.question_revisions (
  question_id, revision, stem, content, answer_key,
  response_format, question_type, marks, negative_marks, content_version, edited_by, edited_at
)
select q.id, q.revision, q.stem, q.content, k.answer_key,
       q.response_format, q.type, q.marks, q.negative_marks, q.content_version,
       coalesce(q.updated_by, q.created_by), q.updated_at
  from public.questions q
  left join public.question_answer_keys k on k.question_id = q.id
 where q.deleted_at is null
on conflict (question_id, revision) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Retrieval — the replay path
--
-- SECURITY DEFINER with a hard-coded permission check rather than a plain view,
-- so there is exactly one way to read history and it cannot be reached without
-- questions.read.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.get_question_revision(
  p_question_id uuid,
  p_revision    int
)
returns public.question_revisions
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.question_revisions;
begin
  if not public.has_perm('questions.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select r.* into v_row
    from public.question_revisions r
    join public.questions q on q.id = r.question_id
   where r.question_id = p_question_id
     and r.revision    = p_revision
     and q.company_id  = public.my_company();

  return v_row;
end;
$$;

grant execute on function public.get_question_revision(uuid, int) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.question_revisions enable row level security;

-- Same gate as question_answer_keys. Employees hold no policy and are denied.
create policy question_revisions_read on public.question_revisions
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and exists (
      select 1 from public.questions q
       where q.id = question_id
         and q.company_id = (select public.my_company())
    )
  );

-- No insert, update or delete policy anywhere. History is written solely by the
-- SECURITY DEFINER triggers above, which makes it append-only from the
-- application's perspective — nobody can rewrite what a question used to say.

comment on table public.question_revisions is
  'Append-only point-in-time copies of every question revision. Enables attempt replay, history browsing and rollback. STORES ANSWER KEYS: same lockdown as question_answer_keys, and exam delivery must never read it. content_version per row keeps old revisions renderable across future shape changes.';
