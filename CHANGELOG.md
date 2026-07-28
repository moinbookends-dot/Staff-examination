# Changelog

Bookends Hospitality — Restaurant Staff LMS.

Entries are grouped by milestone. Each records what shipped, the decisions worth
remembering, and anything left behind as debt.

---

## M4 — Exam Delivery · *in progress*

### Shipped — attempts, the frozen candidate paper, and the clock (0025, 0026)

The data layer for sitting an exam. No UI yet; schema and functions land and are
tested first, which is what made both earlier milestones' screens go in cleanly.

**Four obligations recorded in earlier migrations are discharged here.**
`attempt_questions` exists and is populated by `draw_paper()` rather than a
second selector (0014). `fallback_reason` travels onto the attempt, so a
substituted question is still explainable months later (0014).
`attempt_answers.question_revision` is NOT NULL, which is what lets slice 2 grade
against the key that was served (0011, 0022). And `attempt_paper()` is the
sanitising delivery route 0015 promised — candidates hold no policy on
`exam_questions` *or* `attempt_questions`, so this function is the entire surface
by which they ever see a question.

**The clock is the server's.** `expires_at` is stamped at start as
`min(now() + duration, exam.closes_at)` and every later write is checked against
it; the browser counts down for display only. A client-owned timer is not a
timer — changing the system clock, pausing JavaScript or reloading would each buy
unlimited time on a scored exam, and none of it would leave a trace. Taking the
earlier of the two bounds also stops an attempt outliving its exam and accepting
answers after everyone else has stopped.

**Answers autosave per question.** One row per question, upserted as the
candidate works. Restaurant staff sit these on phones on outlet wifi; losing
signal should cost the question being typed, not the paper.

**Starting again resumes.** A reload returns the existing attempt rather than
creating a second — otherwise answers split across two rows and `max_attempts`
counts wrong. A partial unique index enforces one in-flight attempt per
candidate per exam regardless.

**No table here has an insert or update policy for anyone.** `start_attempt()`
is the only writer, and slice 2 adds the other two. A client able to write
`attempts` directly would choose its own deadline, attempt number and score.

17 integration tests, including the two that matter: an attempt paper never
contains `correct`, `accept`, `rubric`, `keywords` or `modelAnswer`; and a
candidate cannot read `attempt_questions` directly, ask for another candidate's
paper, or edit their own attempt row.

### Shipped — answering, submitting and the auto-grader (0027)

`save_answer()`, `submit_attempt()`, `expire_attempts()`, and the grader itself.
A candidate can now sit an exam end to end and get a mark.

**The grader moved into the database, and the TypeScript engine was deleted.**
This is the decision of the slice and it went the way the security model
demanded rather than the way the codebase's language would have preferred.

`answer_key_at_revision()` is granted to nobody (0022) and is reachable only
from inside another SECURITY DEFINER function. For the M2 grading engine to see
a key, the app would have needed a service-role client — the first RLS-bypassing
connection in the codebase, introduced for precisely the operation where key
exposure is most costly. The alternative considered was keeping both engines and
proving them equal in CI; that was rejected as a standing liability, since two
graders with nothing forcing them to agree is how a scoring rule changes in one
and not the other and nobody notices until a candidate disputes a mark.

So `src/lib/questions/grading.ts` is gone and migration 0027 is the only grader.
Every semantic it encoded was carried across unchanged: a skip scores 0 and never
incurs negative marks, multi-select partial credit subtracts wrong picks, fuzzy
blanks are refused under four characters, regex blanks are anchored, and
normalisation applies NFKC before case-folding.

**The port was proven, not reviewed.** A temporary differential harness ran 49
cases through both engines and asserted identical results — score, status,
review flag and the per-part detail blob. It was checked against a negative
control (perturbing one input failed 23 of the 49) so that "they agree" could not
be a vacuous pass, which this codebase has now seen three times. The harness was
deleted with the engine; `tests/integration/grading.test.ts` keeps the corpus as
explicit expectations, plus the registry conformance cases that moved out of the
unit suite when the grader left TypeScript.

**One behavioural change, stated rather than discovered later.** Regex blanks are
now evaluated by Postgres ARE instead of JavaScript. Anchoring, alternation,
character classes and quantifiers behave identically; exotic patterns
(lookbehind, `\p{...}`) would not. Blank keys use the former.

