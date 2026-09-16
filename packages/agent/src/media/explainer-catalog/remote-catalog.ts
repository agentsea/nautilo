/**
 * D429 Phase 7.4 — bounded remote explainer-catalog fetch with signed pointer.
 *
 * A narrow, testable loader that retrieves ONLY configured HTTPS official
 * release-pointer URLs. It is never a general URL fetcher: every URL it opens
 * is fixed at construction time. It fetches the configured pointer URL plus
 * the immutable manifest URL derived from that pointer's own directory and a
 * validated `catalogVersion` — never a pointer-provided path. No
 * caller-supplied URL is ever accepted.
 *
 * Verification order (all failures retain the prior known-good or seed):
 *   1. strict pointer shape ({catalogVersion, artifactSha256, signature, signingKeyId});
 *   2. trusted signingKeyId (embedded key-id/public-key trust map);
 *   3. Ed25519 signature over the canonical signing payload;
 *   4. exact immutable artifact SHA-256 (computed BEFORE JSON parsing);
 *   5. strict manifest schema (ExplainerCatalogSchema);
 *   6. pointer and manifest catalogVersion match;
 *   7. atomic snapshot replace.
 *
 * Transport guarantees (mirrors the shipped D429 model-catalog loader):
 *   - allowlisted HTTPS origin only (no credentials, no fragments, no query, no redirects);
 *   - forbidden IP-literal hosts rejected (loopback/private/link-local/unspecified/multicast, IPv4+IPv6);
 *   - response byte cap (default 4 MiB) enforced against Content-Length and streamed bytes;
 *   - fatal UTF-8 decoding of the response body;
 *   - connect+read timeout covering the complete fetch-and-body-read operation;
 *   - single-flight refresh, TTL / stale-while-revalidate, last-known-good cache;
 *   - bundled checked-in seed so discovery is never unavailable;
 *   - truthful, non-secret provenance in a narrowly typed result.
 *
 * Inject `fetchImpl` and `now` in tests; unit tests never use the network.
 */
import {
  EXPLAINER_ARTIFACT_SHA256_PATTERN,
  ExplainerCatalogReleasePointerSchema,
  ExplainerCatalogSchema,
  canonicalExplainerCatalogSigningPayload,
  immutableExplainerCatalogFilename,
  type ExplainerCatalog,
  type ExplainerCatalogResultSource,
} from "@nautilo/types";
import { createHash } from "node:crypto";
import { verify as ed25519Verify, createPublicKey } from "node:crypto";
import { localExplainerCatalog } from "./catalog";
import { getTrustedExplainerCatalogPublicKey } from "./trusted-keys";

/** Where a served catalog came from, in narrowly typed terms. */
export type RemoteExplainerCatalogSource = ExplainerCatalogResultSource;

/** Truthful, bounded metadata about a served catalog. */
export interface RemoteExplainerCatalogResult {
  readonly catalog: ExplainerCatalog;
  readonly source: RemoteExplainerCatalogSource;
  /** True when the served payload is past its fresh TTL (remote-stale or checked-in-fallback). */
  readonly stale: boolean;
  /** UTC ISO 8601 timestamp the served remote payload was originally fetched, or null for local. */
  readonly fetchedAt: string | null;
  /** The configured official pointer URL the loader attempts, or null when remote is disabled. */
  readonly originUrl: string | null;
  /** Human-readable note explaining any non-fresh source (non-secret). */
  readonly reason: string;
  /** The catalogVersion of the served snapshot, or null for the checked-in fallback. */
  readonly catalogVersion: string | null;
}

/**
 * Configuration seam for the remote loader. None of these are tool-caller
 * knobs; they are process-level configuration and test seams.
 */
export interface RemoteExplainerCatalogConfig {
  /**
   * Allowlisted official release-pointer URL (e.g. `catalog/latest.json`). No
   * default; unset => remote disabled (serve the checked-in local fallback
   * without any network call). The immutable manifest is derived from this
   * pointer's own directory plus its validated `catalogVersion`.
   */
  catalogPointerUrl?: string;
  /** Hosts permitted for the configured URL. Defaults to the URL's own hostname. */
  allowedHosts?: string[];
  /** Fresh TTL in ms. Default 15 min. */
  ttlMs?: number;
  /** Stale-while-revalidate window after TTL, in ms. Default 24 h. */
  staleMs?: number;
  /** Connect+read timeout in ms. Default 5 s. Covers fetch AND body read. */
  timeoutMs?: number;
  /** Max response body size in bytes. Default 4 MiB. */
  maxBytes?: number;
  /**
   * Trusted signing-key map (signingKeyId → base64 DER SPKI Ed25519 public
   * key). Defaults to the checked-in registry (empty until Phase 8). Tests
   * inject Ed25519 test keys here.
   */
  trustedKeys?: Record<string, string>;
  /** Test seam for the fetch implementation. Defaults to globalThis.fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Test seam for the clock. Defaults to Date.now. */
  now?: () => number;
}

