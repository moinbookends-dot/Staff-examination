import { z } from 'zod'
import { dbId } from '@/lib/db/id'

/**
 * Shapes and limits for uploading a source document.
 *
 * Outside the 'use server' module for the usual mechanical reason — such a file
 * may export only async functions — and so the upload form can reject a file
 * before spending several minutes pushing 92 MB at a bucket that will refuse it.
 */

/**
 * Every kind the extraction pipeline has a branch for. Mirrors 0050's
 * source_documents_kind_check.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE FOR ONE WITH THE CHECK CONSTRAINT, IN BOTH DIRECTIONS.                │
 * │                                                                           │
 * │ This array is what uploadSchema validates against, so a kind the database │
 * │ admits but this list omits is unreachable from the product — the widening │
 * │ ships and nothing can ever send the new value. The reverse is worse: a    │
 * │ kind here that the CHECK does not admit survives every client-side check, │
 * │ reaches the insert, and comes back as a bare 23514 — after the bytes are  │
 * │ already in the bucket, with a half-made document and nothing to explain   │
 * │ to whoever uploaded it.                                                   │
 * │                                                                           │
 * │ 0048's six keep their spelling. Rows already carry them, and a rename     │
 * │ dressed up as a widening strands every one of those rows behind a         │
 * │ constraint that no longer admits what they say.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const SOURCE_DOCUMENT_KINDS = [
  // 0048's six, unchanged.
  'cookbook',
  'sop',
  'manual',
  'policy',
  'vendor',
  'other',

  // 0050. All of these are prose, or images of prose, and all take the ordinary
  // road: OCR -> knowledge units -> generation -> Question Bank.
  'recipe_book',
  'training',
  'food_safety',
  'kitchen_manual',
  'spreadsheet',
  'presentation',
  'image',

  // The exception, and the only one. A question paper is already questions, so
  // it goes OCR -> detect question / answer / marks -> Question Bank directly:
  // no knowledge unit in between and no generation batch at all, because
  // generating from a past paper paraphrases an exam and throws away the marks
  // and answers that were the reason for keeping it.
  'question_paper',
] as const
export type SourceDocumentKind = (typeof SOURCE_DOCUMENT_KINDS)[number]

/**
 * Where a file is in the ingest pipeline (0048's status CHECK).
 *
 * Spelled out here because nothing in src/ spelled it before and
 * guideFiltersSchema below needs an enum rather than a free string. The
 * question bank learned this the expensive way: its filter schema hand-wrote
 * three of seven statuses, so `?status=approved` parsed as invalid and — with
 * the old all-or-nothing fallback — silently discarded the entire query.
 *
 * Deliberately NOT question_status, for the reason 0048 gives: `approved` and
 * `retired` cannot be true of a PDF, and borrowing that vocabulary would hang
 * four meaningless states off every document.
 */
export const SOURCE_DOCUMENT_STATUSES = [
  'uploaded',
  'processing',
  'processed',
  'failed',
  'archived',
] as const
export type SourceDocumentStatus = (typeof SOURCE_DOCUMENT_STATUSES)[number]
export const sourceDocumentStatusSchema = z.enum(SOURCE_DOCUMENT_STATUSES)

/**
 * The Guide (AI) tabs, and the kinds behind each.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A TAB IS A VIEW OF kind, NOT A SECOND COLUMN.                             │
 * │                                                                           │
 * │ Nobody hunting for the cookbooks distinguishes 'cookbook' from            │
 * │ 'recipe_book', and a manual, an SOP, a kitchen manual and a food-safety   │
 * │ file are one shelf to everyone except the pipeline that reads them. The   │
 * │ kinds are fine-grained because a branch of extraction switches on each;   │
 * │ the shelves are coarse because a person is choosing between them.         │
 * │                                                                           │
 * │ Storing the shelf alongside the kind would be a second fact to keep true  │
 * │ about every row, and it would go stale the first time a shelf is          │
 * │ regrouped. Deriving it makes regrouping an edit to this object and no     │
 * │ migration at all.                                                         │
 * │                                                                           │
 * │ `all` is [] rather than all fourteen kinds written out again: the empty   │
 * │ list is the signal to add NO kind predicate to the query, so the default  │
 * │ tab costs nothing and cannot fall out of date the next time the CHECK is  │
 * │ widened.                                                                  │
 * │                                                                           │
 * │ 'other' has no tab but `all`, on purpose. It is the kind chosen when none │
 * │ of the shelves fit; giving it a shelf would contradict what it means.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `satisfies` rather than a plain type annotation, so the keys stay literal for
 * KindGroup below while every value is still checked against
 * SOURCE_DOCUMENT_KINDS — a kind renamed above then fails to compile here,
 * instead of quietly leaving a tab that matches nothing.
 */
