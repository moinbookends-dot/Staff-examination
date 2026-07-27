# Changelog

Bookends Hospitality — Restaurant Staff LMS.

Entries are grouped by milestone. Each records what shipped, the decisions worth
remembering, and anything left behind as debt.

---

## M2 — Question Bank · *in progress*

### Shipped

**Zod contract for 9 response formats** — `09c2c45`

Three shapes per format, and the separation is load-bearing:

| Shape | Holds | Who sees it |
|:--|:--|:--|
| `QuestionContent` | stem, options, items | the candidate |
| `AnswerKey` | correct answers, grading config | authors only, separate table |
| `AnswerPayload` | what was submitted | the candidate |

`validateQuestion()` checks content and key *together*. Neither schema alone
catches a key naming an option id that does not exist — that parses cleanly
against both and then marks every candidate wrong, silently.

The PRD's 14 question types map onto 9 formats: Image/Video/Audio/Document
describe the *stimulus*, not the answer shape. An image-based question is still
an MCQ. This cut roughly 40% from the M2 build with no feature loss.

**Question bank schema + RLS** — `d066adb` (migrations 0009, 0010)

`question_answer_keys` is a **separate table**. If correct answers lived in
`questions.content`, any client that can read a question could read the
answers — and during an exam the candidate's browser must read the question.
RLS is row-level; it cannot hide a column. Employees hold no policy on that
table at all.

`validate_question_content()` mirrors the Zod schemas as a database CHECK,
because bulk import, seeds, AI generation and psql all bypass application
validation.

**Auto-grading engine** — `cc8eab4`

Pure functions, full branch coverage. Decisions:

- A skipped question scores 0 and never incurs negative marks — penalising a
  skip makes guessing better than admitting ignorance.
- Multi-select partial credit subtracts wrong picks, or ticking every box would
  score full marks.
- Fuzzy blank matching credits near-misses but flags `needs_review`; refused on
  words under 4 characters, where distance 1 reaches genuinely different
  answers (`rib` → `rub`).
- Regex blanks are anchored — unanchored `/74/` would accept "not 74".
- Text normalisation applies NFKC before case-folding, because Devanagari and
  Gujarati have multiple valid encodings for the same visible character.

**Question revisions** — `9132d67` (migration 0011)

Questions are edited in place. Without a revision stamp, rewording a question
collapses every attempt before and after into one difficulty statistic — two
different questions, one number — corrupting the discrimination index and any
future adaptive-exam calibration. Cannot be retrofitted: once attempts exist,
which wording a candidate saw is unrecoverable.

**Headless format registry + draft/publish split** — `1890f3d`

A registry conformance test failed on `emptyContent()` for five formats, and
the test was right. A new MCQ starts with two blank options, which the strict
schema correctly rejects — so the editor would have opened covered in
validation errors before the chef typed anything, which trains people to ignore
validation. `questionContentDraftSchema` now checks shape only and gates
`status='draft'`; the strict schema gates activation.

### Decisions taken

| Decision | Chosen | Why not the alternative |
|:--|:--|:--|
| Question storage | One table, JSONB payload | 14 per-type tables means 14× RLS and a 14-way join per exam query. A normalised `question_options` works for choice formats and collapses for blanks/pairs/order. |
| Answer keys | Separate table | RLS cannot hide a column from a candidate who must read the question. |
| Edit model | Revision counter + history table | Full immutable versioning costs row growth, a version picker, and version-awareness at every reference. |
| Question pools | Rule-based saved filters | Membership tables go stale — questions added later belong to no pool until someone remembers. |
| Registry | One interface, lazy UI thunks | A registry importing React breaks Node import scripts and bloats the server bundle. |
| Video | External URLs only | 5 GB monthly egress is 300 staff watching one 15 MB clip, once. |

### Known debt

- `attempt_answers.question_revision` is an **M4 obligation**. Without it the
  revision exists with nothing recording which one was answered.
- Geist ships a Latin subset only; Devanagari and Gujarati fall back to a system
  font. Needs script-appropriate webfonts at M8.
- `hi` / `gu` / `hi-Latn` message files are stubs falling back to English.

---

## M1 — Foundation · *complete*

**Exit criterion met:** a real person registers, a chef approves them, they sign
in, and both actions appear in `audit_logs`. Verified end-to-end against the
live project by `scripts/walkthrough.mjs`.

### Shipped

- **Migrations 0001–0008** — enums, organisation tree, identity/RBAC, custom
  access token hook, RLS policies, audit log, notifications + email outbox.
