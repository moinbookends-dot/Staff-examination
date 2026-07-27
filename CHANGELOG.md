# Changelog

Bookends Hospitality — Restaurant Staff LMS.

Entries are grouped by milestone. Each records what shipped, the decisions worth
remembering, and anything left behind as debt.

---

## M3 — Exam Builder · *in progress*

### Shipped — exam list and settings

`/exams` lists, filters and paginates; `/exams/new` and `/exams/[id]` create and
edit an exam's settings. Same URL-state pattern as the question bank, so a
filtered list is bookmarkable and survives back-navigation.

No search box, unlike the bank: an outlet runs tens of exams, not thousands of
questions, so status and kind narrow it far enough and a full-text index would
answer a question nobody has.

**A published exam renders read-only**, with the reason stated. The 0016 trigger
refuses content edits once an exam leaves draft, so offering fields the database
will reject would be a lie the user only discovers on save.

**`saveExam` now treats an omitted `sections` as "leave the structure alone".**
It previously defaulted to `[]` and replaced the tree on every call — so the
settings form, which knows nothing about sections, would have deleted an exam's
entire paper structure every time somebody fixed a typo in the title. Omitted
means untouched; provided means replaced, empty array included.

`filtersToSearchParams` moved from `questions/filters.ts` to
`src/lib/search-params.ts` now that it has a second caller. A copy is how the
two lists drift into serialising `page=1` differently.

### Shipped — individual assignment (0017)

An exam can now be assigned to one person, not only to a group.

This closes the gap M3 recorded as known debt on the day it shipped: with group
targeting alone, giving somebody a retake meant raising `max_attempts` for the
whole cohort, which quietly hands a second go to everyone who already passed.
For a programme with a pass mark that is not hypothetical — somebody fails, is
coached, and sits it again, and nobody else should be affected.

`is_exam_assigned_to_me()` gains a fourth branch and still joins nothing but
`exam_assignments`: `auth.uid()` is as much a claim as `my_outlet()` is.
`exam_audience()` gains the same branch and keeps its `company_id` filter, so an
assignment naming somebody outside the company reaches nobody — an id is not
authorisation.

**Every comparison in that migration casts to `text`, deliberately.**
`ALTER TYPE … ADD VALUE` is allowed inside a transaction from Postgres 12, but
the new label cannot be *used* in the same transaction — a CHECK constraint or
function body naming `'user'` as an enum literal fails with "unsafe use of new
value of enum type". Comparing `target_kind::text = 'user'` never resolves the
label, so the migration applies whether or not the runner wraps it. The
alternative, splitting the `ALTER TYPE` into its own file, would make the schema
depend on how the migration tool happens to batch statements.

### Shipped — data layer and the Exam Health engine

Migrations 0014–0016. No UI yet: schema and engine land and are tested first,
which is why M2's authoring UI went in cleanly afterwards.

**Two paper modes, expressed as a column.** Official, monthly, annual and
practical exams freeze one paper at publish, so every candidate sits the same
questions and scores are comparable. Practice and quiz kinds draw fresh per
attempt, so repeated practice is not repeated memorisation.

`exams.paper_mode` is a column defaulted from `kind`, not a switch on `kind`.
A switch would scatter the same conditional through the builder, delivery, the
grader and every report — and it would deny a chef who wants a fixed practice
exam to compare two cohorts.

**`draw_paper()` — one selector, two writers.** It returns the draw and writes
nothing; `publish_exam()` inserts `exam_questions` from it, and M4 must insert
`attempt_questions` from the same function. Two copies of "resolve rules into
questions" is how the two modes silently diverge.

The fallback strategy is a single `ORDER BY` rather than a widening loop —
exact difficulty band first, then nearest adjacent, ties broken by
`md5(id || seed)`. The other two guarantees are structural rather than
conditional: a paper-wide exclusion list means no duplicates, and widening moves
along difficulty only, so a section can never borrow another's questions. The
seed is the exam id at publish and will be the attempt id at attempt start —
different per candidate with no extra machinery, and reproducible in tests.

