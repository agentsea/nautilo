import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ExplainerCatalogSchema,
  ExplainerPlaybackEnvelopeSchema,
  canonicalExplainerCatalogSigningPayload,
  type ExplainerCatalog,
} from "@nautilo/types";
import { localExplainerCatalog } from "../../src/media/explainer-catalog/catalog";
import type { RemoteExplainerCatalogConfig } from "../../src/media/explainer-catalog/remote-catalog";
import {
  OFFICIAL_EXPLAINER_CATALOG_URL,
  configureRuntimeExplainerCatalog,
  resetRuntimeExplainerCatalog,
} from "../../src/media/explainer-catalog/runtime-catalog";
import {
  resetTrustedExplainerCatalogKeysForTests,
  setTrustedExplainerCatalogKeysForTests,
} from "../../src/media/explainer-catalog/trusted-keys";
import { createPlayExplainerTool } from "../../src/tools/media/play-explainer";

const POINTER_URL = OFFICIAL_EXPLAINER_CATALOG_URL;

function parseResponse(raw: string) {
  return ExplainerPlaybackEnvelopeSchema.parse(JSON.parse(raw) as unknown);
}

async function invokeErrorMessage(invoke: () => unknown): Promise<string> {
  try {
    await invoke();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected tool invocation to fail.");
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

/** A signed remote catalog payload with a bunny-storage MP4 entry not present locally. */
function remoteManifest(): ExplainerCatalog {
  return ExplainerCatalogSchema.parse({
    version: 1,
    catalogVersion: "2026.09.18.1",
    publishedAt: "2026-09-18T12:00:00Z",
    entries: [
      {
        id: "remote-direct-mp4",
        asset: {
          provider: "bunny-storage",
          key: "explainers/remote-walkthrough.mp4",
          format: "mp4",
          contentSha256: "a".repeat(64),
          byteLength: 2048,
        },
        title: "Remote Direct MP4 Explainer",
        summary: "A remote explainer resolved for verified playback.",
        description: "A remote explainer resolved for verified playback.",
        tags: ["remote", "playback"],
        toolReferences: [{ name: "find_voice", category: "settings", tags: ["remote"] }],
        durationSeconds: 48,
        publishedAt: "2026-09-18",
        captionsAvailable: false,
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

/** Recorder that serves a signed pointer at the official URL and `fn` for the derived manifest. */
function signedRecorderConfig(
  key: ReturnType<typeof makeTestKey>,
  fn: FetchFn,
): RemoteExplainerCatalogConfig {
  const { pointer, immutableBody, manifestUrl } = buildSignedRelease(remoteManifest(), key);
  const recorder: FetchFn = (url, init) => {
    if (url === POINTER_URL) return Promise.resolve(jsonResponse(pointer));
    if (url === manifestUrl) return Promise.resolve(jsonResponse(immutableBody));
    return fn(url, init);
  };
  return {
    ttlMs: 1000,
    staleMs: 1000,
    timeoutMs: 1000,
    maxBytes: 1024 * 1024,
    now: () => 0,
    fetchImpl: recorder,
  };
}

describe("play_explainer", () => {
  beforeEach(() => {
    // Local-only by default: no network I/O, serves the checked-in seed.
    configureRuntimeExplainerCatalog({ catalogPointerUrl: null });
    setTrustedExplainerCatalogKeysForTests(null);
  });

  afterEach(() => {
    resetRuntimeExplainerCatalog();
    resetTrustedExplainerCatalogKeysForTests();
  });

  test("resolves a catalog id to a metadata-only envelope with no CDN/media URL", async () => {
    const tool = createPlayExplainerTool();
    const result = parseResponse(await tool.invoke({ id: "launch-04-customize" }));

    expect(result).toMatchObject({
      id: "launch-04-customize",
      title: "Make Your Genie Yours",
      format: "mp4",
      requiresApproval: true,
    });
    // No CDN/media URL, no provider identity, no token, no asset/key leakage.
    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("src");
    expect(result).not.toHaveProperty("asset");
    expect(result).not.toHaveProperty("provider");
    expect(result).not.toHaveProperty("key");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("secret");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("media.nautilo.ai");
    // Attribution may link to a license; playback must not leak the media key.
    expect(serialized).not.toContain(localExplainerCatalog.entries.find((entry) => entry.id === result.id)!.asset.key);
  });

  test("instructs Genie to wait for explicit playback consent", () => {
    const tool = createPlayExplainerTool();
    expect(tool.description).toContain("only after the user has explicitly agreed");
    expect(tool.description).toContain("never autoplay");
  });

  test("rejects an unknown catalog id and URL-like tool input", async () => {
    const tool = createPlayExplainerTool();
    expect(await invokeErrorMessage(() => tool.invoke({ id: "not-in-the-catalog" }))).toContain(
      "Unknown explainer",
    );
    expect(
      await invokeErrorMessage(() =>
        tool.invoke({ id: "launch-04-customize", src: "https://attacker.example/video.mp4" } as never),
      ),
    ).toBeTruthy();
  });

  test("rejects runtime-mutated non-bunny-storage / non-mp4 catalog assets", async () => {
    const entry = localExplainerCatalog.entries.find((candidate) => candidate.id === "launch-04-customize")!;
    const originalProvider = entry.asset.provider;
    const originalFormat = entry.asset.format;
    const tool = createPlayExplainerTool();
    try {
      entry.asset.provider = "bunny-stream" as never;
      expect(await invokeErrorMessage(() => tool.invoke({ id: entry.id }))).toContain(
        "unsupported provider",
      );
      entry.asset.provider = originalProvider;
      entry.asset.format = "hls" as never;
      expect(await invokeErrorMessage(() => tool.invoke({ id: entry.id }))).toContain(
        "unsupported format",
      );
    } finally {
      entry.asset.provider = originalProvider;
      entry.asset.format = originalFormat;
    }
  });

  test("resolves the exact requested id from the signed remote catalog, not the local one", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    configureRuntimeExplainerCatalog({
      remoteConfig: signedRecorderConfig(key, async () => jsonResponse("not found", { status: 404 })),
    });
    const tool = createPlayExplainerTool();
    const result = parseResponse(await tool.invoke({ id: "remote-direct-mp4" }));
    expect(result.id).toBe("remote-direct-mp4");
    expect(result.title).toBe("Remote Direct MP4 Explainer");
    // A local-only id is NOT found while the remote catalog is served fresh.
    expect(await invokeErrorMessage(() => tool.invoke({ id: "launch-04-customize" }))).toContain(
      "Unknown explainer",
    );
  });

  test("falls back to the local seed for playback when remote is unavailable", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    // Pointer fetch itself fails — the loader falls back to the bundled seed.
    const recorder: FetchFn = (url) => {
      if (url === POINTER_URL) return Promise.resolve(jsonResponse("nope", { status: 503 }));
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
    const tool = createPlayExplainerTool();
    const result = parseResponse(await tool.invoke({ id: "launch-04-customize" }));
    expect(result.id).toBe("launch-04-customize");
  });

  test("rejects a remote-only id when remote is unavailable (no silent local spoof)", async () => {
    const key = makeTestKey();
    setTrustedExplainerCatalogKeysForTests({ [key.signingKeyId]: key.publicKeyB64 });
    const recorder: FetchFn = (url) => {
      if (url === POINTER_URL) return Promise.resolve(jsonResponse("nope", { status: 503 }));
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
    const tool = createPlayExplainerTool();
    expect(await invokeErrorMessage(() => tool.invoke({ id: "remote-direct-mp4" }))).toContain(
      "Unknown explainer",
    );
  });

  test("rejects an unsigned remote pointer and falls back to seed (no silent spoof)", async () => {
    // Unsigned one-field pointer — the loader rejects it and falls back to seed.
    const recorder: FetchFn = (url) => {
      if (url === POINTER_URL) return Promise.resolve(jsonResponse({ catalogVersion: "2026.09.18.1" }));
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
    const tool = createPlayExplainerTool();
    // Remote-only id is unknown because the unsigned pointer was rejected.
    expect(await invokeErrorMessage(() => tool.invoke({ id: "remote-direct-mp4" }))).toContain(
      "Unknown explainer",
    );
    // Local seed id still resolves after fallback.
    const result = parseResponse(await tool.invoke({ id: "launch-04-customize" }));
    expect(result.id).toBe("launch-04-customize");
  });
});
