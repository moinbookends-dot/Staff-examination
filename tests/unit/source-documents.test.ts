import { describe, it, expect } from 'vitest'
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  SNIFFABLE_MIME_TYPES,
  mimeTypeAgrees,
  sniffMimeType,
  storagePathFor,
  uploadSchema,
} from '../../src/lib/imports/source-documents'

/**
 * Upload validation.
 *
 * The two things worth testing here are both security-adjacent: what the byte
 * sniffing accepts, and where a filename can put an object in the bucket.
 */

const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0])

describe('sniffMimeType', () => {
  it('recognises the formats on the allowlist', () => {
    expect(sniffMimeType(bytes(0x25, 0x50, 0x44, 0x46))).toBe('application/pdf')
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff))).toBe('image/jpeg')
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffMimeType(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('application/zip')
  })

  it('returns null for anything it does not recognise', () => {
    // The control: if this ever returned a type for arbitrary bytes, every
    // assertion about refusing bad uploads would pass while refusing nothing.
    expect(sniffMimeType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull()
    expect(sniffMimeType(new Uint8Array([]))).toBeNull()
    // An HTML file, which is the shape of a phishing page uploaded as a manual.
    expect(sniffMimeType(bytes(0x3c, 0x68, 0x74, 0x6d, 0x6c))).toBeNull()
  })
})