**Levenshtein is hand-rolled rather than taken from `fuzzystrmatch`.** The
extension exists on both Supabase and the `postgres:17` image CI runs, but
installs into a different schema on each, so the qualified name that works in
production would not resolve in CI. Twenty lines of PL/pgSQL is cheaper than
another round of the bug class that hid an anon-reachable `draw_paper()` for a
whole milestone.

**The deadline is enforced on every write, not once at submit.** `save_answer()`
refuses past `expires_at`, which is why 0026 gave `attempt_answers` no write
policy for anybody: a row-level policy cannot express "and the clock has not run
out" without re-reading the parent on every write, and a candidate who could
UPDATE directly would simply keep answering.

**A skip is the absence of a row.** Grading iterates `attempt_answers`, not
`attempt_questions`, so an unanswered question contributes nothing and can incur
no penalty — true by construction rather than by a branch somebody could later
remove.

**A candidate cannot claim the server's submit reasons.** `submit_attempt()`
accepts `user`, `timer` and `tab_switch` only; `sweeper` and `admin` are the
server's to assert, and accepting them would hand the candidate the audit trail.
`grade_and_close_attempt()` holds the shared closing logic with no authorisation
check of its own, so the sweeper and the candidate's submit cannot drift into
scoring the same paper differently.

**A paper needing a human gets no verdict.** Any essay, or any fuzzy near-miss
the grader flagged, sends the attempt to `evaluating` with `passed` left NULL —
not false. Recording a fail no evaluator agreed to would publish a result the
system cannot defend. M5 owns releasing it.

**`attempt_answers.grade_detail`** stores the per-part breakdown, and carries
what the candidate submitted and whether each part was right — never the
expected value. A breakdown destined for a results screen that quoted the
accepted answers would hand over the key for every question they got wrong.

### Shipped — evaluation, verification and release (0028)

Closes the lifecycle 0001 drew and every migration since has been walking toward:

```
auto_graded (fully auto-gradable) ─────────────────→ published
evaluating → evaluated → verifying ─┬─ verified ───→ published
                  ▲                 └─ returned ─┘
```

**A result is visible when, and only when, it is `published` — and RLS could not
do it.** A policy chooses rows, and a candidate legitimately needs their attempt
row long before a result exists: to know the paper arrived, that it is being
marked, that it came back for rework. Leaving `attempts_read_own` in place would
have handed them `score`, `max_score` and `passed` over PostgREST the moment the
grader wrote them — hours before an evaluator agreed to anything. So the
candidate's read policies on `attempts` and `attempt_answers` are dropped, and
`my_attempts()`, `my_attempt_state()` and `attempt_review()` replace them.
A column cannot be hidden by a policy; it can be hidden by a function that never
selects it. `my_attempt_state()` carries no score at all, so the function
serving a live paper could not leak one even if the release rule changed.

**`verification_mode` decides whether an auto-graded paper publishes itself.**
`auto` releases it at submit, so a practice quiz still shows a score instantly;
`single` and `dual` hold it at `auto_graded` for someone holding
`evaluation.publish`. That uses the column 0014 already had rather than
inventing a second setting.

**Dual verification is a unique constraint, not a count.** Sign-offs are rows in
`attempt_verifications`, unique on `(attempt_id, verifier_id, round)`. Two
approvals therefore *cannot* come from one person, and a concurrent second
request cannot slip past a `count(*)` check that application code performed a
moment earlier.

**A return discards the approvals it invalidates.** Decisions are recorded
against `returned_count + 1`, so sending a paper back starts a new round and the
signature somebody gave to the old marks does not carry onto the revised ones.
The whole history stays — two rounds, four decisions, both notes.

**A verifier may not be the evaluator.** A chef holds `evaluation.evaluate` and
`evaluation.verify` both, because in a two-manager restaurant the same people do
both jobs on different papers. Signing off your own marking is the one
combination that defeats the point, and it is refused by name.

**The status graph is a trigger, written as data.** One `CASE` lists the legal
moves out of each state; everything else raises. It holds against psql, an
import and any future function that forgets — the tests assert it *as the table
owner*, with RLS off and every function bypassed, because that is the caller it
has to stop. A published result is corrected by voiding it and saying so, never
by editing it back into an earlier state.

