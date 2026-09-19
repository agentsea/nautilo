import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ModelCatalogSchema,
  ModelCatalogV3Schema,
  ModelCatalogV4Schema,
  canonicalModelCatalogSigningPayload,
  type ModelCatalog,
} from "@nautilo/types";
import {
  createRemoteModelCatalogLoader,
  type RemoteModelCatalogConfig,
  type RemoteModelCatalogResult,
} from "../../src/config/model-catalog/remote-catalog";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  getRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  kickRuntimeModelCatalogRefresh,
  OFFICIAL_MODEL_CATALOG_POINTER_URL,
  refreshAndPublishRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  resetTrustedModelCatalogKeysForTests,
  setTrustedModelCatalogKeysForTests,
} from "../../src/config/model-catalog/trusted-keys";
import {
  getActiveModelCatalogProvenance,
  listResolvedCatalogModels,
} from "../../src/config/resolved-catalog";
import {
  modelSupportsFeature,
  modelSupportsInput,
} from "@nautilo/model-capabilities";

const POINTER_URL = "https://media.nautilo.ai/models/latest.json";

/** A minimal valid manifest distinct from the checked-in seed. */
function manifestPayload(catalogVersion = "2026.07.18.1", id = "anthropic:claude-test-7"): ModelCatalog {
  return ModelCatalogSchema.parse({
    version: 1,
    catalogVersion,
    publishedAt: "2026-07-18T10:00:00Z",
    entries: [
      {
        id,
        displayName: "Claude Test 7 (Anthropic)",
        provider: "anthropic",
        routing: "first-party",
        priority: 1,
        defaultEnabled: true,
        modalities: { input: ["text", "image", "file"], output: ["text"] },
        features: { tools: true, structuredOutputs: false, reasoning: true },
        limits: { contextTokens: 200_000, outputTokens: 8_000 },
        cost: { coefficient: 1 },
        privacy: { grade: 1 },
        intelligence: { tier: "frontier" },
        capabilityProvenance: "override",
      },
    ],
  });
}

/** Minimal reviewed v4 decision manifest used by reader/signature tests. */
function decisionManifestPayload(catalogVersion = "2026.09.18.1"): ModelCatalog {
  return ModelCatalogV4Schema.parse({
    version: 4,
    catalogVersion,
    publishedAt: "2026-09-18T10:39:55Z",
    entries: [
      {
        id: "openrouter:typesafe/jev-1.13",
        displayName: "Jev 1.13 (OpenRouter)",
        provider: "openrouter",
        routing: "openrouter",
        priority: 999,
        defaultEnabled: true,
        workload: "decision",
        modalities: { input: ["text"], output: ["text"] },
        capabilityProvenance: "openrouter",
        cost: { coefficient: 0.014 },
        privacy: { grade: 4 },
        decision: {
          operations: ["choice"],
          inputTokens: 32_000,
          maxChoices: 255,
        },
      },
      {
        id: "anthropic:claude-test-security",
        displayName: "Claude Test Security (Anthropic)",
        provider: "anthropic",
        routing: "first-party",
        priority: 1,
        defaultEnabled: true,
        modalities: { input: ["text"], output: ["text"] },
        features: { tools: true, structuredOutputs: false, reasoning: true },
        limits: { contextTokens: 200_000, outputTokens: 8_000 },
        cost: { coefficient: 1 },
        privacy: { grade: 1 },
        intelligence: { tier: "frontier" },
        capabilityProvenance: "override",
        taskPreferences: ["security_research"],
      },
    ],
  });
}

/** Generate an Ed25519 key pair and return base64 DER SPKI public + raw private signing material. */
function makeTestKey(): {
  signingKeyId: string;
  publicKeyB64: string;
  signPayload: (payload: string) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    signingKeyId: "test-key-1",
    publicKeyB64: Buffer.from(publicDer).toString("base64"),
    signPayload: (payload: string) =>
      sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
}

/**
 * Build a signed pointer + the immutable manifest body for a given manifest.
 * The immutable artifact body is `JSON.stringify(manifest) + "\n"` (mirrors
 * publish-model-catalog.mjs). Returns the pointer object and the exact bytes
 * the immutable URL must serve.
 */
function buildSignedRelease(
  manifest: { catalogVersion: string },
  key: ReturnType<typeof makeTestKey>,
): { pointer: object; immutableBody: string } {
  const immutableBody = `${JSON.stringify(manifest)}\n`;
  return buildSignedBody(manifest.catalogVersion, immutableBody, key);
}

