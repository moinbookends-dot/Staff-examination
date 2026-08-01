import { z } from 'zod'

/**
 * Shapes and limits for uploading a source document.
 *
 * Outside the 'use server' module for the usual mechanical reason — such a file
 * may export only async functions — and so the upload form can reject a file
 * before spending several minutes pushing 92 MB at a bucket that will refuse it.
 */

export const SOURCE_DOCUMENT_KINDS = [
  'cookbook',
  'sop',
  'manual',
  'policy',
  'vendor',
  'other',
] as const
export type SourceDocumentKind = (typeof SOURCE_DOCUMENT_KINDS)[number]

/**
 * What may be uploaded.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AN ALLOWLIST, AND IT IS CHECKED AGAINST THE BYTES AS WELL AS THE NAME.    │
 * │                                                                           │
 * │ A browser-supplied MIME type is a claim by the client, and the extension  │
 * │ is a claim by whoever named the file. Neither is evidence. The magic      │
 * │ number is the only thing in an upload that the uploader cannot casually   │
 * │ lie about, so sniffMimeType below reads the first bytes and the action    │
 * │ compares the two.                                                         │
 * │                                                                           │
 * │ This is not virus scanning and does not pretend to be. It stops the       │
 * │ ordinary mistake — a .docx renamed to .pdf, an image saved with the wrong │
 * │ extension — reaching a 113-page OCR pipeline that would fail confusingly  │
 * │ at page one.                                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'image/jpeg',
  'image/png',
] as const

/**
 * 150 MB. The larger cookbook provided is 92 MB, so the ceiling has to clear
 * that with room for a bigger one; beyond this an upload stops being something
 * a chef does from a phone in a kitchen and needs a different mechanism.
 */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024

export const uploadSchema = z.object({
  kind: z.enum(SOURCE_DOCUMENT_KINDS),
  title: z.string().trim().min(1, 'Give the document a title.').max(300),
  description: z.string().trim().max(2000).optional(),
  brandId: z.string().uuid().nullable().optional(),
  /** Replacing an earlier version. The old row is kept and pointed at. */
  supersedesId: z.string().uuid().nullable().optional(),
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
  // ZIP container — docx and xlsx are both ZIPs, and telling them apart needs
  // the central directory. The caller reconciles this with the declared type,
  // which is safe because both are on the allowlist.
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'

  return null
}

/**
 * Is the sniffed type consistent with what the client declared?
 *
 * ZIP is accepted for either Office format because the signature cannot
 * distinguish them, and both are allowed. Anything else must match exactly.
 */
export function mimeTypeAgrees(declared: string, sniffed: string | null): boolean {
  if (sniffed === null) return false
  if (sniffed === declared) return true
  return (
    sniffed === 'application/zip' &&
    (declared ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      declared === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  )
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
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