export interface RemoteExplainerCatalogLoader {
  /** Resolve the best available catalog with truthful source metadata. */
  get(): Promise<RemoteExplainerCatalogResult>;
  /**
   * Single-flight network refresh. Returns the truthful result of this one
   * bounded attempt: fresh remote on success, prior remote LKG on failure, or
   * checked-in fallback when no remote cache exists.
   */
  refresh(): Promise<RemoteExplainerCatalogResult | void>;
  /** Drop the in-memory cache. */
  clearCache(): void;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

interface CacheEntry {
  readonly catalog: ExplainerCatalog;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Parse a dotted-quad into four octets, or null if not a valid IPv4 literal. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets[i] = value;
  }
  return octets;
}

function isForbiddenIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224 && a <= 239) return true;
  return false;
}

function parseIpv6(host: string): bigint | null {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h.includes(":")) return null;
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    h = h.slice(0, lastColon + 1) + hi.toString(16) + ":" + lo.toString(16);
  }
  const doubleColon = h.indexOf("::");
  let groups: string[];
  if (doubleColon >= 0) {
    if (h.indexOf("::", doubleColon + 1) >= 0) return null;
    const head = h.slice(0, doubleColon);
    const foot = h.slice(doubleColon + 2);
    const headGroups = head ? head.split(":") : [];
    const footGroups = foot ? foot.split(":") : [];
    const missing = 8 - headGroups.length - footGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...footGroups];
  } else {
    groups = h.split(":");
  }
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

function isForbiddenIpv6(addr: bigint): boolean {
  if (addr === 0n) return true;
  if (addr === 1n) return true;
  const top96 = addr >> 96n;
  if (top96 === 0xFFFFn || top96 === 0n) {
    const low = Number(addr & 0xFFFFFFFFn);
    const embedded: [number, number, number, number] = [
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    ];
    if (isForbiddenIpv4(embedded)) return true;
  }
  if (addr >> 118n === 0x3fAn) return true;
  if (addr >> 121n === 0x7En) return true;
  if (addr >> 120n === 0xFFn) return true;
  return false;
}

function forbiddenIpLiteral(host: string): "ipv4" | "ipv6" | null {
  const v4 = parseIpv4(host);
  if (v4) return isForbiddenIpv4(v4) ? "ipv4" : null;
  const v6 = parseIpv6(host);
  if (v6 !== null) return isForbiddenIpv6(v6) ? "ipv6" : null;
  return null;
}

function assertAllowedOrigin(url: string, allowedHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("official explainer catalog URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("official explainer catalog URL must use the https: scheme");
  }
  if (parsed.username || parsed.password) {
    throw new Error("official explainer catalog URL must not carry credentials");
  }
  if (parsed.hash) {
    throw new Error("official explainer catalog URL must not carry a fragment");
  }
  if (parsed.search) {
    throw new Error("official explainer catalog URL must not carry a query string");
  }
  const host = parsed.hostname.toLowerCase();
  const forbiddenIp = forbiddenIpLiteral(host);
  if (forbiddenIp) {
    throw new Error(`official explainer catalog host "${host}" is a forbidden IP literal (${forbiddenIp})`);
  }
  if (!allowedHosts.includes(host)) {
    throw new Error(`official explainer catalog host "${host}" is not in the allowlist`);
  }
  return parsed;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) {
    throw new Error("official explainer catalog response has no body");
  }
  interface ByteChunkReader {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock(): void;
  }
  const reader = res.body.getReader() as ByteChunkReader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error(
          `official explainer catalog response exceeded byte limit (${received} > ${maxBytes})`,
        );
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw new Error("official explainer catalog response is not valid UTF-8");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new Error("official explainer catalog response is not valid UTF-8");
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Verify the pointer's Ed25519 signature against the trusted public key for
 * `signingKeyId`. Throws a non-secret reason on unknown key, malformed key,
 * or failed verification — the loader surfaces it and retains the LKG.
 */