**`question_snapshot()` — one place a key could leak.** It builds the
candidate-visible payload with an explicit column list, never `select *`, and
never reads `question_answer_keys` or `question_revisions`. Both writers call
it, so there is exactly one thing to review. A test asserts no stored snapshot
contains `correct`, `accept`, `rubric`, `keywords` or `modelAnswer`.

**Exam Health validates against the real draw.** Nine checks, six blocking and
three advisory. It is SQL rather than TypeScript for one reason: two rules can
match the same question, and deduping makes the second fall short even though
counting each rule independently says both are satisfiable. A validator that
counted per-rule would pass and then publish would fail — the exact failure it
exists to prevent. `publish_exam()` calls the same function, so the screen a
chef reads and the gate that refuses them cannot disagree.

Blocking: `structure.no_sections`, `structure.no_rules`, `rule.short`,
`paper.duplicate`, `marks.zero`, `media.missing`.
Advisory: `difficulty.narrow`, `duration.mismatch`, `translation.missing`.
A chef may publish over a warning; they may not publish something broken.

**Published exams are immutable**, enforced by a trigger rather than a UI
convention — the thing it protects is an attempt already in flight, and a
candidate answering question 7 of a paper somebody just redrew is being graded
against a paper that no longer exists. The allowlist is written positively, so a
column added by a future migration is locked by default rather than silently
editable. `closes_at` and status transitions stay open; extending a window
because a shift ran late is routine.

`duplicate_exam()` is mandatory rather than a nicety: locking without it means
correcting one typo requires rebuilding a 40-question exam by hand, which nobody
will do — they will edit the database instead, and then the lock protects
nothing.

**M2's outstanding debt discharged**: `questions.usage_count` is now incremented
at publish.

### Fixed while building

**A `CASE` expression in a trigger compiles every branch.** The shared child
immutability trigger used `case tg_table_name when 'exam_rules' then
new.section_id …`, which resolved `section_id` against `exam_sections` too and
failed every insert with `record "new" has no field "section_id"`. Rewritten as
`IF/ELSIF`, where only the taken branch is compiled.

### Decisions taken

| Decision | Chosen | Why not the alternative |
|:--|:--|:--|
| Paper freeze | Hybrid, per `paper_mode` column | One mode for everything either makes practice memorisable or makes official scores incomparable. |
| Rule ownership | Sections own rules, `section_id` NOT NULL | Rules hanging off either parent means every paper-assembly query handles two. |
| Rule shortfall | Blocks publishing, naming the rule and the gap | A silently short paper no longer totals the marks the exam claims. |
| Candidate fallback | Never refuse at attempt start | An administrator's misconfiguration must not stop somebody sitting an exam. |
| Validator location | SQL, called by both the UI and the gate | A TypeScript copy would count per-rule and miss overlapping pools. |
| Post-publish edits | Trigger allowlist | A UI that hides fields is a suggestion; psql, imports and scripts are not bound by it. |
| Assignment targets | Outlet, department, brand, role by **key**, and individual (0017) | A uuid role target forces the visibility policy to join `user_roles` per row — the join the JWT claims model exists to avoid. |
| Candidate access to `exam_questions` | **None** | Reading the table is reading the whole paper before the timer starts. M4 serves it through a definer route gated on an in-progress attempt. |

### Deferred to M4, deliberately

`attempt_questions` cannot exist yet: it needs a foreign key to `attempts`,
which M4 owns. Creating `attempts` here would pull M4's core table forward. M3
ships `paper_mode`, `draw_paper()` and the `fixed` path end to end; M4 adds the
table and calls the same function. Recorded in the 0014 header alongside the
other M4 obligations — persisting `fallback_reason` onto attempts, and
`attempt_answers.question_revision` still outstanding from 0011.

### Known technical debt

- The per-attempt path is written but unexercised: `draw_paper()` is tested
  directly, and `publish_exam()` handles `paper_mode='per_attempt'` by deriving
  totals from the rules, but nothing draws for a real attempt until M4.
- `exam_sections.duration_minutes` is accepted and stored but enforced by
  nothing until M4 builds the delivery timer.
- The exam builder UI does not exist, so exams are currently creatable only
  through the server actions or psql.

