# M11–M13 — Cookbook-First Knowledge Platform

**Status: proposal. Nothing here is built.**

---

## 1. Audit — what already exists and is reusable

The platform is further along than a greenfield knowledge system would assume.
Most of what M11–M13 needs is already in the schema under a different name.

| Requirement in the brief | Already exists | Reuse verdict |
|---|---|---|
| Immutable provenance on questions | `questions.source`, `imported_from` (0037), preserved by `coalesce` in 0039 — `saveQuestion` never sends them, so no code path can overwrite them | **Extend**, don't rebuild. Add FK columns to knowledge, keep the same immutability construction |
| "Imported enters Review" | `question_status` has `review`; 0040's transition trigger enforces the lifecycle; `question_is_drawable()` excludes `review` | **Reuse exactly.** A knowledge-generated question in `review` is already undrawable |
| Approval workflow | `question_status_transition_allowed()` + `enforce_question_status_transition` trigger | **Reuse** |
| Review queue | `?status=review` on the existing bank, plus M8's bulk operations | **Reuse** |
| Versioning / revision history | `question_revisions` (0011), `bump_question_revision` | **Reuse** for questions; knowledge needs its own equivalent |
| Audit trail | `audit_row()` + `questions_lifecycle_audit` (0041) | **Reuse** — attach the same trigger to knowledge tables |
| Multi-tenancy | `company_id` + `my_company()` on every table; brand scoping | **Reuse verbatim** |
| Question quality | M9's `question_quality()`, `question_health()`, `bank_quality()` | **Extend** — generated questions get quality for free |
| Coverage analysis | `bank_quality()` returns long-format distributions; `bank_recommendations()` returns exam-health shape | **Extend** with a knowledge dimension |
| Exam generation by filter | `exam_rules` + `draw_paper()` already select by category/difficulty/tags | **Extend** — knowledge selection becomes another rule predicate |
| Media on questions | `question_media` (0009) | **Reuse** for page images |
| Translations | `question_translations`, workbench, `save_question_translation` | **Reuse** |
| Notifications | existing notification system | **Reuse** |
| Health/remedy rendering | `HealthIssueList` + `ISSUE_REMEDY` + `health-codes.test.ts` parity test | **Reuse** — new codes get remedies or CI fails |

### Gaps — what genuinely does not exist

1. **No file storage.** `question_media` stores references but no bucket is
   provisioned and no migration touches `storage.*`. Source documents have
   nowhere to live.
2. **No pgvector.** 0001 installs `pgcrypto` only. Semantic search and
   duplicate detection need the extension plus an index strategy.
3. **No job/queue table.** OCR over ~113 pages cannot run inside a request.
   Nothing in the schema models asynchronous work, retries, or failure.
4. **No knowledge layer.** Categories and tags are flat labels on questions;
   there is no content substrate and no graph.
5. **No AI integration.** No Anthropic SDK, no key handling, no prompt/response
   audit trail.
6. **No manual paper mode.** `exam_questions` is written only by
   `publish_exam()` from the rule draw, so "pick these exact questions" has no
   representation. M10 deferred print preview and group pinning for this reason.

### Two facts that constrain the design

- **The cookbooks are scanned images.** Every stream in both PDFs was swept: 0
  text operators, every page a full-page JPEG. A text-extraction pipeline
  returns the empty string for both of the only documents that exist. OCR is
  the primary path, not a fallback.
- **The PDFs are currently in public Git history** (my error, commit
  `63f30a5`). Regardless of how that is resolved, source documents belong in
  Supabase Storage — it gives RLS, versioning and signed URLs, all of which the
  provenance model needs and Git provides none of.

---

## 2. The central design decision

> **Knowledge units are content. Questions remain questions.**

The brief says the Master Knowledge Dataset is "the single source of truth for
the entire application." Taken literally that would move grading, permissions
and lifecycle into a new layer, and the database would stop being the
enforcement boundary.