**Found by the tests, worth recording.** The first "is anything still unmarked?"
check asked whether `score is null`, and never fired: 0027's grader had already
written `score = 0, auto_grade_status = 'not_applicable'` against every essay,
so an unread paper looked finished. What marks a manual question done is a human
moving it to `'graded'`, which is what `save_evaluation()` does. An attempt could
otherwise have reached `evaluated` with an unmarked essay and a total that was
simply wrong, with nothing downstream any the wiser.

### Shipped — the candidate delivery UI

`/my-exams` and `/attempt/[id]`. A candidate can now see what they have been
assigned, sit it, and get a mark, entirely in the browser.

**Nothing here decides who may see an exam.** `listMyExams()` filters by
nothing: 0015's policy on `exams` matches the assignment against the outlet,
department, brand and role already in the JWT. A second definition of "assigned
to me" in TypeScript would be a thing to drift, and the one that governs is in
the database.

**The countdown decides nothing either.** It renders `expiresAt - now`. The
deadline was stamped by `start_attempt`, every save is refused against it by
`save_answer`, and `expire_attempts` closes the paper whether the browser is
running or not — so putting the machine clock back, pausing JavaScript, or
closing the tab all achieve nothing. Auto-submit at zero is a courtesy that
saves the sweeper a job, not the thing that enforces the limit. Every save
returns the server's `expires_at` and the display re-anchors on it, so a phone
that slept through a question corrects itself rather than drifting until submit.

**Autosave is debounced per question, not globally.** Typing into question 3
must not postpone the save of the choice just made on question 2 — on outlet
wifi that is the difference between losing a keystroke and losing an answer.
Pending saves are flushed before submit and on unmount.

**Route is `/attempt/[id]`, not `/exams/[id]/take`.** What a candidate works
through is the attempt: under `per_attempt` two attempts at one exam are
different papers, and a URL naming only the exam could not tell them apart. The
same page shows the result once the attempt closes, rather than redirecting —
a redirect races the submit, and its back button lands on a paper that no longer
accepts answers.

**The renderers are the ones M2 built.** `FormatRendererProps` was typed as the
candidate-facing contract back then, with `onAnswerChange` documented as
"supplied by exam delivery in M4". Delivery supplied it and needed no changes to
any of the nine — the answer key was never in the props, so it cannot be read
out of devtools.

**`render-check.mjs` now sits an exam.** Fourteen new assertions cover the
candidate path end to end, and four of them are the reason the section exists:
the live paper contains no `"correct"`, `modelAnswer`, `"rubric"` or
`"accept"`. Every check before it renders the authoring side, where the person
looking is allowed to know the answers; this is the one screen where a leak is
a scored exam thrown away. It also asserts a foreign attempt 404s and that a
candidate cannot open the authoring exam list.

**Known gaps, stated rather than discovered later.** `shuffle_questions` and
`shuffle_options` are stored and not yet honoured at delivery — the paper renders
in `paper_position` order. `allow_backtrack` *is* honoured. Results are shown to
the candidate immediately on submit; M5 owns deciding when a result is released,
and will move that behind its gate.

### Fixed while building

**`render-check.mjs` asserted a shortfall by depending on an empty database.**
Its rule checks ask for more questions than exist, to prove the shortfall is
reported and blocks publishing — but they pointed at the seeded Food Safety
category and relied on nobody having put anything in it. Seeding twelve demo
questions flipped seven checks at once. The check now creates and owns its own
category, so the pool is exactly what the script put there. Worth noting the
failure mode: the script was not wrong about the app, it was wrong about the
world, and any real deployment with real Food Safety questions would have broken
it the same way.

**`email_outbox` rows outlive the exam that queued them.** `publish_exam` writes
one per assignee under a UNIQUE dedupe key, and `email_outbox` has no foreign key
to `exams` — so deleting an exam leaves the row, and any later publish with the
same ids collides. Harmless in production, where immutability means an exam
publishes once; fatal for a test suite with fixed ids, where it made the whole
attempts suite fail in setup on every run after the first. The audit had flagged
the same leak in `render-check.mjs`.

---

## M3 — Exam Builder · *in progress*

### Architectural debt closed before M4 (0022–0024)

Five things the audit surfaced that would each have become harder, not easier,
once attempts and grading existed.

**Grading reads the key that was served (0022).** `exam_questions` froze a
question's content and its revision, but not its answer key — that stayed
mutable in `question_answer_keys`. So the obvious grader, `select answer_key
from question_answer_keys`, would mark Monday's attempts against Tuesday's
corrections. Silently: nothing errors, the marks are simply wrong.

