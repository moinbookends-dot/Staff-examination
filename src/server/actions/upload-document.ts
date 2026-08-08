'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  SOURCE_DOCUMENTS_BUCKET,
  storagePathFor,
  uploadSchema,
} from '@/lib/imports/source-documents'

/**
 * The reference-library upload path (0048, kinds widened by 0050).
 *
 * TWO STEPS, AND THE BYTES GO PAST THIS SERVER ENTIRELY.
 *
 *   createUploadTicket(input)  → row + a signed URL for one exact path
 *   …the browser PUTs the file straight at Storage…
 *   finaliseUpload(documentId) → confirm the object arrived, and file it
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NOTHING IS READ OUT OF THESE FILES. THAT IS THE WHOLE POINT NOW.          │
 * │                                                                           │
 * │ This path used to end by opening an import_batch and enqueueing an        │
 * │ ocr_page job, because a cookbook was going to be read by OCR and turned   │
 * │ into questions. The examination system no longer does that: questions     │
 * │ come from the question bank and nowhere else, and the bank is filled by   │
 * │ Editors and by bulk import.                                               │
 * │                                                                           │
 * │ A cookbook is now REFERENCE MATERIAL — something an Editor opens to find  │
 * │ the page number they are citing on a question. So the upload ends when    │
 * │ the bytes are confirmed, and the document goes straight to 'processed',   │
 * │ which for a reference document is the truth: it is stored and it is       │
 * │ readable. No queue, no worker, no extraction, and bank_questions.         │
 * │ reference_document_id is the only thing that ever points at it.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE SHAPE CHANGED: THE OLD ONE COULD NOT CARRY A COOKBOOK.            │
 * │                                                                           │
 * │ A Server Action's request body is capped at 1 MB by default in Next 16    │
 * │ (`experimental.serverActions.bodySizeLimit`) and next.config.ts does not  │
 * │ set it. The previous single action took the whole File in a FormData, so  │
 * │ the framework rejected a 40 MB PDF before the action was ever entered —   │
 * │ with an error no line in this repo wrote and no message key could catch.  │
 * │ Raising the cap to clear MAX_UPLOAD_BYTES would have meant streaming      │
 * │ 150 MB through the Node process for every upload, twice: once to hash it, │
 * │ once to push it at the bucket.                                           │
 * │                                                                           │
 * │ A signed upload URL removes the question rather than answering it. The    │
 * │ body of both actions below is a few hundred bytes of JSON, the config     │
 * │ default stops mattering, and nothing in this file needs next.config.ts to │
 * │ change. What it costs is written down in the next two boxes, honestly,    │
 * │ because every one of those costs is a check this server used to make and │
 * │ now cannot.                                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE SHA256 IS NOW A CLIENT CLAIM. IT IS NOT PROOF OF ANYTHING.            ║
 * ║                                                                           ║
 * ║ The browser computes the digest and posts it. The server never sees the   ║
 * ║ bytes, so it CANNOT verify that the hash describes the file that was      ║
 * ║ actually uploaded — not at ticket time, not at finalise time, not ever    ║
 * ║ without downloading the object back and hashing it here, which is the     ║
 * ║ whole cost this design exists to avoid.                                   ║
 * ║                                                                           ║
 * ║ THEREFORE: DEDUPE IS A CONVENIENCE, NOT INTEGRITY.                        ║
 * ║                                                                           ║
 * ║ A wrong hash has exactly two outcomes, and neither is a security          ║
 * ║ boundary:                                                                 ║
 * ║                                                                           ║
 * ║   • a hash that collides with an existing row refuses a file that is      ║
 * ║     genuinely new — an annoyance, and visible, because the person is told ║
 * ║     which document it matched and can look at it;                         ║
 * ║   • a hash that does not match the bytes lets a second copy of the same   ║
 * ║     document through — wasted storage and a duplicate in the library.     ║
 * ║                                                                           ║
 * ║ Neither grants access to anything. Access is 0048's RLS, on the rows and  ║
 * ║ on the bucket, and none of it consults this column.                       ║
 * ║                                                                           ║
 * ║ WHAT MUST NOT HAPPEN LATER: no code may treat source_documents.sha256 as  ║
 * ║ evidence of content. Not "these two rows are the same document, so reuse  ║
 * ║ the extracted text". Not "the hash matches, so skip re-reading it". Not   ║
 * ║ as a cache key for anything derived from the bytes, and never as an       ║
 * ║ integrity check on a file served back out. It is a fingerprint somebody   ║
 * ║ else took, offered in good faith. If content identity is ever needed as a ║
 * ║ FACT, it has to be established where the bytes are — in the OCR worker,   ║
 * ║ which already opens every file — and written to a different column, so    ║
 * ║ that column can say what this one cannot.                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE OTHER CHECKS THAT MOVED, AND WHAT SURVIVES.                           │
 * │                                                                           │
 * │ GONE FROM THE SERVER: the magic-number sniff. It read the first eight     │
 * │ bytes; there are no bytes here now. It moved to the upload dialog, which  │
 * │ is the only place they exist, and it is a courtesy there — see the box in │
 * │ src/lib/imports/source-documents.ts. That is why 'type-mismatch' is no    │
 * │ longer one of this file's reasons: nothing here can produce it honestly.  │
 * │                                                                           │
 * │ WEAKENED: byteSize is a number the client sends, so the MAX_UPLOAD_BYTES  │
 * │ check below is a claim checked against a constant rather than a           │
 * │ measurement. It is still the only size gate the product has and it is     │
 * │ still worth making — see the box on it.                                   │
 * │                                                                           │
 * │ UNCHANGED AND STILL BINDING: the permission, the allowlist against the    │
 * │ declared type, and every policy in 0048. The signed URL is minted by the  │
 * │ CALLER'S client, so source_documents_storage_insert — has_perm            │
 * │ ('questions.import') AND (storage.foldername(name))[1] = my_company() —   │
 * │ is evaluated at sign time against the caller's own JWT. A user who may    │
 * │ not upload cannot obtain a ticket, and a ticket is good for one path this │
 * │ server chose inside that user's own company folder.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE USER'S CLIENT, AND ONLY THE USER'S CLIENT.                            │
 * │                                                                           │
 * │ 0048 is SECURITY INVOKER end to end, and that holds for the                │
 * │ bucket as well as the tables. createClient() is therefore the whole       │
 * │ authorisation story, for the ticket and for the rows, and there is no     │
 * │ service-role path to reach for when something below is refused — a        │
 * │ refusal here means the caller may not do it. A service-role client would  │
 * │ also be the wrong tool mechanically: it carries no `app` claims, so       │
 * │ my_company() would be NULL inside the storage policy it is trying to      │
 * │ satisfy.                                                                  │
 * │                                                                           │
 * │ companyId comes from the VERIFIED claims requirePermission returns, never │
 * │ from the input. The storage path is built from it HERE and never accepted │
 * │ from the browser: the signed token authorises one exact path with no      │
 * │ further policy check at PUT time, so whoever chooses the path chooses     │
 * │ where the object lands. A client-chosen path would still be refused       │
 * │ across companies at sign time, but inside its own company it could aim at │
 * │ a sibling document.                                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * 0048's bucket. Private; every read of it is a signed URL.
 *
 * Aliased from the shared constant rather than re-typed: the browser addresses
 * the same bucket when it PUTs, and the two must not be able to disagree.
 */