**Proposed reading:** knowledge is the source of truth for *content and
provenance*. Enforcement — who may see what, what may be drawn, how an attempt
is graded — stays exactly where it is. A generated question is an ordinary row
in `questions` with a foreign key to the knowledge unit that produced it.

This is what makes "no duplicate tables, no duplicate provenance, no duplicate
import flow" achievable:

- Generated questions inherit M9 quality analysis, M8 bulk operations, the
  translation workbench, revisions, audit and RLS **with no new code**.
- The exam builder does not fork. Knowledge selection becomes another predicate
  on `exam_rules`, resolved by the existing `draw_paper()`.
- There is one question lifecycle, not two.

The alternative — a parallel `knowledge_questions` table — would duplicate
every one of those systems. It is rejected.

---

## 3. Schema

### M11 — source documents and OCR (migrations 0048–0050)

```
source_documents          one uploaded file, immutable once ingested
  id, company_id, brand_id, storage_path, sha256, byte_size, page_count,
  kind ('cookbook'|'sop'|'manual'|'other'), original_filename,
  uploaded_by, uploaded_at, status, superseded_by

import_batches            one ingestion run — the unit of reversal
  id, company_id, source_document_id, started_by, started_at,
  finished_at, status, stats jsonb

document_pages            one page — the unit of provenance
  id, source_document_id, page_number, image_path,
  ocr_text, ocr_confidence, ocr_status, ocr_attempts, ocr_error
```

`sha256` makes re-uploading the same file detectable rather than silently
duplicating a 92 MB document. `document_pages.page_number` is the citation
anchor the brief requires ("open the original cookbook page").

**Reversibility** is `import_batches` + `on delete cascade`, plus a refusal to
delete a batch whose questions have been used in a published exam — a paper
that cites a deleted source is worse than an un-reversible import.

### M11 — the knowledge layer (0051)

```
cookbooks                 metadata over a source_document
  id, company_id, brand_id, source_document_id, title, author,
  version, language, department_id, status, description, thumbnail_path

knowledge_sections        the hierarchy; SELF-REFERENCING, not a fixed depth
  id, company_id, cookbook_id, parent_id, kind, title,
  sort_order, first_page, last_page

knowledge_units           the content substrate
  id, company_id, cookbook_id, section_id, page_id,
  kind, title, raw_text, cleaned_text, summary,
  keywords text[], difficulty, bloom_level,
  confidence numeric, status, approved_by, approved_at,
  created_by, updated_by, revision, search_tsv

knowledge_edges           the graph
  from_id, to_id, relation, weight, created_by_ai boolean
```

`knowledge_sections.parent_id` self-references so "unlimited custom sections"
is a data property, not a schema change. `kind` is a **lookup table**, not an
enum — 0037 demonstrated what adding enum values costs, and the brief requires
admins to define their own section types.

`knowledge_edges` is an edge list rather than a graph extension: Postgres does
recursive CTEs well, the graphs here are small, and adding an extension to
serve one screen is not justified.

### Linking questions to knowledge (0052)

```
alter table questions
  add column knowledge_unit_id uuid references knowledge_units(id),
  add column generated_by text,          -- 'ai' | 'manual-from-knowledge'
  add column generation_id uuid references question_generations(id);

question_generations      the prompt/response audit trail
  id, company_id, knowledge_unit_ids uuid[], model, prompt_hash,
  parameters jsonb, requested_by, requested_at, accepted_count, rejected_count
```

Provenance stays immutable by the **same construction 0039 established**:
`save_question` never accepts these as parameters, so no code path can
overwrite them. Not a trigger, not a policy — an argument that does not exist.

### M12 — pgvector (0053)

```
create extension vector;
alter table knowledge_units add column embedding vector(1024);
create index on knowledge_units using hnsw (embedding vector_cosine_ops);
```

Embeddings live on knowledge units, never on questions: the brief's rule is
"never mix embeddings with generation", and duplicate detection is about
knowledge, not phrasing. **Note:** the Claude SDK does not provide embeddings —
a separate provider is required, and this is a decision to confirm before M12.

### M12 — the job queue (0054)