---

## M2 — Question Bank · *in progress*

### Shipped

**Question authoring UI** — the bank is reachable from the application

Everything before this was headless. `/questions` now lists, filters and
searches the bank; `/questions/new` and `/questions/[id]` author a question in
any of the nine formats, preview it exactly as a candidate will see it, publish
it and read its revision history.

- **UI format registry** (`src/components/questions/registry.tsx`) — the
  counterpart `src/lib/questions/registry.ts` has described since M2 began.
  Editors and renderers load through `next/dynamic` thunks, resolved once at
  module scope: calling `dynamic()` during render mints a new component identity
  per keystroke, so React unmounts the editor and the cursor leaves the field.
- **Renderers are the candidate-facing components**, not preview-only mockups.
  M4's exam delivery mounts the same ones, which is the only way a preview can
  be trusted. They receive `content` and never the answer key.
- **Editors take content and key as one `onChange`.** Ticking "correct" beside
  option c is a key edit made from a content control, and deleting option c must
  drop it from the key in the same commit. Two callbacks means a render where the
  key names an option that no longer exists — valid to both schemas, silently
  wrong for every candidate.
- **Ordering is up/down buttons, not drag-and-drop.** No dnd dependency, works
  with a keyboard, and does not fight the scroll gesture on the phones this
  platform's staff actually use.
- **Filters live in the URL.** A chef can bookmark and share "active
  knife-skills questions at difficulty 4", and it is the shape M3's rule-based
  exam selection will store.
- **Starter category tree seeded.** An empty taxonomy is not merely unfinished —
  the M3 exam builder selects *by category*, so the first exam would have nothing
  to draw from.

**`save_question()` + a reachable change note** — migration 0013

One RPC writes the question, its answer key and its tag set in a single
transaction. supabase-js has no transactions, so two round trips would leave a
question with no key when the second failed: ungradeable, invisible until an exam
runs. `SECURITY INVOKER`, so every policy from 0010 still applies — a
`SECURITY DEFINER` version would quietly become the one write path with no
authorisation.

It also makes `question_revisions.change_note` writable for the first time. 0012
declared the column and promised it in the table comment, but history rows come
from triggers and a trigger cannot know *why* an edit was made. The reason now
travels as a transaction-local GUC that both capture triggers read; every other
writer (seeds, psql, the future importer) still gets a null note.

**The publish gate** — `src/lib/questions/publish.ts`

`publishIssues()` strict-parses content and key, then runs `validateQuestion()`
across them. Pure, so the editor calls it on every keystroke to decide whether
Publish is enabled and the server calls it against what is actually *stored*
before flipping the status. Same code, so an enabled button cannot 403.

### Fixed — the app did not work in a browser

Found by rendering a page with a real session, which nothing had ever done: the
RLS suite talks to Postgres directly and fabricates the `app` claim, and
`walkthrough.mjs` drives PostgREST over HTTP. Both were green throughout. Three
independent bugs, each producing the same symptom — a signed-in, approved user
bounced to `/pending` forever.

1. **`middleware.ts` never ran.** It sat at the repository root; Next resolves
   the convention beside `app`, so in a `src/` project it must be `src/`. Next 16
   also renamed middleware to **proxy**. `next build` prints
   "ƒ Proxy (Middleware)" either way because the file compiles — it is simply
   never invoked. Now `src/proxy.ts`, exporting `proxy`. The tell was `/`
   returning 404 instead of redirecting to `/en`.

2. **The proxy's cookie decoder used `atob()`.** `@supabase/ssr` writes the
   session cookie as **base64url** by default, and JWT segments are base64url by
   specification; `atob` throws on the `-` and `_` they use. The function fails
   closed, so the throw read as "not approved". Chunk reassembly also sorted
   lexicographically, which scrambles at ten chunks.

3. **`getAppClaims()` never loaded a session.** `createServerClient` sets
   `skipAutoInitialize: true`, so `getClaims()` calls `getSession()`, finds
   nothing, and returns `{ data: null }` *with no error* — landing on `DENY_ALL`.
   It needs an explicit `await supabase.auth.initialize()`. `getUser()`
   initialises as a side effect, which is why the proxy's `updateSession()`
   worked and this did not.