function buildSignedBody(
  catalogVersion: string,
  immutableBody: string,
  key: ReturnType<typeof makeTestKey>,
): { pointer: object; immutableBody: string } {
  const artifactSha256 = createHash("sha256").update(immutableBody, "utf8").digest("hex");
  const payload = canonicalModelCatalogSigningPayload(catalogVersion, artifactSha256);
  const pointer = {
    catalogVersion,
    artifactSha256,
    signature: key.signPayload(payload),
    signingKeyId: key.signingKeyId,
  };
  return { pointer, immutableBody };
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface Harness {
  config: RemoteModelCatalogConfig;
  fetches: { url: string; init?: RequestInit }[];
  setFetch(fn: FetchFn): void;
}

function makeHarness(
  key: ReturnType<typeof makeTestKey>,
  opts: {
    pointer?: unknown;
    immutableBody?: string;
    other?: FetchFn;
    now?: () => number;
    ttlMs?: number;
    staleMs?: number;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Harness {
  const defaultVersion = "2026.07.18.1";
  const defaultManifest = manifestPayload(defaultVersion);
  const { pointer: defaultPointer, immutableBody: defaultBody } = buildSignedRelease(
    defaultManifest,
    key,
  );
  const pointer = opts.pointer ?? defaultPointer;
  const immutableBody = opts.immutableBody ?? defaultBody;
  const pointerVersion = pointer && typeof pointer === "object"
    && "catalogVersion" in pointer && typeof pointer.catalogVersion === "string"
    ? pointer.catalogVersion
    : defaultVersion;
  const manifestUrl = `https://media.nautilo.ai/models/catalog-${pointerVersion}.json`;
  const fetches: { url: string; init?: RequestInit }[] = [];
  let fetchFn: FetchFn = (url) => {
    if (url === POINTER_URL) return Promise.resolve(jsonResponse(pointer));
    if (url === manifestUrl) return Promise.resolve(jsonResponse(immutableBody));
    return (opts.other ?? (() => Promise.resolve(jsonResponse("not found", { status: 404 }))))(url);
  };
  const recorder: FetchFn = (u, init) => {
    fetches.push(init ? { url: u, init } : { url: u });
    return fetchFn(u, init);
  };
  const config: RemoteModelCatalogConfig = {
    catalogPointerUrl: POINTER_URL,
    ttlMs: opts.ttlMs ?? 1000,
    staleMs: opts.staleMs ?? 1000,
    timeoutMs: opts.timeoutMs ?? 1000,
    maxBytes: opts.maxBytes ?? 1024 * 1024,
    now: opts.now ?? (() => 0),
    fetchImpl: recorder,
    trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
  };
  return { config, fetches, setFetch(fn) { fetchFn = fn; } };
}

describe("the current implementation — signed pointer + immutable artifact loader", () => {
  let key: ReturnType<typeof makeTestKey>;

  beforeEach(() => {
    key = makeTestKey();
  });

  test("fetches the pointer then the derived same-origin immutable manifest and serves fresh", async () => {
    const h = makeHarness(key);
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();

    expect(result.source).toBe("remote-fresh");
    expect(result.stale).toBe(false);
    expect(result.originUrl).toBe(POINTER_URL);
    expect(result.catalogVersion).toBe("2026.07.18.1");
    expect(result.catalog.entries[0]?.id).toBe("anthropic:claude-test-7");
    expect(result.fetchedAt).toBe(new Date(0).toISOString());
    expect(h.fetches.map((f) => f.url)).toEqual([
      "https://media.nautilo.ai/models/latest.json",
      "https://media.nautilo.ai/models/catalog-2026.07.18.1.json",
    ]);
  });

  test("verifies the Ed25519 signature and exact immutable SHA-256 before activation", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const h = makeHarness(key, { pointer, immutableBody });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("remote-fresh");
    expect(result.catalog.entries[0]?.id).toBe("anthropic:claude-test-7");
  });

  test("accepts a signed v4 decision catalog through the ordinary remote reader", async () => {
    const manifest = decisionManifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const h = makeHarness(key, { pointer, immutableBody });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();

    expect(result.source).toBe("remote-fresh");
    expect(result.catalog.version).toBe(4);
    expect(result.catalog.entries[0]).toMatchObject({
      id: "openrouter:typesafe/jev-1.13",
      workload: "decision",
      decision: {
        operations: ["choice"],
        inputTokens: 32_000,
        maxChoices: 255,
      },
    });
  });

  test("retains last-known-good when signed v4 bytes are malformed or schema-invalid", async () => {
    const invalidDecision = {
      ...decisionManifestPayload("2026.09.18.2"),
      entries: [{
        ...decisionManifestPayload("2026.09.18.2").entries[0],
        limits: { contextTokens: 32_000, outputTokens: 1 },
      }],
    };
    const cases = [
      buildSignedBody("2026.09.18.2", "{not-json}\n", key),
      buildSignedRelease(invalidDecision, key),
    ];

    for (const release of cases) {
      let now = 0;
      const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 1000 });
      const loader = createRemoteModelCatalogLoader(h.config);
      const initial = await loader.get();
      expect(initial.source).toBe("remote-fresh");
      expect(initial.catalog.catalogVersion).toBe("2026.07.18.1");

      h.setFetch(async (url) => {
        if (url === POINTER_URL) return jsonResponse(release.pointer);
        if (url === "https://media.nautilo.ai/models/catalog-2026.09.18.2.json") {
          return jsonResponse(release.immutableBody);
        }
        return jsonResponse("not found", { status: 404 });
      });
      now = 10_000;

      const retained = await loader.get();
      expect(retained.source).toBe("remote-stale");
      expect(retained.catalog.catalogVersion).toBe("2026.07.18.1");
      expect(retained.catalog.entries[0]?.id).toBe("anthropic:claude-test-7");
    }
  });

  test("retains last-known-good when a v4 pointer has an invalid signature", async () => {
    let now = 0;
    const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 1000 });
    const loader = createRemoteModelCatalogLoader(h.config);
    await loader.get();

    const release = buildSignedRelease(decisionManifestPayload("2026.09.18.2"), key);
    const badSignature = Buffer.from(new Uint8Array(64).fill(7)).toString("base64");
    h.setFetch(async (url) => {
      if (url === POINTER_URL) {
        return jsonResponse({ ...release.pointer, signature: badSignature });
      }
      if (url === "https://media.nautilo.ai/models/catalog-2026.09.18.2.json") {
        return jsonResponse(release.immutableBody);
      }
      return jsonResponse("not found", { status: 404 });
    });
    now = 10_000;

    const retained = await loader.get();
    expect(retained.source).toBe("remote-stale");
    expect(retained.catalog.catalogVersion).toBe("2026.07.18.1");
    expect(retained.catalog.entries[0]?.id).toBe("anthropic:claude-test-7");
  });

  test("rejects a tampered immutable artifact (SHA-256 mismatch) and falls back to local", async () => {
    const manifest = manifestPayload();
    const { pointer } = buildSignedRelease(manifest, key);
    // Serve a different body than the signed hash commits.
    const tampered = `${JSON.stringify({ ...manifest, publishedAt: "2026-07-18T11:00:00Z" })}\n`;
    const h = makeHarness(key, { pointer, immutableBody: tampered });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.catalog).toBe(localModelCatalog);
    expect(result.reason).toContain("SHA-256");
  });

  test("rejects a bad signature and falls back to local", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    // Flip the signature to a different (invalid) 64-byte blob.
    const badSig = Buffer.from(new Uint8Array(64).fill(7)).toString("base64");
    const h = makeHarness(key, {
      pointer: { ...pointer, signature: badSig },
      immutableBody,
    });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("signature");
  });

  test("rejects an unknown signingKeyId and falls back to local", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const h = makeHarness(key, {
      pointer: { ...pointer, signingKeyId: "not-in-registry" },
      immutableBody,
    });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("unknown signingKeyId");
  });

  test("falls back to local when the trusted registry is empty (official production until )", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const manifestUrl = `https://media.nautilo.ai/models/catalog-2026.07.18.1.json`;
    const fetches: string[] = [];
    const loader = createRemoteModelCatalogLoader({
      catalogPointerUrl: POINTER_URL,
      ttlMs: 1000,
      staleMs: 1000,
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
      now: () => 0,
      fetchImpl: async (url) => {
        fetches.push(url);
        if (url === POINTER_URL) return jsonResponse(pointer);
        if (url === manifestUrl) return jsonResponse(immutableBody);
        return jsonResponse("not found", { status: 404 });
      },
      // No trustedKeys => falls back to the (empty) checked-in registry.
    });
    // Ensure the checked-in registry is empty for this test.
    setTrustedModelCatalogKeysForTests(null);
    try {
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
      expect(result.reason).toContain("unknown signingKeyId");
    } finally {
      resetTrustedModelCatalogKeysForTests();
    }
  });

  test("rejects a malformed pointer (extra fields / missing fields) and falls back to local", async () => {
    for (const bad of [
      { catalogVersion: "2026.07.18.1", artifactSha256: "x".repeat(64), signature: Buffer.from(new Uint8Array(64)).toString("base64"), signingKeyId: "test-key-1", extra: "evil" },
      { catalogVersion: "2026.07.18.1", artifactSha256: "x".repeat(64), signingKeyId: "test-key-1" },
      { catalogVersion: "bad-version", artifactSha256: "x".repeat(64), signature: Buffer.from(new Uint8Array(64)).toString("base64"), signingKeyId: "test-key-1" },
      "not-an-object",
    ]) {
      const h = makeHarness(key, { pointer: bad });
      const loader = createRemoteModelCatalogLoader(h.config);
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
      expect(h.fetches.map((f) => f.url)).toEqual([POINTER_URL]);
    }
  });

  test("rejects a pointer/manifest catalogVersion mismatch and falls back to local", async () => {
    const manifest = manifestPayload("2026.07.18.1");
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    // Serve a manifest whose body declares a different version but re-sign
    // the pointer for the original — the immutable hash still matches the
    // tampered body, but the parsed catalogVersion won't match the pointer.
    const mismatched = manifestPayload("2026.07.18.2");
    const mismatchedBody = `${JSON.stringify(mismatched)}\n`;
    // Re-sign so the hash matches mismatchedBody but pointer says .1.
    const artifactSha256 = createHash("sha256").update(mismatchedBody, "utf8").digest("hex");
    const payload = canonicalModelCatalogSigningPayload("2026.07.18.1", artifactSha256);
    const badPointer = {
      catalogVersion: "2026.07.18.1",
      artifactSha256,
      signature: key.signPayload(payload),
      signingKeyId: key.signingKeyId,
    };
    void pointer;
    void immutableBody;
    const h = makeHarness(key, { pointer: badPointer, immutableBody: mismatchedBody });
    const loader = createRemoteModelCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("catalogVersion");
  });

  test("rejects a schema-invalid manifest and falls back to local", async () => {
    const manifestUrl = `https://media.nautilo.ai/models/catalog-2026.07.18.1.json`;
    const h = makeHarness(key, {
      immutableBody: `${JSON.stringify({ version: 999, catalogVersion: "2026.07.18.1", publishedAt: "2026-07-18T10:00:00Z", entries: [] })}\n`,
    });
    void manifestUrl;
    const loader = createRemoteModelCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
  });

  test("rejects a post- catalog that drops security-research routing metadata", async () => {
    const manifest = manifestPayload("2026.09.03.1");
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const manifestUrl =
      "https://media.nautilo.ai/models/catalog-2026.09.03.1.json";
    const loader = createRemoteModelCatalogLoader({
      catalogPointerUrl: POINTER_URL,
      ttlMs: 1000,
      staleMs: 1000,
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
      now: () => 0,
      fetchImpl: async (url) => {
        if (url === POINTER_URL) return jsonResponse(pointer);
        if (url === manifestUrl) return jsonResponse(immutableBody);
        return jsonResponse("not found", { status: 404 });
      },
      trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
    });

    const result = await loader.get();

    expect(result.source).toBe("checked-in-fallback");
    expect(result.catalog).toBe(localModelCatalog);
    expect(result.reason).toContain("security_research");
  });

  test("serves fresh cache within TTL, then stale + background-refresh, then fresh", async () => {
    let now = 0;
    const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 2000 });
    const loader = createRemoteModelCatalogLoader(h.config);

    await loader.get();
    expect(h.fetches).toHaveLength(2);
    now = 500;
    await loader.get();
    expect(h.fetches).toHaveLength(2); // fresh within TTL

    now = 1500; // past TTL, inside stale window
    const stale = await loader.get();
    expect(stale.source).toBe("remote-stale");
    await loader.refresh();
    const refreshed = await loader.get();
    expect(refreshed.source).toBe("remote-fresh");
  });

  test("serves last-known-good when a forced refresh fails (outage)", async () => {
    let now = 0;
    const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 1000 });
    const loader = createRemoteModelCatalogLoader(h.config);
    await loader.get();
    h.setFetch(async () => jsonResponse("nope", { status: 503 }));
    now = 10_000;
    const result = await loader.get();
    expect(result.source).toBe("remote-stale");
    expect(result.catalog.catalogVersion).toBe("2026.07.18.1");
  });

  test("falls back to local when remote fails and no cache exists (bootstrap)", async () => {
    const h = makeHarness(key);
    h.setFetch(async () => jsonResponse("nope", { status: 503 }));
    const loader = createRemoteModelCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.catalog).toBe(localModelCatalog);
    expect(result.reason).toContain("503");
  });

  test("refresh is single-flight", async () => {
    const h = makeHarness(key);
    const loader = createRemoteModelCatalogLoader(h.config);
    loader.clearCache();
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    // Pointer + manifest = 2 fetches for one single-flight refresh.
    expect(h.fetches).toHaveLength(2);
  });

  test("clearCache forces the next get to refetch", async () => {
    const h = makeHarness(key);
    const loader = createRemoteModelCatalogLoader(h.config);
    await loader.get();
    expect(h.fetches).toHaveLength(2);
    loader.clearCache();
    await loader.get();
    expect(h.fetches).toHaveLength(4);
  });

  test("rejects non-HTTPS / credentials / query / fragment / forbidden-IP pointer URLs at construction", () => {
    for (const bad of [
      "http://media.nautilo.ai/models/latest.json",
      "https://user:test@example.com/models/latest.json",
      "https://media.nautilo.ai/models/latest.json?v=2",
      "https://media.nautilo.ai/models/latest.json#section",
      "https://127.0.0.1/models/latest.json",
      "https://[fc00::1]/models/latest.json", // Synthetic IPv6 unique-local address.
      "https://[::1]/models/latest.json",
    ]) {
      expect(() =>
        createRemoteModelCatalogLoader({ catalogPointerUrl: bad, fetchImpl: async () => jsonResponse("") }),
      ).toThrow();
    }
  });

  test("rejects a 3xx / non-200 / non-JSON content type and falls back to local", async () => {
    const cases: { status?: number; headers?: Record<string, string> }[] = [
      { status: 302, headers: { location: "https://evil.example/x" } },
      { status: 503 },
      { headers: { "content-type": "text/plain" } },
    ];
    for (const c of cases) {
      const h = makeHarness(key);
      h.setFetch(async () => jsonResponse("body", c));
      const loader = createRemoteModelCatalogLoader(h.config);
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
    }
  });

  test("enforces the response byte cap and falls back to local", async () => {
    const h = makeHarness(key, { maxBytes: 64 });
    h.setFetch(async () => jsonResponse("x".repeat(10_000)));
    const loader = createRemoteModelCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("byte limit");
  });

  test("rejects invalid UTF-8 bodies and falls back to local", async () => {
    const h = makeHarness(key);
    const invalid = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21]);
    h.setFetch(async () =>
      new Response(invalid, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const loader = createRemoteModelCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("UTF-8");
  });

  test("aborts a slow fetch / slow body read and falls back to local", async () => {
    const h = makeHarness(key, { timeoutMs: 10 });
    h.setFetch(() => new Promise<Response>(() => { /* never resolves */ }));
    const loader = createRemoteModelCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("timed out");
  });

  test("serves local when no pointer URL is configured (remote disabled)", async () => {
    const loader = createRemoteModelCatalogLoader({
      ttlMs: 1000,
      staleMs: 1000,
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
      now: () => 0,
      fetchImpl: async () => { throw new Error("must not fetch when remote is disabled"); },
    });
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.originUrl).toBeNull();
    expect(result.catalog).toBe(localModelCatalog);
  });
});

