/** Generic verified-release transport. It has no catalogue-specific semantics. */
import { createHash, createPublicKey, verify } from "node:crypto";

/** One shared transport boundary for signed JSON releases. */
export const VERIFIED_RELEASE_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const VERIFIED_RELEASE_TIMEOUT_MS = 60_000;

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map((part) => /^\d{1,3}$/u.test(part) ? Number(part) : -1);
  return values.every((value) => value >= 0 && value <= 255) ? values as [number, number, number, number] : null;
}
function forbiddenIpv4([a, b]: [number, number, number, number]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}
function ipv6Value(host: string): bigint | null {
  const value = host.replace(/^\[|\]$/gu, "");
  if (!value.includes(":")) return null;
  const pair = value.split("::"); if (pair.length > 2) return null;
  const left = pair[0] ? pair[0].split(":") : [], right = pair[1] ? pair[1].split(":") : [];
  if (right.length && right.at(-1)?.includes(".")) { const v4 = parseIpv4(right.pop()!); if (!v4) return null; right.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)); }
  const padding: string[] = Array.from({ length: 8 - left.length - right.length }, () => "0" as string);
  const groups: string[] = pair.length === 2 ? [...left, ...padding, ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return null;
  return groups.reduce((result, group) => result << 16n | BigInt(`0x${group}`), 0n);
}
function forbiddenHost(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) return forbiddenIpv4(v4);

  const v6 = ipv6Value(host);
  if (v6 === null) return false;
  if (v6 === 0n || v6 === 1n) return true;
  // fc00::/7 (including fd00::/8), fe80::/10, and ff00::/8.
  if (v6 >> 121n === 0x7en || v6 >> 118n === 0x3fan || v6 >> 120n === 0xffn) return true;

  const top96 = v6 >> 32n;
  if (top96 === 0n || top96 === 0xffffn) {
    return forbiddenIpv4([
      Number((v6 >> 24n) & 255n),
      Number((v6 >> 16n) & 255n),
      Number((v6 >> 8n) & 255n),
      Number(v6 & 255n),
    ]);
  }
  return false;
}

export function verifiedReleaseUrl(value: string, allowedHosts: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("release transport rejected");
  }
  const host = parsed.hostname.toLowerCase();
  const normalizedAllowedHosts = allowedHosts.map((candidate) => candidate.toLowerCase());
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !normalizedAllowedHosts.includes(host)
    || forbiddenHost(host)
  ) {
    throw new Error("release transport rejected");
  }
  return parsed;
}
async function within<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("release transport timed out")); }, timeoutMs); });
  try { return await Promise.race([promise, deadline]); } finally { if (timer) clearTimeout(timer); }
}
export async function boundedJsonFetch(fetcher: typeof fetch, url: URL, maxBytes: number, timeoutMs: number): Promise<{ text: string; sha256: string }> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > VERIFIED_RELEASE_JSON_MAX_BYTES || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VERIFIED_RELEASE_TIMEOUT_MS) throw new Error("release transport bounds rejected");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const pending = Promise.resolve(fetcher(url, { redirect: "error", signal: controller.signal }));
  // A noncompliant injected fetch may settle after timeout; absorb its later rejection.
  void pending.catch(() => undefined);
  const response = await within(pending, timeoutMs, controller);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok || response.status !== 200 || response.type === "opaqueredirect" || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !Number.isFinite(declared) || declared > maxBytes || !response.body) throw new Error("release response rejected");
  type Reader = { read(): Promise<{ done: true } | { done: false; value: Uint8Array }>; releaseLock(): void };
  const reader = response.body.getReader() as unknown as Reader; const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; let text = "";
  try { for (;;) { const remaining = deadline - Date.now(); if (remaining <= 0) { controller.abort(); throw new Error("release transport timed out"); } const item = await within(reader.read(), remaining, controller); if (item.done) break; const chunk = item.value; bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error("release response too large"); text += decoder.decode(chunk, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); }
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
export function verifyEd25519Release(payload: string, signature: string, publicKeyDer: string): void {
  const key = createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64"))) throw new Error("release signature rejected");
}