```
jobs
  id, company_id, kind, payload jsonb, status, attempts, max_attempts,
  run_after, locked_at, locked_by, last_error, created_by
```

One table, `for update skip locked` for claiming. OCR of 113 pages and AI
extraction cannot run in a request. A queue is unavoidable; a *second* queue
would not be.

---

## 4. Pipelines

### OCR

```
upload → storage → source_documents + import_batches
      → one 'ocr_page' job per page
      → worker: fetch page image → Claude vision → ocr_text + confidence
      → all pages done → enqueue 'extract_knowledge'
```

Per-page jobs, not per-document: a 113-page document that fails on page 90
must not redo 89 pages. `ocr_attempts` and `ocr_error` make retry a data
property rather than a manual re-run.

### Extraction

```
'extract_knowledge' → group pages into sections (Claude, structural pass)
                    → per section: emit knowledge_units (Claude, content pass)
                    → status = 'review' for every unit, always
                    → propose knowledge_edges, flagged created_by_ai
```

Two passes because structure and content are different problems and a single
prompt doing both is where hallucinated sections come from.

### Generation

```
wizard: select knowledge → preview coverage → generate
      → per unit: Claude proposes N questions with citations
      → validate against the EXISTING publishIssues gate
      → insert into questions with status='review', knowledge_unit_id set
      → chef reviews in the EXISTING bank at ?status=review
```

The generated question passes through the same publish gate as a hand-written
one. No second validator.

**Strict Cookbook Mode** is enforced by *retrieval*, not by prompt wording: the
model is given only the selected units' `cleaned_text` and told to cite. A
question whose citation does not resolve to a supplied unit is rejected before
insert — a check, not a hope.

---

## 5. Milestones

Each is independently shippable and independently verifiable.

| | Scope | Depends on |
|---|---|---|
| **M11a** | Storage bucket + RLS, `source_documents`, `import_batches`, `document_pages`, upload UI, SHA-256 dedupe | — |
| **M11b** | `jobs` table + worker, OCR pipeline, per-page retry, OCR status UI | M11a |
| **M11c** | Knowledge schema, section-kind lookup, review queue, approval | M11b |
| **M12a** | Anthropic client, key handling, prompt/response audit, extraction pass | M11c |
| **M12b** | pgvector, embeddings, semantic search, duplicate detection | M11c |
| **M12c** | Question generation + wizard + coverage preview | M12a, M9 |
| **M13a** | Knowledge graph edges, traversal, visualisation | M11c |
| **M13b** | Coverage dashboard, knowledge gaps | M12c |
| **M13c** | Knowledge-driven exam builder (new `exam_rules` predicate) | M12c |
| **M13d** | AI assistant, answering only from approved units with citations | M12b |

Learning modules and certification are **not** scheduled here. They are a
second product surface, and designing them before the knowledge layer has real
data in it would be guesswork.

---

## 6. Decisions needed before M11 starts

1. **The PDFs in public Git history** — purge and force-push, stop tracking
   going forward, or leave them.
2. **Embedding provider** — Claude provides no embeddings API. Voyage,
   OpenAI, or a self-hosted model. This blocks M12b only.
3. **Worker runtime** — where the job worker runs. Render cron, a long-lived
   worker, or Supabase Edge Functions. Affects M11b.
4. **OCR cost ceiling** — ~113 pages of large JPEGs through a vision model, per
   re-import. Worth an explicit budget before it is automated.

## 7. Risks

- **AI hallucination.** Mitigated by retrieval-only context, mandatory
  citations validated against supplied units, and `review` status on
  everything. Never fully eliminated.
- **OCR quality on scanned pages.** `ocr_confidence` is stored per page and
  surfaced; low-confidence pages are flagged for human reading rather than
  silently feeding generation.
- **Cost.** Per-page OCR and per-unit generation are both metered. The queue
  makes spend observable before it is automatic.
- **Scope.** M11–M13 as specified is larger than M0–M10 combined. The slicing
  above exists so value ships continuously rather than at the end.
