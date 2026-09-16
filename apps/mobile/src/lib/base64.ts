const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) {
  B64_LOOKUP[B64_ALPHABET.charAt(i)] = i;
}

/**
 * Decode base64 without depending on browser `atob` or Node `Buffer`.
 * Hermes supports typed arrays, so this shared decoder stays valid in native
 * voice playback and bounded Computer Files previews alike.
 */
export function base64ToBytes(base64: string): Uint8Array {
  let clean = "";
  for (let i = 0; i < base64.length; i++) {
    const ch = base64.charAt(i);
    if (ch in B64_LOOKUP) clean += ch;
  }
  const len = clean.length;
  const byteLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[clean.charAt(i)] ?? 0;
    const c1 = i + 1 < len ? (B64_LOOKUP[clean.charAt(i + 1)] ?? 0) : 0;
    const c2 = i + 2 < len ? B64_LOOKUP[clean.charAt(i + 2)] : undefined;
    const c3 = i + 3 < len ? B64_LOOKUP[clean.charAt(i + 3)] : undefined;
    const n =
      (c0 << 18) | (c1 << 12) | (((c2 ?? 0) & 63) << 6) | ((c3 ?? 0) & 63);
    if (p < byteLen) out[p++] = (n >> 16) & 0xff;
    if (c2 !== undefined && p < byteLen) out[p++] = (n >> 8) & 0xff;
    if (c3 !== undefined && p < byteLen) out[p++] = n & 0xff;
  }
  return out;
}
