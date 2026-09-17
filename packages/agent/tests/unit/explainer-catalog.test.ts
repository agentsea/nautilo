import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  EXPLAINER_CATALOG_MAX_PAGE_SIZE,
  ExplainerCatalogListResultSchema,
  ExplainerCatalogSchema,
  canonicalExplainerCatalogSigningPayload,
  type ExplainerCatalog,
} from "@nautilo/types";
import {
  localExplainerCatalog,
  parseExplainerCatalog,
  resolveLocalExplainerDetail,
  searchExplainerCatalog,
  searchLocalExplainerCatalog,
} from "../../src/media/explainer-catalog/catalog";
import {
  createRemoteExplainerCatalogLoader,
  type RemoteExplainerCatalogConfig,
} from "../../src/media/explainer-catalog/remote-catalog";
import {
  EXPLAINER_MEDIA_ORIGIN_ENV,
  OFFICIAL_EXPLAINER_CATALOG_URL,
  OFFICIAL_EXPLAINER_MEDIA_ORIGIN,
  configureRuntimeExplainerCatalog,
  getRuntimeExplainerCatalog,
  mapExplainerCatalogProvenance,
  mapExplainerCatalogSource,
  resetRuntimeExplainerCatalog,
  resolveExplainerMediaOrigin,
} from "../../src/media/explainer-catalog/runtime-catalog";
import {
  resetTrustedExplainerCatalogKeysForTests,
  setTrustedExplainerCatalogKeysForTests,
} from "../../src/media/explainer-catalog/trusted-keys";