0011 already bumped the revision on a key change and 0012 already stored the key
*per revision*. Nothing connected either to grading. `answer_key_at_revision()`
now does, and it is the only sanctioned source — internal, granted to nobody, and
it **raises** rather than returning null, because a null key marks every
candidate wrong while an exception stops the attempt being graded at all.
`exam_health` gains a blocking `key.missing` check so a paper that cannot be
graded cannot be published, which is what makes that exception unreachable.

An integration test pins the invariant: after a published question's key is
edited, the frozen and live keys disagree, and the test asserts which one an
attempt is entitled to. **If M4 reads the wrong source, that test fails.**

**One definition of who an assignment reaches (0023).** Two functions answered
the same question and disagreed. `exam_audience` resolved brand from the
outlet; `is_exam_assigned_to_me` compared against `my_brand()`, a claim the auth
hook copied from `profiles.brand_id` — **a column nothing ever writes**.
Registration does not set it and `approveRegistration` sets outlet and department
only. So it was null for every user, and a brand-targeted exam notified and
emailed people who then could not see it. The same null broke
`exams_read_manage`, making brand-scoped exams invisible to everyone but a super
admin.

Fixed in two parts, because either alone would leave it fragile. The hook now
**derives** brand from the outlet, so the claim is true; and
`assignment_matches()` is the single place that decides whether an assignment
reaches a person — both callers pass their own view of that person into it and
neither contains a comparison of its own. Two implementations cannot drift when
there is one implementation. A test asserts the two paths agree for **every**
target kind, and the walkthrough asserts a real minted token actually carries a
brand, which is the only place that can be checked.

**Cross-company isolation is now tested (`tenancy.test.ts`, 16 cases).** Every
other suite ran inside one seeded company, so `company_id = my_company()` — a
predicate in a dozen policies and in the guard of every definer entry point — was
never exercised. It matters most for the definer functions: they bypass RLS by
construction, so that check is the *only* barrier. The suite adds a second
tenant and asserts each entry point refuses it, with allow-cases alongside so the
denials cannot pass because everything is broken for everybody.

**Render assertions test rendered state, not translated text.** The remaining
message-bundle matches are gone: the category filter now asserts real `<option>`
elements, the type select asserts it has children, the settings form asserts its
actual input ids, and the published notice matches the element rather than the
sentence. The old settings-form check looked for "Food Safety" — a string that
page never renders — so it would have passed against a blank page.

**`include_subcategories` descends the whole tree (0024).** It matched exactly
one level, while the seed already ships two (Food Safety → Temperature Control)
and chefs can nest further. Questions filed deeper were silently excluded — the
rule looked satisfied and the count was inexplicably low. Now a recursive CTE,
using `UNION` rather than `UNION ALL` so a cyclic tree terminates instead of
spinning forever, plus a CHECK forbidding self-parenthood. Tested at three levels
and with a deliberate cycle.

### Security — two critical fixes found by audit (0020, 0021)

An adversarial audit of the M3 exam layer, run before starting M4, found two live
critical defects. Both were confirmed by exploit against the real database rather
than by reading, and both are fixed.

**1. Four internal helpers were callable by anyone, including anon.**

0014 and 0018 protected `question_snapshot`, `draw_paper`, `exam_audience` and
`question_pool` with `revoke all on function … from public`. That removes only
the PUBLIC pseudo-role's ACL entry — it does nothing to an explicit grant held by
a named role, and this database auto-grants EXECUTE on new functions to `anon`
and `authenticated`. The ACLs still read `anon=X | authenticated=X`.

With nothing but the publishable key that ships in every browser bundle, and no
session at all:

| Request | Result |
|:--|:--|
| `POST /rest/v1/rpc/draw_paper` | 200 — the whole paper, in order |
| `POST /rest/v1/rpc/question_snapshot` | 200 — stem and every option |
| `POST /rest/v1/rpc/exam_audience` | 200 — every assignee's email address |
| `POST /rest/v1/rpc/question_pool` | 200 — enumerate the question bank |

`publish_exam` seeds the draw with the exam id, so passing that id as the seed
reproduced the exact frozen paper. A candidate could read the real paper before
the timer started — the precise failure the answer-key split and the delivery
design exist to prevent — and staff email addresses were readable by the open
internet.