4. **Zod 4's `.uuid()` rejects every id in `seed.sql`.** v4 enforces the RFC 4122
   version and variant nibbles; `00000000-0000-0000-0000-00000000c001` has
   neither, though Postgres stores it happily. So the `app` claim failed to
   parse on `company_id` and fell through to `DENY_ALL`. The same latent break
   sat in `approveRegistration`, where every seeded outlet and department id
   would have been refused. Added `dbId()` (`src/lib/db/id.ts`) for values that
   come out of a `uuid` column, with a test that sweeps every id in `seed.sql`.

**`scripts/render-check.mjs`** exists so this class of bug cannot return: it
drives the real pages with a real session cookie and asserts on the HTML.
`npm run check:render`, against a running `npm run dev`.

### Shipped earlier in M2

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
| Editor saves | One RPC, one transaction | Two client round trips leave a question with no answer key when the second fails — ungradeable, and invisible until an exam runs. |
| Save trigger | Explicit button, never autosave | A debounced autosave mints a revision on every typing pause once a question is live, fragmenting the analytics the revision counter exists to protect. |
| Change note | Transaction-local GUC | The alternative is a column on `questions` (which then bumps the revision it describes) or an UPDATE on the append-only history table. |
| Reordering | Up/down buttons | Drag-and-drop needs a dependency, has no keyboard path, and fights the scroll gesture on the phones staff actually use. |
| Preview | The real candidate renderer | A separate preview component can drift from delivery, and the drift is only discovered during an exam. |
| Filters | URL parameters | Shareable and bookmarkable, survives back-navigation, and is the shape M3's rule-based selection stores. |
| DB identifiers | `dbId()` / `z.guid()` | Zod 4's `.uuid()` enforces RFC 4122 version bits that Postgres does not, and rejects every fixed id in the seed. |

### Deferred — chosen scope cuts, not oversights

Each of these was cut deliberately so the authoring slice stayed reviewable.
None is blocked; all are one focused slice each.

| Deferred | Why it was cut | What it needs |
|:--|:--|:--|
| **Media attachment** | A storage-bucket migration, upload authorisation and byte accounting against the 1 GB cap are not UI concerns and would have doubled the diff. | Bucket + RLS, signed-URL upload action, alt-text enforcement, external video URLs. The type selector already offers all 14 types; the four media ones simply author without a stimulus. |
| **Bulk CSV import** | Nothing to correct an import *with* until the editor existed. | An import screen and template download behind `questions.import`. The registry's `serialize`/`deserialize` are already written and round-trip-tested, so this is cheap. |
| **Translation UI** | `question_translations` and its RLS exist; the authoring flow had to settle first. | A per-locale editor behind `questions.translate`. |
| **Category hierarchy manager** | Inline creation from the editor's picker covers the real need today. | A tree screen, once anyone has enough categories to need one. |
| **Revision diff and rollback** | History is captured and readable — the irreversible half is done. | A diff view over `question_revisions`, and a restore that writes a new revision rather than rewriting one. |

### Known technical debt

- `attempt_answers.question_revision` is an **M4 obligation**. Without it the
  revision exists with nothing recording which one was answered.
- Geist ships a Latin subset only; Devanagari and Gujarati fall back to a system
  font. Needs script-appropriate webfonts at M8.
- `hi` / `gu` / `hi-Latn` message files are stubs falling back to English. The
  question bank's ~90 new keys are English-only, so a Hindi-preferring chef
  authors in English today.
- `scripts/render-check.mjs` needs a running dev server, so it is **not in CI**.
  It is the only check that renders a page with a real session — run it by hand
  before merging anything touching auth, routing or i18n. Four bugs hid from
  every other check precisely because nothing rendered a page.
- The `(app)` layout and each page call `getAppClaims()` independently, so a
  page render verifies the token more than once. Correct but wasteful; worth a
  request-scoped cache when there is a reason to look at it.
- `questions.usage_count` is never incremented. M3 owns it when exams start
  drawing from the bank.

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
