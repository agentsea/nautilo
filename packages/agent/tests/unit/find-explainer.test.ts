import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ExplainerCatalogListResultSchema,
  ExplainerCatalogSchema,
  canonicalExplainerCatalogSigningPayload,
  type ExplainerCatalog,
} from "@nautilo/types";
import { createFindExplainerTool } from "../../src/tools/media/find-explainer";
import {
  OFFICIAL_EXPLAINER_CATALOG_URL,
  configureRuntimeExplainerCatalog,
  resetRuntimeExplainerCatalog,
} from "../../src/media/explainer-catalog/runtime-catalog";
import {
  resetTrustedExplainerCatalogKeysForTests,
  setTrustedExplainerCatalogKeysForTests,
} from "../../src/media/explainer-catalog/trusted-keys";
import type { RemoteExplainerCatalogConfig } from "../../src/media/explainer-catalog/remote-catalog";

const POINTER_URL = OFFICIAL_EXPLAINER_CATALOG_URL;
const POINTER_ENV = "NAUTILO_EXPLAINER_CATALOG_POINTER_URL";
const SEED_VERSION = "2026.09.07.1";
const SEED_PUBLISHED_AT = "2026-09-07T19:46:43Z";

function parseResponse(raw: string) {
  return ExplainerCatalogListResultSchema.parse(JSON.parse(raw) as unknown);
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

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

/** A valid signed remote catalog payload distinct from the local seed. */
function remoteManifest(): ExplainerCatalog {
  return ExplainerCatalogSchema.parse({
    version: 1,
    catalogVersion: "2026.09.08.1",
    publishedAt: "2026-09-08T10:00:00Z",
    entries: [
      {
        id: "remote-onboarding-walkthrough",
        asset: {
          provider: "bunny-storage",
          key: "onboarding/walkthrough.mp4",
          format: "mp4",
          contentSha256: "a".repeat(64),
          byteLength: 1024,
        },
        title: "Remote Onboarding Walkthrough",
        summary: "A walkthrough served from the official remote catalog.",
        description: "A description served from the official remote catalog.",
        tags: ["remote", "onboarding"],
        toolReferences: [{ name: "regenerate_soul", category: "settings", tags: ["onboarding"] }],
        durationSeconds: 55,
        publishedAt: "2026-09-08",
        captionsAvailable: true,
      },
    ],
  });
}

/** Build a signed pointer + immutable manifest body for a given manifest. */
function buildSignedRelease(
  manifest: ExplainerCatalog,
  key: ReturnType<typeof makeTestKey>,
): { pointer: object; immutableBody: string; manifestUrl: string } {
  const immutableBody = `${JSON.stringify(manifest)}\n`;
  const artifactSha256 = createHash("sha256").update(immutableBody, "utf8").digest("hex");
  const payload = canonicalExplainerCatalogSigningPayload(manifest.catalogVersion, artifactSha256);
  const pointer = {
    catalogVersion: manifest.catalogVersion,
    artifactSha256,
    signature: key.signPayload(payload),
    signingKeyId: key.signingKeyId,
  };
  const manifestUrl = `https://media.nautilo.ai/catalog/catalog-${manifest.catalogVersion}.json`;
  return { pointer, immutableBody, manifestUrl };
}

interface FetchHarness {
  config: RemoteExplainerCatalogConfig;
  fetches: { url: string; init?: RequestInit }[];
}

/** Recorder that serves a signed pointer at the pointer URL and `fn` elsewhere. */
function signedFetchHarness(key: ReturnType<typeof makeTestKey>, fn: FetchFn): FetchHarness {
  const { pointer, immutableBody, manifestUrl } = buildSignedRelease(remoteManifest(), key);
  const fetches: { url: string; init?: RequestInit }[] = [];
  const recorder: FetchFn = (u, init) => {
    fetches.push(init ? { url: u, init } : { url: u });
    if (u === POINTER_URL) return Promise.resolve(jsonResponse(pointer));
    if (u === manifestUrl) return Promise.resolve(jsonResponse(immutableBody));
    return fn(u, init);
  };
  return {
    fetches,
    config: {
      ttlMs: 1000,
      staleMs: 1000,
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
      now: () => 0,
      fetchImpl: recorder,
    },
  };
}

const originalPointerEnv = process.env[POINTER_ENV];

describe("find_explainer", () => {
  beforeEach(() => {
    // Local-only: no network I/O, serves the checked-in fallback catalog.
    configureRuntimeExplainerCatalog({ catalogPointerUrl: null });
    setTrustedExplainerCatalogKeysForTests(null);
  });

  afterEach(() => {
    resetRuntimeExplainerCatalog();
    resetTrustedExplainerCatalogKeysForTests();
    if (originalPointerEnv === undefined) {
      delete process.env[POINTER_ENV];
    } else {
      process.env[POINTER_ENV] = originalPointerEnv;
    }
  });

  test("finds a local walkthrough associated with tool metadata", async () => {
    const tool = createFindExplainerTool();

    const result = parseResponse(await tool.invoke({
      tool: { name: "regenerate_soul", category: "settings", tags: ["personality"] },
    }));

    expect(result.source).toBe("local");
    expect(result.stale).toBe(true);
    expect(result.catalogVersion).toBe(SEED_VERSION);
    expect(result.publishedAt).toBe(SEED_PUBLISHED_AT);
    expect(result.items[0]).toMatchObject({
      id: "launch-04-customize",
      title: "Make Your Genie Yours",
      durationSeconds: 241,
    });
    expect(result.items[0]).not.toHaveProperty("videoId");
    expect(result.items[0]).not.toHaveProperty("asset");
    expect(result.items[0]).not.toHaveProperty("playbackUrl");
    expect(result.items[0]).not.toHaveProperty("embedUrl");
  });

  test("searches bounded local metadata without playback behavior", async () => {
    const tool = createFindExplainerTool();

    const result = parseResponse(await tool.invoke({ query: "google-sheets", pageSize: 1 }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "launch-06-google-suite",
      title: "Build a Google Sheets Executive Summary",
      durationSeconds: 88,
    });
    expect(result.pageSize).toBe(1);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(tool.description).toContain("Do not autoplay or request playback until the user consents.");
  });

  test("rejects requests exceeding the local catalog page bound", () => {
    const tool = createFindExplainerTool();

    expect(() => tool.invoke({ pageSize: 21 })).toThrow();
  });

  test("does not expose the manifest URL, host, or provider credentials", async () => {
    const tool = createFindExplainerTool();

    const raw = await tool.invoke({ query: "google-sheets" });
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty("originUrl");
    expect(parsed).not.toHaveProperty("url");
    expect(parsed).not.toHaveProperty("host");
    expect(parsed).not.toHaveProperty("headers");
    expect(parsed).not.toHaveProperty("reason");
    expect(JSON.stringify(parsed)).not.toContain("media.nautilo.ai");
  });

  test("reports remote provenance when the signed official catalog is served fresh", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    const h = signedFetchHarness(key, async () => jsonResponse("not found", { status: 404 }));
    configureRuntimeExplainerCatalog({ remoteConfig: h.config });

    const tool = createFindExplainerTool();
    const result = parseResponse(await tool.invoke({ query: "onboarding" }));

    expect(result.source).toBe("remote");
    expect(result.stale).toBe(false);
    expect(result.catalogVersion).toBe("2026.09.08.1");
    expect(result.items[0]).toMatchObject({
      id: "remote-onboarding-walkthrough",
      title: "Remote Onboarding Walkthrough",
    });
    // Pointer mode: pointer fetch then derived immutable manifest fetch.
    expect(h.fetches).toHaveLength(2);
    expect(h.fetches[0]?.url).toBe(OFFICIAL_EXPLAINER_CATALOG_URL);
  });

  test("falls back to local with stale provenance when remote is unavailable", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    // Pointer fetch itself fails — the loader falls back to the bundled seed.
    const recorder: FetchFn = (u) => {
      if (u === POINTER_URL) return Promise.resolve(jsonResponse("nope", { status: 503 }));
      return Promise.resolve(jsonResponse("not found", { status: 404 }));
    };
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: recorder,
      },
    });

    const tool = createFindExplainerTool();
    const result = parseResponse(await tool.invoke({ query: "genie" }));

    expect(result.source).toBe("local");
    expect(result.stale).toBe(true);
    expect(result.catalogVersion).toBe(SEED_VERSION);
    expect(result.items.length).toBeGreaterThan(0);
  });

  test("caches the remote catalog across tool invocations within TTL", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    const h = signedFetchHarness(key, async () => jsonResponse("not found", { status: 404 }));
    configureRuntimeExplainerCatalog({ remoteConfig: h.config });

    const tool = createFindExplainerTool();
    await tool.invoke({ query: "onboarding" });
    const second = parseResponse(await tool.invoke({ query: "onboarding" }));

    expect(second.source).toBe("remote");
    expect(second.stale).toBe(false);
    // Cold load fetches pointer + manifest; the warm call within TTL fetches neither.
    expect(h.fetches).toHaveLength(2);
  });

  test("uses the official default catalog pointer URL when no override is configured", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    const h = signedFetchHarness(key, async () => jsonResponse("not found", { status: 404 }));
    configureRuntimeExplainerCatalog({ remoteConfig: h.config });

    const tool = createFindExplainerTool();
    await tool.invoke({});

    expect(h.fetches[0]?.url).toBe("https://media.nautilo.ai/catalog/latest.json");
  });

  test("respects an optional catalog pointer URL override via environment", async () => {
    const overrideUrl = "https://override.example.test/explainers/latest.json";
    process.env[POINTER_ENV] = overrideUrl;
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    const { pointer, immutableBody } = buildSignedRelease(remoteManifest(), key);
    const fetches: { url: string; init?: RequestInit }[] = [];
    const recorder: FetchFn = (u, init) => {
      fetches.push(init ? { url: u, init } : { url: u });
      if (u === overrideUrl) return Promise.resolve(jsonResponse(pointer));
      return Promise.resolve(jsonResponse(immutableBody));
    };
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: recorder,
      },
    });

    const tool = createFindExplainerTool();
    await tool.invoke({});

    expect(fetches[0]?.url).toBe(overrideUrl);
  });

  test("rejects an unsigned remote pointer and falls back to local seed", async () => {
    // Unsigned one-field pointer — the loader rejects it and falls back to seed.
    const fetches: { url: string; init?: RequestInit }[] = [];
    const recorder: FetchFn = (u, init) => {
      fetches.push(init ? { url: u, init } : { url: u });
      if (u === OFFICIAL_EXPLAINER_CATALOG_URL) {
        return Promise.resolve(jsonResponse({ catalogVersion: "2026.09.08.1" }));
      }
      return Promise.resolve(jsonResponse("not found", { status: 404 }));
    };
    configureRuntimeExplainerCatalog({
      remoteConfig: {
        ttlMs: 1000,
        staleMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        now: () => 0,
        fetchImpl: recorder,
      },
    });

    const tool = createFindExplainerTool();
    const result = parseResponse(await tool.invoke({ query: "genie" }));

    expect(result.source).toBe("local");
    expect(result.stale).toBe(true);
    expect(result.catalogVersion).toBe(SEED_VERSION);
  });
});
