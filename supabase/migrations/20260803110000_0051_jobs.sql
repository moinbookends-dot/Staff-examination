-- ═════════════════════════════════════════════════════════════════════════════
-- 0051 — M11c: the job queue
--
-- 0048 gave the pipeline something to process (source_documents and
-- document_pages) and something to reverse (import_batches). This is the part
-- that actually runs: one row per unit of work, claimed by a worker, retried on
-- its own schedule, and readable by the person standing at a progress bar.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ONE JOBS TABLE, NOT ONE PER KIND.                                         │
-- │                                                                           │
-- │ The four kinds differ in their PAYLOAD, not in their lifecycle. Every one │
-- │ of them is queued, becomes running when a worker takes it, ends           │
-- │ succeeded / failed / cancelled, and may be waiting on a provider that is  │
-- │ not there yet. Four tables would be four copies of that lifecycle, four   │
-- │ claim queries, four partial indexes and four sets of policies — and the   │
-- │ first time the retry rule changes it will change in three of them.        │
-- │                                                                           │
-- │ One table is also what makes a FAIR claim possible. A worker asks the     │
-- │ queue for work, not each of four tables in whatever order the poller was  │
-- │ written in. With per-kind tables a 113-page OCR run holds every           │
-- │ generate_questions job behind it for no reason but that ordering, and the │
-- │ starvation is invisible because each table looks healthy on its own.      │
-- │                                                                           │
-- │ WHAT IS GIVEN UP, stated rather than hidden: per-kind tables could type   │
-- │ the payload as real columns with real foreign keys, so a malformed job    │
-- │ would be a 23502 at insert. Here it is a runtime failure recorded in      │
-- │ last_error. That is the trade — a worse error, later, in exchange for one │
-- │ lifecycle that cannot drift.                                              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ 'blocked' IS NOT 'failed', AND THE DIFFERENCE IS 113 PAGES OF HAND WORK.  │
-- │                                                                           │
-- │ There is no AI provider configured yet — .env.example reserves the key    │
-- │ under "Phase 3" and nothing sets it. A job that cannot run because no     │
-- │ provider exists has not failed: nothing was attempted, nothing went       │
-- │ wrong, and the payload is still exactly as good as it was.                │
-- │                                                                           │
-- │ Folding that into 'failed' is lossy in the one way that costs a human     │
-- │ real work. 'failed' means the attempts were spent and a person must now   │
-- │ decide something. 'blocked' means wait. Upload a 113-page cookbook with   │
-- │ no key set and that spelling leaves 113 FAILED rows for a person to       │
-- │ re-queue by hand once the key appears — and re-queueing by hand is        │
-- │ precisely the moment somebody re-OCRs the ninety pages that were already  │
-- │ done, or misses the twenty that were not.                                 │
-- │                                                                           │
-- │ Resuming is one statement over rows that already exist, no new jobs and   │
-- │ no decisions:                                                             │
-- │                                                                           │
-- │     update public.jobs                                                    │
-- │        set status = 'queued', run_after = now(),                          │
-- │            locked_at = null, locked_by = null                             │
-- │      where status = 'blocked';                                            │
-- │                                                                           │
-- │ And blocking must NOT consume an attempt — see the box below. Three       │
-- │ deploys without a key would otherwise exhaust max_attempts and quietly    │
-- │ convert a wait into a failure, which is this whole distinction undone.    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ attempts AND last_error LIVE ON THE ROW, NOT IN A job_attempts TABLE.     │
-- │                                                                           │
-- │ The same call 0048 made for document_pages.ocr_attempts / ocr_error, for  │
-- │ the same reason: retry is a property of the work, not an event log.       │
-- │                                                                           │
-- │ A child table with one row per try would buy a full history and charge    │
-- │ for it on the hottest path in the system — "is this job still eligible"   │
-- │ becomes an aggregate over another table inside the very statement that    │
-- │ has to take a row lock. And the history is not what gets asked for. The   │
-- │ question at 2am is "why is page 90 not done", and its answer is the LAST  │
-- │ error, not the previous two.                                              │
-- │                                                                           │
-- │ The durable record of a run already exists and is not this table: it is   │
-- │ import_batches (0048), which keeps stats and last_error per batch and is  │
-- │ the thing that gets reverted. A job is scaffolding for one batch; the     │
-- │ batch is the history.                                                     │
-- │                                                                           │
-- │ attempts is incremented AT CLAIM, not at failure. The failure a queue     │
-- │ must survive is the one where the worker dies without writing anything    │
-- │ back — if the counter moved only on a recorded failure, a job that kills  │
-- │ its worker is retried forever by every worker that follows.               │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THIS QUEUE IS CLIENT-READABLE WHEN email_outbox (0007) IS NOT.        │
-- │                                                                           │
-- │ 0007's outbox has RLS enabled and no policy at all — deny everything —    │
-- │ because it holds other people's email addresses and nobody has a reason   │
-- │ to watch it drain. This queue is the opposite case, and the three link    │
-- │ columns below are why.                                                    │
-- │                                                                           │
-- │ "42 of 113 pages OCR'd" has to come from somewhere. Either it is a        │
-- │ group-by over this table, or it is a second progress table that a writer  │
-- │ keeps in step with this one — and the moment those two writes are not in  │
-- │ the same transaction the progress bar is simply wrong, most visibly as    │
-- │ 100% with nothing finished. So the links live on the job, the counts are  │
-- │ read straight off it under questions.read, and there is no second table   │
-- │ to disagree with.                                                         │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- SECURITY INVOKER throughout, no definer functions, no service-role client —
-- 0048's posture, continued deliberately. The worker authenticates as the
-- person whose import it is running, so every question about what it may
-- touch is answered by the same policies that answer it for the browser. See
-- the claim section at the bottom, where that decision is load bearing rather
-- than tidy.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── jobs ─────────────────────────────────────────────────────────────────────
create table public.jobs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,

  -- The four units of work the pipeline has, and a closed set for the reason
  -- 0050 gives about source_documents.kind: the worker SWITCHES on this value,
  -- so a kind with no branch behind it is not an extension point — it is a row
  -- that is claimed, cannot be executed, and burns its attempts finding out.
  -- 'extract_question_paper' is the second road from 0050: a past paper is
  -- already questions, so it never gets an extract_knowledge job at all.
  kind text not null check (
    kind in (
      'ocr_page','extract_knowledge','generate_questions','extract_question_paper'
    )
  ),

  -- What the worker needs that is not already reachable through the links
  -- below: model name, page range, prompt version, retry hints. jsonb because
  -- it differs per kind and four sets of mostly-null columns would be worse —
  -- the same call import_batches.stats made in 0048.
  --
  -- No default. import_batches.stats defaults to '{}' because a batch that has
  -- recorded nothing yet is normal; a job with nothing to act on is a bug, and
  -- it should be visible at insert rather than at claim. jsonb_typeof pins it
  -- to an object, because `'null'::jsonb` and `'3'::jsonb` both satisfy NOT
  -- NULL and neither is a payload.
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),

  -- Queue lifecycle. Deliberately not import_batches.status: a batch is
  -- 'reverted', which a job never is, and a job is 'blocked', which a batch
  -- never is. Two vocabularies that are nearly the same are still two.
  status text not null default 'queued'
    check (
      status in ('queued','running','succeeded','failed','cancelled','blocked')
    ),

  attempts     int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts > 0),

  -- Both the schedule and the backoff. A worker that fails a job sets this
  -- forward instead of sleeping, so nothing is held in a process's memory and
  -- a restart loses no timing.
  run_after timestamptz not null default now(),

  -- Who holds it, since when. Written together at claim and cleared together
  -- afterwards; the constraint below is what keeps "together" true, because a
  -- running job with no owner and no timestamp can never be reaped.
  locked_at timestamptz,
  locked_by text,

  last_error text,

  -- ── The links: progress without a second table ─────────────────────────────
  -- All three nullable because which of them is meaningful depends on kind —
  -- an ocr_page job has a page, a generate_questions job has a batch and a
  -- document. on delete cascade throughout: a job that outlives the document
  -- it processes has nothing to do and nothing to report against, which is a
  -- different thing from the source_documents FKs, where restrict protects a
  -- citation somebody may still need to open.
  source_document_id uuid
    references public.source_documents(id) on delete cascade,
  import_batch_id uuid
    references public.import_batches(id) on delete cascade,
  document_page_id uuid
    references public.document_pages(id) on delete cascade,

  -- The person whose import this is, and therefore the identity the worker
  -- runs as. Not "the worker" — locked_by is the worker, and it is text
  -- precisely because a process name is not a profile.
  created_by uuid not null references public.profiles(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A half-set lock is unreadable: locked_by with no locked_at cannot be timed
  -- out, locked_at with no locked_by cannot be attributed.
  constraint jobs_lock_is_whole check ((locked_at is null) = (locked_by is null)),

  -- The invariant the reaper depends on. An unowned 'running' row matches no
  -- stale-lock query and no claim query, so it sits there forever holding a
  -- progress count at 112 of 113 with nothing to point at.
  constraint jobs_running_is_owned
    check (status <> 'running' or locked_by is not null)
);