describe("D416 Phase 1 — local explainer catalog", () => {
  test("resolves checked-in transcribed demo metadata", () => {
    const result = searchLocalExplainerCatalog({
      tool: {
        name: "regenerate_soul",
        category: "settings",
        tags: ["personality"],
      },
    });

    expect(result.source).toBe("local");
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("launch-04-customize");

    const detail = resolveLocalExplainerDetail("launch-04-customize");
    expect(detail).toMatchObject({
      id: "launch-04-customize",
      asset: {
        provider: "bunny-storage",
        key: "explainers/2026.09.07.1/nautilo-04-customize-captioned-neon-hq.mp4",
        format: "mp4",
      },
    });
    expect(detail?.asset.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof detail?.asset.byteLength).toBe("number");
    expect(detail).not.toHaveProperty("embedUrl");
    expect(detail).not.toHaveProperty("playbackUrl");
  });

  test("seed includes the refreshed September launch films", () => {
    expect(localExplainerCatalog.catalogVersion).toBe("2026.09.17.1");
    expect(localExplainerCatalog.publishedAt).toBe("2026-09-17T14:00:00Z");
    expect(localExplainerCatalog.entries).toHaveLength(16);
    for (const entry of localExplainerCatalog.entries) {
      expect(entry.asset.provider).toBe("bunny-storage");
      expect(entry.asset.format).toBe("mp4");
      expect(entry.asset.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.asset.byteLength).toBeGreaterThan(0);
    }
  });

  test("launch discovery includes every film, starts with the hero, and excludes retired films", () => {
    const result = searchLocalExplainerCatalog({ query: "launch", pageSize: 20 });
    expect(result.total).toBe(16);
    expect(result.items).toHaveLength(16);
    expect(result.hasMore).toBe(false);
    expect(result.items[0]?.id).toBe("launch-hero");
    expect(result.items.some((entry) => entry.id === "launch-13-android-mobile")).toBe(true);
    for (const entry of localExplainerCatalog.entries) {
      expect(entry.captionsAvailable).toBe(true);
    }
    for (const retiredId of ["multi-user-multi-agent-chat", "third-party-app-control", "co-create-in-writer", "adaptive-teacher-mode", "agent-delegation", "customize-your-genie"]) {
      expect(resolveLocalExplainerDetail(retiredId)).toBeUndefined();
    }
  });

  test("discovers Browser Use and Video Kung Fu through their product tools", () => {
    expect(searchLocalExplainerCatalog({ tool: { name: "run_website_task", tags: [] } })
      .items[0]?.id).toBe("launch-14-browser-use");
    expect(searchLocalExplainerCatalog({ query: "timeline", tool: { name: "generate_video", tags: [] } })
      .items[0]?.id).toBe("launch-15-video-kung-fu");
    expect(resolveLocalExplainerDetail("launch-hero")?.durationSeconds).toBe(87);
    expect(resolveLocalExplainerDetail("launch-15-video-kung-fu")?.durationSeconds).toBe(136);
  });

  test("rejects malformed catalog manifests", () => {
    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [
          {
            ...localExplainerCatalog.entries[0],
            id: "invalid uppercase",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [localExplainerCatalog.entries[0], localExplainerCatalog.entries[0]],
      }),
    ).toThrow();
  });

  test("requires valid immutable catalog release metadata", () => {
    const { catalogVersion: _catalogVersion, ...withoutCatalogVersion } = localExplainerCatalog;
    const { publishedAt: _publishedAt, ...withoutPublishedAt } = localExplainerCatalog;

    expect(() => parseExplainerCatalog(withoutCatalogVersion)).toThrow();
    expect(() => parseExplainerCatalog(withoutPublishedAt)).toThrow();
    expect(() =>
      parseExplainerCatalog({ ...localExplainerCatalog, catalogVersion: "2026-07-12.1" }),
    ).toThrow();
    expect(() =>
      parseExplainerCatalog({ ...localExplainerCatalog, catalogVersion: "2026.07.17.0" }),
    ).toThrow();
    expect(() =>
      parseExplainerCatalog({ ...localExplainerCatalog, publishedAt: "2026-07-12T16:34:00" }),
    ).toThrow();
    expect(() =>
      parseExplainerCatalog({ ...localExplainerCatalog, publishedAt: "2026-07-12T18:34:00+02:00" }),
    ).toThrow();
  });

  test("rejects non-bunny-storage providers, non-mp4 formats, and missing hash/length", () => {
    const entry = localExplainerCatalog.entries[0]!;
    // bunny-stream / hls are now rejected by the strict asset schema.
    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [
          { ...entry, asset: { ...entry.asset, provider: "bunny-stream" as never } },
          { ...entry, id: "generic-provider", asset: { ...entry.asset, provider: "acme-video" as never } },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [{ ...entry, asset: { ...entry.asset, format: "hls" as never } }],
      }),
    ).toThrow();
    // Missing contentSha256 / byteLength are rejected.
    const { contentSha256: _sha, ...assetWithoutSha } = entry.asset;
    const { byteLength: _len, ...assetWithoutLen } = entry.asset;
    void _sha;
    void _len;
    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [{ ...entry, asset: assetWithoutSha as never }],
      }),
    ).toThrow();
    expect(() =>
      parseExplainerCatalog({
        ...localExplainerCatalog,
        entries: [{ ...entry, asset: assetWithoutLen as never }],
      }),
    ).toThrow();
  });

  test("rejects URLs, tokens, and secret-shaped asset objects", () => {
    const entry = localExplainerCatalog.entries[0]!;

    for (const forbiddenField of [
      { embedUrl: "https://evil.example/embed/video" },
      { playbackUrl: "https://video.example/play" },
      { signingKey: "not-a-real-secret" },
      { apiKey: "not-a-real-secret" },
    ]) {
      expect(() =>
        parseExplainerCatalog({
          ...localExplainerCatalog,
          entries: [{ ...entry, ...forbiddenField }],
        }),
      ).toThrow();
    }

    for (const asset of [
      { ...entry.asset, key: "https://video.example/not-an-id" },
      { ...entry.asset, key: "/leading-slash.mp4" },
      { ...entry.asset, key: "../traversal.mp4" },
      { ...entry.asset, provider: "https://video.example" as never },
      { ...entry.asset, token: "not-a-real-token" },
      { ...entry.asset, signingKey: "not-a-real-secret" },
      { ...entry.asset, playbackUrl: "https://video.example/play" },
    ]) {
      expect(() =>
        parseExplainerCatalog({
          ...localExplainerCatalog,
          entries: [{ ...entry, asset }],
        }),
      ).toThrow();
    }
  });

  test("paginates results and enforces bounded list DTOs", () => {
    const firstPage = searchLocalExplainerCatalog({ page: 1, pageSize: 2 });
    const secondPage = searchLocalExplainerCatalog({ page: 2, pageSize: 2 });

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.catalogVersion).toBe("2026.09.17.1");
    expect(firstPage.total).toBe(16);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.hasMore).toBe(true);

    expect(() => searchLocalExplainerCatalog({ pageSize: EXPLAINER_CATALOG_MAX_PAGE_SIZE + 1 })).toThrow();
    expect(() =>
      ExplainerCatalogListResultSchema.parse({
        ...firstPage,
        items: Array.from({ length: EXPLAINER_CATALOG_MAX_PAGE_SIZE + 1 }, () => firstPage.items[0]!),
      }),
    ).toThrow();
  });

  test("includes the grounded Writer co-creation walkthrough", () => {
    const detail = resolveLocalExplainerDetail("launch-02-writer");

    expect(detail).toMatchObject({
      title: "Co-Create in Writer with Genie",
      asset: {
        provider: "bunny-storage",
        key: "explainers/2026.09.07.1/nautilo-02-writer-captioned-neon-hq.mp4",
        format: "mp4",
      },
      durationSeconds: 49,
      captionsAvailable: true,
    });
    expect(detail?.description).toContain("suggested corrections");
  });
});
const POINTER_URL = "https://media.nautilo.ai/catalog/latest.json";
const EXPLAINER_DOMAIN = "nautilo-explainer-catalog-v1";
const MODEL_DOMAIN = "nautilo-model-catalog-v1";