Fixed in 0020 by revoking from `anon` and `authenticated` explicitly, with a DO
block that fails the migration if any of the four is ever reachable again.

These four cannot simply gain a `has_perm()` check instead: M4 must call
`draw_paper` and `question_snapshot` for a **candidate** at attempt start, and a
candidate holds no `exams.*` permission. Their guard is the ACL, so the ACL has
to be right. The rule now: a SECURITY DEFINER function is either granted to
`authenticated` **and** carries its own permission check, or granted to nobody
and reached only from another definer function. "Revoked from public" is not a
third option.

**2. A per-attempt exam could go live without ever being validated.**

`setExamStatus` accepted `scheduled` and required only `exams.update`, so it
bypassed both `exams.publish` and the `exam_health()` gate. The database did not
catch it either: `exams_published_has_paper` exempted `paper_mode='per_attempt'`
from every condition, including `published_at`. A practice exam with no sections,
no rules and no validation could be moved straight to `scheduled` by a plain
UPDATE — and 0016 then locked it permanently, with no paper, no notifications and
no way back except duplicating it. The same UPDATE on a `fixed` exam was
correctly refused, which is why it went unnoticed.

Fixed on both sides: `scheduled` is gone from the action's schema (publishing is
`publishExam` and nothing else), and 0021 requires `published_at` on every
non-draft row whatever its paper mode — which makes "was this validated?"
checkable rather than assumed, and binds psql and imports too.

### Fixed — CI disagreed with production about who can call what

The workflow ran `grant execute on all functions in schema public to anon,
authenticated` **after** replaying migrations, undoing every deliberate REVOKE in
the only environment that tests them. That is why six commits of green CI said
nothing about the vulnerability above. Functions are no longer granted there;
every function the app invokes carries its own explicit grant in the migration
that creates it.

Three new guards so this class cannot return quietly:

- `tests/integration/function-acl.test.ts` asserts the four internal helpers are
  unreachable, that every granted definer function carries its own check, and —
  generally — that **no** definer function is both anon-reachable and unguarded,
  so one added later is caught without anybody remembering to list it.
- `scripts/walkthrough.mjs` now calls each internal RPC over real HTTP as anon
  and as an employee and requires a refusal. Nothing made an unprivileged HTTP
  call before, which is exactly why nothing saw this.
- The draw tests now run as **owner** rather than as a chef, because a chef
  cannot call `draw_paper` and should not be able to.

### Shipped — paper preview and provenance (0019)

**The paper preview mounts the same renderers exam delivery will.** That was the
point of typing `FormatRendererProps` as the candidate-facing contract back in
M2 rather than building preview-only components: a preview drawn by different
code drifts from delivery, and the drift is discovered during an exam. Read-only
here, with each format's empty answer.

`exam_paper()` serves both cases from one call — the frozen `exam_questions`
rows when they exist, otherwise a representative draw flagged `is_preview`. A
chef asks the same question of a draft and a published exam, so making them
reason about which storage backs it would serve the schema rather than the
person.

For a `per_attempt` exam the preview is **nobody's paper**, and the UI says so
at length. Every candidate draws their own; a chef who believes they are looking
at *the* paper will reasonably conclude the exam is broken when a candidate
reports different questions.

The frozen branch reads the **stored** snapshot rather than rebuilding it, so
editing a question after publication cannot change what the paper says a
candidate was asked. A test proves it: rewrite the stem, and the paper still
shows the original wording at the original revision.

**Provenance**: each question carries the revision that was frozen — the number
attempt analytics group by, so two wordings never merge into one statistic — and
the header names who published it, not just when. A substituted question shows
why, since a `fallback_reason` recorded at draw time is otherwise invisible when
somebody asks months later why the paper looks odd.

`exam_paper()` is a second route to question content, so it carries the same
key-leak assertion the frozen snapshot does, in both branches. The rendered page
is checked too — no `"correct"`, `modelAnswer` or `"rubric"` reaches the browser.

### Shipped — assignments, schedule and clone

**Assignment UI** covers all five target kinds — outlet, department, brand, role
and individual. Assignments deliberately stay editable after publish: the 0016
lock covers what is asked, not who sits it, and adding an outlet that opened
late or giving one person a retake changes nothing about the paper. An exam with
no assignments says so plainly, because a published exam nobody is assigned to
is not an error the database catches and it silently reaches no one.