export const KIND_GROUPS = {
  all: [],
  cookbooks: ['cookbook', 'recipe_book'],
  questionPapers: ['question_paper'],
  manuals: ['sop', 'manual', 'kitchen_manual', 'training', 'food_safety', 'policy', 'vendor'],
  spreadsheets: ['spreadsheet'],
  presentations: ['presentation'],
  images: ['image'],
} as const satisfies Record<string, readonly SourceDocumentKind[]>

export type KindGroup = keyof typeof KIND_GROUPS

/**
 * The tab names, in the order the strip renders them.
 *
 * Derived from the object rather than written out a second time, so a tab added
 * above appears in the UI and in the filter schema without a third edit — the
 * failure mode a hand-written copy has is a tab that renders and then parses as
 * invalid. Object.keys preserves insertion order for string keys, which is what
 * makes `all` the first tab. The cast is unavoidable: Object.keys is typed
 * string[] regardless of the object it was given.
 *
 * Narrowed to `readonly KindGroup[]` and NOT to a non-empty tuple. Zod 4 types
 * z.enum as `<const T extends readonly string[]>`, so a plain array is accepted
 * and `T[number]` still yields the KindGroup union; Zod 3 was the version that
 * demanded `[string, ...string[]]`. Asserting the tuple here is also a cast TS
 * rejects outright — string[] provides nothing for the required element at
 * position 0 — and the only way to force it would be through `unknown`, which
 * would buy a shape no caller needs at the cost of silencing the compiler.
 */
export const KIND_GROUP_NAMES = Object.keys(KIND_GROUPS) as readonly KindGroup[]
export const kindGroupSchema = z.enum(KIND_GROUP_NAMES)

/**
 * What may be uploaded.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AN ALLOWLIST. THE LIST IS BINDING; THE BYTE CHECK NO LONGER CAN BE.       │
 * │                                                                           │
 * │ A browser-supplied MIME type is a claim by the client, and the extension  │
 * │ is a claim by whoever named the file. Neither is evidence. The magic      │
 * │ number is the only thing in an upload that the uploader cannot casually   │
 * │ lie about, so sniffMimeType below reads the first bytes and mimeTypeAgrees│
 * │ reconciles the two.                                                       │
 * │                                                                           │
 * │ WHERE THAT RECONCILIATION NOW RUNS: in the browser, because the browser   │
 * │ is the only place the bytes exist. The upload path is a signed URL        │
 * │ straight to Storage (src/server/actions/upload-document.ts) and the       │
 * │ server never receives the file. So the sniff catches the ordinary mistake │
 * │ early — a .docx renamed to .pdf, an image saved with the wrong extension, │
 * │ which would otherwise fail at page one of an OCR run started long after   │
 * │ the person who uploaded it walked away — and it is a COURTESY, not a      │
 * │ control. Anyone with a console can skip it.                               │
 * │                                                                           │
 * │ This list, checked against the declared type, is what the server still    │
 * │ enforces. That check is binding and is the reason the list is short.      │
 * │                                                                           │
 * │ This is not virus scanning and does not pretend to be.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PPTX. A training deck is one of the commonest things a kitchen hands over,
  // and 0050 admits the 'presentation' kind — accepting the kind while refusing
  // the file leaves a tab that can never have anything in it.
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'image/jpeg',
  'image/png',
] as const

/**
 * 0048's bucket, named once.
 *
 * Both ends of the upload address it — the server action to mint a signed URL,
 * the browser to PUT against that URL — and a bucket id spelled twice is a
 * bucket id that can be spelled differently. Storage answers a wrong bucket
 * with a 404 that says nothing about which of the two callers is wrong.
 */
export const SOURCE_DOCUMENTS_BUCKET = 'source-documents'