- **JWT-claims RLS.** Roles, permissions and org scope are baked into the access
  token at mint time. Policies read `auth.jwt()` and join nothing — a policy
  joining the RBAC tables would run a three-way join *per candidate row*, and
  any policy on `user_roles` querying `user_roles` recurses.
- **Auth screens** — login, register, pending, forgot-password.
- **Chef approval queue** — the first end-to-end feature, exercising auth, RLS,
  RBAC, notifications and audit in one screen.
- **i18n routing** (`/[locale]`) shipped in M1 though strings land in M8;
  retrofitting it across ~40 routes later is a multi-day refactor.
- **Audit logging** moved from M8 to M1 — a 40-line trigger, and deferring it
  means no trail for the first seven weeks of real approvals and role grants.

### Bugs found and fixed

**The chef approval queue was permanently empty.** `profiles_read_team` scopes
by `outlet_id = my_outlet()`, but a pending user has `outlet_id = NULL` — the
outlet is assigned *during* approval, deliberately, because taking it from the
signup payload would let a user choose their own data scope. So `NULL = '<uuid>'`
filtered the row out and nobody could ever be approved.

Found by the HTTP walkthrough, not the RLS suite — the test fixtures had given
every profile an outlet, including pending ones, which was more convenient than
reality. Fixed in migration 0008 with a company-scoped policy for pending
registrations, plus two regression tests. The fixture now deliberately leaves
`outlet_id` null, with a comment not to tidy it.

### Decisions taken

- **`raw_user_meta_data` is client-controlled.** `handle_new_user` reads display
  fields from it and hard-codes `approval_status` to `'pending'`. Reading a role
  from it would let a user sign up as Super Admin.
- **RLS enabled at table creation**, not deferred to the policy migration.
  Enabled-with-no-policies denies everything; created-without-RLS is
  world-readable until policies land.
- **`verification_mode`** (`auto`/`single`/`dual`) per exam, so a single-chef
  organisation does not deadlock — dual verification with one chef means nothing
  can ever be verified.
- **JWT staleness handshake.** Claims are baked at mint, so an approved user
  still carries `approved: false` until refresh. `/pending` polls `me_status()`
  (which reads the table, bypassing the claim), then calls `refreshSession()`
  *before* navigating. Skipping that refresh produces a redirect loop in which
  every component behaves correctly.

---

## M0 — Foundation setup · *complete*

- Next 16.2.12 · React 19.2.4 · Tailwind 4 · shadcn, on the current stable
  stack rather than the PRD's Next 14.
- **12 high-severity vulnerabilities → 0.** `npm audit`'s own `fixAvailable`
  proposed downgrading Next from 16.2.12 to **9.3.3**; patched versions of every
  root cause were already published, pinned via `overrides`.
- **`shadcn` CLI had installed itself into `dependencies`** — a CLI shipping to
  production carrying an MCP server with a path-traversal advisory. Moved to
  dev.
- **CI**: typecheck · lint · unit · build · migration replay on a Postgres
  service container · RLS · type drift.
- **`scripts/gen-types.mjs`** replaces `supabase gen types`, which shells out to
  a Docker container unavailable on this machine.

### Environment constraints

No Docker and no WSL, so there is no local Supabase stack. Development runs
against the remote project via the session pooler (`aws-0-ap-southeast-1`,
Postgres 17.6); direct connections are IPv6-only and unreachable. CI replays
migrations onto a bare `postgres:17` container using
`supabase/tests/bootstrap.sql`, which recreates the Supabase platform objects
(`auth` schema, roles, `auth.jwt()`) that a hosted project provides.

### CI failures worth remembering

1. **RLS job failed wholesale** while passing locally. A hosted Supabase project
   grants `anon`/`authenticated` table privileges at creation; a bare container
   does not. `set role authenticated; select …` failed on *privileges*, before
   RLS was consulted.
2. **Type drift failed** because `create extension pgcrypto` lands in `public`
   on bare Postgres but in `extensions` on Supabase — so CI's generator emitted
   every pgcrypto function as if it were ours. Fixed by filtering on
   `pg_depend.deptype = 'e'`.

### Outstanding

- **Rotate the Supabase secret key and database password** before real staff
  data exists — both were exposed in a chat transcript.
- Split a dedicated production Supabase project; the current one is dev.
- No automated backups on the free tier: nightly `pg_dump` still to be wired.
