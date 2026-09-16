/**
 * D425 Wave 1A — /api/profile/bundle/* client contract tests. Mocks
 * `globalThis.fetch` and asserts URL, method, auth, multipart body, and the
 * response shapes the CLI will consume.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  NautiloApiClient,
  ApiError,
  extractArtifactOpaqueId,
  type ProfileBundleExportResponse,
  type ProfileBundlePlanResponse,
  type ProfileBundleStageResponse,
  type ProfileBundleCommitTargetResponse,
  type ProfileBundleCommitSourceResponse,
  type ProfileBundlePlanRequest,
  type ProfileBundleArtifactPreviewResponse,
  type ProfileBundleArtifactStageResponse,
} from "../../src/client";
import { SEMANTIC_VERSION, semantic } from "@nautilo/profile-portability";

const BASE = "http://127.0.0.1:9";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function readAuthHeader(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    return h.get("authorization") ?? h.get("Authorization");
  }
  if (typeof h === "object" && !Array.isArray(h)) {
    const r = h as Record<string, string>;
    return r["authorization"] ?? r["Authorization"] ?? null;
  }
  return null;
}

function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonStatus(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  fn: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
  realFetch: typeof fetch,
): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: realFetch.preconnect.bind(realFetch),
  }) as typeof fetch;
}

function sampleExport(avatarSha: string | null): ProfileBundleExportResponse {
  const records: semantic.SemanticRecord[] = [
    { recordKind: "identity", name: "Jeannie", handleIntent: "jeannie" },
    { recordKind: "soul", text: "my soul" },
    { recordKind: "avatar", avatar: avatarSha ? { mediaEntry: "avatar.bin", mimeType: "image/png", sha256: avatarSha, width: null, height: null } : null },
  ];
  return {
    semanticVersion: SEMANTIC_VERSION,
    bundleId: "bundle-12345678",
    scopes: ["profile", "avatar"],
    records,
    avatarMedia: avatarSha
      ? { mediaEntry: "avatar.bin", sha256: avatarSha, mimeType: "image/png", size: 12 }
      : null,
  };
}

function samplePlan(planToken: string, choice: "source" | "target" = "source"): ProfileBundlePlanResponse {
  return {
    planToken,
    plan: {
      planToken,
      semanticRoot: "root-abc",
      targetStateDigest: "digest-fixed",
      targetAgentId: "agent-target-1",
      destinationInstanceId: "alpha-instance",
      scopes: ["profile", "avatar"],
      wholeProfileChoice: choice,
      conflicts: [],
      avatarMedia: { mediaEntry: "avatar.bin", sha256: "a".repeat(64), mimeType: "image/png" },
      privateMemoryCount: 0,
      privateMemoryAddedCount: 0,
      privateMemoryAlreadyPresentCount: 0,
      privateArtifactCount: 0,
      privateArtifactBytes: 0,
      refused: [],
      unknown: [],
      expiresAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("profile bundle client (D425 Wave 1A, mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("exportProfileBundle — GET URL, bearer auth, ID-free response shape", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      auth = readAuthHeader(init);
      return jsonOk(sampleExport("a".repeat(64)));
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.exportProfileBundle();
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/export");
    expect(auth === "Bearer tok").toBe(true);
    expect(out.semanticVersion).toEqual({ major: 1, minor: 1 });
    expect(out.scopes).toEqual(["profile", "avatar"]);
    expect(out.avatarMedia?.mediaEntry).toBe("avatar.bin");
    expect(out.records.map((r) => r.recordKind)).toContain("identity");
  });

  test("downloadProfileBundleMedia — GET URL, returns raw Blob (not base64)", async () => {
    let seenUrl = "";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    installFetch(async (input) => {
      seenUrl = requestUrl(input);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const blob = await client.downloadProfileBundleMedia("avatar.bin");
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/export/media/avatar.bin");
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test("planProfileBundleImport — POST URL, forwards bundle+choice, returns plan", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return jsonOk(samplePlan("plan-token-1", "source"));
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const exported = sampleExport("a".repeat(64));
    const req: ProfileBundlePlanRequest = {
      bundle: exported as unknown as semantic.GenieLiveV1,
      destinationInstanceId: "alpha-instance",
      scopes: ["profile", "avatar"],
      wholeProfileChoice: "source",
    };
    const out = await client.planProfileBundleImport(req);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/import/plan");
    expect(seenBody).toEqual(req);
    expect(out.planToken).toBe("plan-token-1");
    expect(out.plan.wholeProfileChoice).toBe("source");
    expect(out.plan.targetStateDigest).toBe("digest-fixed");
  });

  test("planProfileBundleImport — forwards privateMemoryCount from the server (count only)", async () => {
    let seenBody: unknown;
    installFetch(async (input, init) => {
      void requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const res: ProfileBundlePlanResponse = {
        planToken: "plan-token-mem",
        plan: {
          planToken: "plan-token-mem",
          semanticRoot: "root-mem",
          targetStateDigest: "digest-mem",
          targetAgentId: "agent-target-1",
          destinationInstanceId: "alpha-instance",
          scopes: ["profile", "avatar", "privateMemories"],
          wholeProfileChoice: "source",
          conflicts: [],
          avatarMedia: null,
          privateMemoryCount: 3,
          privateMemoryAddedCount: 3,
          privateMemoryAlreadyPresentCount: 0,
          privateArtifactCount: 0,
          privateArtifactBytes: 0,
          refused: [],
          unknown: [],
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      };
      return jsonOk(res);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const exported = sampleExport(null);
    const req: ProfileBundlePlanRequest = {
      bundle: exported as unknown as semantic.GenieLiveV1,
      destinationInstanceId: "alpha-instance",
      scopes: ["profile", "avatar", "privateMemories"],
      wholeProfileChoice: "source",
    };
    const out = await client.planProfileBundleImport(req);
    expect(seenBody).toEqual(req);
    expect(out.plan.privateMemoryCount).toBe(3);
    expect(out.plan.privateMemoryAddedCount).toBe(3);
    expect(out.plan.privateMemoryAlreadyPresentCount).toBe(0);
    expect(out.plan.scopes).toContain("privateMemories");
  });

  test("stageProfileBundleAvatar — POST multipart with planToken query + file part", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let form: FormData | null = null;
    const stageRes: ProfileBundleStageResponse = {
      planToken: "plan-token-1",
      mediaEntry: "avatar.bin",
      sha256: "a".repeat(64),
      size: 12,
      staged: true,
    };
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      form = init?.body instanceof FormData ? init.body : null;
      return jsonOk(stageRes);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const out = await client.stageProfileBundleAvatar({
      planToken: "plan-token-1",
      mediaEntry: "avatar.bin",
      bytes,
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe(
      BASE + "/api/profile/bundle/import/stage/avatar.bin?planToken=plan-token-1",
    );
    expect(form).not.toBeNull();
    expect(form!.has("file")).toBe(true);
    expect(out.staged).toBe(true);
    expect(out.sha256).toBe("a".repeat(64));
  });

  test("stageProfileBundleAvatar — non-2xx throws ApiError", async () => {
    installFetch(async () => jsonStatus(413, { error: "avatar_too_large" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.stageProfileBundleAvatar({
        planToken: "pt",
        mediaEntry: "avatar.bin",
        bytes: new Blob([new Uint8Array([0])]),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
    expect((err as ApiError).message).toBe("avatar_too_large");
  });

  test("commitProfileBundleImport — target choice returns committed:true", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const commitRes: ProfileBundleCommitTargetResponse = {
      planToken: "plan-token-1",
      idempotencyKey: "k1",
      semanticRoot: "root-abc",
      targetStateDigest: "digest-fixed",
      fresh: true,
      committed: true,
      choice: "target",
      privateMemoryAddedCount: 0,
      privateMemoryAlreadyPresentCount: 0,
    };
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return jsonOk(commitRes);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.commitProfileBundleImport({
      planToken: "plan-token-1",
      idempotencyKey: "k1",
    });
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/import/commit");
    expect(seenBody).toEqual({ planToken: "plan-token-1", idempotencyKey: "k1" });
    const target = out as ProfileBundleCommitTargetResponse;
    expect(target.committed).toBe(true);
    expect(target.choice).toBe("target");
  });

  test("commitProfileBundleImport — source choice returns committed:true with applied fields", async () => {
    const commitRes: ProfileBundleCommitSourceResponse = {
      planToken: "plan-token-1",
      idempotencyKey: "k1",
      semanticRoot: "root-abc",
      targetStateDigest: "digest-fixed",
      fresh: true,
      committed: true,
      choice: "source",
      privateMemoryAddedCount: 2,
      privateMemoryAlreadyPresentCount: 1,
      applied: {
        name: "Jeannie",
        handle: "jeannie",
        handleCustomized: true,
        avatar: { kind: "uploaded", blobId: "blob-abc-123" },
      },
    };
    installFetch(async () => jsonOk(commitRes), realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.commitProfileBundleImport({
      planToken: "plan-token-1",
      idempotencyKey: "k1",
    });
    const source = out as ProfileBundleCommitSourceResponse;
    expect(source.committed).toBe(true);
    expect(source.choice).toBe("source");
    expect(source.applied.name).toBe("Jeannie");
    expect(source.applied.handle).toBe("jeannie");
    expect(source.applied.handleCustomized).toBe(true);
    expect(source.applied.avatar).toEqual({ kind: "uploaded", blobId: "blob-abc-123" });
    expect(source.privateMemoryAddedCount).toBe(2);
    expect(source.privateMemoryAlreadyPresentCount).toBe(1);
  });

  test("commitProfileBundleImport — source choice with no avatar returns applied.avatar null", async () => {
    const commitRes: ProfileBundleCommitSourceResponse = {
      planToken: "plan-token-1",
      idempotencyKey: "k1",
      semanticRoot: "root-abc",
      targetStateDigest: "digest-fixed",
      fresh: true,
      committed: true,
      choice: "source",
      privateMemoryAddedCount: 0,
      privateMemoryAlreadyPresentCount: 0,
      applied: {
        name: "Jeannie",
        handle: "jeannie-auto",
        handleCustomized: false,
        avatar: null,
      },
    };
    installFetch(async () => jsonOk(commitRes), realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.commitProfileBundleImport({
      planToken: "plan-token-1",
      idempotencyKey: "k1",
    });
    const source = out as ProfileBundleCommitSourceResponse;
    expect(source.applied.avatar).toBeNull();
    expect(source.applied.handleCustomized).toBe(false);
  });

  test("commitProfileBundleImport — 409 stale_target throws ApiError", async () => {
    installFetch(async () => jsonStatus(409, { error: "stale_target" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.commitProfileBundleImport({
        planToken: "plan-token-1",
        idempotencyKey: "k1",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });

  test("exportProfileBundle — 401 throws ApiError (no silent guest fallback)", async () => {
    installFetch(async () => jsonStatus(401, { error: "Authentication required" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.exportProfileBundle();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// D425 Wave 3 — private-artifact preview / source stream / target stage.
// ---------------------------------------------------------------------------

describe("profile bundle artifact client (D425 Wave 3, mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("previewProfileBundleArtifacts — GET preview URL, forwards limit/offset, returns opaque inventory", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    const body: ProfileBundleArtifactPreviewResponse = {
      selectionPlanToken: "sel-plan-1",
      items: [
        { selectionToken: "tok-aaaaaaaa", path: "notes/a.md", mimeType: "text/markdown", size: 12 },
        { selectionToken: "tok-bbbbbbbb", path: "notes/b.md", mimeType: "text/markdown", size: 999_999 },
      ],
      totalCount: 2,
      totalBytes: 1_000_011,
      limit: 100,
      offset: 0,
      hasMore: false,
    };
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      auth = readAuthHeader(init);
      return jsonOk(body);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.previewProfileBundleArtifacts({
      limit: 100,
      offset: 0,
      selectionPlanToken: "sel-plan-existing",
    });
    expect(seenUrl).toBe(
      BASE + "/api/profile/bundle/artifacts/preview?limit=100&offset=0&selectionPlanToken=sel-plan-existing",
    );
    expect(auth === "Bearer tok").toBe(true);
    expect(out.selectionPlanToken).toBe("sel-plan-1");
    expect(out.totalCount).toBe(2);
    expect(out.totalBytes).toBe(1_000_011);
    expect(out.items[0]!.selectionToken).toBe("tok-aaaaaaaa");
    // Large items are surfaced (no silent size omission).
    expect(out.items[1]!.size).toBe(999_999);
  });

  test("previewProfileBundleArtifacts — omits query when no paging opts", async () => {
    let seenUrl = "";
    installFetch(async (input) => {
      seenUrl = requestUrl(input);
      return jsonOk({
        selectionPlanToken: "sel-plan-2",
        items: [],
        totalCount: 0,
        totalBytes: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      } satisfies ProfileBundleArtifactPreviewResponse);
    }, realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    await client.previewProfileBundleArtifacts();
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/artifacts/preview");
  });

  test("streamProfileBundleArtifactSource — GET source URL keyed by opaque tokens, returns streaming Response", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      auth = readAuthHeader(init);
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const res = await client.streamProfileBundleArtifactSource({
      selectionPlanToken: "sel-plan-1",
      selectionToken: "tok-aaaaaaaa",
    });
    expect(seenUrl).toBe(
      BASE + "/api/profile/bundle/artifacts/source/tok-aaaaaaaa?selectionPlanToken=sel-plan-1",
    );
    expect(auth === "Bearer tok").toBe(true);
    expect(res.ok).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("streamProfileBundleArtifactSource — non-2xx throws ApiError", async () => {
    installFetch(async () => jsonStatus(410, { error: "selection_plan_expired" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.streamProfileBundleArtifactSource({
        selectionPlanToken: "sel-plan-1",
        selectionToken: "tok-aaaaaaaa",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(410);
    expect((err as ApiError).message).toBe("selection_plan_expired");
  });

  test("stageProfileBundleArtifact — POST stage-artifact URL keyed by opaque id, multipart file part", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let form: FormData | null = null;
    const stageRes: ProfileBundleArtifactStageResponse = {
      planToken: "plan-token-1",
      bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
      artifactId: "fresh-target-id",
      sha256: "a".repeat(64),
      size: 4,
      staged: true,
    };
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      form = init?.body instanceof FormData ? init.body : null;
      return jsonOk(stageRes);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.stageProfileBundleArtifact({
      planToken: "plan-token-1",
      bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
      bytes: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/octet-stream" }),
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe(
      BASE + "/api/profile/bundle/import/stage-artifact/tok-aaaaaaaa?planToken=plan-token-1",
    );
    expect(form).not.toBeNull();
    expect(form!.has("file")).toBe(true);
    expect(out.staged).toBe(true);
    expect(out.bytesEntry).toBe("media/artifacts/tok-aaaaaaaa.bin");
    expect(out.artifactId).toBe("fresh-target-id");
  });

  test("stageProfileBundleArtifact — non-2xx throws ApiError", async () => {
    installFetch(async () => jsonStatus(409, { error: "artifact_already_staged" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.stageProfileBundleArtifact({
        planToken: "pt",
        bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
        bytes: new Blob([new Uint8Array([0])]),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("artifact_already_staged");
  });

  test("stageProfileBundleArtifact — rejects a bytesEntry that is not a media/artifacts/<opaque>.bin path", async () => {
    installFetch(async () => jsonOk({}), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.stageProfileBundleArtifact({
        planToken: "pt",
        bytesEntry: "notes/a.md",
        bytes: new Blob([new Uint8Array([0])]),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/invalid artifact bytesEntry/);
  });

  test("planProfileBundleImport — forwards privateArtifactCount + privateArtifactBytes (count/totals only)", async () => {
    let seenBody: unknown;
    installFetch(async (input, init) => {
      void requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const res: ProfileBundlePlanResponse = {
        planToken: "plan-token-art",
        plan: {
          planToken: "plan-token-art",
          semanticRoot: "root-art",
          targetStateDigest: "digest-art",
          targetAgentId: "agent-target-1",
          destinationInstanceId: "alpha-instance",
          scopes: ["profile", "avatar", "privateArtifacts"],
          wholeProfileChoice: "source",
          conflicts: [],
          avatarMedia: null,
          privateMemoryCount: 0,
          privateMemoryAddedCount: 0,
          privateMemoryAlreadyPresentCount: 0,
          privateArtifactCount: 2,
          privateArtifactBytes: 1_000_011,
          refused: [],
          unknown: [],
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      };
      return jsonOk(res);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const exported = sampleExport(null);
    const req: ProfileBundlePlanRequest = {
      bundle: exported as unknown as semantic.GenieLiveV1,
      destinationInstanceId: "alpha-instance",
      scopes: ["profile", "avatar", "privateArtifacts"],
      wholeProfileChoice: "source",
    };
    const out = await client.planProfileBundleImport(req);
    expect(seenBody).toEqual(req);
    expect(out.plan.privateArtifactCount).toBe(2);
    expect(out.plan.privateArtifactBytes).toBe(1_000_011);
    expect(out.plan.scopes).toContain("privateArtifacts");
  });

  test("extractArtifactOpaqueId — round-trips a valid bytesEntry and rejects malformed ones", () => {
    expect(extractArtifactOpaqueId("media/artifacts/tok-aaaaaaaa.bin")).toBe("tok-aaaaaaaa");
    expect(() => extractArtifactOpaqueId("notes/a.md")).toThrow(/invalid artifact bytesEntry/);
    expect(() => extractArtifactOpaqueId("media/artifacts/short.bin")).toThrow(/invalid artifact opaque id/);
    expect(() => extractArtifactOpaqueId("media/artifacts/has space here.bin")).toThrow(/invalid artifact opaque id/);
  });
});

describe("profile bundle artifact client — streaming stage + abort (D425 Wave 3 streaming slice)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("stageProfileBundleArtifactStream — POST octet-stream with a ReadableStream body (no Blob/FormData), bearer auth", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenContentType = "";
    let bodyKind = "";
    const stageRes: ProfileBundleArtifactStageResponse = {
      planToken: "plan-token-1",
      bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
      artifactId: "fresh-target-id",
      sha256: "a".repeat(64),
      size: 4,
      staged: true,
    };
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      seenContentType = headers.get("content-type") ?? "";
      bodyKind = init?.body instanceof ReadableStream ? "ReadableStream"
        : init?.body instanceof Blob ? "Blob"
        : init?.body instanceof FormData ? "FormData"
        : typeof init?.body;
      if (init?.body instanceof ReadableStream) {
        await new Response(init.body).arrayBuffer();
      }
      return jsonOk(stageRes);
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.stageProfileBundleArtifactStream({
      planToken: "plan-token-1",
      bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }),
    });
    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/octet-stream");
    expect(seenUrl).toBe(
      BASE + "/api/profile/bundle/import/stage-artifact/tok-aaaaaaaa?planToken=plan-token-1",
    );
    expect(bodyKind).toBe("ReadableStream");
    expect(out.staged).toBe(true);
    expect(out.artifactId).toBe("fresh-target-id");
  });

  test("stageProfileBundleArtifactStream — bounded async-iterable chunks flow through the body in order (no aggregate Blob)", async () => {
    const yielded: number[] = [];
    let bodyKind = "";
    let drained: Uint8Array | null = null;
    installFetch(async (_input, init) => {
      bodyKind = init?.body instanceof ReadableStream ? "ReadableStream"
        : init?.body instanceof Blob ? "Blob"
        : init?.body instanceof FormData ? "FormData"
        : typeof init?.body;
      if (init?.body instanceof ReadableStream) {
        const ab = await new Response(init.body).arrayBuffer();
        drained = new Uint8Array(ab);
      }
      return jsonOk({
        planToken: "pt",
        bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
        artifactId: "id",
        sha256: "a".repeat(64),
        size: 6,
        staged: true as const,
      });
    }, realFetch);

    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])];
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (i >= chunks.length) return { done: true, value: undefined };
            const v = chunks[i]!;
            yielded.push(i);
            i += 1;
            return { done: false, value: v };
          },
        };
      },
    };
    const out = await client.stageProfileBundleArtifactStream({
      planToken: "pt",
      bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
      body,
    });
    expect(bodyKind).toBe("ReadableStream");
    expect(yielded).toEqual([0, 1, 2]);
    expect(Array.from(drained ?? new Uint8Array())).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.staged).toBe(true);
  });

  test("stageProfileBundleArtifactStream — non-2xx throws ApiError", async () => {
    installFetch(async () => jsonStatus(409, { error: "artifact_already_staged" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.stageProfileBundleArtifactStream({
        planToken: "pt",
        bytesEntry: "media/artifacts/tok-aaaaaaaa.bin",
        body: new ReadableStream({ start(c) { c.close(); } }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("artifact_already_staged");
  });

  test("stageProfileBundleArtifactStream — rejects a malformed bytesEntry before fetching", async () => {
    let called = false;
    installFetch(async () => {
      called = true;
      return jsonOk({});
    }, realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.stageProfileBundleArtifactStream({
        planToken: "pt",
        bytesEntry: "notes/a.md",
        body: new ReadableStream({ start(c) { c.close(); } }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/invalid artifact bytesEntry/);
    expect(called).toBe(false);
  });

  test("abortProfileBundleArtifactStaging — DELETE plan cleanup URL with planToken query, bearer auth", async () => {
    let seenUrl = "";
    let seenMethod = "";
    installFetch(async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return jsonOk({ planToken: "pt", cleared: 2, clearedAll: true as const });
    }, realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    const out = await client.abortProfileBundleArtifactStaging({ planToken: "pt" });
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toBe(BASE + "/api/profile/bundle/import/stage-artifact?planToken=pt");
    expect(out.cleared).toBe(2);
    expect(out.clearedAll).toBe(true);
  });

  test("abortProfileBundleArtifactStaging — non-2xx throws ApiError", async () => {
    installFetch(async () => jsonStatus(404, { error: "plan_not_found" }), realFetch);
    const client = new NautiloApiClient(BASE);
    client.setToken("tok");
    let err: unknown;
    try {
      await client.abortProfileBundleArtifactStaging({ planToken: "pt" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});