/** A minimal valid explainer manifest distinct from the checked-in seed. */
function manifestPayload(
  catalogVersion = "2026.09.18.1",
  id = "remote-demo",
): ExplainerCatalog {
  return ExplainerCatalogSchema.parse({
    version: 1,
    catalogVersion,
    publishedAt: "2026-09-18T10:00:00Z",
    entries: [
      {
        id,
        asset: {
          provider: "bunny-storage",
          key: "explainers/remote-walkthrough.mp4",
          format: "mp4",
          contentSha256: "a".repeat(64),
          byteLength: 1024,
        },
        title: "Remote Demo Explainer",
        summary: "A summary fetched from the official remote catalog.",
        description: "A description fetched from the official remote catalog.",
        tags: ["remote", "demo"],
        toolReferences: [{ name: "find_voice", category: "settings", tags: ["remote"] }],
        durationSeconds: 42,
        publishedAt: "2026-09-18",
        captionsAvailable: true,
      },
    ],
  });
}

/** Generate an Ed25519 key pair and return base64 DER SPKI public + signing fn. */
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

/** Build a signed pointer + immutable manifest body for a given manifest. */
function buildSignedRelease(
  manifest: ExplainerCatalog,
  key: ReturnType<typeof makeTestKey>,
  domain: string = EXPLAINER_DOMAIN,
): { pointer: object; immutableBody: string } {
  const immutableBody = `${JSON.stringify(manifest)}\n`;
  const artifactSha256 = createHash("sha256").update(immutableBody, "utf8").digest("hex");
  const payload = canonicalExplainerCatalogSigningPayload(manifest.catalogVersion, artifactSha256);
  // canonicalExplainerCatalogSigningPayload always uses the explainer domain; for
  // the domain-separation test we re-derive the payload with the model domain.
  const usedPayload =
    domain === EXPLAINER_DOMAIN
      ? payload
      : `${domain}\ncatalogVersion=${manifest.catalogVersion}\nartifactSha256=${artifactSha256}\n`;
  const pointer = {
    catalogVersion: manifest.catalogVersion,
    artifactSha256,
    signature: key.signPayload(usedPayload),
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
  config: RemoteExplainerCatalogConfig;
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
  const version = "2026.09.18.1";
  const manifestUrl = `https://media.nautilo.ai/catalog/catalog-${version}.json`;
  const defaultManifest = manifestPayload(version);
  const { pointer: defaultPointer, immutableBody: defaultBody } = buildSignedRelease(
    defaultManifest,
    key,
  );
  const pointer = opts.pointer ?? defaultPointer;
  const immutableBody = opts.immutableBody ?? defaultBody;
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
  const config: RemoteExplainerCatalogConfig = {
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

describe("D429 Phase 7.4.1 — signed pointer + immutable artifact explainer loader", () => {
  let key: ReturnType<typeof makeTestKey>;

  beforeEach(() => {
    key = makeTestKey();
  });

  test("fetches the pointer then the derived same-origin immutable manifest and serves fresh", async () => {
    const h = makeHarness(key);
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();

    expect(result.source).toBe("remote-fresh");
    expect(result.stale).toBe(false);
    expect(result.originUrl).toBe(POINTER_URL);
    expect(result.catalogVersion).toBe("2026.09.18.1");
    expect(result.catalog.entries[0]?.id).toBe("remote-demo");
    expect(result.fetchedAt).toBe(new Date(0).toISOString());
    expect(h.fetches.map((f) => f.url)).toEqual([
      "https://media.nautilo.ai/catalog/latest.json",
      "https://media.nautilo.ai/catalog/catalog-2026.09.18.1.json",
    ]);
  });

  test("verifies the Ed25519 signature and exact immutable SHA-256 before activation", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const h = makeHarness(key, { pointer, immutableBody });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("remote-fresh");
    expect(result.catalog.entries[0]?.id).toBe("remote-demo");
  });

  test("a valid stale signed release cannot resurrect retired films over the bundled catalogue", async () => {
    const older = manifestPayload("2026.07.17.1", "customize-your-genie");
    const { pointer, immutableBody } = buildSignedRelease(older, key);
    const h = makeHarness(key);
    h.setFetch(async (url) => jsonResponse(url === POINTER_URL ? pointer : immutableBody));
    const result = await createRemoteExplainerCatalogLoader(h.config).get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("older than the bundled release");
    expect(result.catalog.catalogVersion).toBe(localExplainerCatalog.catalogVersion);
    expect(result.catalog.entries).toHaveLength(16);
    expect(result.catalog.entries.some((entry) => entry.id === "customize-your-genie")).toBe(false);
  });

  test("accepts the same bundled release and compares revision numbers numerically", async () => {
    for (const version of [localExplainerCatalog.catalogVersion, "2026.09.17.10"]) {
      const { pointer, immutableBody } = buildSignedRelease(manifestPayload(version), key);
      const h = makeHarness(key);
      h.setFetch(async (url) => jsonResponse(url === POINTER_URL ? pointer : immutableBody));
      const result = await createRemoteExplainerCatalogLoader(h.config).get();
      expect(result.source).toBe("remote-fresh");
      expect(result.catalogVersion).toBe(version);
    }
  });

  test("the previous September catalog cannot restore the old hero or hide the new films", async () => {
    const older = manifestPayload("2026.09.07.1", "launch-hero");
    const { pointer, immutableBody } = buildSignedRelease(older, key);
    const h = makeHarness(key, { pointer, immutableBody });
    h.setFetch(async (url) => jsonResponse(url === POINTER_URL ? pointer : immutableBody));
    const result = await createRemoteExplainerCatalogLoader(h.config).get();

    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("older than the bundled release");
    expect(result.catalog.entries.find((entry) => entry.id === "launch-hero"))
      .toEqual(resolveLocalExplainerDetail("launch-hero"));
    expect(result.catalog.entries.some((entry) => entry.id === "launch-14-browser-use")).toBe(true);
    expect(result.catalog.entries.some((entry) => entry.id === "launch-15-video-kung-fu")).toBe(true);
  });

  test("rejects a tampered immutable artifact (SHA-256 mismatch) and falls back to seed", async () => {
    const manifest = manifestPayload();
    const { pointer } = buildSignedRelease(manifest, key);
    const tampered = `${JSON.stringify({ ...manifest, publishedAt: "2026-09-18T11:00:00Z" })}\n`;
    const h = makeHarness(key, { pointer, immutableBody: tampered });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.catalog).toBe(localExplainerCatalog);
    expect(result.reason).toContain("SHA-256");
  });

  test("rejects a bad signature and falls back to seed", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const badSig = Buffer.from(new Uint8Array(64).fill(7)).toString("base64");
    const h = makeHarness(key, { pointer: { ...pointer, signature: badSig }, immutableBody });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("signature");
  });

  test("rejects an unknown signingKeyId and falls back to seed", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const h = makeHarness(key, {
      pointer: { ...pointer, signingKeyId: "not-in-registry" },
      immutableBody,
    });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("unknown signingKeyId");
  });

  test("falls back to seed when the trusted registry is empty (official production until Phase 8)", async () => {
    const manifest = manifestPayload();
    const { pointer, immutableBody } = buildSignedRelease(manifest, key);
    const manifestUrl = `https://media.nautilo.ai/catalog/catalog-2026.09.18.1.json`;
    const loader = createRemoteExplainerCatalogLoader({
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
      // No trustedKeys => falls back to the (empty) checked-in registry.
    });
    setTrustedExplainerCatalogKeysForTests(null);
    try {
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
      expect(result.reason).toContain("unknown signingKeyId");
    } finally {
      resetTrustedExplainerCatalogKeysForTests();
    }
  });

  test("domain separation: a pointer signed over the model domain is rejected", async () => {
    const manifest = manifestPayload();
    // Sign with the MODEL domain payload; the loader verifies against the
    // explainer domain, so the signature must NOT verify.
    const { pointer, immutableBody } = buildSignedRelease(manifest, key, MODEL_DOMAIN);
    const h = makeHarness(key, { pointer, immutableBody });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("signature");
  });

  test("rejects a malformed pointer (extra/missing fields, bad version) and falls back to seed", async () => {
    for (const bad of [
      { catalogVersion: "2026.09.18.1", artifactSha256: "a".repeat(64), signature: Buffer.from(new Uint8Array(64)).toString("base64"), signingKeyId: "test-key-1", extra: "evil" },
      { catalogVersion: "2026.09.18.1", artifactSha256: "a".repeat(64), signingKeyId: "test-key-1" },
      { catalogVersion: "bad-version", artifactSha256: "a".repeat(64), signature: Buffer.from(new Uint8Array(64)).toString("base64"), signingKeyId: "test-key-1" },
      "not-an-object",
    ]) {
      const h = makeHarness(key, { pointer: bad });
      const loader = createRemoteExplainerCatalogLoader(h.config);
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
      expect(h.fetches.map((f) => f.url)).toEqual([POINTER_URL]);
    }
  });

  test("rejects an unsigned one-field pointer and falls back to seed", async () => {
    // The old unsigned `{ catalogVersion }` pointer must be rejected.
    const h = makeHarness(key, { pointer: { catalogVersion: "2026.09.18.1" } });
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(h.fetches.map((f) => f.url)).toEqual([POINTER_URL]);
  });

  test("rejects a full-manifest body served at the pointer URL (no unsigned bypass)", async () => {
    // A full manifest is not a valid signed pointer; the loader must reject it
    // rather than activating it as an unsigned manifest.
    const h = makeHarness(key, { pointer: manifestPayload() });
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
  });

  test("rejects a pointer/manifest catalogVersion mismatch and falls back to seed", async () => {
    const mismatched = manifestPayload("2026.09.18.2");
    const mismatchedBody = `${JSON.stringify(mismatched)}\n`;
    const artifactSha256 = createHash("sha256").update(mismatchedBody, "utf8").digest("hex");
    const payload = canonicalExplainerCatalogSigningPayload("2026.09.18.1", artifactSha256);
    const badPointer = {
      catalogVersion: "2026.09.18.1",
      artifactSha256,
      signature: key.signPayload(payload),
      signingKeyId: key.signingKeyId,
    };
    const h = makeHarness(key, { pointer: badPointer, immutableBody: mismatchedBody });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("catalogVersion");
  });

  test("rejects a schema-invalid manifest and falls back to seed", async () => {
    const h = makeHarness(key, {
      immutableBody: `${JSON.stringify({ version: 999, catalogVersion: "2026.09.18.1", publishedAt: "2026-09-18T10:00:00Z", entries: [] })}\n`,
    });
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
  });

  test("serves fresh cache within TTL, then stale + background-refresh, then fresh", async () => {
    let now = 0;
    const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 2000 });
    const loader = createRemoteExplainerCatalogLoader(h.config);

    await loader.get();
    expect(h.fetches).toHaveLength(2);
    now = 500;
    await loader.get();
    expect(h.fetches).toHaveLength(2);

    now = 1500;
    const stale = await loader.get();
    expect(stale.source).toBe("remote-stale");
    await loader.refresh();
    const refreshed = await loader.get();
    expect(refreshed.source).toBe("remote-fresh");
  });

  test("serves last-known-good when a forced refresh fails (outage)", async () => {
    let now = 0;
    const h = makeHarness(key, { now: () => now, ttlMs: 1000, staleMs: 1000 });
    const loader = createRemoteExplainerCatalogLoader(h.config);
    await loader.get();
    h.setFetch(async () => jsonResponse("nope", { status: 503 }));
    now = 10_000;
    const result = await loader.get();
    expect(result.source).toBe("remote-stale");
    expect(result.catalog.catalogVersion).toBe("2026.09.18.1");
  });

  test("falls back to seed when remote fails and no cache exists (bootstrap)", async () => {
    const h = makeHarness(key);
    h.setFetch(async () => jsonResponse("nope", { status: 503 }));
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.catalog).toBe(localExplainerCatalog);
    expect(result.reason).toContain("503");
  });

  test("refresh is single-flight", async () => {
    const h = makeHarness(key);
    const loader = createRemoteExplainerCatalogLoader(h.config);
    loader.clearCache();
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    expect(h.fetches).toHaveLength(2);
  });

  test("clearCache forces the next get() to refetch", async () => {
    const h = makeHarness(key);
    const loader = createRemoteExplainerCatalogLoader(h.config);
    await loader.get();
    expect(h.fetches).toHaveLength(2);
    loader.clearCache();
    await loader.get();
    expect(h.fetches).toHaveLength(4);
  });

  test("rejects non-HTTPS / credentials / query / fragment / forbidden-IP pointer URLs at construction", () => {
    for (const bad of [
      "http://media.nautilo.ai/catalog/latest.json",
      "https://user:pass@media.nautilo.ai/catalog/latest.json",
      "https://media.nautilo.ai/catalog/latest.json?v=2",
      "https://media.nautilo.ai/catalog/latest.json#section",
      "https://127.0.0.1/catalog/latest.json",
      "https://10.0.0.1/catalog/latest.json",
      "https://[::1]/catalog/latest.json",
    ]) {
      expect(() =>
        createRemoteExplainerCatalogLoader({ catalogPointerUrl: bad, fetchImpl: async () => jsonResponse("") }),
      ).toThrow();
    }
  });

  test("rejects 3xx / non-200 / non-JSON content type and falls back to seed", async () => {
    const cases: { status?: number; headers?: Record<string, string> }[] = [
      { status: 302, headers: { location: "https://evil.example/x" } },
      { status: 503 },
      { headers: { "content-type": "text/plain" } },
    ];
    for (const c of cases) {
      const h = makeHarness(key);
      h.setFetch(async () => jsonResponse("body", c));
      const loader = createRemoteExplainerCatalogLoader(h.config);
      const result = await loader.get();
      expect(result.source).toBe("checked-in-fallback");
    }
  });

  test("enforces the response byte cap and falls back to seed", async () => {
    const h = makeHarness(key, { maxBytes: 64 });
    h.setFetch(async () => jsonResponse("x".repeat(10_000)));
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("byte limit");
  });

  test("rejects invalid UTF-8 bodies and falls back to seed", async () => {
    const h = makeHarness(key);
    const invalid = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21]);
    h.setFetch(async () =>
      new Response(invalid, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("UTF-8");
  });

  test("aborts a slow fetch / slow body read and falls back to seed", async () => {
    const h = makeHarness(key, { timeoutMs: 10 });
    h.setFetch(() => new Promise<Response>(() => { /* never resolves */ }));
    const loader = createRemoteExplainerCatalogLoader(h.config);
    const result = await loader.get();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).toContain("timed out");
  });

  test("serves seed when no pointer URL is configured (remote disabled)", async () => {
    const loader = createRemoteExplainerCatalogLoader({
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
    expect(result.catalog).toBe(localExplainerCatalog);
  });
});