-- No deleted_at, and therefore none of 0041/0048/0049's restore machinery. A
-- job is not a document: nobody cites it, and withdrawing one means 'cancelled'
-- — a terminal state that is still readable, still counted, and still explains
-- why 12 pages have no text. This also keeps the table out of the trap 0049
-- swept for: no select policy here carries a deleted_at predicate, so no update
-- can move a row outside every select policy and be refused for it.

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE CLAIM INDEX CANNOT CONTAIN now(), AND DOES NOT NEED TO.               │
-- │                                                                           │
-- │ The claim query is `status = 'queued' and run_after <= now()`, but now()  │
-- │ is STABLE, not IMMUTABLE, and a partial index predicate must be           │
-- │ immutable — writing it produces "functions in index predicate must be     │
-- │ marked IMMUTABLE" and the migration stops.                                │
-- │                                                                           │
-- │ It is not a loss. The predicate holds the selective half (queued rows are │
-- │ a shrinking minority of a table that keeps every succeeded job), and      │
-- │ run_after leads the key, so `<= now()` is an ordinary range scan over an  │
-- │ index that is already exactly the rows in question. id follows it only to │
-- │ make the claim order total, so two workers agree on which job is next     │
-- │ instead of racing for the same second.                                    │
-- └───────────────────────────────────────────────────────────────────────────┘
create index jobs_claim_idx
  on public.jobs (run_after, id)
  where status = 'queued';

