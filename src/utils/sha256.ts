/**
 * sha256.ts — pure TypeScript SHA-256 implementation (FIPS 180-4).
 * Zero dependencies. Used to hash P2PK secrets before SPEND_PROOF signing.
 *
 * @param message  UTF-8 string or raw bytes
 * @returns        32-byte Uint8Array digest
 */

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Compute SHA-256 of a UTF-8 string.
 * @returns hex digest string (64 chars)
 */
export function sha256Hex(message: string): string {
  const bytes = utf8ToBytes(message);
  const digest = sha256Bytes(bytes);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const h = digest[i].toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return hex;
}

/**
 * Compute SHA-256 of raw bytes.
 * @returns 32-byte array
 */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  // Initial hash values (first 32 bits of fractional parts of sqrt of first 8 primes)
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  // Pre-processing: add padding
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  // Padded length: multiple of 64, with room for the 1-bit, zeros, and 8-byte length
  const padLen = msgLen % 64 < 56 ? 64 : 128;
  const padded = new Uint8Array(msgLen + padLen - (msgLen % 64));
  padded.set(data);
  padded[msgLen] = 0x80;
  // Write 64-bit big-endian bit length at the end
  // (only lower 32 bits needed for messages < 512MB)
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  // Process each 64-byte block
  const w = new Array<number>(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3;
    let e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1  = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch  = ((e & f) ^ (~e & g)) >>> 0;
      const tmp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0  = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const tmp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + tmp1) >>> 0;
      d = c; c = b; b = a;
      a = (tmp1 + tmp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0,  h0, false);
  outDv.setUint32(4,  h1, false);
  outDv.setUint32(8,  h2, false);
  outDv.setUint32(12, h3, false);
  outDv.setUint32(16, h4, false);
  outDv.setUint32(20, h5, false);
  outDv.setUint32(24, h6, false);
  outDv.setUint32(28, h7, false);
  return out;
}

function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push((cp >> 6) | 0xc0, (cp & 0x3f) | 0x80);
    } else if (cp >= 0xd800 && cp <= 0xdbff) {
      // Surrogate pair
      const hi = cp;
      const lo = str.charCodeAt(++i);
      cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        (cp >> 18) | 0xf0,
        ((cp >> 12) & 0x3f) | 0x80,
        ((cp >> 6) & 0x3f) | 0x80,
        (cp & 0x3f) | 0x80,
      );
    } else {
      out.push((cp >> 12) | 0xe0, ((cp >> 6) & 0x3f) | 0x80, (cp & 0x3f) | 0x80);
    }
  }
  const arr = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) arr[i] = out[i];
  return arr;
}