describe("D429 Phase 7.4 — runtime explainer catalog seam", () => {
  const originalPointerEnv = process.env["NAUTILO_EXPLAINER_CATALOG_POINTER_URL"];
  const originalMediaEnv = process.env[EXPLAINER_MEDIA_ORIGIN_ENV];

  beforeEach(() => {
    resetRuntimeExplainerCatalog();
    delete process.env["NAUTILO_EXPLAINER_CATALOG_POINTER_URL"];
    delete process.env[EXPLAINER_MEDIA_ORIGIN_ENV];
  });

  afterEach(() => {
    resetRuntimeExplainerCatalog();
    if (originalPointerEnv === undefined) {
      delete process.env["NAUTILO_EXPLAINER_CATALOG_POINTER_URL"];
    } else {
      process.env["NAUTILO_EXPLAINER_CATALOG_POINTER_URL"] = originalPointerEnv;
    }
    if (originalMediaEnv === undefined) {
      delete process.env[EXPLAINER_MEDIA_ORIGIN_ENV];
    } else {
      process.env[EXPLAINER_MEDIA_ORIGIN_ENV] = originalMediaEnv;
    }
  });

  test("ships the verified official media.nautilo.ai defaults", () => {
    expect(OFFICIAL_EXPLAINER_CATALOG_URL).toBe("https://media.nautilo.ai/catalog/latest.json");
    expect(OFFICIAL_EXPLAINER_MEDIA_ORIGIN).toBe("https://media.nautilo.ai/");
  });

  test("searchExplainerCatalog forwards provenance into the bounded list DTO", () => {
    const fresh = searchExplainerCatalog(localExplainerCatalog, {}, { source: "remote", stale: false });
    const stale = searchExplainerCatalog(localExplainerCatalog, {}, { source: "local", stale: true });
    expect(fresh.source).toBe("remote");
    expect(fresh.stale).toBe(false);
    expect(stale.source).toBe("local");
    expect(stale.stale).toBe(true);
  });

  test("mapExplainerCatalogSource maps each loader source truthfully", () => {
    expect(mapExplainerCatalogSource("remote-fresh")).toEqual({ source: "remote", stale: false });
    expect(mapExplainerCatalogSource("remote-stale")).toEqual({ source: "remote", stale: true });
    expect(mapExplainerCatalogSource("checked-in-fallback")).toEqual({ source: "local", stale: true });
  });

  test("mapExplainerCatalogProvenance maps a full result", () => {
    expect(mapExplainerCatalogProvenance({
      catalog: localExplainerCatalog,
      source: "remote-fresh",
      stale: false,
      fetchedAt: "2026-09-18T00:00:00.000Z",
      originUrl: OFFICIAL_EXPLAINER_CATALOG_URL,
      reason: "",
      catalogVersion: "2026.09.18.1",
    })).toEqual({ source: "remote", stale: false });
    expect(mapExplainerCatalogProvenance({
      catalog: localExplainerCatalog,
      source: "checked-in-fallback",
      stale: true,
      fetchedAt: null,
      originUrl: null,
      reason: "unavailable",
      catalogVersion: null,
    })).toEqual({ source: "local", stale: true });
  });

  test("runtime loader disables remote and serves seed when catalogPointerUrl is null", async () => {
    configureRuntimeExplainerCatalog({
      catalogPointerUrl: null,
      remoteConfig: {
        fetchImpl: async () => {
          throw new Error("must not fetch when remote is disabled");
        },
      },
    });
    const result = await getRuntimeExplainerCatalog();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.stale).toBe(true);
    expect(result.originUrl).toBeNull();
    expect(result.catalog).toBe(localExplainerCatalog);
  });

  test("runtime seam never fetches a URL other than the resolved official pointer + derived manifest", async () => {
    const key = makeTestKey();
    const { pointer, immutableBody } = buildSignedRelease(manifestPayload(), key);
    const manifestUrl = "https://media.nautilo.ai/catalog/catalog-2026.09.18.1.json";
    const fetches: string[] = [];
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: async (url) => {
          fetches.push(url);
          if (url === OFFICIAL_EXPLAINER_CATALOG_URL) return jsonResponse(pointer);
          if (url === manifestUrl) return jsonResponse(immutableBody);
          return jsonResponse("not found", { status: 404 });
        },
        trustedKeys: { [key.signingKeyId]: key.publicKeyB64 },
      },
    });
    await getRuntimeExplainerCatalog();
    await getRuntimeExplainerCatalog();
    for (const url of fetches) {
      expect(url === OFFICIAL_EXPLAINER_CATALOG_URL || url === manifestUrl).toBe(true);
    }
  });

  test("configureRuntimeExplainerCatalog resets the cached loader", async () => {
    let firstCalled = 0;
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: async () => {
          firstCalled += 1;
          return jsonResponse("nope", { status: 503 });
        },
      },
    });
    await getRuntimeExplainerCatalog();
    let secondCalled = 0;
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: async () => {
          secondCalled += 1;
          return jsonResponse("nope", { status: 503 });
        },
      },
    });
    await getRuntimeExplainerCatalog();
    expect(firstCalled).toBe(1);
    expect(secondCalled).toBe(1);
  });

  test("resolveExplainerMediaOrigin uses the official default when no override is set", () => {
    expect(resolveExplainerMediaOrigin().toString()).toBe(OFFICIAL_EXPLAINER_MEDIA_ORIGIN);
  });

  test("resolveExplainerMediaOrigin accepts a valid HTTPS override", () => {
    process.env[EXPLAINER_MEDIA_ORIGIN_ENV] = "https://cdn.selfhost.example.test";
    expect(resolveExplainerMediaOrigin().toString()).toBe("https://cdn.selfhost.example.test/");
  });

  test("resolveExplainerMediaOrigin rejects invalid overrides", () => {
    for (const invalid of [
      "http://storage.example.test",
      "https://user:password@storage.example.test",
      "https://storage.example.test/videos",
      "https://storage.example.test?token=not-allowed",
      "https://storage.example.test#fragment",
      "not-a-url",
    ]) {
      process.env[EXPLAINER_MEDIA_ORIGIN_ENV] = invalid;
      expect(() => resolveExplainerMediaOrigin()).toThrow();
    }
  });
});
