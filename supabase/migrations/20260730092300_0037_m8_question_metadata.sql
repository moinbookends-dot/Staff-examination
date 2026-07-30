-- ═════════════════════════════════════════════════════════════════════════════
-- 0037 — M8 Enhanced Question Metadata
--
-- Extends the questions table with new properties for the Enterprise Exam platform,
-- including Bloom taxonomy, import lineage, and new workflow statuses.
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Bloom Taxonomy Enum
create type public.bloom_taxonomy as enum (
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create'
);

-- 2. Extend question_status
-- Postgres does not support removing or renaming enum values in ALTER TYPE,
-- so we add the new values to support the requested ('Draft', 'Review', 'Approved', 'Archived', 'Deprecated')
alter type public.question_status add value if not exists 'review' after 'draft';
alter type public.question_status add value if not exists 'approved' after 'active';
alter type public.question_status add value if not exists 'archived' after 'retired';
alter type public.question_status add value if not exists 'deprecated' after 'archived';

-- 3. Extend questions table
alter table public.questions
  add column bloom_level public.bloom_taxonomy,
  add column imported_from text; -- Stores 'pdf', 'docx', 'moodle_xml', etc. if imported

-- Note: 'negative_marks' and 'reference_note' (which acts as source_reference) 
-- already exist in the schema, as well as the 'source' column for tracking 'ai' vs 'manual' vs 'import'.