-- The progress count: "42 of 113 pages OCR'd" is a group-by over this. Partial
-- because a job with no document — none today, but the queue is generic — has
-- no progress bar to appear in and would only widen the index.
create index jobs_document_progress_idx
  on public.jobs (source_document_id, status)
  where source_document_id is not null;

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS
--
-- The shape is 0048's source_documents, with two differences that are absences
-- rather than choices, and both are worth naming so the next reader does not
-- read them as oversights:
--
--   · No brand triple. source_documents carries brand_id, so its read policy
--     ends in `brand_id is null or brand_id = my_brand() or is_super_admin()`.
--     A job has no brand of its own — its brand is whatever its document's is —
--     and inventing one here would create a second scoping rule to keep in step
--     with the first. The precedent is already set either way: document_pages
--     holds the OCR TEXT of those same brand-scoped documents and is
--     company-scoped only (0048). Brand-scoping the queue while the text it
--     points at is company-visible would be a lock on a door with no wall.
--
--   · No _read_deleted / _restore pair. There is no deleted_at (see above).
--
-- Read is questions.read, every write is questions.import, exactly as 0048 —
-- whoever may import a cookbook may run and retry the work that imports it, and
-- whoever may read the question bank may see why the questions are not there
-- yet. A progress bar nobody can read is not progress.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.jobs enable row level security;

create policy jobs_read on public.jobs
  for select to authenticated
  using (
    (select public.has_perm('questions.read'))
    and company_id = (select public.my_company())
  );

-- created_by = auth.uid() mirrors source_documents_insert and, exactly,
-- import_batches_write (0048). It holds for jobs the worker enqueues too — an
-- ocr_page job that finishes and queues extract_knowledge is still running as
-- the person who started the import, so the chain of rows keeps naming a human.
create policy jobs_insert on public.jobs
  for insert to authenticated
  with check (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
    and created_by = (select auth.uid())
  );

-- Claiming, finishing, failing, blocking, cancelling and re-queueing are all
-- this one policy. There is no state machine in SQL: unlike question status
-- (0040), a queue's transitions are enforced by the claim query itself — a
-- running job is one no other worker can take, and that is the only transition
-- correctness actually depends on.
create policy jobs_update on public.jobs
  for update to authenticated
  using (
    (select public.has_perm('questions.import'))
    and company_id = (select public.my_company())
  )
  with check (company_id = (select public.my_company()));

-- No DELETE policy, matching all three tables in 0048 and public.questions
-- (0010). A failed ocr_page job is the only surviving explanation for a blank
-- page in a cookbook somebody is about to generate questions from; deleting it
-- turns a known gap into an unknown one. Withdrawal is 'cancelled'.