describe("the current implementation/7.3 — runtime seam, reconciliation, and consumer consistency", () => {
  let key: ReturnType<typeof makeTestKey>;

  beforeEach(() => {
    key = makeTestKey();
    resetRuntimeModelCatalog();
    resetTrustedModelCatalogKeysForTests();
    setTrustedModelCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    resetTrustedModelCatalogKeysForTests();
  });

  function configureRemote(manifest: ModelCatalog, now = 0): void {
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const manifestUrl = `https://media.nautilo.ai/models/v4/catalog-${manifest.catalogVersion}.json`;
    configureRuntimeModelCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => now,
        fetchImpl: async (url) => {
          if (url === OFFICIAL_MODEL_CATALOG_POINTER_URL) return jsonResponse(pointer);
          if (url === manifestUrl) return jsonResponse(immutableBody);
          return jsonResponse("not found", { status: 404 });
        },
        trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
      },
    });
  }

  test("ships the verified official pointer URL", () => {
    expect(OFFICIAL_MODEL_CATALOG_POINTER_URL).toBe("https://media.nautilo.ai/models/v4/latest.json");
  });

  test("Zod contract represents reviewed xai, together, and gateway routing classes", () => {
    const base = manifestPayload();
    const catalog = ModelCatalogSchema.parse({
      ...base,
      entries: [
        { ...base.entries[0], id: "xai:grok-test", provider: "xai", routing: "first-party" },
        { ...base.entries[0], id: "together:llama-test", provider: "together", routing: "together" },
        { ...base.entries[0], id: "gateway:operator-test", provider: "gateway", routing: "gateway" },
      ],
    });
    expect(catalog.entries.map((entry) => entry.routing)).toEqual([
      "first-party",
      "together",
      "gateway",
    ]);
  });

  test("Zod contract rejects invalid release dates/revisions, duplicate modalities, and cross-routing", () => {
    const base = manifestPayload();
    for (const catalogVersion of ["2026.02.30.1", "2026.07.18.0"]) {
      expect(() => ModelCatalogSchema.parse({ ...base, catalogVersion })).toThrow();
    }
    expect(() =>
      ModelCatalogSchema.parse({
        ...base,
        entries: [{
          ...base.entries[0],
          modalities: { input: ["text", "text"], output: ["text"] },
        }],
      }),
    ).toThrow("unique");
    expect(() =>
      ModelCatalogSchema.parse({
        ...base,
        entries: [{
          ...base.entries[0],
          id: "together:llama-test",
          provider: "together",
          routing: "first-party",
        }],
      }),
    ).toThrow("not valid for provider");
  });

  test("Zod contract rejects chat entries without model-specific token limits in every version", () => {
    const base = manifestPayload();
    const { limits: _limits, ...withoutLimits } = base.entries[0]!;

    for (const version of [1, 2, 3, 4] as const) {
      expect(() => ModelCatalogSchema.parse({
        ...base,
        version,
        entries: [{ ...withoutLimits, ...(version >= 3 ? { workload: "chat" } : {}) }],
      }), `catalog v${version}`).toThrow("limits");
    }
  });

  test("legacy manifests reject v3 media fields and v3 requires an explicit generation pairing", () => {
    const base = manifestPayload();
    const media = {
      ...base.entries[0],
      id: "venice:seedance-2-5-text-to-video-basic",
      displayName: "Seedance 2.5",
      provider: "venice",
      routing: "western-anonymized",
      modalities: { input: ["text"], output: ["video"] },
      privacy: { grade: 6, label: "anonymized" },
    };
    expect(() => ModelCatalogSchema.parse({ ...base, entries: [media] })).toThrow();
    expect(() => ModelCatalogSchema.parse({ ...base, version: 2, entries: [media] })).toThrow();

    const generationBase = {
      id: "venice:seedance-2-5-text-to-video-basic",
      displayName: "Seedance 2.5",
      provider: "venice",
      routing: "western-anonymized",
      priority: 1,
      defaultEnabled: true,
      modalities: { input: ["text"], output: ["video"] },
      cost: { coefficient: 1 },
      privacy: { grade: 6, label: "anonymized" },
    };
    expect(() => ModelCatalogSchema.parse({ ...base, version: 3, entries: [generationBase] })).toThrow(
      "chat workload must declare text output",
    );
    expect(() => ModelCatalogSchema.parse({
      ...base,
      version: 3,
      entries: [{
        ...generationBase,
        workload: "generation",
        generation: { family: "video" },
      }],
    })).not.toThrow();
  });

  test("the legacy v3 reader rejects a v4 decision manifest", () => {
    const manifest = decisionManifestPayload();
    expect(ModelCatalogV4Schema.parse(manifest).version).toBe(4);
    expect(() => ModelCatalogV3Schema.parse(manifest)).toThrow();
  });

  test("all chat catalog versions accept optional visual-grounding facts and remain strict", () => {
    const base = manifestPayload();
    for (const value of [true, false, null] as const) {
      for (const version of [1, 2, 3, 4] as const) {
        const parsed = ModelCatalogSchema.parse({
          ...base,
          version,
          entries: [{
            ...base.entries[0],
            ...(version >= 3 ? { workload: "chat" } : {}),
            features: { ...base.entries[0]!.features, visualGrounding: value },
          }],
        });
        expect(parsed.entries[0]?.features?.visualGrounding).toBe(value);
      }
    }

    expect(ModelCatalogSchema.parse(base).entries[0]?.features?.visualGrounding).toBeUndefined();
    expect(() => ModelCatalogSchema.parse({
      ...base,
      entries: [{
        ...base.entries[0],
        features: { ...base.entries[0]!.features, visualGrounding: true, visualScore: 1 },
      }],
    })).toThrow();
  });

  test("sync snapshot reads the checked-in fallback before hydration (no network)", () => {
    // No hydration yet — sync read returns the checked-in fallback.
    const snap = getActiveModelCatalogSync();
    expect(snap.provenance.source).toBe("checked-in-fallback");
    expect(snap.catalog).toBe(localModelCatalog);
    expect(modelSupportsInput("venice:minimax-m3-preview", "image")).toBe(true);
    expect(modelSupportsFeature("venice:minimax-m3-preview", "reasoning")).toBe(true);
  });

  test("hydrate publishes a validated remote snapshot; sync reads see it", async () => {
    configureRemote(manifestPayload());
    const provenance = await hydrateRuntimeModelCatalog();
    expect(provenance.source).toBe("remote-fresh");
    expect(provenance.catalogVersion).toBe("2026.07.18.1");
    const snap = getActiveModelCatalogSync();
    expect(snap.provenance.source).toBe("remote-fresh");
    expect(snap.catalog.entries[0]?.id).toBe("anthropic:claude-test-7");
    expect(modelSupportsInput("anthropic:claude-test-7", "image")).toBe(true);
    expect(modelSupportsInput("venice:minimax-m3-preview", "image")).toBe(false);
  });

  test("reader-first hydration atomically exposes a signed v2 control snapshot while the current fallback remains compatible", async () => {
    const base = manifestPayload("2026.07.28.1");
    const manifest = ModelCatalogSchema.parse({
      ...base,
      version: 2,
      entries: [{
        ...base.entries[0],
        id: "fireworks:accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3 (Fireworks)",
        provider: "fireworks",
        routing: "fireworks",
        features: { tools: true, structuredOutputs: true, reasoning: false },
        controls: {
          serving: {
            defaultProfile: "standard",
            provenance: {
              kind: "provider-documentation",
              provider: "fireworks",
              verifiedAt: "2026-07-27T00:00:00Z",
            },
            profiles: [
              {
                id: "standard",
                label: "Standard",
                intent: "balanced",
                selector: { kind: "default" },
              },
              {
                id: "priority",
                label: "Priority",
                intent: "reliability",
                selector: {
                  kind: "request-parameter",
                  parameter: "service_tier",
                  value: "priority",
                },
              },
              {
                id: "fast",
                label: "Fast",
                intent: "throughput",
                selector: {
                  kind: "model-override",
                  modelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
                },
              },
            ],
          },
        },
      }],
    });
    configureRemote(manifest);

    await hydrateRuntimeModelCatalog();
    const snapshot = getActiveModelCatalogSync();
    expect(snapshot.catalog.version).toBe(2);
    if (snapshot.catalog.version !== 2) throw new Error("expected v2 control snapshot");
    expect(snapshot.catalog.entries[0]?.controls?.serving?.profiles.map((profile) => profile.id)).toEqual([
      "standard",
      "priority",
      "fast",
    ]);
    expect(localModelCatalog.version).toBe(4);
  });

  test("hydrate failure is non-fatal and leaves the checked-in fallback active", async () => {
    configureRuntimeModelCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: async () => jsonResponse("nope", { status: 503 }),
        trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
      },
    });
    const provenance = await hydrateRuntimeModelCatalog();
    expect(provenance.source).toBe("checked-in-fallback");
    expect(getActiveModelCatalogSync().catalog).toBe(localModelCatalog);
  });

  test("failed request kicks are throttled, single-flight, and make no double cold attempt", async () => {
    let now = 0;
    let fetchCount = 0;
    configureRuntimeModelCatalog({
      refreshNow: () => now,
      minRefreshIntervalMs: 60_000,
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => now,
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse("unavailable", { status: 503 });
        },
        trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
      },
    });

    // Boot hydrate is exactly one bounded cold attempt.
    await hydrateRuntimeModelCatalog();
    expect(fetchCount).toBe(1);

    // Sequential request kicks inside the negative throttle do no network I/O.
    kickRuntimeModelCatalogRefresh();
    kickRuntimeModelCatalogRefresh();
    expect(await refreshAndPublishRuntimeModelCatalog()).toBeNull();
    expect(fetchCount).toBe(1);

    // Once the interval elapses, concurrent kicks collapse to one attempt.
    now = 60_000;
    const first = refreshAndPublishRuntimeModelCatalog();
    const concurrent = refreshAndPublishRuntimeModelCatalog();
    expect(concurrent).toBe(first);
    const result = await first;
    expect(result?.source).toBe("checked-in-fallback");
    // One additional pointer fetch only: no refresh-then-get duplicate.
    expect(fetchCount).toBe(2);

    // The new failed attempt starts another throttle window.
    kickRuntimeModelCatalogRefresh();
    expect(await refreshAndPublishRuntimeModelCatalog()).toBeNull();
    expect(fetchCount).toBe(2);
  });

  test("hot refresh publishes B then rollback A without restart and is process-single-flight", async () => {
    const manifestA = manifestPayload("2026.07.18.1", "anthropic:claude-hot-a");
    const manifestB = manifestPayload("2026.07.18.2", "anthropic:claude-hot-b");
    const resultFor = (catalog: ModelCatalog) => ({
      catalog,
      source: "remote-fresh" as const,
      stale: false,
      fetchedAt: "2026-07-18T10:00:00.000Z",
      originUrl: POINTER_URL,
      reason: "",
      catalogVersion: catalog.catalogVersion,
    });
    let current: RemoteModelCatalogResult = resultFor(manifestA);
    let refreshCount = 0;
    let releaseRefresh!: () => void;
    let refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    configureRuntimeModelCatalog({
      minRefreshIntervalMs: 0,
      loader: {
        get: async () => current,
        refresh: async () => {
          refreshCount += 1;
          await refreshGate;
        },
        clearCache: () => {},
      },
    });

    await hydrateRuntimeModelCatalog();
    expect(getActiveModelCatalogSync().catalog.catalogVersion).toBe("2026.07.18.1");
    expect(modelSupportsInput("anthropic:claude-hot-a", "image")).toBe(true);

    current = resultFor(manifestB);
    kickRuntimeModelCatalogRefresh();
    kickRuntimeModelCatalogRefresh();
    const first = refreshAndPublishRuntimeModelCatalog();
    const concurrent = refreshAndPublishRuntimeModelCatalog();
    expect(concurrent).toBe(first);
    expect(refreshCount).toBe(1);
    releaseRefresh();
    await Promise.all([first, concurrent]);

    const rowsB = listResolvedCatalogModels({
      env: { ANTHROPIC_API_KEY: "x" },
      includeUnavailable: true,
    });
    expect(getActiveModelCatalogSync().catalog.catalogVersion).toBe("2026.07.18.2");
    expect(rowsB.map((row) => row.id)).toEqual(["anthropic:claude-hot-b"]);
    expect(modelSupportsInput("anthropic:claude-hot-a", "image")).toBe(false);
    expect(modelSupportsInput("anthropic:claude-hot-b", "image")).toBe(true);

    current = resultFor(manifestA);
    refreshGate = Promise.resolve();
    await refreshAndPublishRuntimeModelCatalog();
    const rowsA = listResolvedCatalogModels({
      env: { ANTHROPIC_API_KEY: "x" },
      includeUnavailable: true,
    });
    expect(getActiveModelCatalogSync().catalog.catalogVersion).toBe("2026.07.18.1");
    expect(rowsA.map((row) => row.id)).toEqual(["anthropic:claude-hot-a"]);
    expect(modelSupportsInput("anthropic:claude-hot-a", "image")).toBe(true);
    expect(modelSupportsInput("anthropic:claude-hot-b", "image")).toBe(false);

    current = {
      catalog: localModelCatalog,
      source: "checked-in-fallback",
      stale: true,
      fetchedAt: null,
      originUrl: POINTER_URL,
      reason: "simulated outage",
      catalogVersion: localModelCatalog.catalogVersion,
    };
    await refreshAndPublishRuntimeModelCatalog();
    expect(getActiveModelCatalogSync().catalog.catalogVersion).toBe("2026.07.18.1");
  });

  test("remote metadata cannot make an unsupported provider runnable", async () => {
    // Inject through the runtime-loader seam to exercise the local
    // defense-in-depth gate independently of signer/schema validation.
    const manifest: ModelCatalog = {
      version: 1,
      catalogVersion: "2026.07.18.1",
      publishedAt: "2026-07-18T10:00:00Z",
      entries: [
        {
          id: "newprovider:vortex-99",
          displayName: "Vortex 99 (NewProvider)",
          provider: "newprovider",
          routing: "first-party",
          priority: 1,
          defaultEnabled: true,
          limits: { contextTokens: 128_000, outputTokens: 8_000 },
          cost: { coefficient: 1 },
          privacy: { grade: 5 },
          intelligence: { tier: "strong" },
        },
      ],
    };
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog: manifest,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-18T10:00:00.000Z",
          originUrl: POINTER_URL,
          reason: "",
          catalogVersion: manifest.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();
    const rows = listResolvedCatalogModels({ env: {}, includeUnavailable: true });
    const row = rows.find((r) => r.id === "newprovider:vortex-99");
    expect(row).toBeDefined();
    expect(row?.availability).toBe("disabled");
    expect(row?.unavailableReason).toContain("not supported");
  });

  test("remote metadata cannot supply URLs/credentials or make China routing consent true", async () => {
    const manifest = ModelCatalogSchema.parse({
      version: 1,
      catalogVersion: "2026.07.18.1",
      publishedAt: "2026-07-18T10:00:00Z",
      entries: [
        {
          id: "venice:qwen-3-6-plus",
          displayName: "Qwen 3.6 Plus (Venice → Alibaba)",
          provider: "venice",
          routing: "china-anonymized",
          priority: 33,
          defaultEnabled: true,
          modalities: { input: ["text"], output: ["text"] },
          features: { tools: true, structuredOutputs: false, reasoning: true },
          limits: { contextTokens: 1_000_000, outputTokens: 65_536 },
          cost: { coefficient: 0.38 },
          privacy: { grade: 5 },
          intelligence: { tier: "strong" },
          capabilityProvenance: "override",
        },
      ],
    });
    configureRemote(manifest);
    await hydrateRuntimeModelCatalog();
    // Without local allowChinaUpstream opt-in, the remote china-anonymized row
    // stays routing_filtered even though the remote catalog published it.
    const filtered = listResolvedCatalogModels({
      env: { VENICE_API_KEY: "vk-test" },
      allowChinaUpstream: false,
      includeUnavailable: true,
    });
    const row = filtered.find((r) => r.id === "venice:qwen-3-6-plus");
    expect(row?.availability).toBe("routing_filtered");
    // With the LOCAL opt-in, it becomes selectable — consent is never remote.
    const opted = listResolvedCatalogModels({
      env: { VENICE_API_KEY: "vk-test" },
      allowChinaUpstream: true,
      includeUnavailable: true,
    });
    expect(opted.find((r) => r.id === "venice:qwen-3-6-plus")?.availability).toBe("selectable");
  });

  test("local credentials restrict a remote defaultEnabled=true row when no key is present", async () => {
    const manifest = manifestPayload("2026.07.18.1", "anthropic:claude-test-7");
    configureRemote(manifest);
    await hydrateRuntimeModelCatalog();
    const rows = listResolvedCatalogModels({ env: {}, includeUnavailable: true });
    const row = rows.find((r) => r.id === "anthropic:claude-test-7");
    expect(row?.availability).toBe("missing_credentials");
    expect(row?.unavailableReason).toBe("Anthropic credential is not configured");
  });

  test("no request-path fetch: sync catalog reads never touch the network", () => {
    const original = globalThis.fetch;
    let called = 0;
    (globalThis as { fetch: unknown }).fetch = () => {
      called++;
      throw new Error("fetch must not be called during sync catalog reads");
    };
    try {
      // Before any hydration, sync reads use the checked-in fallback.
      listResolvedCatalogModels({ env: {}, includeUnavailable: true });
      getActiveModelCatalogProvenance();
      expect(called).toBe(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });

  test("consumer consistency: discover/list/validate agree on the active snapshot membership", async () => {
    const manifest = manifestPayload("2026.07.18.1", "anthropic:claude-test-7");
    configureRemote(manifest);
    await hydrateRuntimeModelCatalog();
    const listed = listResolvedCatalogModels({ env: { ANTHROPIC_API_KEY: "x" }, includeUnavailable: true });
    expect(listed.map((r) => r.id)).toEqual(["anthropic:claude-test-7"]);
    // The provenance exposed to callers is non-secret (no URL / key material).
    const prov = getActiveModelCatalogProvenance();
    expect(prov.catalogVersion).toBe("2026.07.18.1");
    expect(prov).not.toHaveProperty("originUrl");
    expect(JSON.stringify(prov)).not.toContain("media.nautilo.ai");
  });

  test("getRuntimeModelCatalog returns truthful provenance without leaking secrets", async () => {
    configureRemote(manifestPayload());
    const result = await getRuntimeModelCatalog();
    expect(result.source).toBe("remote-fresh");
    expect(result.catalogVersion).toBe("2026.07.18.1");
    expect(getActiveModelCatalogSync().catalog.catalogVersion).toBe("2026.07.18.1");
    // The result exposes the configured origin URL for diagnostics, but never
    // signing keys or credentials.
    expect(result.originUrl).toBe(OFFICIAL_MODEL_CATALOG_POINTER_URL);
    expect(JSON.stringify(result)).not.toContain("publicKeyB64");
  });
});