/**
 * 50 MB, and this number is not ours to choose.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ IT MATCHES THE SUPABASE PROJECT UPLOAD LIMIT, ON PURPOSE.                 │
 * │                                                                           │
 * │ The `source-documents` bucket sets no file_size_limit of its own, so the  │
 * │ project-wide ceiling applies — 50 MB on the current plan. Storage refuses │
 * │ anything larger, and it refuses it at the PUT, which in this design is    │
 * │ the very last step.                                                       │
 * │                                                                           │
 * │ So a ceiling above the real one is not generous, it is a trap. A chef     │
 * │ picking a 92 MB file would pass the browser check, wait through a hash of │
 * │ 92 MB, receive a ticket, watch a progress bar climb for minutes — and     │
 * │ only then be told no, with a row already reserved and a tombstone left    │
 * │ holding its sha256. Every one of those steps costs them time we knew in   │
 * │ advance would be wasted.                                                  │
 * │                                                                           │
 * │ Refusing at the file picker costs nothing and says the true thing.        │
 * │                                                                           │
 * │ WHAT THIS MEANS FOR THE PROVIDED COOKBOOKS: the AIKO manual (28 MB) fits. │
 * │ The Capiche manual (88 MiB) DOES NOT, and no code change here admits it — │
 * │ it needs splitting into sections before upload, or a plan that raises the │
 * │ project limit. That is a deliberate product decision, not an oversight,   │
 * │ and this constant is where it is written down.                           │
 * │                                                                           │
 * │ If the project limit is ever raised, raise this WITH it, and check the    │
 * │ bucket's own file_size_limit at the same time — the bucket's null is what │
 * │ makes the project value authoritative today.                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export const uploadSchema = z.object({
  kind: z.enum(SOURCE_DOCUMENT_KINDS),
  title: z.string().trim().min(1, 'Give the document a title.').max(300),
  description: z.string().trim().max(2000).optional(),
  // dbId(), not z.string().uuid(): both of these arrive from uuid columns
  // (source_documents.brand_id, source_documents.supersedes_id), and Zod 4's
  // .uuid() enforces RFC 4122 where Postgres enforces nothing. Every fixed id
  // in supabase/seed.sql looks like 00000000-0000-0000-0000-00000000c001 —
  // Postgres stores it, z.string().uuid() rejects it. See src/lib/db/id.ts.
  //
  // This was not theoretical. The upload action surfaces issues[0].message as
  // the whole result, so a posted brandId belonging to a seeded brand failed
  // the parse and took the entire upload down over a field the form filled in
  // for the user. It had not fired only because the dialog never sent one.
  brandId: dbId().nullable().optional(),
  /** Replacing an earlier version. The old row is kept and pointed at. */
  supersedesId: dbId().nullable().optional(),
})

export type UploadInput = z.infer<typeof uploadSchema>

/**
 * The file's real type, from its leading bytes.
 *
 * Only the formats in ACCEPTED_MIME_TYPES are recognised; anything else returns
 * null and is refused. Deliberately a small hand-written table rather than a
 * dependency: six signatures is not worth a package, and a package here would
 * run over untrusted bytes.
 */
export function sniffMimeType(head: Uint8Array): string | null {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)

  // %PDF
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  // JPEG SOI
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  // PNG
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  // ZIP container — docx, xlsx and pptx are all ZIPs, and telling them apart
  // needs the central directory. The caller reconciles this with the declared
  // type, which is safe because all three are on the allowlist.
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'

  return null
}

/**
 * The allowlisted formats that are ZIP containers underneath.
 *
 * Every OOXML file is a ZIP, so sniffMimeType returns 'application/zip' for all
 * three and mimeTypeAgrees has to accept that against any of them. Held as a
 * list because the alternative — naming them in the condition below — is what
 * makes adding an Office format a two-site change with no compiler help: pptx
 * joins ACCEPTED_MIME_TYPES in this same change, and had this stayed a
 * hand-written pair of comparisons, the allowlist would have admitted decks
 * that mimeTypeAgrees then refused as forgeries.
 */
const ZIP_CONTAINER_MIME_TYPES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

