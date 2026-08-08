/**
 * SHA-256 that can be fed a file a piece at a time.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS EXISTS WHEN EVERY BROWSER SHIPS crypto.subtle.digest.            ║
 * ║                                                                           ║
 * ║ WebCrypto's digest is ONE-SHOT. `crypto.subtle.digest('SHA-256', data)`   ║
 * ║ takes a single BufferSource and there is no incremental form of it — no   ║
 * ║ update(), no DigestStream (that one is Cloudflare Workers only), no       ║
 * ║ proposal that has shipped anywhere. Two things follow, and both of them   ║
 * ║ are requirements the upload dialog cannot meet with it:                   ║
 * ║                                                                           ║
 * ║   1. THE WHOLE FILE HAS TO BE RESIDENT. `await file.arrayBuffer()` on the ║
 * ║      92 MB cookbook this product was sized for is 92 MB of heap in one    ║
 * ║      allocation, in a tab that may be a phone in a kitchen. On a modest   ║
 * ║      laptop that is a spike; on a phone it is the tab dying, and a tab    ║
 * ║      that dies mid-upload looks exactly like the application losing the   ║
 * ║      document.                                                            ║
 * ║   2. THERE IS NO PROGRESS TO SHOW. One call, one promise, no events. The  ║
 * ║      dialog would sit frozen for however long the digest takes, and a     ║
 * ║      frozen dialog reads as a crash — which is the whole reason the       ║
 * ║      upload flow wants a progress figure while it hashes.                 ║
 * ║                                                                           ║
 * ║ So the digest is spelled out here and fed 2 MiB at a time. One chunk is   ║
 * ║ live at once, the caller gets a fraction after every chunk, and the       ║
 * ║ awaits between chunks are real I/O, so the browser paints instead of      ║
 * ║ freezing.                                                                 ║
 * ║                                                                           ║
 * ║ WHAT IT COSTS: this is hand-written cryptographic code, and hand-written  ║
 * ║ cryptographic code that is subtly wrong produces a plausible-looking      ║
 * ║ 64-character hex string that is not the file's SHA-256. Nothing downstream ║
 * ║ would notice — source_documents.sha256 would simply hold a number that    ║
 * ║ never matches anyone else's, and dedupe would quietly stop working. That  ║
 * ║ is why tests/unit/sha256.test.ts checks this implementation against       ║
 * ║ node:crypto over every block-boundary length and over chunk splits that   ║
 * ║ do not line up with the 64-byte block. THAT TEST IS NOT OPTIONAL: it is   ║
 * ║ the only thing standing between a typo in the constant table below and a  ║
 * ║ column full of wrong fingerprints.                                        ║
 * ║                                                                           ║
 * ║ WHAT IT IS NOT FOR: anything that needs to resist an attacker. This is a  ║
 * ║ fingerprint for telling somebody they have already uploaded a file. See   ║
 * ║ the box at the top of src/server/actions/upload-document.ts — the value   ║
 * ║ is a client claim the moment it leaves this machine, and no amount of     ║
 * ║ correctness here changes that.                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

/**
 * FIPS 180-4's K: the first 32 bits of the fractional parts of the cube roots
 * of the first 64 primes. Held as a Uint32Array so every read is already an
 * unsigned 32-bit value and no `>>> 0` is needed at the use site.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const BLOCK_BYTES = 64

/**
 * An incremental SHA-256.
 *
 * Feed it with `update()` as many times as you like, in pieces of any size, and
 * ask for `hex()` once. It is single-use: after `hex()` the state has been
 * padded and there is nothing sensible left to add, so `update()` throws rather
 * than silently returning a digest of something nobody asked for.
 */
export class Sha256 {
  private readonly h = new Uint32Array(H0)
  /** The bytes that did not fill a whole 64-byte block last time. */
  private readonly partial = new Uint8Array(BLOCK_BYTES)
  private partialLength = 0
  /** Total bytes consumed. Only used to write the length suffix at the end. */
  private totalBytes = 0
  /** The message schedule, allocated once rather than per block. */
  private readonly w = new Uint32Array(64)
  private finished = false

  update(bytes: Uint8Array): this {
    if (this.finished) {
      throw new Error('Sha256.update() after hex(): this digest is already closed.')
    }
    this.totalBytes += bytes.length

    let offset = 0

    // Top up a partial block from the previous call first, so the block-aligned
    // fast path below can read straight out of the caller's buffer.
    if (this.partialLength > 0) {
      const take = Math.min(BLOCK_BYTES - this.partialLength, bytes.length)
      this.partial.set(bytes.subarray(0, take), this.partialLength)
      this.partialLength += take
      offset = take
      if (this.partialLength === BLOCK_BYTES) {
        this.compress(this.partial, 0)
        this.partialLength = 0
      }
    }

    // Whole blocks, with no copying at all.
    while (bytes.length - offset >= BLOCK_BYTES) {
      this.compress(bytes, offset)
      offset += BLOCK_BYTES
    }

    // Whatever is left over waits for the next update() or for the padding.
    if (offset < bytes.length) {
      this.partial.set(bytes.subarray(offset), 0)
      this.partialLength = bytes.length - offset
    }

    return this
  }