-- ═════════════════════════════════════════════════════════════════════════════
-- Claiming
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A LOCKING SELECT ALSO APPLIES THE UPDATE POLICY'S USING CLAUSE.           │
-- │                                                                           │
-- │ This is the fact that decides the whole design, and it is not obvious.    │
-- │ For a locking select, Postgres applies the SELECT policies AND the UPDATE │
-- │ policies' USING expressions to the existing row. So a caller holding      │
-- │ questions.read but not questions.import does not get an error from the    │
-- │ claim — jobs_update filters the row out and the statement claims nothing. │
-- │                                                                           │
-- │ Zero rows back therefore means either "nothing to do" or "you may not do  │
-- │ it", and reading the second as the first is the same class of mistake as  │
-- │ 3b52dcc, where a zero row count was reported as success. That, and only   │
-- │ that, is why claim_job() raises: the enforcement is jobs_update, and the  │
-- │ raise exists so the two empty answers stop looking identical.             │
-- │                                                                           │
-- │ WHY NOT SECURITY DEFINER. Nothing about claiming needs to see a row the   │
-- │ caller cannot. A definer version would let any session claim any          │
-- │ company's work, and would then have to re-implement company scoping in    │
-- │ its body — a copy of jobs_read that goes stale the first time the real    │
-- │ policy changes. 0020's rule (a definer function is granted to             │
-- │ authenticated AND checks, or is granted to nobody) is satisfiable here,   │
-- │ but the honest answer is that it does not need to be definer at all.      │
-- │                                                                           │
-- │ CONSEQUENCE, stated plainly: RLS scopes the worker to one company, so a   │
-- │ worker serving several runs one session per company. That is the price of │
-- │ having no service role, and it is the price this codebase has chosen to   │
-- │ pay everywhere else already.                                              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- `for update skip locked` is what makes two workers safe: the second SKIPS the
-- row the first has locked rather than blocking behind it, so N workers claim N
-- distinct jobs and nobody waits. Without it, ten pollers serialise on the
-- oldest queued row and the queue drains at the speed of one.
--
-- The function is a convenience over a statement anybody may write directly.
-- Written out, the claim is:
--
--     with claimed as (
--       select id from public.jobs
--        where status = 'queued' and run_after <= now()
--        order by run_after, id
--        for update skip locked
--        limit 1
--     )
--     update public.jobs j
--        set status = 'running', attempts = j.attempts + 1,
--            locked_at = now(), locked_by = $1
--       from claimed c where j.id = c.id
--     returning j.*;
--
-- It is offered as a function so the attempts increment and the lock stamp
-- cannot be forgotten by a second caller, not because it can do anything the
-- statement cannot.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.claim_job(
  p_locked_by text,
  p_kinds     text[] default null
)
returns setof public.jobs
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
  if p_locked_by is null or btrim(p_locked_by) = '' then
    raise exception 'claim_job requires a worker identity'
      using errcode = '22023';
  end if;

  -- Not the security boundary — jobs_update is, and it is applied to the FOR
  -- UPDATE below whatever this says. This turns "you may not claim" into a
  -- 42501 instead of an empty result indistinguishable from an idle queue.
  if not public.has_perm('questions.import') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with claimed as (
    select j.id
      from public.jobs j
     where j.status = 'queued'
       and j.run_after <= now()
       -- A queued row that has already spent its attempts must not be claimed:
       -- re-queueing without resetting attempts is a plausible mistake, and the
       -- result of not checking here is a job that spins instead of stopping.
       and j.attempts < j.max_attempts
       and (p_kinds is null or j.kind = any (p_kinds))
     order by j.run_after, j.id
     for update skip locked
     limit 1
  ),
  taken as (
    update public.jobs j
       set status    = 'running',
           attempts  = j.attempts + 1,
           locked_at = now(),
           locked_by = p_locked_by
      from claimed c
     where j.id = c.id
    returning j.*
  )
  select * from taken;