/**
 * The allowlisted formats that HAVE a magic number.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A MAGIC NUMBER IS EVIDENCE WHERE ONE EXISTS. DEMANDING EVIDENCE THAT      │
 * │ CANNOT EXIST REFUSES EVERY VALID FILE.                                    │
 * │                                                                           │
 * │ text/csv is on ACCEPTED_MIME_TYPES and has no signature — it is text, and │
 * │ a valid CSV may begin with any byte at all. sniffMimeType therefore       │
 * │ returned null for every CSV ever written, mimeTypeAgrees('text/csv',      │
 * │ null) was false unconditionally, and the upload action carried a bespoke  │
 * │ sentence refusing CSV outright. An allowlist entry that nothing can       │
 * │ satisfy is not a control; it is a promise the product does not keep.      │
 * │                                                                           │
 * │ So the question splits in two. "Is this format one we can read evidence   │
 * │ about?" is answered here, once. "Does the evidence agree with the claim?" │
 * │ is answered below, and only for the formats where the first answer is     │
 * │ yes. A format with no signature is admitted on its declared type alone —  │
 * │ which is exactly as much as anyone could ever know about it — and that is │
 * │ stated rather than smuggled in as a special case in a consumer.           │
 * │                                                                           │
 * │ THE BINARY FORMATS STAY STRICT. A .pdf whose bytes are a ZIP is still     │
 * │ refused, and a JPEG named .png still is. Nothing about CSV loosens them.  │
 * │                                                                           │
 * │ WHAT THIS DOES ADMIT, SAID PLAINLY: a PDF renamed to .csv now passes,     │
 * │ because "not sniffable" is answered from the DECLARED type before the     │
 * │ bytes are consulted at all. That is the cost of the rule and it is        │
 * │ bounded — the sniff runs in the browser and catches honest mistakes, and  │
 * │ nothing downstream treats its verdict as a control. A dishonest uploader  │
 * │ never needed this door: they could declare application/pdf and send       │
 * │ anything, because the server has no bytes to check either way.            │
 * │                                                                           │
 * │ Typed as members of ACCEPTED_MIME_TYPES so a renamed allowlist entry      │
 * │ fails to compile here. The direction that has no compiler help is the     │
 * │ dangerous one: a NEW binary format added to the allowlist and forgotten   │
 * │ here would be waved through on its declared type with its signature never │
 * │ read. Adding a format is therefore a two-line change, and this comment is │
 * │ the second line's reason for existing.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const SNIFFABLE: readonly (typeof ACCEPTED_MIME_TYPES)[number][] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
]

/** Everything on the allowlist except text/csv, which has no magic number. */
export const SNIFFABLE_MIME_TYPES: ReadonlySet<string> = new Set(SNIFFABLE)

/**
 * Is the sniffed type consistent with what the client declared?
 *
 * Three rules, in order:
 *
 *  1. A declared type that is not on the allowlist never agrees with anything.
 *     Callers check the allowlist themselves — they need to say WHY in their
 *     own words — but this function will not quietly bless a type nobody
 *     admits just because its bytes happen to match its name.
 *  2. A declared type with no signature is taken at its word, because no
 *     evidence about it can exist. See the box above.
 *  3. Everything else must match: exactly, or as ZIP against one of the Office
 *     formats, which the signature cannot tell apart and all of which are
 *     allowed.
 */
export function mimeTypeAgrees(declared: string, sniffed: string | null): boolean {
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(declared)) return false
  if (!SNIFFABLE_MIME_TYPES.has(declared)) return true
  if (sniffed === null) return false
  if (sniffed === declared) return true
  return sniffed === 'application/zip' && ZIP_CONTAINER_MIME_TYPES.includes(declared)
}

/**
 * Where the file lives in the bucket.
 *
 * `<company_id>/<document_id>/<filename>` — 0048's storage policies authorise on
 * the first segment alone, so the company must lead and nothing may be inserted
 * before it. The filename is sanitised because it reaches a path: a name
 * containing a slash would otherwise create a folder and land the object
 * outside the company prefix its policy checks.
 */
export function storagePathFor(
  companyId: string,
  documentId: string,
  filename: string,
): string {
  const safe = filename
    .normalize('NFKD')
    // Anything that is not a word character, dot or dash becomes a dash. This
    // is what removes slashes, and with them any ability to add path segments.
    .replace(/[^\w.\-]+/g, '-')
    // Dots survive the class above, so `../../x` arrives here as `..-..-x` with
    // its traversal tokens intact. They cannot escape the folder — there are no
    // separators left — but a stored name containing `..` is one normalisation
    // away from meaning something again, in a layer this file does not control.
    // Collapsing runs of dots removes the token rather than trusting that.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 120)
  return `${companyId}/${documentId}/${safe || 'document'}`
}

