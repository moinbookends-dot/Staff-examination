'use server'

import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import {
  GUIDE_PAGE_SIZE,
  KIND_GROUPS,
  parseGuideFilters,
  type SourceDocumentRow,
} from '@/lib/imports/source-documents'

/**
 * The Guide (AI) document library's read path (0048, widened by 0050).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE USER'S CLIENT, AND ONLY THE USER'S CLIENT.                            │
 * │                                                                           │
 * │ 0048 is SECURITY INVOKER end to end — no definer functions, no bypass —   │
 * │ so createClient() is the entire authorisation story here and there is no  │
 * │ service-role path to reach for. Company scoping, brand scoping and the    │
 * │ Super Admin's cross-brand read all live in source_documents_read; this    │
 * │ file re-implements none of them.                                          │
 * │                                                                           │
 * │ requirePermission('questions.read') is therefore doing one job: keeping   │
 * │ somebody with no claim on the bank out of the table at all, before a      │
 * │ query is spent. It is the same permission source_documents_read keys on,  │
 * │ so a caller who slipped past this line would still read nothing.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IS NOT HERE, AND WHY. Uploading is a different permission
 * (questions.import) and a different client — the storage API against bucket
 * 'source-documents' — plus a sniff of the bytes, a sha256, and a 23505 on
 * (company_id, sha256) that has to be reported as "already uploaded" rather
 * than a generic failure. None of that shares a line with listing, and half an
 * upload action is worse than none: it would be the thing that puts bytes in a
 * bucket with no row pointing at them. It arrives whole, in the next slice.
 *
 * The recycle bin is not here either. Deleted documents need
 * source_documents_read_deleted, which keys on questions.import rather than
 * questions.read, so it is a different query under a different guard and not a
 * flag on this one.
 */
export async function listSourceDocuments(
  input: unknown,
): Promise<{ items: SourceDocumentRow[]; total: number; page: number; pageSize: number }> {
  await requirePermission('questions.read')

  // Re-parsed here rather than trusted. The page parses the same searchParams
  // with the same schema, but this is a server action and its argument is
  // whatever a client sent — listQuestions takes `input: unknown` and re-runs
  // its parser for exactly this reason.
  const filters = parseGuideFilters(input)
  const from = (filters.page - 1) * GUIDE_PAGE_SIZE
  const empty = { items: [], total: 0, page: filters.page, pageSize: GUIDE_PAGE_SIZE }

  const supabase = await createClient()
  let query = supabase
    .from('source_documents')
    /*
     * ONE STRING LITERAL, NOT A CONCATENATION.
     *
     * supabase-js parses this select at the TYPE level to work out the row
     * shape, which needs a literal type. `'a, ' + 'b'` widens to `string`, the
     * parser gives up, and every field access downstream fails with
     * "Property 'id' does not exist on type 'GenericStringError'" — which
     * reads like a database problem and is a TypeScript one.
     *
     * `description` is deliberately absent: the list does not render it, and a
     * column that is fetched but never shown is a row somebody has to explain.
     */
    .select(
      'id, kind, title, original_filename, byte_size, page_count, status, created_at',
      { count: 'exact' },
    )
    // Redundant against source_documents_read, which already requires
    // `deleted_at is null` — kept because source_documents_company_idx is
    // PARTIAL on exactly this predicate, and spelling it in the query makes the
    // index match unconditional rather than dependent on how the policy inlines.
    .is('deleted_at', null)

  // NO .eq('company_id', …), and that is the point. The policy scopes this to
  // my_company(), to my_brand() where a brand is set, and lets a Super Admin
  // across brands. Repeating any of it here would be a second copy of the rule
  // that can disagree with the first — and the naive copy would quietly revoke
  // the Super Admin's cross-brand read, which is the sort of bug that looks
  // like missing data rather than a broken filter.
  const kinds = KIND_GROUPS[filters.kind]
  // `all` is [], meaning no predicate at all rather than an IN list naming
  // every kind. Spread because KIND_GROUPS is `as const` and .in() takes a
  // mutable array.
  if (kinds.length > 0) query = query.in('kind', [...kinds])

  if (filters.status) query = query.eq('status', filters.status)

  if (filters.q) {
    /*
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │ THE VALUE IS QUOTED BECAUSE .or() TAKES A FILTER EXPRESSION, NOT A   │
     * │ BOUND PARAMETER.                                                    │
     * │                                                                     │
     * │ PostgREST parses this string as a comma-separated list of filters,  │
     * │ and supabase-js sends it through untouched — there is no            │
     * │ placeholder to bind to. A search for `chicken, rice` interpolated   │
     * │ raw arrives as THREE branches, two of them malformed; a `)` ends    │
     * │ the list early and whatever follows is read as more query. So the   │
     * │ term is wrapped in double quotes, which PostgREST accepts as a      │
     * │ single opaque value, and the two characters that could close that   │
     * │ quote early are escaped.                                            │
     * │                                                                     │
     * │ `%` and `_` inside the term stay LIKE wildcards. That is a broader  │
     * │ match than the person may have meant and nothing more — it cannot   │
     * │ reach another company's rows, because RLS is applied after this     │
     * │ predicate, not by it.                                               │
     * └─────────────────────────────────────────────────────────────────────┘
     *
     * ILIKE and not full text search: 0009 gave `questions` a generated
     * search_tsv with a GIN index, and 0048 gave source_documents nothing
     * equivalent. Two short columns over a library of hundreds of files is what
     * ILIKE is for; it would be the wrong answer over tens of thousands of
     * question stems, which is why the bank has the tsvector and this does not.
     *
     * Title and filename only. The description is searchable in principle, but
     * a result that matches on a field the list never displays reads as a bug —
     * the row appears with nothing in it that contains the search term.
     */
    const term = filters.q.replace(/[\\"]/g, (character) => `\\${character}`)
    const pattern = `"%${term}%"`
    query = query.or(`title.ilike.${pattern},original_filename.ilike.${pattern}`)
  }

  const { data, error, count } = await query
    // Newest upload first: this list is read as "what has come in", and the
    // thing somebody just added is the thing they are looking for.
    .order('created_at', { ascending: false })
    // A stable tiebreak. Files arriving in one batch share a created_at often
    // enough, and without a second key two of them can swap places between
    // page 1 and page 2 — one row seen twice, another never.
    .order('id', { ascending: true })
    .range(from, from + GUIDE_PAGE_SIZE - 1)

  // Degrade to an empty shelf rather than throwing, as listSavedFilters and
  // listExams do. The only error boundary is (app)/error.tsx and it
  // deliberately does not render the message, so a transient read failure would
  // replace the whole page with a card that says nothing.
  if (error) return empty

  return {
    // `kind` comes back typed as plain `string`: the type generator reads
    // columns, not CHECK constraints, so it cannot know the fourteen values.
    // The cast narrows it to the union this codebase owns, and
    // source_documents_kind_check is what makes the cast true.
    items: (data ?? []) as SourceDocumentRow[],
    total: count ?? 0,
    page: filters.page,
    pageSize: GUIDE_PAGE_SIZE,
  }
}
