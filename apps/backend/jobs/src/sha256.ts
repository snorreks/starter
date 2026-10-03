// apps/backend/jobs/src/sha256.ts
//
// An incremental SHA-256, because the artifact hash has to be computed while a
// stream goes past and the platform's digest does not stream.
//
// Why this is not `node:crypto`
// -----------------------------
// `createHash('sha256')` would do exactly this, and it is available in workerd
// under `nodejs_compat`. It is not used, for one reason: `bun run guard` classifies
// a `node:` import as the `node-runtime` capability, and the worker plane does not
// hold it. Widening that classification for one hash function would make the
// capability table mean less, and this file is 70 lines of a published algorithm
// with test vectors rather than a relaxation of the architecture's own rule.
//
// Why this is not WebCrypto
// --------------------------
// `crypto.subtle.digest` takes the whole buffer at once. Hashing an artifact would
// then mean holding it — 10 MiB inside a Worker whose memory ceiling is orders of
// magnitude smaller — which is precisely what the streaming design avoids.
//
// It is a real SHA-256: the unit lane checks it against `crypto.subtle.digest` for
// inputs that straddle the 64-byte block boundary, which is where a broken
// implementation differs from a working one.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

/**
 * A streaming SHA-256.
 *
 * `update` may be called with arbitrary chunk sizes — the caller is a network
 * stream and knows nothing about block boundaries — and `hex` may be called at any
 * point, which finalises a *copy* so the running state survives. That copy
 * behaviour is what lets a caller hash one stream and then continue feeding it,
 * which the artifact path does not need but a test does.
 */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly buffer = new Uint8Array(64);

  private bufferLength = 0;

  /** Total bytes absorbed. The length field is what makes the hash length-sensitive. */
  private length = 0;

  private readonly words = new Uint32Array(64);

  update(chunk: Uint8Array): this {
    this.length += chunk.length;
    let offset = 0;

    if (this.bufferLength > 0) {
      const take = Math.min(64 - this.bufferLength, chunk.length);
      this.buffer.set(chunk.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }

    for (; offset + 64 <= chunk.length; offset += 64) {
      this.compress(chunk.subarray(offset, offset + 64));
    }

    if (offset < chunk.length) {
      this.buffer.set(chunk.subarray(offset), 0);
      this.bufferLength = chunk.length - offset;
    }
    return this;
  }

  hex(): string {
    const snapshot = new Sha256();
    snapshot.state.set(this.state);
    snapshot.buffer.set(this.buffer);
    snapshot.bufferLength = this.bufferLength;
    snapshot.length = this.length;
    return snapshot.finish();
  }

  private finish(): string {
    const bitLength = this.length * 8;
    // 0x80, then zeros, then the 64-bit big-endian length. `padTo` writes the
    // marker and pads within `this.buffer`, so a message that already filled a
    // block starts a fresh one — the case a naive implementation gets wrong.
    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    this.buffer[56] = (high >>> 24) & 0xff;
    this.buffer[57] = (high >>> 16) & 0xff;
    this.buffer[58] = (high >>> 8) & 0xff;
    this.buffer[59] = high & 0xff;
    this.buffer[60] = (low >>> 24) & 0xff;
    this.buffer[61] = (low >>> 16) & 0xff;
    this.buffer[62] = (low >>> 8) & 0xff;
    this.buffer[63] = low & 0xff;
    this.compress(this.buffer);

    let out = '';
    for (const word of this.state) {
      out += word.toString(16).padStart(8, '0');
    }
    return out;
  }

  private compress(block: Uint8Array): void {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const base = i * 4;
      w[i] =
        ((block[base] ?? 0) << 24) |
        ((block[base + 1] ?? 0) << 16) |
        ((block[base + 2] ?? 0) << 8) |
        (block[base + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0) as number;
    }

    let [a, b, c, d, e, f, g, h] = this.state as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i += 1) {
      this.state[i] = ((this.state[i] ?? 0) + (next[i] ?? 0)) >>> 0;
    }
  }
}

/** Convenience: the lowercase hex digest of a whole buffer. */
export const sha256Hex = (bytes: Uint8Array): string => new Sha256().update(bytes).hex();
