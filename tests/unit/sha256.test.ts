import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Sha256, sha256Bytes, sha256File, HASH_CHUNK_BYTES } from '@/lib/crypto/sha256'

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY THING BETWEEN A TYPO AND A COLUMN OF WRONG FINGERPRINTS.         │
 * │                                                                           │
 * │ src/lib/crypto/sha256.ts is hand-written because WebCrypto's digest is    │
 * │ one-shot and the upload dialog needs a chunked one — see the box at the   │
 * │ top of that file. Hand-written cryptographic code that is subtly wrong    │
 * │ does not crash: it returns a plausible 64-character hex string that is    │
 * │ not the file's SHA-256, source_documents.sha256 fills up with values that │
 * │ match nobody, and dedupe silently stops answering "you already uploaded   │
 * │ this" for the rest of the product's life. Nothing else in the system      │
 * │ would notice.                                                             │
 * │                                                                           │
 * │ node:crypto is the oracle. Every assertion below is against it and none   │
 * │ is against a digest written out by hand, so a wrong expected value cannot │
 * │ be copied in alongside a wrong implementation.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

function reference(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('Sha256', () => {
  /**
   * The lengths where padding changes shape. 55/56 is the boundary at which the
   * 0x80 and the 8-byte length stop fitting in the same block, and 119/120 is
   * the same boundary one block later — the two places an off-by-one in pad()
   * hides, and the two places every other length would pass over.
   */
  it.each([0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 1000])(
    'agrees with node:crypto for a %i-byte message',
    (length) => {
      const bytes = randomBytes(length)
      expect(sha256Bytes(bytes)).toBe(reference(bytes))
    },
  )

  it('is unaffected by where the updates are split', () => {
    const bytes = randomBytes(5000)
    const expected = reference(bytes)

    // Splits that deliberately do NOT line up with the 64-byte block: the
    // partial-block carry in update() is the only code that runs here, and a
    // chunk-aligned test would never execute it.
    for (const size of [1, 7, 13, 63, 64, 65, 100, 999, 4096]) {
      const digest = new Sha256()
      for (let offset = 0; offset < bytes.length; offset += size) {
        digest.update(bytes.subarray(offset, Math.min(offset + size, bytes.length)))
      }
      expect(digest.hex(), `split into ${size}-byte updates`).toBe(expected)
    }
  })

  it('accepts a zero-length update without disturbing the digest', () => {
    const bytes = randomBytes(200)
    const digest = new Sha256()
    digest.update(new Uint8Array(0))
    digest.update(bytes.subarray(0, 100))
    digest.update(new Uint8Array(0))
    digest.update(bytes.subarray(100))
    expect(digest.hex()).toBe(reference(bytes))
  })

  it('produces 64 lowercase hex characters, because the column demands it', () => {
    // 0048: check (sha256 ~ '^[0-9a-f]{64}$'). An uppercase digest is a 23514.
    expect(sha256Bytes(randomBytes(300))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to be updated after it has been read', () => {
    const digest = new Sha256().update(randomBytes(10))
    digest.hex()
    expect(() => digest.update(randomBytes(10))).toThrow(/already closed/)
  })

  it('is stable when read twice', () => {
    const digest = new Sha256().update(randomBytes(70))
    expect(digest.hex()).toBe(digest.hex())
  })
})

describe('sha256File', () => {
  it('agrees with node:crypto across several chunk reads', async () => {
    const bytes = randomBytes(300_000)
    const blob = new Blob([bytes])
    // A small chunk so the loop really runs many times without allocating
    // megabytes in a unit test.
    expect(await sha256File(blob, { chunkBytes: 4096 })).toBe(reference(bytes))
  })

  it('agrees when the file is smaller than one chunk', async () => {
    const bytes = randomBytes(100)
    expect(await sha256File(new Blob([bytes]))).toBe(reference(bytes))
  })

  it('hashes an empty blob rather than returning nothing', async () => {
    expect(await sha256File(new Blob([]))).toBe(reference(new Uint8Array(0)))
  })

  it('reports progress from 0 to exactly 1', async () => {
    const seen: number[] = []
    await sha256File(new Blob([randomBytes(10_000)]), {
      chunkBytes: 1024,
      onProgress: (f) => seen.push(f),
    })

    expect(seen.length).toBeGreaterThan(1)
    expect(Math.min(...seen)).toBeGreaterThan(0)
    // Exactly 1 on the last chunk, so a caller can drive a bar straight off it
    // without special-casing the end.
    expect(seen.at(-1)).toBe(1)
    // Monotonic, or a progress bar goes backwards.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })

  it('returns null rather than throwing when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await sha256File(new Blob([randomBytes(5000)]), { signal: controller.signal })).toBeNull()
  })

  it('returns null when the signal is aborted part-way through', async () => {
    const controller = new AbortController()
    const result = await sha256File(new Blob([randomBytes(10_000)]), {
      chunkBytes: 1024,
      signal: controller.signal,
      onProgress: (f) => {
        if (f > 0.2) controller.abort()
      },
    })
    expect(result).toBeNull()
  })

  it('reads two megabytes at a time by default', () => {
    // The dialog's progress granularity is a function of this: a 92 MB cookbook
    // reports ~46 times. Asserted so a change to it is a change somebody made.
    expect(HASH_CHUNK_BYTES).toBe(2 * 1024 * 1024)
  })
})