export interface SourceDocumentRow {
  id: string
  kind: SourceDocumentKind
  title: string | null
  original_filename: string
  byte_size: number
  page_count: number | null
  status: string
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Guide (AI) list filters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the document library can be narrowed by.
 *
 * Outside the 'use server' module for the two familiar reasons: mechanically,
 * such a file may export only async functions and this is a value; really,
 * because the same schema parses `searchParams` on the page and the argument to
 * listSourceDocuments(), so a URL somebody bookmarked and a call the client
 * makes are checked by identical rules. `page` is coerced because everything
 * arriving from a query string is a string.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `kind` HOLDS A TAB NAME, NOT A SourceDocumentKind.                        │
 * │                                                                           │
 * │ The tab strip is this page's primary navigation, and a filter the URL     │
 * │ cannot express is a view nobody can bookmark, share or link a chef to —   │
 * │ the whole reason list state lives in the query string here. "Cookbooks"   │
 * │ is two kinds and "Manuals" is seven, so a field holding one kind could    │
 * │ not name either of them.                                                  │
 * │                                                                           │
 * │ So the URL carries the coarse thing a person picked and KIND_GROUPS       │
 * │ expands it into the kinds the query needs. It defaults to `all` rather    │
 * │ than being optional because a tab strip always has exactly one tab        │
 * │ current: with a default the page reads filters.kind and knows which to    │
 * │ mark, with `.optional()` every call site would need the same `?? 'all'`   │
 * │ and one of them would eventually forget it.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `status` is the imported enum, never re-spelled — see SOURCE_DOCUMENT_STATUSES
 * for what a partial hand-written copy of a status list cost the question bank.
 */
export const guideFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: kindGroupSchema.default('all'),
  status: sourceDocumentStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
})

export type GuideFilters = z.infer<typeof guideFiltersSchema>

/**
 * Parse filters, keeping whatever is valid.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SAME PARTIAL RECOVERY parseQuestionFilters DOES, AND FOR THE SAME     │
 * │ REASON. See src/lib/questions/filters.ts for the long version.            │
 * │                                                                           │
 * │ safeParse().data ?? {} throws away the whole query when any one part of   │
 * │ it is unrecognised. A link to                                             │
 * │                                                                           │
 * │     /guide?kind=cookbooks&status=processed&q=brine                        │
 * │                                                                           │
 * │ kept from before a tab was renamed would not come back with the tab       │
 * │ ignored — it would come back as the unfiltered first page of everything,  │
 * │ silently, and be read as a filtered list. Dropping only the key Zod       │
 * │ objected to is the failure mode that survives the NEXT widening of the    │
 * │ kind CHECK too, and this file expects more of those.                      │
 * │                                                                           │
 * │ Copied rather than shared: the algorithm is fifteen lines closing over a  │
 * │ different schema, and a generic helper earns its keep at the third caller │
 * │ rather than the second. If a third list page wants it, lift it then —     │
 * │ what must not happen is a second, DIFFERENT recovery rule.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function parseGuideFilters(input: unknown): GuideFilters {
  const parsed = guideFiltersSchema.safeParse(input ?? {})
  if (parsed.success) return parsed.data

  // Path[0] is the field name; anything deeper is inside a value this schema
  // treats as a scalar, so the whole field goes.
  const offending = new Set(
    parsed.error.issues.map((issue) => String(issue.path[0])).filter(Boolean),
  )
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (!offending.has(key)) kept[key] = value
  }

  const retry = guideFiltersSchema.safeParse(kept)
  if (retry.success) return retry.data

  // Everything was offensive. Parsing an empty object rather than writing the
  // defaults out by hand, so this can never disagree with the schema.
  return guideFiltersSchema.parse({})
}

/**
 * Fixed, and not a URL parameter.
 *
 * The question bank offers a page-size chooser because its lists run to tens of
 * thousands of rows and people work them in different ways. A company's
 * document library is hundreds of files at most, so the control would be
 * chrome nobody touches — and a size that reaches PostgREST's .range() has to
 * be bounded and validated the moment it is anything a caller can set. Same
 * choice, and the same number, as EXAMS_PAGE_SIZE.
 */
export const GUIDE_PAGE_SIZE = 25
