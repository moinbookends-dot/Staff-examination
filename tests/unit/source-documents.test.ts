import { describe, it, expect } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
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
  it('accepts a PDF that really is a PDF', () => {
    expect(mimeTypeAgrees('application/pdf', 'application/pdf')).toBe(true)
  })

  /**
   * The case this exists for: a browser will happily report application/pdf for
   * a file somebody renamed, and the extension is whatever the uploader typed.
   * The magic number is the only part of an upload that is evidence.
   */
  it('refuses a file whose bytes disagree with its declared type', () => {
    expect(mimeTypeAgrees('application/pdf', 'image/jpeg')).toBe(false)
    expect(mimeTypeAgrees('application/pdf', null)).toBe(false)
  })

  it('allows either Office format for a ZIP container', () => {
    // docx and xlsx are both ZIPs and the signature cannot separate them. Safe
    // because both are on the allowlist; a ZIP claiming to be a PDF is not.
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    expect(mimeTypeAgrees(docx, 'application/zip')).toBe(true)
    expect(mimeTypeAgrees(xlsx, 'application/zip')).toBe(true)
    expect(mimeTypeAgrees('application/pdf', 'application/zip')).toBe(false)
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

  it('leaves room for the cookbooks that exist', () => {
    // The larger provided cookbook is 92 MB. A ceiling below it would make the
    // feature untestable against the only real documents there are.
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(92 * 1024 * 1024)
  })
})