const BUCKET = SOURCE_DOCUMENTS_BUCKET

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What step 1 needs, on top of the metadata a person typed.
 *
 * Built by extending uploadSchema rather than re-spelling it: `kind`, `title`,
 * `description`, `brandId` and `supersedesId` keep one definition, so a rule
 * added there — the .max(300) on the title, dbId() on the brand — reaches this
 * path without a second edit. The four fields below are the ones that used to
 * be read off the File object and now have to be asserted by the caller.
 *
 * `sha256` accepts either case and is lowercased before it reaches the insert:
 * 0048 has `check (sha256 ~ '^[0-9a-f]{64}$')`, so an uppercase digest — which
 * is what several hashing helpers produce — would otherwise be a bare 23514
 * from a column nobody was thinking about.
 */
const ticketSchema = uploadSchema.extend({
  filename: z.string().trim().min(1, 'That file has no name.').max(300),
  byteSize: z.number().int().min(0, 'That file has no size.'),
  declaredMimeType: z.string().trim().min(1, 'That file has no recognisable type.'),
  sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'That file could not be fingerprinted. Try again.'),
})

export type CreateUploadTicketInput = z.infer<typeof ticketSchema>

// ─────────────────────────────────────────────────────────────────────────────
// The results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A DUPLICATE IS INFORMATION, NOT AN ERROR.                                 │
 * │                                                                           │
 * │ "You already uploaded this in March; here it is" is a useful answer, and  │
 * │ the person who gets it usually wanted the existing document rather than a │
 * │ second copy of it. Flattening it into `{ ok: false, error: string }` —    │
 * │ the shape every other mutation in this codebase uses — would leave the UI │
 * │ nothing to name and reduce that answer to red text.                       │
 * │                                                                           │
 * │ So the failures are discriminated by `reason` and the duplicate carries   │
 * │ the existing document's id and title. `failed` is the only reason that    │
 * │ means "this did not work and it is not your fault"; the other two are     │
 * │ recoverable by doing something different.                                 │
 * │                                                                           │
 * │ Shared between both steps so the dialog holds ONE piece of failure state  │
 * │ across a three-call sequence. 'duplicate' can only come from step 1 and   │
 * │ 'too-large' likewise, but a union that changed shape halfway through the  │
 * │ flow would be two render paths for one message.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export type UploadFailure =
  | { ok: false; reason: 'duplicate'; existingId: string; existingTitle: string }
  | { ok: false; reason: 'too-large' | 'unsupported-type' | 'failed'; message: string }

