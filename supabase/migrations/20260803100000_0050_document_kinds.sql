-- ═════════════════════════════════════════════════════════════════════════════
-- 0050 — M11b: the document kinds the extraction pipeline actually has
--
-- 0048 allowed six kinds because six were all the ingest path had to prove. The
-- uploader now takes what a kitchen actually hands over: a recipe book, a
-- training deck, a food-safety file, a kitchen manual, a spreadsheet of yields,
-- a slide pack, a photographed page, and last year's question paper.
--
-- Widening only. The six from 0048 keep their spelling, because rows already
-- carry them and a rename dressed up as a widening would strand every one of
-- them behind a constraint that no longer admits what they say.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY kind IS A WIDENED CHECK AND NOT A LOOKUP TABLE.                       │
-- │                                                                           │
-- │ A lookup table is the right shape for an OPEN set — one where an admin    │
-- │ adds a row on a Tuesday and the system keeps working. This set is closed. │
-- │ Every value here exists because a branch of the extraction pipeline reads │
-- │ it: which OCR profile runs, whether pages become knowledge units or       │
-- │ questions, what the generator may assume about the text it is given.      │
-- │                                                                           │
-- │ So a document_kinds table would buy exactly one capability — insert       │
-- │ 'menu' at 3am and have uploads accept it — and that capability is the     │
-- │ bug. The insert would succeed, the upload would succeed, and the file     │
-- │ would sit at status 'uploaded' forever with no branch to carry it,        │
-- │ because naming a kind does not write a pipeline. The failure would land   │
-- │ on a chef waiting for questions, days after the row that caused it.       │
-- │                                                                           │
-- │ A CHECK says the opposite thing at the right moment: a kind exists when   │
-- │ somebody has shipped code for it AND the migration that admits it.        │
-- │ Adding a kind is deliberately a deploy, not a row — the constraint is the │
-- │ thing that makes those two impossible to do separately.                   │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ 'question_paper' IS A SECOND PIPELINE WEARING THE SAME COLUMN.            │
-- │                                                                           │
-- │ Twelve of these thirteen kinds travel one road:                           │
-- │                                                                           │
-- │     OCR ──> knowledge units ──> generation ──> Question Bank              │
-- │                                                                           │
-- │ A question paper is already questions. Sent down that road the generator  │
-- │ would read questions, distil them into knowledge units, and then invent   │
-- │ questions about questions — a fresh paper that is a paraphrase of an      │
-- │ exam nobody asked to reuse, with the marks and the answers thrown away    │
-- │ on the way through. What is wanted from a past paper is the paper.        │
-- │                                                                           │
-- │     OCR ──> detect question / answer / marks ──> Question Bank            │
-- │                                                                           │
-- │ No knowledge unit in between, and no generation batch at all: the         │
-- │ extraction batch itself writes questions.                                 │
-- │                                                                           │
-- │ ONE PROVENANCE CHAIN EITHER WAY, which is why this can be a branch and    │
-- │ not a separate table. Both roads start at a document_pages row, so the    │
-- │ page stays the citation (0048), and both run inside an import_batch, so   │
-- │ the import stays the unit of reversal. What differs is what gets          │
-- │ extracted from a page — never whether a question can be traced back to    │
-- │ one.                                                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- 0048 declared this CHECK inline on the column, so it carries Postgres's
-- default name for a single-column constraint: <table>_<column>_check. Named
-- explicitly on the way back in, so the next migration that widens it does not
-- have to know that naming rule to find it.
alter table public.source_documents
  drop constraint source_documents_kind_check;

-- A strict superset of what 0048 allowed, so every existing row already
-- satisfies it and the validating scan cannot fail. No NOT VALID needed, and
-- none wanted: a constraint that has never been checked is a comment.
alter table public.source_documents
  add constraint source_documents_kind_check check (
    kind in (
      -- 0048's six, unchanged.
      'cookbook','sop','manual','policy','vendor','other',

      -- Added here. All of these are prose or images of prose, and all take
      -- the ordinary road: OCR -> knowledge units -> generation.
      'recipe_book','training','food_safety','kitchen_manual',
      'spreadsheet','presentation','image',

      -- The exception, and the only one. See the box above.
      'question_paper'
    )
  );

comment on column public.source_documents.kind is
  'What the file is, and therefore which pipeline reads it — not a label for the UI. Twelve of the thirteen kinds go OCR -> knowledge units -> generation -> Question Bank. ''question_paper'' takes a DIFFERENT path: it is already questions, so it goes OCR -> detect question / answer / marks -> Question Bank directly, with no knowledge unit in between and no generation batch at all — generating from a past paper would paraphrase an exam and discard its marks and answers. One provenance chain either way: both paths start at a document_pages row and run inside an import_batch, so the page stays the citation and the import stays reversible; what differs is what is extracted from a page, never whether a question can be traced back to one.';

comment on constraint source_documents_kind_check on public.source_documents is
  'A closed set, held as a CHECK rather than a document_kinds lookup table on purpose. The extraction pipeline SWITCHES on this value, so a kind with no branch behind it is not an extension point — it is an upload that succeeds, then stalls at status ''uploaded'' with nothing to process it. A lookup table would make that state reachable by INSERT; this makes adding a kind a deploy, which is what it actually is.';

-- Keep SOURCE_DOCUMENT_KINDS in src/lib/imports/source-documents.ts one for one
-- with this list. It is the same closed set spelled in TypeScript, and it is
-- what uploadSchema validates against — a kind missing there is unreachable
-- from the product, and a kind missing here is a 23514 at insert time.