function verifyPointerSignature(
  pointer: {
    catalogVersion: string;
    artifactSha256: string;
    signature: string;
    signingKeyId: string;
  },
  trustedKeys: Record<string, string>,
): void {
  const publicKeyB64 =
    trustedKeys[pointer.signingKeyId] ??
    getTrustedExplainerCatalogPublicKey(pointer.signingKeyId);
  if (!publicKeyB64) {
    throw new Error(`unknown signingKeyId "${pointer.signingKeyId}" — not in trusted registry`);
  }
  let keyObject: ReturnType<typeof createPublicKey>;
  try {
    keyObject = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error(`trusted public key for "${pointer.signingKeyId}" is not valid DER`);
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error(`trusted public key for "${pointer.signingKeyId}" is not Ed25519`);
  }
  const payload = Buffer.from(
    canonicalExplainerCatalogSigningPayload(pointer.catalogVersion, pointer.artifactSha256),
    "utf8",
  );
  const signature = Buffer.from(pointer.signature, "base64");
  if (signature.length !== 64) {
    throw new Error("pointer signature must decode to 64 bytes");
  }
  let ok: boolean;
  try {
    ok = ed25519Verify(null, payload, keyObject, signature);
  } catch {
    throw new Error("pointer signature verification failed");
  }
  if (!ok) {
    throw new Error("pointer signature does not verify against trusted key");
  }
}