/** Step 1: the row exists and this is permission to write its bytes, once. */
export type CreateUploadTicketResult =
  | {
      ok: true
      documentId: string
      /** The object key the token authorises. Pass it back verbatim. */
      path: string
      /** For supabase.storage.from(...).uploadToSignedUrl(path, token, file). */
      token: string
      /** The same grant as a plain URL, for a PUT with progress events. */
      signedUrl: string
    }
  | UploadFailure

/** Step 2: the bytes are really there and the pipeline has been told. */
export type FinaliseUploadResult = { ok: true; documentId: string } | UploadFailure

/** Every message the UI can be handed is written here, in one place, in one voice. */
function fail(
  reason: 'too-large' | 'unsupported-type' | 'failed',
  message: string,
): UploadFailure {
  return { ok: false, reason, message }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — the ticket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reserve a document and hand back permission to upload its bytes.
 *
 * A plain object rather than FormData, because there is no file in it any more.
 * Every field is a claim by the client and is treated as one.
 */
export async function createUploadTicket(
  input: CreateUploadTicketInput,
): Promise<CreateUploadTicketResult> {
  // 1. Authorisation, first. The claims come back so the company and the
  //    uploader are known without a second round trip — and so they come from a
  //    verified token rather than from the input.
  const claims = await requirePermission('questions.import')
  const companyId = claims.company_id
  const userId = claims.userId

  // A Super Admin passes has_perm() on roles alone and can be attached to no
  // company. source_documents_insert would refuse the row anyway; refusing it
  // here says why, instead of surfacing an RLS filter as a mystery.
  if (!companyId || !userId) {
    return fail(
      'failed',
      'Your account is not attached to a company, so there is nowhere to file this document.',
    )
  }

  // 2. The metadata.
  const parsed = ticketSchema.safeParse(input)
  if (!parsed.success) {
    // The first issue, not all of them: this result has one message slot, and a
    // form with five fields shows the rest as it is corrected.
    return fail('failed', parsed.error.issues[0]?.message ?? 'Check the document details.')
  }
  const details = parsed.data

  // Lowercase for `check (sha256 ~ '^[0-9a-f]{64}$')`. See ticketSchema.
  const sha256 = details.sha256.toLowerCase()

  /*
   * ╔═════════════════════════════════════════════════════════════════════════╗
   * ║ 3. THE ONLY SIZE GATE LEFT, AND IT IS CHECKING A NUMBER THE BROWSER     ║
   * ║    TYPED IN.                                                            ║
   * ║                                                                         ║
   * ║ byteSize used to be file.size, read off a File this process was holding.║
   * ║ It is now a field in a JSON body, and a caller who wants to defeat this ║
   * ║ line only has to send a smaller number. THE BROWSER CANNOT BE TRUSTED   ║
   * ║ AND THIS CHECK KNOWS IT.                                                ║
   * ║                                                                         ║
   * ║ It stays because it is the only gate that exists. Storage does not      ║
   * ║ enforce a per-object limit from here, the signed token carries no size, ║
   * ║ and 0048's policies say nothing about bytes. So this catches the honest ║
   * ║ case — somebody picked a 400 MB scan — before a row is made and before  ║
   * ║ minutes of a kitchen's connection are spent, and it catches nothing     ║
   * ║ else. A REAL ceiling is a bucket-level file size limit configured on    ║
   * ║ 'source-documents', which is a Storage setting and not a line of        ║
   * ║ TypeScript; until that exists, this is what the product has and this    ║
   * ║ paragraph is what it is worth.                                          ║
   * ║                                                                         ║
   * ║ Zero is refused separately because byte_size has `check (byte_size > 0)`║
   * ║ and a bare 23514 reads as a database fault rather than "that file is    ║
   * ║ empty". Size before empty, matching the order the old action used.      ║
   * ╚═════════════════════════════════════════════════════════════════════════╝
   */
  if (details.byteSize > MAX_UPLOAD_BYTES) {
    const limitMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))
    return fail(
      'too-large',
      `That file is larger than ${limitMb} MB. Split it, or ask for it to be loaded another way.`,
    )
  }
  if (details.byteSize === 0) {
    return fail('failed', 'That file is empty.')
  }

  /*
   * 4. The allowlist, against the declared type.
   *
   * This is the check that survived the move intact, and it is binding: the
   * value below is what goes into mime_type and what every later signed URL
   * serves the object as. What did NOT survive is the comparison against the
   * magic number — there are no bytes in this request to compare against. The
   * dialog sniffs before it sends; that is a courtesy and cannot be more.
   *
   * text/csv is on the list and is no longer special-cased here. It used to be
   * refused with a bespoke sentence because mimeTypeAgrees('text/csv', null)
   * was false for every CSV ever written; that was fixed where it belonged, in
   * src/lib/imports/source-documents.ts, by saying which formats have a magic
   * number at all instead of demanding one from a format that cannot have it.
   */
  const declared = details.declaredMimeType
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(declared)) {
    return fail(
      'unsupported-type',
      'That kind of file cannot be uploaded here. PDFs, Word, Excel and PowerPoint files, CSVs, and JPEG or PNG images are accepted.',
    )
  }

  const supabase = await createClient()

  /*
   * ╔═════════════════════════════════════════════════════════════════════════╗
   * ║ 5. DEDUPE BEFORE ANYTHING MOVES — AND NOW IT REALLY IS BEFORE.          ║
   * ║                                                                         ║
   * ║ The old action could not ask this question until it had received and    ║
   * ║ hashed the whole file: 92 MB up a kitchen's connection, minutes of      ║
   * ║ somebody's shift, to be told the document was already uploaded in       ║
   * ║ March. The insert was ordered before the bucket write to make the       ║
   * ║ 23505 arrive as early as possible, but "as early as possible" was still ║
   * ║ after every byte had been sent.                                         ║
   * ║                                                                         ║
   * ║ The browser hashes locally now, so a repeat costs a few hundred bytes   ║
   * ║ and a single SELECT. This is the one respect in which the new design is ║
   * ║ strictly better rather than a trade: the answer arrives before the      ║
   * ║ upload starts, not after it finishes.                                   ║
   * ║                                                                         ║
   * ║ RLS scopes the lookup to the company, which is why there is no          ║
   * ║ .eq('company_id') — the same rule listSourceDocuments declines to       ║
   * ║ re-implement. No .is('deleted_at', null) either: source_documents_read_ ║
   * ║ deleted keys on questions.import, which this caller holds, so a         ║
   * ║ document in the recycle bin is found too. That is the right answer —    ║
   * ║ source_documents_sha_per_company counts it, so the upload really is     ║
   * ║ blocked by it, and "it is in the bin" is something a person can act on. ║
   * ║                                                                         ║
   * ║ AND IT IS A CONVENIENCE. The hash came from the browser. See the box at ║
   * ║ the top of this file: a wrong hash refuses a new file or admits a       ║
   * ║ second copy, and neither is a boundary anything relies on.              ║
   * ╚═════════════════════════════════════════════════════════════════════════╝
   */
  const { data: existing, error: lookupError } = await supabase
    .from('source_documents')
    .select('id, title, original_filename')
    .eq('sha256', sha256)
    .limit(1)
    .maybeSingle()

  if (lookupError) {
    return fail(
      'failed',
      'Could not check whether this document is already in the library. Try again.',
    )
  }
  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      existingId: existing.id,
      // title is nullable in SQL even though uploadSchema requires one — rows
      // predating that rule exist, and the filename is what the person will
      // recognise anyway.
      existingTitle: existing.title ?? existing.original_filename,
    }
  }

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ 6. THE ID IS MINTED HERE, NOT BY gen_random_uuid().                     │
   * │                                                                         │
   * │ storage_path is `not null unique` and it contains the document id, so   │
   * │ the path cannot be built from a default the database has not generated  │
   * │ yet — and the signed URL has to be for a path that is already decided.  │
   * │ One uuid, generated before either, used by both.                        │
   * │                                                                         │
   * │ storagePathFor puts the company first because 0048's storage policies   │
   * │ authorise on (storage.foldername(name))[1] alone, and it sanitises the  │
   * │ filename because that segment reaches a path. Neither is re-implemented │
   * │ here; a second copy of the path convention is a second thing that can   │
   * │ disagree with the policy. It matters more than it did: the token issued │
   * │ below authorises this exact string with no further check at PUT time.   │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const documentId = randomUUID()
  const storagePath = storagePathFor(companyId, documentId, details.filename)

  // original_filename is `check (length(btrim(...)) between 1 and 300)`. The
  // schema already trimmed and bounded it; the fallback mirrors the one
  // storagePathFor uses, so the row and the object agree about what this file
  // is called even when nothing of the name survives sanitising.
  const originalFilename = details.filename.slice(0, 300) || 'document'

  /*
   * ╔═════════════════════════════════════════════════════════════════════════╗
   * ║ 7. THE ROW GOES IN BEFORE THE TICKET IS ISSUED.                         ║
   * ║                                                                         ║
   * ║ Same ordering as before and the same reason, restated for a flow where  ║
   * ║ this server no longer touches the bytes: a row with no bytes can be     ║
   * ║ unwound (step 8) and is at worst a document that shows as failed. Bytes ║
   * ║ with no row cannot be removed AT ALL — 0048 grants no DELETE policy on  ║
   * ║ storage.objects, so .remove() from the user's client is filtered to     ║
   * ║ nothing and the object sits in the bucket forever, invisible, counted   ║
   * ║ against the quota, referenced by nothing.                               ║
   * ║                                                                         ║
   * ║ status is 'uploaded', written out rather than left to the column        ║
   * ║ default. It is the truth for the whole window this ticket is open: the  ║
   * ║ row exists, nothing has arrived yet, and nothing is processing.         ║
   * ║ finaliseUpload owns the move to 'processing'.                           ║
   * ║                                                                         ║
   * ║ page_count is null and NEVER 0 — `check (page_count > 0)`. It is        ║
   * ║ genuinely unknown until something opens the file, and null is how a     ║
   * ║ column says that.                                                       ║
   * ╚═════════════════════════════════════════════════════════════════════════╝
   */
  const { error: insertError } = await supabase.from('source_documents').insert({
    id: documentId,
    company_id: companyId,
    brand_id: details.brandId ?? null,
    kind: details.kind,
    original_filename: originalFilename,
    storage_path: storagePath,
    mime_type: declared,
    byte_size: details.byteSize,
    // A client claim. Never read it as proof of content — see the box at the
    // top of this file. It is here because 0048 makes the column NOT NULL and
    // because a fingerprint offered in good faith is still useful for telling
    // somebody they have already uploaded this.
    sha256,
    page_count: null,
    supersedes_id: details.supersedesId ?? null,
    title: details.title,
    description: details.description ?? null,
    // Not a form field: source_documents_insert requires uploaded_by =
    // auth.uid(), so an upload cannot be attributed to somebody who did not
    // make it.
    uploaded_by: userId,
    status: 'uploaded',
  })

  if (insertError) {
    /*
     * The dedupe SELECT above answers this question first in the ordinary case,
     * so a 23505 here means the race: two tabs, the same file, both past the
     * lookup before either inserted. Answered by looking rather than by
     * grepping the error string for a constraint name — a select by sha256
     * returns a row if and only if this company already has this file, and it
     * keeps working when PostgREST rephrases its messages.
     */
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('source_documents')
        .select('id, title, original_filename')
        .eq('sha256', sha256)
        .limit(1)
        .maybeSingle()

      if (raced) {
        return {
          ok: false,
          reason: 'duplicate',
          existingId: raced.id,
          existingTitle: raced.title ?? raced.original_filename,
        }
      }

      // The constraint fired and the row cannot be read: it belongs to another
      // brand in this company, which source_documents_read hides. Reporting it
      // as a duplicate would hand the UI an id it cannot open.
      return fail(
        'failed',
        'This file is already in your company’s library, filed under a brand you cannot see. Ask an administrator to move or share it.',
      )
    }

    return fail('failed', 'Could not save this document. Try again.')
  }

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ 8. THE TICKET.                                                          │
   * │                                                                         │
   * │ Issued on the CALLER'S client, so this call is the authorisation point: │
   * │ Storage evaluates source_documents_storage_insert against the caller's  │
   * │ own JWT — has_perm('questions.import') and the leading folder being     │
   * │ my_company() — and refuses here if either is false. The PUT that        │
   * │ follows needs no policy at all, which is precisely why the path was     │
   * │ chosen by this server and not accepted from the browser.                │
   * │                                                                         │
   * │ No { upsert: true }. Upsert is decided at SIGN time, not at PUT time,   │
   * │ so leaving it off is what stops a replayed or leaked token overwriting  │
   * │ an ingested document. The path contains a uuid minted moments ago, so a │
   * │ collision would mean something is deeply wrong, and overwriting is the  │
   * │ one outcome that could destroy another document's bytes.                │
   * │                                                                         │
   * │ The token is valid for two hours, which is comfortable for 92 MB on a   │
   * │ bad connection and short enough that a ticket abandoned in a closed tab │
   * │ stops meaning anything.                                                 │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const { data: ticket, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath)

  if (signError || !ticket) {
    /*
     * ╔═══════════════════════════════════════════════════════════════════════╗
     * ║ 9. THE ROW MUST NOT SURVIVE A TICKET THAT WAS NEVER ISSUED.           ║
     * ║                                                                       ║
     * ║ A source_documents row whose storage_path points at nothing is worse  ║
     * ║ than no row at all. The library lists it — listSourceDocuments has no ║
     * ║ way to know — a chef clicks it, the signed URL 404s, and the document ║
     * ║ is permanently a broken link that also occupies this file's           ║
     * ║ (company_id, sha256) slot, so re-uploading the SAME file comes back   ║
     * ║ "already uploaded" and points at the broken one. Two failures         ║
     * ║ compounding, from one storage error.                                  ║
     * ║                                                                       ║
     * ║ Nothing is orphaned in the bucket by unwinding here: no token was     ║
     * ║ ever handed out, so no bytes can arrive. This is the direction the    ║
     * ║ ordering was chosen to leave recoverable.                             ║
     * ╚═══════════════════════════════════════════════════════════════════════╝
     */
    const removed = await removeOrphanRow(supabase, documentId)

    revalidatePath('/guide')
    return fail(
      'failed',
      removed
        ? 'The upload could not be started. Nothing was saved — try again.'
        : `The upload could not be started, and the half-made record could not be cleared up. Quote document ${documentId} when reporting this.`,
    )
  }

  /*
   * Deliberately no revalidatePath on the way out.
   *
   * The row exists and the library would show it — at status 'uploaded', with
   * no bytes behind it, for as long as the transfer takes. Re-rendering /guide
   * now would put a document in front of somebody a minute or more before it
   * is real. finaliseUpload revalidates once the object is confirmed, and the
   * failure paths revalidate because they leave a tombstone worth seeing.
   */
  return {
    ok: true,
    documentId,
    path: storagePath,
    token: ticket.token,
    signedUrl: ticket.signedUrl,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — the finalise
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirm the bytes landed, and mark the document usable.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE THING THIS STEP EXISTS TO PREVENT: A ROW POINTING AT ABSENT       │
 * │ BYTES.                                                                    │
 * │                                                                           │
 * │ The browser can close the tab mid-PUT, lose the connection, or simply     │
 * │ never call this at all. Every one of those leaves a source_documents row  │
 * │ at 'uploaded' with nothing behind it, and the library must not show that  │
 * │ as a finished document: an Editor clicks it looking for a page to cite,   │
 * │ the signed URL 404s, and the only conclusion available to them is that    │
 * │ the library is broken.                                                    │
 * │                                                                           │
 * │ So the existence check is not a formality, and it is the only thing       │
 * │ standing between an abandoned transfer and a permanently broken link.     │
 * │ HEAD on the object is the cheapest question that has a real answer.       │
 * │                                                                           │
 * │ No claims are read below. Step 1 needed company_id to build the storage   │
 * │ path and user_id to satisfy `uploaded_by = auth.uid()`; this step writes  │
 * │ neither, and RLS already scopes the row lookup to the caller. A guard     │
 * │ re-deriving them here would check a condition nothing downstream uses.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function finaliseUpload(documentId: string): Promise<FinaliseUploadResult> {
  await requirePermission('questions.import')

  // dbId(), not z.uuid(): this id came out of a uuid column and went through a
  // browser. See src/lib/db/id.ts for what Zod 4's stricter .uuid() cost the
  // last time a value like this was parsed with it.
  const id = dbId().safeParse(documentId)
  if (!id.success) {
    return fail('failed', 'That document could not be found.')
  }

  const supabase = await createClient()

  // RLS scopes this to the caller's company and brand; a document belonging to
  // anybody else simply is not here, which is the same answer as "not found"
  // and the only one worth giving.
  const { data: row, error: rowError } = await supabase
    .from('source_documents')
    .select('id, storage_path, status')
    .eq('id', id.data)
    .maybeSingle()

  if (rowError || !row) {
    return fail(
      'failed',
      'That document could not be found. It may have been removed while the file was uploading.',
    )
  }

  /*
   * Only a row that is still waiting for its bytes may be queued.
   *
   * A double-click, a retried request or a second tab would otherwise open a
   * second import_batch and enqueue a second ocr_page job for the same
   * document, and the worker would read the whole thing twice. This is a guard
   * and NOT a lock — two calls that both read 'uploaded' before either wrote
   * would still both proceed — so if concurrent finalises ever become ordinary
   * the answer is a conditional update (.eq('status','uploaded') on the write,
   * with a count check), not a longer comment here.
   */
  if (row.status !== 'uploaded') {
    // Deliberately not four sentences for four statuses. source_documents_read_
    // deleted shows this caller the recycle bin too, so `row` may be a tombstone
    // at 'failed' from an abandoned attempt as easily as a document already
    // processing — and the useful half of the answer is the same either way.
    return fail(
      'failed',
      'That document is not waiting for a file — it has already been sent for reading, or the attempt was cleared up. Check the library rather than uploading it again.',
    )
  }

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ ABSENT AND "COULD NOT TELL" ARE DIFFERENT ANSWERS, AND CONFLATING THEM  │
   * │ DESTROYS DATA.                                                          │
   * │                                                                         │
   * │ Tombstoning on 'absent' is right: the row is a lie and there are no     │
   * │ bytes to strand. Tombstoning on 'unknown' — a timeout, a 5xx, a network │
   * │ blip — would mark a document failed whose file IS in the bucket, and    │
   * │ 0048 grants no DELETE on storage.objects, so those bytes could never be │
   * │ removed by anyone. That is the one irreversible mistake available here. │
   * │                                                                         │
   * │ So 'unknown' leaves the row exactly as it is, at 'uploaded', and says   │
   * │ try again — the retry is free and the guard above still admits it.      │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const present = await objectPresence(supabase, row.storage_path)

  if (present === 'unknown') {
    return fail(
      'failed',
      'The file could not be confirmed just now. Nothing has been lost — try finishing the upload again in a moment.',
    )
  }

  if (present === 'absent') {
    // The same unwind step 1 uses, for the same reason and with the same
    // count-checked fallback: a delete that RLS will filter to nothing,
    // followed by deleted_at + status 'failed', which is 0048's real removal.
    const removed = await removeOrphanRow(supabase, id.data)

    revalidatePath('/guide')
    return fail(
      'failed',
      removed
        ? 'The file did not finish uploading, so nothing was saved. Try again.'
        : `The file did not finish uploading, and the half-made record could not be cleared up. Quote document ${id.data} when reporting this.`,
    )
  }

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ 'processed' — THE END OF THE ROAD, NOT A HANDOVER.                      │
   * │                                                                         │
   * │ This line used to open an import_batch, enqueue an ocr_page job and     │
   * │ write 'processing', because something was going to read the file        │
   * │ afterwards. Nothing is, now. A reference document is finished the       │
   * │ moment its bytes are confirmed: an Editor opens it, finds a page, and   │
   * │ cites it on a question. There is no later stage for a status to be      │
   * │ waiting on.                                                             │
   * │                                                                         │
   * │ So the three surviving statuses mean:                                   │
   * │   uploaded  — a ticket was issued and the bytes have not arrived yet    │
   * │   processed — the bytes are confirmed and the document is usable        │
   * │   failed    — the attempt was abandoned; removeOrphanRow's tombstone    │
   * │                                                                         │
   * │ 'processing' is now unreachable, and deliberately not dropped from      │
   * │ 0048's CHECK: rows written before this change still carry it, and a     │
   * │ constraint that retroactively invalidates existing data is a migration  │
   * │ that fails on deploy rather than a tidier vocabulary.                   │
   * │                                                                         │
   * │ Counted, because RLS refuses by filtering: a status update the policies │
   * │ do not admit returns error: null having changed nothing.                │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const { error: statusError, count: moved } = await supabase
    .from('source_documents')
    .update({ status: 'processed' }, { count: 'exact' })
    .eq('id', id.data)

  if (statusError || moved !== 1) {
    /*
     * The bytes ARE in the bucket — objectPresence said so a moment ago — so
     * this is a wrong label on a document that is otherwise complete, not a
     * failed upload. Saying "try again" would send somebody to re-upload a
     * file that is already there and get "already in the library" back.
     */
    revalidatePath('/guide')
    return fail(
      'failed',
      `The file was stored, but the library may still show it as waiting. Nothing is lost and nothing needs re-uploading. Quote document ${id.data} if it stays that way.`,
    )
  }

  // The library is a server-rendered list and it now has one more row in it.
  revalidatePath('/guide')

  return { ok: true, documentId: id.data }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is the object really at that path?
 *
 * Three answers, not two — see the box in finaliseUpload for why conflating
 * the last two would be the one irreversible mistake in this file.
 *
 * storage-js's .exists() is a HEAD that returns { data: false } for 400 and 404
 * and THROWS for anything else, so the try/catch is load-bearing rather than
 * defensive decoration. A 404 is a genuine absence; a 400 is Storage's answer
 * when the object is not visible to this caller, which for the roles that hold
 * questions.import (chef, and super_admin who short-circuits has_perm) is the
 * same thing — source_documents_storage_read keys on questions.read, and chef
 * holds both. Anything else — a timeout, a 5xx — is 'unknown' and is treated as
 * one.
 */
async function objectPresence(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string,
): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const { data } = await supabase.storage.from(BUCKET).exists(path)
    return data === true ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}

/**
 * Unwind a row whose bytes are not there and never will be.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE COUNT IS THE POINT, FOR THE FOURTH TIME IN THIS CODEBASE.             ║
 * ║                                                                           ║
 * ║ RLS REFUSES BY FILTERING, NOT BY ERRORING. A delete the policies do not   ║
 * ║ admit returns `error: null` and removes nothing, and code that checks     ║
 * ║ only `error` reports a clean rollback that never happened. deleteQuestion ║
 * ║ (3b52dcc) and deleteExam (0049) were both bitten by exactly this, and     ║
 * ║ tests/integration/soft-delete.test.ts exists because of the third time.   ║
 * ║                                                                           ║
 * ║ Here it is not even a maybe: 0048 grants NO DELETE POLICY on              ║
 * ║ public.source_documents at all — "No DELETE policy anywhere, exactly as   ║
 * ║ public.questions has none" — so the delete below is filtered to zero rows ║
 * ║ every single time, silently. It is still attempted, and still counted,    ║
 * ║ because the count is what tells the truth about it: on the day a DELETE   ║
 * ║ policy is added this starts working and nothing here needs changing, and  ║
 * ║ until then the fallback is what actually runs. NO DELETE POLICY IS BEING  ║
 * ║ ADDED FOR THIS; the behaviour is kept exactly as it was.                  ║
 * ║                                                                           ║
 * ║ The fallback is 0048's real removal: deleted_at, plus status 'failed' so  ║
 * ║ the recycle bin says what happened rather than showing a document that    ║
 * ║ looks fine and cannot be opened. source_documents_update admits it —      ║
 * ║ questions.import, same company, deleted_at currently null — and it is     ║
 * ║ counted for the same reason the delete is.                                ║
 * ║                                                                           ║
 * ║ THE TOMBSTONE KEEPS THE (company_id, sha256) SLOT. Re-uploading the same  ║
 * ║ file therefore comes back 'duplicate' pointing at it, and with dedupe now ║
 * ║ running FIRST that answer arrives before any bytes move — so an abandoned ║
 * ║ upload can wedge the second attempt at a document nobody can see in the   ║
 * ║ list. That is why the duplicate lookup deliberately finds deleted rows    ║
 * ║ and why the dialog's copy points at the recycle bin: restoring the        ║
 * ║ tombstone, or purging it, is the bin's job, and the person has to be told ║
 * ║ it is there rather than left arguing with "you already uploaded this".    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
async function removeOrphanRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  documentId: string,
): Promise<boolean> {
  const { error: deleteError, count: deleted } = await supabase
    .from('source_documents')
    .delete({ count: 'exact' })
    .eq('id', documentId)

  if (!deleteError && deleted === 1) return true

  const { error: softError, count: tombstoned } = await supabase
    .from('source_documents')
    .update({ deleted_at: new Date().toISOString(), status: 'failed' }, { count: 'exact' })
    .eq('id', documentId)

  return !softError && tombstoned === 1
}
