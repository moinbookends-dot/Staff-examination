-- ═════════════════════════════════════════════════════════════════════════════
-- 0001 — Extensions, enums, and shared trigger helpers
--
-- Foundation migration. Every later migration depends on the types declared
-- here. Enums are used over CHECK constraints deliberately: they are enforced
-- at the type level, appear in `supabase gen types` output as TypeScript string
-- unions, and so make an invalid status a compile error rather than a runtime
-- one. The cost is that adding a value later needs ALTER TYPE — acceptable,
-- because these value sets come from the PRD and are stable.
-- ═════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;      -- gen_random_uuid()

-- ── Identity ─────────────────────────────────────────────────────────────────

-- The registration approval gate (PRD §4.1). Accounts land in 'pending' and
-- cannot access anything until a chef or admin approves. 'suspended' exists so
-- access can be revoked without destroying the audit trail.
create type public.approval_status as enum (
  'pending',
  'approved',
  'rejected',
  'suspended'
);

-- ── Question bank ────────────────────────────────────────────────────────────

-- The PRD's 14 user-facing question types (§4.3). Kept in full so the UI can
-- say "14 question types" truthfully.
create type public.question_type as enum (
  'mcq_single',
  'mcq_multi',
  'true_false',
  'fill_blank',
  'match',
  'sequence',
  'short_answer',
  'essay',
  'image',
  'video',
  'audio',
  'document',
  'practical',
  'viva'
);

-- The 9 shapes an ANSWER can actually take.
--
-- The PRD conflates stimulus with response: Image/Video/Audio/Document-Based
-- are not answer shapes, they are presentation modifiers. An image-based
-- question is still an MCQ or still a short answer. Splitting the two axes
-- means 9 editors, 9 renderers and 6 auto-graders instead of 14 of each —
-- roughly a 40% cut in build effort with zero feature loss.
--
-- questions.type stays the user-facing label; response_format drives storage,
-- validation, rendering and grading.
create type public.response_format as enum (
  'choice_single',    -- one correct option           → auto
  'choice_multi',     -- one or more correct options  → auto, partial credit
  'boolean',          -- true/false                   → auto
  'blanks',           -- N blanks, accepted answers   → auto, fuzzy → needs_review
  'pairs',            -- match the following          → auto, per-pair partial
  'order',            -- sequencing                   → auto, exact/kendall/adjacent
  'text_short',       -- 1-3 sentences                → manual, keyword hints
  'text_long',        -- essay                        → manual + rubric
  'evaluator_only'    -- practical / viva             → manual rubric, no candidate input
);

create type public.question_status as enum (
  'draft',
  'active',
  'retired'
);

-- ── Exams ────────────────────────────────────────────────────────────────────

-- Lifecycle per PRD §4.4. 'cancelled' is added: a scheduled exam sometimes has
-- to be pulled before it opens, and forcing that through 'archived' would
-- corrupt reporting (archived implies it ran).
create type public.exam_status as enum (
  'draft',
  'scheduled',
  'active',
  'completed',
  'archived',
  'cancelled'
);

create type public.exam_kind as enum (
  'official',
  'practice',
  'quiz',
  'monthly',
  'annual',
  'practical'
);

-- ── Attempts ─────────────────────────────────────────────────────────────────

-- The dual-chef evaluation state machine (PRD §4.5, plan §6). Transitions are
-- enforced by a trigger in a later migration — this type only declares the
-- vocabulary.
--
--   in_progress → submitted → auto_graded
--        ├─ (fully auto-gradable) ─────────────────────→ published
--        └─ evaluating → evaluated → verifying ─┬─ verified → published
--                            ▲                  └─ returned ─┘
--
-- 'expired'  : the sweeper closed an attempt the candidate abandoned.
-- 'voided'   : an admin invalidated it; kept for audit, excluded from reports.
create type public.attempt_status as enum (
  'in_progress',
  'submitted',
  'auto_graded',
  'evaluating',
  'evaluated',
  'verifying',
  'verified',
  'returned',
  'published',
  'expired',
  'voided'
);

-- Per-answer auto-grading outcome. 'needs_review' is the important one: a
-- fuzzy fill-in-the-blank near-miss must reach a human rather than silently
-- scoring zero on a spelling variant — especially with four languages in play.
create type public.auto_grade_status as enum (
  'not_applicable',   -- manually graded formats
  'pending',
  'graded',
  'needs_review'
);

-- Why an attempt ended. Distinguishing these matters for both fairness reviews
-- and for spotting a broken sweeper.
create type public.submit_reason as enum (
  'user',           -- candidate pressed submit
  'timer',          -- client hit the deadline and submitted
  'tab_switch',     -- violation threshold exceeded
  'sweeper',        -- server closed an abandoned attempt
  'admin'
);

-- Who must sign off before results publish (plan §2, §6).
-- 'dual' is the PRD's intent. 'single' exists because the group may have only
-- one chef, in which case dual verification would deadlock permanently — every
-- attempt stuck awaiting a second reviewer who does not exist. 'auto' skips
-- human review entirely when every question was auto-graded.
create type public.verification_mode as enum (
  'auto',
  'single',
  'dual'
);

-- ── Shared trigger helper ────────────────────────────────────────────────────

-- Attached to every table carrying updated_at. Application code must never set
-- updated_at itself; a client-supplied timestamp is worthless for auditing.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at server-side. Never trust a client timestamp.';