  /**
   * The digest, as 64 lowercase hex characters.
   *
   * Lowercase is not cosmetic: 0048 has `check (sha256 ~ '^[0-9a-f]{64}$')`, so
   * an uppercase digest anywhere near this value is a 23514 from a column
   * nobody was thinking about.
   */
  hex(): string {
    if (!this.finished) this.pad()
    let out = ''
    for (let i = 0; i < 8; i += 1) out += this.h[i].toString(16).padStart(8, '0')
    return out
  }

  /**
   * The 0x80 byte, zeros, and the message length in bits as a big-endian 64-bit
   * number — in one buffer, so the padding never goes through update() and
   * cannot disturb totalBytes.
   */
  private pad(): void {
    const length = this.totalBytes

    // length * 8 exceeds 2^53 only past a petabyte, but length * 8 exceeds 2^32
    // at 512 MB — well inside what a bigger ceiling could admit one day. So the
    // two halves are computed separately rather than with a single shift that
    // would silently wrap.
    const high = Math.floor(length / 0x20000000)
    const low = ((length % 0x20000000) * 8) >>> 0

    // 56 is the largest offset that still leaves room for the 0x80 and the
    // 8-byte length inside one block; at or above it the padding spills into a
    // second block, which is why this is two blocks rather than one.
    const tail = new Uint8Array(this.partialLength < 56 ? BLOCK_BYTES : BLOCK_BYTES * 2)
    tail.set(this.partial.subarray(0, this.partialLength), 0)
    tail[this.partialLength] = 0x80

    const end = tail.length
    tail[end - 8] = (high >>> 24) & 0xff
    tail[end - 7] = (high >>> 16) & 0xff
    tail[end - 6] = (high >>> 8) & 0xff
    tail[end - 5] = high & 0xff
    tail[end - 4] = (low >>> 24) & 0xff
    tail[end - 3] = (low >>> 16) & 0xff
    tail[end - 2] = (low >>> 8) & 0xff
    tail[end - 1] = low & 0xff

    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) this.compress(tail, offset)
    this.partialLength = 0
    this.finished = true
  }

  /** One 64-byte block, read big-endian from `data` at `offset`. */
  private compress(data: Uint8Array, offset: number): void {
    const w = this.w

    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4
      w[i] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }

    let a = this.h[0]
    let b = this.h[1]
    let c = this.h[2]
    let d = this.h[3]
    let e = this.h[4]
    let f = this.h[5]
    let g = this.h[6]
    let hh = this.h[7]

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0

      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }

    // Stored into a Uint32Array, which is what turns these signed sums back
    // into the unsigned words the next block expects.
    this.h[0] = (this.h[0] + a) | 0
    this.h[1] = (this.h[1] + b) | 0
    this.h[2] = (this.h[2] + c) | 0
    this.h[3] = (this.h[3] + d) | 0
    this.h[4] = (this.h[4] + e) | 0
    this.h[5] = (this.h[5] + f) | 0
    this.h[6] = (this.h[6] + g) | 0
    this.h[7] = (this.h[7] + hh) | 0
  }
}

/** Bytes read per turn. Big enough that the per-chunk overhead vanishes, small
 * enough that one chunk on a phone is unremarkable, and small enough that a
 * 92 MB file reports progress ~46 times rather than 3. */
export const HASH_CHUNK_BYTES = 2 * 1024 * 1024

/** Convenience for hashing something already in memory. */
export function sha256Bytes(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex()
}

/**
 * The SHA-256 of a Blob or File, read a chunk at a time.
 *
 * Returns null — rather than throwing — when `signal` is aborted, because
 * cancelling is an ordinary thing a person does and not an exceptional one.
 * A rejected promise here means the file itself could not be READ: it was
 * moved, renamed, unmounted or revoked after it was chosen, which the platform
 * reports as a NotReadableError from .arrayBuffer(). That is a different answer
 * and the caller has to be able to tell them apart.
 *
 * `onProgress` receives a fraction from 0 to 1 after each chunk. It is called
 * with 1 exactly once, on the last chunk, so a caller can drive a bar with it
 * without special-casing the end.
 */
export async function sha256File(
  blob: Blob,
  options: {
    signal?: AbortSignal
    onProgress?: (fraction: number) => void
    chunkBytes?: number
  } = {},
): Promise<string | null> {
  const { signal, onProgress, chunkBytes = HASH_CHUNK_BYTES } = options
  const digest = new Sha256()
  const total = blob.size

  // An empty blob has a perfectly good digest and the loop below would never
  // run, so the fraction is reported once and the padding does the rest.
  if (total === 0) {
    onProgress?.(1)
    return digest.hex()
  }

  for (let offset = 0; offset < total; offset += chunkBytes) {
    if (signal?.aborted) return null
    const end = Math.min(offset + chunkBytes, total)
    // .slice() is a view, not a copy — the read happens on .arrayBuffer(), and
    // only this chunk is ever resident.
    digest.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()))
    onProgress?.(end / total)
  }

  // Checked once more after the last read: an abort that arrived during the
  // final chunk should not come back as a digest the caller then uploads.
  if (signal?.aborted) return null

  return digest.hex()
}