end;
$$;

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ REVOKE FIRST. A BARE GRANT ADDS NOTHING HERE.                             │
-- │                                                                           │
-- │ 0020 wrote this down and it has now been missed three times: this         │
-- │ database AUTO-GRANTS EXECUTE on every new function to anon and            │
-- │ authenticated. So `grant … to authenticated` is a no-op that reads like a │
-- │ decision, and the function ships anon-executable. 0044 and 0045 shipped   │
-- │ that way in M9; this one did too, and the check after applying it is what │
-- │ caught it.                                                                │
-- │                                                                           │
-- │ claim_job is SECURITY INVOKER, so an anonymous caller would claim nothing │
-- │ — RLS answers before the function does. That is why this is tidiness      │
-- │ rather than an incident, and it is not a reason to leave it: the standard │
-- │ is that a function is reachable by the roles that were named, and         │
-- │ "harmless because something else stops it" is how the next one is not.    │
-- │                                                                           │
-- │ Revoking from PUBLIC alone is not enough — the auto-grant is held         │
-- │ explicitly by anon and authenticated, and revoking from PUBLIC does not   │
-- │ touch a privilege held by a named role.                                   │
-- └───────────────────────────────────────────────────────────────────────────┘
revoke all on function public.claim_job(text, text[]) from public, anon, authenticated;
grant execute on function public.claim_job(text, text[]) to authenticated;

-- ── The two statements that finish the story ─────────────────────────────────
--
-- Neither is a function, because neither needs to be: both are ordinary updates
-- under jobs_update, and writing them as functions would only hide which rows
-- they touch.
--
-- BLOCKING (no provider). Gives back the attempt claim_job spent, which is the
-- exception to "attempts is incremented at claim" and the reason 'blocked' is
-- not slowly converted into 'failed' by three deploys without a key:
--
--     update public.jobs
--        set status = 'blocked', attempts = attempts - 1, last_error = $2,
--            locked_at = null, locked_by = null
--      where id = $1;
--
-- REAPING (worker died holding the row). Run at worker start or on a timer by
-- any holder of questions.import; there is no cron and no privileged process:
--
--     update public.jobs
--        set status = 'queued', run_after = now(),
--            locked_at = null, locked_by = null
--      where status = 'running'
--        and locked_at < now() - interval '15 minutes';
--
-- It deliberately does NOT reset attempts. That counter, incremented at claim,
-- is the only thing standing between a job that kills its worker and a queue
-- that restarts it forever.

comment on table public.jobs is
  'The pipeline''s unit of work: one row per thing a worker must do, for all four kinds. One table rather than one per kind because the kinds differ in payload, not lifecycle — and because a worker must be able to ask the QUEUE for work, or a 113-page OCR run starves generation purely through the order a poller was written in. Client-readable on purpose, unlike email_outbox (0007): the source_document_id / import_batch_id / document_page_id links exist so progress is a group-by over this table and never a second table that can disagree with it. No deleted_at and no DELETE policy — withdrawal is ''cancelled'', and a failed job is the only surviving explanation for a page that has no text.';

comment on column public.jobs.status is
  '''blocked'' is the one that carries weight: it means no AI provider is configured, so the job CANNOT run — not that it ran and failed. Nothing was attempted and nothing is wrong with the payload, so it must resume by a single `update … set status = ''queued''` over rows that already exist, never by a human re-queueing 113 pages one at a time. Blocking also hands back the attempt that claim_job spent, or three deploys with no key would exhaust max_attempts and turn a wait into a failure.';

comment on column public.jobs.attempts is
  'Incremented at CLAIM, not at failure. The failure a queue has to survive is the worker that dies without writing anything back — with the counter moving only on a recorded failure, a job that kills its worker is retried forever by every worker after it. This is also why the reaper re-queues a stale ''running'' row without resetting the count.';

comment on constraint jobs_running_is_owned on public.jobs is
  'A ''running'' row with no locked_by matches neither the claim query nor any stale-lock sweep, so it is unreachable by every process that could move it: the progress count sits at 112 of 113 forever with nothing to point at. Paired with jobs_lock_is_whole, which keeps locked_at and locked_by set and cleared together so a held job can always be both timed out and attributed.';

comment on function public.claim_job(text, text[]) is
  'Takes the oldest due job with `for update skip locked`, so N workers claim N distinct jobs instead of serialising on the oldest row. SECURITY INVOKER on purpose: jobs_read and jobs_update do the scoping, so nothing here can reach another company''s work and there is no copy of a policy to go stale. The internal has_perm check is NOT the boundary — a locking select applies jobs_update''s USING clause anyway — it exists so "you may not claim" raises 42501 instead of returning the same empty result as an idle queue.';

-- When a JOB_KINDS / JOB_STATUSES vocabulary lands in src/lib (it will — see
-- SOURCE_DOCUMENT_KINDS in src/lib/imports/source-documents.ts, kept one for
-- one with 0050's CHECK), keep it one for one with the two CHECKs above. A
-- value missing there is unreachable from the product; a value missing here is
-- a 23514 at insert time, on the enqueue path, where nobody is watching.