export function createRemoteExplainerCatalogLoader(
  config: RemoteExplainerCatalogConfig = {},
): RemoteExplainerCatalogLoader {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const staleMs = config.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const clock = config.now ?? Date.now;
  const trustedKeys = config.trustedKeys ?? {};

  const rawPointerUrl = config.catalogPointerUrl?.trim();
  let originUrl: string | null = null;
  let allowedHosts: string[] = [];
  if (rawPointerUrl) {
    allowedHosts = (config.allowedHosts ?? [new URL(rawPointerUrl).hostname]).map((h) =>
      h.toLowerCase(),
    );
    assertAllowedOrigin(rawPointerUrl, allowedHosts);
    originUrl = rawPointerUrl;
  }

  let cacheEntry: CacheEntry | null = null;
  let refreshInflight: Promise<RemoteExplainerCatalogResult> | null = null;

  async function fetchStrictText(url: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`official explainer catalog fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const work = async (): Promise<string> => {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (res.status !== 200) {
        throw new Error(`official explainer catalog fetch failed status=${res.status}`);
      }
      const contentType = res.headers.get("content-type");
      if (!isJsonContentType(contentType)) {
        throw new Error(
          `official explainer catalog response has invalid Content-Type (${contentType ?? "missing"})`,
        );
      }
      const contentLengthHeader = res.headers.get("content-length");
      if (contentLengthHeader) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Error(
            `official explainer catalog Content-Length exceeds byte limit (${declared} > ${maxBytes})`,
          );
        }
      }
      return readBoundedText(res, maxBytes);
    };
    try {
      const workPromise = work();
      workPromise.catch(() => {});
      return await Promise.race([workPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("official explainer catalog response is not valid JSON");
    }
  }

  function deriveManifestUrl(pointerUrl: string, catalogVersion: string): string {
    const base = new URL(pointerUrl);
    const path = base.pathname;
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash < 0) {
      throw new Error("official explainer catalog pointer URL must reside in a directory");
    }
    base.pathname = path.slice(0, lastSlash + 1) + immutableExplainerCatalogFilename(catalogVersion);
    const derived = base.toString();
    const validated = assertAllowedOrigin(derived, allowedHosts);
    if (validated.origin !== base.origin) {
      throw new Error("official explainer catalog manifest URL must be same-origin as the pointer");
    }
    return derived;
  }

  async function performFetch(now: number): Promise<CacheEntry> {
    if (originUrl === null) {
      throw new Error("remote explainer catalog is disabled (no pointer URL configured)");
    }
    // 1. Fetch + strict-parse the signed pointer.
    const pointerText = await fetchStrictText(originUrl);
    let pointer: {
      catalogVersion: string;
      artifactSha256: string;
      signature: string;
      signingKeyId: string;
    };
    try {
      pointer = ExplainerCatalogReleasePointerSchema.parse(parseJson(pointerText));
    } catch {
      throw new Error("official explainer catalog pointer is not a valid signed release pointer");
    }
    // 2-3. Trusted key + Ed25519 signature verification.
    verifyPointerSignature(pointer, trustedKeys);
    // 4. Fetch the derived immutable manifest (same-origin, re-validated).
    const manifestUrl = deriveManifestUrl(originUrl, pointer.catalogVersion);
    const manifestText = await fetchStrictText(manifestUrl);
    // 4b. Exact SHA-256 of the immutable artifact BEFORE JSON activation.
    const artifactSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
    if (!EXPLAINER_ARTIFACT_SHA256_PATTERN.test(artifactSha256)) {
      throw new Error("computed artifact SHA-256 is not valid lowercase hex");
    }
    if (artifactSha256 !== pointer.artifactSha256) {
      throw new Error("official explainer catalog immutable artifact SHA-256 mismatch");
    }
    // 5. Strict manifest schema.
    const catalog = ExplainerCatalogSchema.parse(parseJson(manifestText));
    // 6. Pointer and manifest catalogVersion must match.
    if (catalog.catalogVersion !== pointer.catalogVersion) {
      throw new Error("official explainer catalog pointer and manifest catalogVersion do not match");
    }
    // The shipped seed is a trusted release floor. A lagging CDN replica can
    // return an authentic older pointer after retirement; signature validity
    // must not resurrect films that the installed release has already removed.
    const incomingVersion = catalog.catalogVersion.split(".").map(Number);
    const bundledVersion = localExplainerCatalog.catalogVersion.split(".").map(Number);
    const differingPart = incomingVersion.findIndex((part, index) => part !== bundledVersion[index]);
    if (differingPart >= 0 && incomingVersion[differingPart]! < bundledVersion[differingPart]!) {
      throw new Error("official explainer catalog is older than the bundled release; retaining current films");
    }
    return {
      catalog,
      fetchedAt: now,
      expiresAt: now + ttlMs,
      staleUntil: now + ttlMs + staleMs,
    };
  }

  async function refresh(): Promise<RemoteExplainerCatalogResult> {
    if (refreshInflight) return refreshInflight;
    const promise = (async () => {
      try {
        const entry = await performFetch(clock());
        cacheEntry = entry;
        return fromCache(entry, "remote-fresh");
      } catch (error) {
        const cached = cacheEntry;
        if (cached) return fromCache(cached, "remote-stale");
        return localFallback(`official explainer catalog unavailable: ${errorMessage(error)}`);
      }
    })();
    refreshInflight = promise;
    try {
      return await promise;
    } finally {
      if (refreshInflight === promise) refreshInflight = null;
    }
  }

  function localFallback(reason: string): RemoteExplainerCatalogResult {
    return {
      catalog: localExplainerCatalog,
      source: "checked-in-fallback",
      stale: true,
      fetchedAt: null,
      originUrl,
      reason,
      catalogVersion: localExplainerCatalog.catalogVersion,
    };
  }

  function fromCache(
    entry: CacheEntry,
    source: "remote-fresh" | "remote-stale",
  ): RemoteExplainerCatalogResult {
    return {
      catalog: entry.catalog,
      source,
      stale: source === "remote-stale",
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      originUrl,
      reason: source === "remote-fresh" ? "" : "serving cached payload past TTL",
      catalogVersion: entry.catalog.catalogVersion,
    };
  }

  async function get(): Promise<RemoteExplainerCatalogResult> {
    if (originUrl === null) {
      return localFallback("remote explainer catalog disabled — no pointer URL configured");
    }
    const now = clock();
    const cached = cacheEntry;
    if (cached && cached.expiresAt > now) {
      return fromCache(cached, "remote-fresh");
    }
    if (cached && cached.staleUntil > now) {
      void refresh();
      return fromCache(cached, "remote-stale");
    }
    try {
      const entry = await performFetch(now);
      cacheEntry = entry;
      return fromCache(entry, "remote-fresh");
    } catch (error) {
      if (cached) {
        return fromCache(cached, "remote-stale");
      }
      return localFallback(`official explainer catalog unavailable: ${errorMessage(error)}`);
    }
  }

  function clearCache(): void {
    cacheEntry = null;
    refreshInflight = null;
  }

  return { get, refresh, clearCache };
}