describe('mimeTypeAgrees', () => {
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

  it('accepts a PDF that really is a PDF', () => {
    expect(mimeTypeAgrees('application/pdf', 'application/pdf')).toBe(true)
    expect(mimeTypeAgrees('image/png', 'image/png')).toBe(true)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE POSITIVE CONTROL FOR THE CSV CHANGE.                                │
   * │                                                                         │
   * │ Admitting text/csv without a magic number is only safe if it loosened   │
   * │ NOTHING for the formats that have one. If this test ever goes green in  │
   * │ the other direction, the sniff has stopped being a check at all and     │
   * │ every assertion about refusing renamed files below is decoration.       │
   * │                                                                         │
   * │ The case it exists for: a browser will happily report application/pdf   │
   * │ for a file somebody renamed, and the extension is whatever the uploader │
   * │ typed. The magic number is the only part of an upload that is evidence. │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('still refuses a BINARY file whose bytes disagree with its declared type', () => {
    expect(mimeTypeAgrees('application/pdf', 'image/jpeg')).toBe(false)
    expect(mimeTypeAgrees('image/png', 'image/jpeg')).toBe(false)
    // A .docx renamed to .pdf — the ordinary mistake, and a ZIP is not a PDF.
    expect(mimeTypeAgrees('application/pdf', 'application/zip')).toBe(false)
    // A sniffable format with NO recognisable signature is still refused. Only
    // the unsniffable ones are taken at their word.
    expect(mimeTypeAgrees('application/pdf', null)).toBe(false)
    expect(mimeTypeAgrees(docx, null)).toBe(false)
    expect(mimeTypeAgrees('image/jpeg', null)).toBe(false)
  })

  it('allows any Office format for a ZIP container', () => {
    // docx, xlsx and pptx are all ZIPs and the signature cannot separate them.
    // Safe because all three are on the allowlist; a ZIP claiming to be a PDF
    // is not, which the control above asserts.
    expect(mimeTypeAgrees(docx, 'application/zip')).toBe(true)
    expect(mimeTypeAgrees(xlsx, 'application/zip')).toBe(true)
    expect(mimeTypeAgrees(pptx, 'application/zip')).toBe(true)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ CSV HAS NO MAGIC NUMBER, AND DEMANDING ONE REFUSED EVERY CSV.           │
   * │                                                                         │
   * │ text/csv is on ACCEPTED_MIME_TYPES, sniffMimeType returns null for text,│
   * │ and the old rule was `if (sniffed === null) return false` — so the      │
   * │ allowlist promised something no file could satisfy, and the upload      │
   * │ action carried a bespoke sentence apologising for it.                   │
   * │                                                                         │
   * │ A magic number is evidence where one exists. Where none can exist, the  │
   * │ declared type is all there is, and asking for more refuses valid files  │
   * │ while stopping nobody.                                                  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('accepts a CSV, which cannot have a signature to check', () => {
    expect(mimeTypeAgrees('text/csv', null)).toBe(true)
    expect(SNIFFABLE_MIME_TYPES.has('text/csv')).toBe(false)
  })

  /**
   * The known cost of the rule above, asserted so it is a decision and not a
   * surprise: "is this format sniffable" is answered from the DECLARED type,
   * before the bytes are consulted, so a PDF renamed to .csv is admitted.
   *
   * Bounded, and not a hole anyone needed: the sniff runs in the browser as a
   * courtesy (the server never receives the bytes), so somebody willing to lie
   * would declare application/pdf and send anything at all rather than going
   * looking for this door.
   */
  it('takes an unsniffable declared type at its word even when the bytes say otherwise', () => {
    expect(mimeTypeAgrees('text/csv', 'application/pdf')).toBe(true)
  })

  /**
   * Every sniffable format is on the allowlist, and every allowlisted format
   * that is NOT sniffable is admitted on its name alone. This asserts the
   * relationship rather than the membership, so adding a format to one list
   * and forgetting the other is caught here instead of in a bucket.
   */
  it('only waives the byte check for formats that have no signature', () => {
    for (const declared of SNIFFABLE_MIME_TYPES) {
      expect(ACCEPTED_MIME_TYPES as readonly string[]).toContain(declared)
      // Sniffable means the bytes are consulted, which means null is a refusal.
      expect(mimeTypeAgrees(declared, null), declared).toBe(false)
    }
    const unsniffable = (ACCEPTED_MIME_TYPES as readonly string[]).filter(
      (m) => !SNIFFABLE_MIME_TYPES.has(m),
    )
    expect(unsniffable).toEqual(['text/csv'])
  })

  /**
   * A declared type nobody admits never agrees with anything, even when its
   * bytes match its name perfectly. The action checks the allowlist itself —
   * it needs to say why in its own words — but this function will not bless a
   * type the product does not accept.
   */
  it('refuses a type that is not on the allowlist at all', () => {
    expect(mimeTypeAgrees('text/html', null)).toBe(false)
    expect(mimeTypeAgrees('application/zip', 'application/zip')).toBe(false)
    expect(mimeTypeAgrees('', null)).toBe(false)
  })
})

describe('storagePathFor', () => {
  const COMPANY = '11111111-1111-1111-1111-111111111111'
  const DOC = '22222222-2222-2222-2222-222222222222'

  it('puts the company first, because the storage policy reads that segment', () => {
    const path = storagePathFor(COMPANY, DOC, 'Cookbook.pdf')
    expect(path.split('/')[0]).toBe(COMPANY)
    expect(path).toBe(`${COMPANY}/${DOC}/Cookbook.pdf`)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE ONE THAT MATTERS.                                                   │
   * │                                                                         │
   * │ 0048's storage policies authorise on (storage.foldername(name))[1] —    │
   * │ the leading path segment. A filename containing a slash would create    │
   * │ additional folders, and a crafted one could land an object where the    │
   * │ company check no longer describes it.                                   │
   * │                                                                         │
   * │ Sanitising the filename is what keeps the path exactly three segments   │
   * │ deep, so the segment the policy inspects is always the company.         │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('cannot be talked out of the company folder by a hostile filename', () => {
    for (const hostile of [
      '../../../etc/passwd',
      'a/b/c.pdf',
      '..%2f..%2fx.pdf',
      '/absolute.pdf',
      'x\\y.pdf',
    ]) {
      const path = storagePathFor(COMPANY, DOC, hostile)
      expect(path.split('/'), hostile).toHaveLength(3)
      expect(path.startsWith(`${COMPANY}/${DOC}/`), hostile).toBe(true)
      expect(path, hostile).not.toContain('..')
    }
  })

  it('still produces a usable name when nothing survives sanitising', () => {
    const path = storagePathFor(COMPANY, DOC, '///')
    expect(path).toBe(`${COMPANY}/${DOC}/document`)
  })

  it('keeps the extension and bounds the length', () => {
    expect(storagePathFor(COMPANY, DOC, 'Aiko Kitchen Cookbook.pdf')).toContain(
      'Aiko-Kitchen-Cookbook.pdf',
    )
    const long = storagePathFor(COMPANY, DOC, 'x'.repeat(400) + '.pdf')
    expect(long.split('/')[2].length).toBeLessThanOrEqual(120)
  })
})

describe('uploadSchema', () => {
  it('requires a title and a known kind', () => {
    expect(uploadSchema.safeParse({ kind: 'cookbook', title: 'AIKO' }).success).toBe(true)
    expect(uploadSchema.safeParse({ kind: 'cookbook', title: '   ' }).success).toBe(false)
    expect(uploadSchema.safeParse({ kind: 'recipe-book', title: 'AIKO' }).success).toBe(false)
  })

  /**
   * dbId(), not z.string().uuid(). Zod 4's .uuid() enforces RFC 4122 and every
   * fixed id in supabase/seed.sql has a zero version nibble, so the strict
   * validator rejected ids Postgres stores happily — and the upload action
   * surfaces the first issue as the whole result, which would have failed an
   * entire upload over a brand the form filled in by itself.
   */
  it('accepts the seeded id shapes that come out of uuid columns', () => {
    const seeded = '00000000-0000-0000-0000-00000000c001'
    expect(
      uploadSchema.safeParse({ kind: 'cookbook', title: 'AIKO', brandId: seeded }).success,
    ).toBe(true)
    expect(
      uploadSchema.safeParse({ kind: 'cookbook', title: 'AIKO', supersedesId: seeded }).success,
    ).toBe(true)
    // Still a uuid-shaped thing and not a free string.
    expect(
      uploadSchema.safeParse({ kind: 'cookbook', title: 'AIKO', brandId: 'not-an-id' }).success,
    ).toBe(false)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE CEILING MUST NOT EXCEED WHAT STORAGE WILL ACCEPT.                   │
   * │                                                                         │
   * │ This test used to assert the opposite — that the ceiling cleared the    │
   * │ 92 MB Capiche cookbook — which encoded an assumption that turned out to │
   * │ be false: the bucket sets no file_size_limit, so the Supabase PROJECT   │
   * │ limit applies, and that is 50 MB on the current plan.                   │
   * │                                                                         │
   * │ A ceiling above the real one is a trap, not generosity. The refusal     │
   * │ would arrive at the PUT — after the hash, after the ticket, after       │
   * │ minutes of progress bar — with a row already reserved. Refusing at the  │
   * │ file picker costs nothing.                                             │
   * │                                                                         │
   * │ Asserted as "not more than", not as an exact number, so raising the     │
   * │ plan and the constant together does not require editing this test —     │
   * │ only lowering the real limit below ours would fail it, which is the     │
   * │ direction that actually hurts anyone.                                  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('does not promise more than Supabase Storage will accept', () => {
    const SUPABASE_PROJECT_LIMIT = 50 * 1024 * 1024
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(SUPABASE_PROJECT_LIMIT)
  })

  it('still admits the documents this platform is actually for', () => {
    // The AIKO manual is 28 MB and must fit — a ceiling low enough to exclude
    // an ordinary kitchen manual would make the feature pointless. The Capiche
    // manual at 88 MiB does NOT fit and is expected to be split before upload;
    // that is a product decision recorded on MAX_UPLOAD_BYTES itself.
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(30 * 1024 * 1024)
  })
})