**Schedule UI** with an asymmetry that mirrors the trigger: a draft edits the
opening time, closing time and timezone; a **published exam offers only the
closing time**, and the other two are rendered as read-only text rather than
disabled inputs — a disabled field still reads as "temporarily unavailable", and
this one never becomes available again. `updateSchedule()` narrows the write to
match, so the chef gets a sentence instead of a constraint violation.

**Clone** is the escape hatch that makes immutability liveable, and it drops the
chef straight into the copy — the reason anyone duplicates an exam is to change
something.

Authenticated org lookups live in a new `directory.ts` rather than in `org.ts`,
whose header warns against adding filters to the two unauthenticated
admin-client functions it holds. Putting authenticated lookups beside them would
blur a boundary that is currently unmistakable.

### Fixed while building

**The render check's disabled-button helper reported every button as disabled.**
It tested `slice.includes('disabled')`, and every button in the app carries
Tailwind variant classes containing the word — `disabled:pointer-events-none
disabled:opacity-50`. So "the publish button is disabled while blocked" passed
whether or not it was. It now matches the *attribute*, and the Publish button is
asserted in both states — disabled when blocked, enabled when ready — so the
check cannot pass vacuously again.

### Shipped — Exam Health dashboard and publish validation

The health report a chef actually reads, on `/exams/[id]`. Blocking issues
first, then advisories, each paired with a remedy — the database says what is
wrong, this layer says what to do about it, kept apart so a SQL message can stay
short and factual.

Nothing is re-derived on the client. Severity, message and detail are the
database's answer; the panel decides only how to draw them. `publish_exam()`
calls the same `exam_health()` the panel shows, so the screen and the gate that
refuses cannot disagree — and when publish does refuse, it raises with its
blocking rows attached, so the refusal lands back in the panel as the same list
rather than as an opaque failure.

**Publish is disabled while blocked**, with the reasons listed above it. A button
that is enabled and then refuses teaches people to click it twice. It also asks
for confirmation first: publishing freezes the paper and emails everyone
assigned, and neither is easy to walk back.

Advisories say so explicitly. A warning that looks like an error gets treated
like one, and then a chef stops publishing perfectly good exams.

The lifecycle controls follow the 0016 transition table — `scheduled` offers
*Open now* and *Cancel*, `active` offers *Close*, and terminal states offer
*Archive*. Only transitions the trigger actually permits are shown.

The health panel needs `exams.update`: its detail payload carries question ids
and stems, so it is as sensitive as the paper. A reader without that permission
does not see it at all, and the page skips the call rather than swallowing the
authorisation error into an empty report.

### Shipped — section and rule builder (0018)

Sections and their selection rules are editable on `/exams/[id]`, each rule
showing **two numbers**:

    available — what this rule matches on its own, within its difficulty band
    drawn     — what it actually gets once earlier rules have taken theirs

One number would be a trap. Two rules matching the same 23 questions each report
"23 available" and publish then refuses both. "23 available · 19 already taken by
an earlier rule" says the same thing while the chef can still act on it.
`available` updates live as they edit, debounced; `drawn` needs the real draw, so
it refreshes on save.

**The refactor matters more than the feature.** Counting a rule needs the same
predicate `draw_paper()` selects with. A second copy would drift, and the builder
would promise questions the draw does not agree exist. `question_pool()` is that
predicate extracted; `draw_paper()`, `exam_rule_counts()` and
`preview_rule_count()` all call it, so there is one definition of what a rule
matches. The existing 21 draw tests passed unchanged against the refactored
function, which is what a refactor should be able to show.

`preview_rule_count()` takes rule *parameters* rather than a rule id, so the
count answers for a rule that has not been saved yet. It reports `available`
only — a rule with no place in the running order has no meaningful `drawn`, and
inventing one would be worse than omitting it.

**Counts are in-band only.** `question_pool()` deliberately returns out-of-band
questions so the draw can widen to adjacent difficulty, but a chef asking "how
many match this rule?" means the rule as written. Counting the widened pool made
the difficulty control look inert — narrowing 1–5 to 3–3 left the number
unchanged.

`saveSections()` is separate from `saveExam()`. Routing a sections-only save
through the settings action would mean sending a title the builder does not own,
which is how a form writes back a stale copy of something somebody else just
changed.

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
