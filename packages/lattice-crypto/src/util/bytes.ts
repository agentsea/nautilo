/**
 * Small byte helpers. No crypto here — just encoding plumbing shared across
 * the crypto module, scheme, and serialization.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Big-endian u16 length prefix. */
export function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (n >>> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}

export function readU16(b: Uint8Array, off: number): number {
  return (((b[off] ?? 0) << 8) | (b[off + 1] ?? 0)) >>> 0;
}

export function toHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) {
    throw new Error("hex input must be lowercase, even-length hexadecimal");
  }
  const b = new Uint8Array(h.length >> 1);
  for (let i = 0; i < b.length; i++) {
    b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return b;
}

export function encodeJson(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}
