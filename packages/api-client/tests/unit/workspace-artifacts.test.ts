import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  NautiloApiClient,
  ApiError,
  ConflictError,
  DocumentPatchConflictError,
  type WorkspaceArtifactEvent,
} from "../../src/client";

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

function readHeader(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  const lower = name.toLowerCase();
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    return h.get(name) ?? h.get(lower);
  }
  if (typeof h === "object" && !Array.isArray(h)) {
    const r = h as Record<string, string>;
    return r[name] ?? r[lower] ?? null;
  }
  return null;
}

function sampleArtifactDto(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "int-1",
    artifactId: "ext-uuid",
    path: "notes/hello.md",
    mimeType: "text/markdown",
    size: 12,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2025-12-01T00:00:00.000Z",
    namespaceIds: ["ns-a"],
    canWrite: true,
    ...overrides,
  };
}

function sampleListPayload() {
  return {
    artifacts: [sampleArtifactDto()],
  };
}

function chunkedResponse(
  chunks: readonly Uint8Array[],
  options: { contentLength?: string; failAfterChunk?: number; onCancel?: () => void } = {},
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.failAfterChunk === index) {
          controller.error(new Error("interrupted"));
          return;
        }
        const chunk = chunks[index++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    {
      status: 200,
      headers:
        options.contentLength === undefined
          ? { "content-type": "application/octet-stream" }
          : {
              "content-type": "application/octet-stream",
              "content-length": options.contentLength,
            },
    },
  );
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

describe("workspace artifacts client (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sharing targets the captured source Room and listing uses only caller identity", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init });
      return Response.json(init?.method === "POST" ? { status: "shared" } : { artifacts: [] });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect(await client.shareWorkspaceArtifact("file-1", "person-1", { roomId: "source-room" })).toEqual({ status: "shared" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:9/api/workspace/artifacts/file-1/share?roomId=source-room");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ recipientUserId: "person-1" }));
    await client.listWorkspaceShares();
    expect(requests[1]?.url).toBe("http://127.0.0.1:9/api/workspace/shared-with-me");
  });

  test("listWorkspaceArtifacts — GET URL and response shape", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleListPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listWorkspaceArtifacts();
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]!.path).toBe("notes/hello.md");
    expect(out.artifacts[0]!.namespaceIds).toEqual(["ns-a"]);
    expect(out.artifacts[0]!.canWrite).toBe(true);
  });

  test("listWorkspaceArtifacts — pathPrefix and limit in query string", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleListPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.listWorkspaceArtifacts({ pathPrefix: "notes/", limit: 42 });
    expect(seenUrl).toContain("/api/workspace/artifacts?");
    expect(seenUrl).toContain("pathPrefix=notes%2F");
    expect(seenUrl).toContain("limit=42");
  });

  test("listWorkspaceArtifacts — roomId in query string", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleListPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.listWorkspaceArtifacts({ roomId: "abc" });
    expect(seenUrl).toContain("roomId=abc");
  });

  test("listWorkspaceArtifactPage opts into bounded keyset pagination", async () => {
    let seenUrl = "";
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return Response.json({ artifacts: [sampleArtifactDto()], nextCursor: "next-page" });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await client.listWorkspaceArtifactPage({
      roomId: "room/one",
      pathPrefix: "notes/",
      limit: 250,
      cursor: "current-page",
    })).toEqual({ artifacts: [sampleArtifactDto()], nextCursor: "next-page" });
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/workspace/artifacts?pagination=keyset_v1&pathPrefix=notes%2F&limit=250&roomId=room%2Fone&cursor=current-page",
    );
  });

  test("paged Artifact DTOs tolerate additive server fields", async () => {
    globalThis.fetch = Object.assign(async () => Response.json({
      artifacts: [sampleArtifactDto({ sourceSummary: { kind: "room" } })],
      nextCursor: null,
      serverGeneration: "additive",
    }), { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const page = await client.listWorkspaceArtifactPage();
    expect(page.artifacts[0]?.path).toBe("notes/hello.md");
    expect((page as unknown as { serverGeneration: string }).serverGeneration).toBe("additive");
  });

  test("listAllWorkspaceArtifacts traverses every page without a fresh item cap", async () => {
    const urls: string[] = [];
    const pages = [
      { artifacts: [sampleArtifactDto({ id: "row-1" })], nextCursor: "page-2" },
      { artifacts: [sampleArtifactDto({ id: "row-2" })], nextCursor: "page-3" },
      { artifacts: [sampleArtifactDto({ id: "row-3" })], nextCursor: null },
    ];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(requestUrl(input));
      return Response.json(pages.shift());
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const result = await client.listAllWorkspaceArtifacts({ roomId: "room-1", pageSize: 1 });

    expect(result.artifacts.map((artifact) => artifact.id)).toEqual(["row-1", "row-2", "row-3"]);
    expect(urls).toHaveLength(3);
    expect(urls[0]).not.toContain("cursor=");
    expect(urls[1]).toContain("cursor=page-2");
    expect(urls[2]).toContain("cursor=page-3");
  });

  test("complete traversal rejects repeated objects and cursors instead of returning a partial list", async () => {
    const responses = [
      { artifacts: [sampleArtifactDto({ id: "row-1" })], nextCursor: "repeat" },
      { artifacts: [sampleArtifactDto({ id: "row-1" })], nextCursor: "repeat" },
    ];
    globalThis.fetch = Object.assign(async () => Response.json(responses.shift()), {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const error = await rejected(client.listAllWorkspaceArtifacts());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toContain("repeated an object");
  });

  test("complete traversal rejects a cyclic continuation without imposing a page cap", async () => {
    const responses = [
      { artifacts: [], nextCursor: "cursor-a" },
      { artifacts: [], nextCursor: "cursor-b" },
      { artifacts: [], nextCursor: "cursor-a" },
    ];
    globalThis.fetch = Object.assign(async () => Response.json(responses.shift()), {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const error = await rejected(client.listAllWorkspaceArtifacts());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toContain("repeated a continuation cursor");
  });

  test("paged inventory forwards cancellation and validates the complete response shape", async () => {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | null> = [];
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observedSignals.push(init?.signal ?? null);
      return Response.json({ artifacts: [sampleArtifactDto()] });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const error = await rejected(client.listWorkspaceArtifactPage({ signal: controller.signal }));
    expect(observedSignals[0]).toBe(controller.signal);
    expect(error).toBeInstanceOf(Error);
  });

  test("getWorkspaceArtifactAuthoredChange — binds artifact, Room, SHA, and revision in the URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify({ kind: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await client.getWorkspaceArtifactAuthoredChange("artifact/one", {
      roomId: "room one",
      expectedSha256: "a".repeat(64),
      expectedRevision: 7,
    })).toEqual({ kind: "none" });
    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/workspace/artifacts/artifact%2Fone/authored-change?roomId=room+one&expectedSha256=${"a".repeat(64)}&expectedRevision=7`,
    );
  });

  test("getWorkspaceArtifact — 200 returns DTO", async () => {
    const dto = sampleArtifactDto();
    const mockFetch = async () =>
      new Response(JSON.stringify(dto), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getWorkspaceArtifact("int-1");
    expect(out).not.toBeNull();
    expect(out!.id).toBe("int-1");
    expect(out!.artifactId).toBe("ext-uuid");
    expect(out!.canWrite).toBe(true);
  });

  test("getWorkspaceArtifact — 404 returns null", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getWorkspaceArtifact("missing");
    expect(out).toBeNull();
  });

  test("getWorkspaceArtifactBytes — URL, Authorization, Blob body", async () => {
    let seenUrl = "";
    let authHeader: string | null = null;
    let seenInit: RequestInit | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      authHeader = readAuthHeader(init);
      seenInit = init;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("bearer-secret");
    const blob = await client.getWorkspaceArtifactBytes("art-internal");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/art-internal/bytes");
    expect(authHeader === "Bearer bearer-secret").toBe(true);
    expect(seenInit?.redirect).toBeUndefined();
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  test("getWorkspaceArtifactBytes — roomId in query string", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.getWorkspaceArtifactBytes("id1", { roomId: "abc" });
    expect(seenUrl).toContain("roomId=abc");
  });

  test("getWorkspaceArtifactBytesArrayBuffer — incrementally reads a known length with auth and roomId", async () => {
    let seenInit: RequestInit | undefined;
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenInit = init;
      return chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
        contentLength: "4",
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("bearer-secret");
    const bytes = await client.getWorkspaceArtifactBytesArrayBuffer("art-internal", {
      roomId: "room-a",
      expectedBytes: 4,
      maxBytes: 8,
    });

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3, 4]);
    expect(seenUrl).toContain("roomId=room-a");
    expect(readAuthHeader(seenInit)).toBe("Bearer bearer-secret");
    expect(seenInit?.redirect).toBe("error");
  });

  test("getWorkspaceArtifactBytesArrayBuffer — exact one-buffer result for unknown length", async () => {
    const mockFetch = async () =>
      chunkedResponse([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])]);
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const bytes = await client.getWorkspaceArtifactBytesArrayBuffer("art-internal", { maxBytes: 8 });
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(bytes.byteLength).toBe(4);
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3, 4]);
  });

  test("getWorkspaceArtifactBytesArrayBuffer — rejects oversize data during transfer", async () => {
    const mockFetch = async () =>
      chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await rejected(client.getWorkspaceArtifactBytesArrayBuffer("art-internal", { maxBytes: 3 }))).toMatchObject({
      name: "WorkspaceArtifactStreamError",
      code: "size",
    });
  });

  test("getWorkspaceArtifactBytesArrayBuffer — rejects content-length mismatch and stream errors", async () => {
    let request = 0;
    const mockFetch = async () => {
      request += 1;
      return request === 1
        ? chunkedResponse([new Uint8Array([1, 2])], { contentLength: "3" })
        : chunkedResponse([new Uint8Array([1])], { failAfterChunk: 1 });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await rejected(client.getWorkspaceArtifactBytesArrayBuffer("art-internal"))).toMatchObject({
      name: "WorkspaceArtifactStreamError",
      code: "truncated",
    });
    expect(await rejected(client.getWorkspaceArtifactBytesArrayBuffer("art-internal"))).toMatchObject({
      name: "WorkspaceArtifactStreamError",
      code: "response",
    });
  });

  test("getWorkspaceArtifactBytesArrayBuffer — abort cancels and releases an active reader", async () => {
    let cancelled = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const mockFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const signal = new AbortController();
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const pending = client.getWorkspaceArtifactBytesArrayBuffer("art-internal", { signal: signal.signal });
    await Promise.resolve();
    signal.abort();
    expect(await rejected(pending)).toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(controllerRef).toBeDefined();
  });

  test("getWorkspaceArtifactBytesArrayBuffer — preserves authorization failures", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await rejected(client.getWorkspaceArtifactBytesArrayBuffer("art-internal"))).toMatchObject({
      name: "ApiError",
      status: 403,
    });
  });

  test("getWorkspaceArtifactBytesUrl — bytes route URL with encoded id, no fetch", () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    // No token set — builder must not require one (URL only, caller attaches bearer).
    const url = client.getWorkspaceArtifactBytesUrl("art/with+slash");
    expect(url).toBe(
      "http://127.0.0.1:9/api/workspace/artifacts/art%2Fwith%2Bslash/bytes",
    );
  });

  test("getWorkspaceArtifactBytesUrl — roomId appended when provided; omitted when empty", () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect(client.getWorkspaceArtifactBytesUrl("id", { roomId: "room-1" })).toBe(
      "http://127.0.0.1:9/api/workspace/artifacts/id/bytes?roomId=room-1",
    );
    expect(client.getWorkspaceArtifactBytesUrl("id", { roomId: "" })).toBe(
      "http://127.0.0.1:9/api/workspace/artifacts/id/bytes",
    );
    expect(client.getWorkspaceArtifactBytesUrl("id")).toBe(
      "http://127.0.0.1:9/api/workspace/artifacts/id/bytes",
    );
  });

  test("getWorkspaceArtifactBytesUrl — matches the URL getWorkspaceArtifactBytes fetches", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.getWorkspaceArtifactBytes("id1", { roomId: "abc" });
    expect(seenUrl).toBe(client.getWorkspaceArtifactBytesUrl("id1", { roomId: "abc" }));
  });

  test("getWorkspaceArtifactObjectUrl — caches; createObjectURL once per id", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return new Response(new Uint8Array([9]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    let urlCounter = 0;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => `blob:fake-${++urlCounter}`;
    URL.revokeObjectURL = () => {};

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const u1 = await client.getWorkspaceArtifactObjectUrl("same-id");
      const u2 = await client.getWorkspaceArtifactObjectUrl("same-id");
      expect(fetchCount).toBe(1);
      expect(u1).toBe("blob:fake-1");
      expect(u2).toBe("blob:fake-1");
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  test("revokeWorkspaceArtifactObjectUrl — next getWorkspaceArtifactObjectUrl refetches", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    let urlCounter = 0;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    let revokeCalls = 0;
    URL.createObjectURL = () => `blob:fake-${++urlCounter}`;
    URL.revokeObjectURL = () => {
      revokeCalls += 1;
    };

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.getWorkspaceArtifactObjectUrl("rid");
      expect(fetchCount).toBe(1);
      client.revokeWorkspaceArtifactObjectUrl("rid");
      expect(revokeCalls).toBe(1);
      await client.getWorkspaceArtifactObjectUrl("rid");
      expect(fetchCount).toBe(2);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  test("createWorkspaceArtifact — POST multipart with file, path, optional mimeType", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let form: FormData | null = null;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      form = init?.body instanceof FormData ? init.body : null;
      return new Response(JSON.stringify(sampleArtifactDto({ path: "a/b.png" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const file = new Blob([new Uint8Array([1, 2])], { type: "application/octet-stream" });
    const out = await client.createWorkspaceArtifact(file, {
      path: "workspace/a/b.png",
      mimeType: "image/png",
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts");
    expect(form).not.toBeNull();
    expect(form!.get("path")).toBe("workspace/a/b.png");
    expect(form!.get("mimeType")).toBe("image/png");
    expect(form!.has("file")).toBe(true);
    expect(out.path).toBe("a/b.png");
  });

  test("createWorkspaceArtifact — roomId in URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleArtifactDto()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.createWorkspaceArtifact(new Blob(), { path: "x", roomId: "room-1" });
    expect(seenUrl).toContain("roomId=room-1");
  });

  test("renameWorkspaceArtifact — PATCH JSON body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let bodyText = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify(sampleArtifactDto({ path: "new.md" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.renameWorkspaceArtifact("int-1", "new.md");
    expect(seenMethod).toBe("PATCH");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/int-1");
    expect(JSON.parse(bodyText)).toEqual({ newPath: "new.md" });
    expect(out.path).toBe("new.md");
  });

  test("renameWorkspaceArtifact — roomId in URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleArtifactDto()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.renameWorkspaceArtifact("id", "newpath", { roomId: "r2" });
    expect(seenUrl).toContain("roomId=r2");
  });

  test("deleteWorkspaceArtifact — DELETE succeeds", async () => {
    let seenMethod = "";
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.deleteWorkspaceArtifact("int-1");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/int-1");
    expect(out).toBeUndefined();
  });

  test("deleteWorkspaceArtifact — roomId in URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.deleteWorkspaceArtifact("id", { roomId: "r3" });
    expect(seenUrl).toContain("roomId=r3");
  });

  test("subscribeWorkspaceArtifactEvents — URL, listeners, unsubscribe closes; no token throws", () => {
    class FakeEventSource {
      url: string;
      listeners = new Map<string, Set<(e: MessageEvent) => void>>();
      closed = false;
      constructor(url: string) {
        this.url = url;
        FakeEventSource.last = this;
      }
      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }
      removeEventListener(type: string, cb: (e: MessageEvent) => void) {
        this.listeners.get(type)?.delete(cb);
      }
      close() {
        this.closed = true;
      }
      static last: FakeEventSource | null = null;
      dispatch(type: string, data: string) {
        for (const cb of this.listeners.get(type) ?? []) cb({ data } as MessageEvent);
      }
    }

    const origEs = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown as typeof EventSource;

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("");
      let noTokenErr: unknown;
      try {
        client.subscribeWorkspaceArtifactEvents(() => {});
      } catch (e) {
        noTokenErr = e;
      }
      expect(noTokenErr).toBeInstanceOf(ApiError);
      expect((noTokenErr as ApiError).message).toBe("Bearer token required");

      client.setToken("jwt%token+value");
      const opens: boolean[] = [];
      const errorStatuses: Array<number | undefined> = [];
      const unsub = client.subscribeWorkspaceArtifactEvents(() => {}, {
        onOpen: (reconnected) => opens.push(reconnected),
        onError: ({ status }) => errorStatuses.push(status),
      });
      expect(FakeEventSource.last).not.toBeNull();
      expect(FakeEventSource.last!.url).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/events?token=" + encodeURIComponent("jwt%token+value"),
      );
      expect(FakeEventSource.last!.listeners.has("changed")).toBe(true);
      expect(FakeEventSource.last!.listeners.has("renamed")).toBe(true);
      expect(FakeEventSource.last!.listeners.has("deleted")).toBe(true);
      expect(FakeEventSource.last!.listeners.has("document.mutation.committed")).toBe(true);
      FakeEventSource.last!.dispatch("open", "");
      FakeEventSource.last!.dispatch("open", "");
      expect(opens).toEqual([false, true]);
      const errorListener = [...(FakeEventSource.last!.listeners.get("error") ?? [])][0];
      errorListener?.({ xhrStatus: 401 } as unknown as MessageEvent);
      errorListener?.({ xhrStatus: 0 } as unknown as MessageEvent);
      errorListener?.({} as MessageEvent);
      expect(errorStatuses).toEqual([401, undefined, undefined]);
      unsub();
      expect(FakeEventSource.last!.closed).toBe(true);
    } finally {
      if (origEs !== undefined) {
        (globalThis as { EventSource?: typeof EventSource }).EventSource = origEs;
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });

  test("subscribeWorkspaceArtifactEvents — roomId appended after token", () => {
    class FakeEventSource {
      url: string;
      listeners = new Map<string, Set<(e: MessageEvent) => void>>();
      closed = false;
      constructor(url: string) {
        this.url = url;
        FakeEventSource.last = this;
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.closed = true;
      }
      static last: FakeEventSource | null = null;
    }

    const origEs = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown as typeof EventSource;

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const unsub = client.subscribeWorkspaceArtifactEvents(() => {}, { roomId: "rid-9" });
      expect(FakeEventSource.last!.url).toContain("?token=");
      expect(FakeEventSource.last!.url).toContain("&roomId=rid-9");
      unsub();
    } finally {
      if (origEs !== undefined) {
        (globalThis as { EventSource?: typeof EventSource }).EventSource = origEs;
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });

  test("pingArtifactEvent — POST URL, body, and woke response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(
        JSON.stringify({
          artifactId: "art-1",
          topic: "submitted",
          id: "event-1",
          createdAt: "2026-06-10T12:00:00.000Z",
          woke: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.pingArtifactEvent("art-1", "submitted", { ok: true });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/art-1/events/ping");
    expect(seenBody).toEqual({ topic: "submitted", payload: { ok: true } });
    expect(out.artifactId).toBe("art-1");
    expect(out.topic).toBe("submitted");
    expect(out.woke).toBe(true);
  });

  test("pingArtifactEvent — roomId in URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(
        JSON.stringify({
          artifactId: "id",
          topic: "t",
          id: "event-2",
          createdAt: "2026-06-10T12:00:00.000Z",
          woke: false,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.pingArtifactEvent("id", "t", null, { roomId: "r3" });
    expect(seenUrl).toContain("roomId=r3");
    expect(seenUrl).toContain("/events/ping");
  });

  test("subscribeWorkspaceArtifactEvents — parses changed event payload", () => {
    class FakeEventSource2 {
      url: string;
      listeners = new Map<string, Set<(e: MessageEvent) => void>>();
      closed = false;
      constructor(url: string) {
        this.url = url;
        FakeEventSource2.last = this;
      }
      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }
      removeEventListener() {}
      close() {
        this.closed = true;
      }
      static last: FakeEventSource2 | null = null;
    }

    const origEs = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource2 as unknown as typeof EventSource;

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const received: WorkspaceArtifactEvent[] = [];
      client.subscribeWorkspaceArtifactEvents((e) => received.push(e));
      const inst = FakeEventSource2.last!;
      const cbs = [...(inst.listeners.get("changed") ?? [])];
      expect(cbs.length).toBe(1);
      cbs[0]!({
        data: JSON.stringify({
          id: "i",
          artifactId: "a",
          path: "p",
          clientMutationId: "mutation-123",
        }),
      } as MessageEvent);
      expect(received).toEqual([
        {
          type: "changed",
          id: "i",
          artifactId: "a",
          path: "p",
          clientMutationId: "mutation-123",
        },
      ]);
    } finally {
      if (origEs !== undefined) {
        (globalThis as { EventSource?: typeof EventSource }).EventSource = origEs;
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });

  test("saveWorkspaceArtifactContent — headers, body, and success shape", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    const headersSeen = {
      contentType: null as string | null,
      artifactMimeType: null as string | null,
      ifMatch: null as string | null,
      baseSha: null as string | null,
      checkpoint: null as string | null,
      clientMutationId: null as string | null,
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : "";
      headersSeen.contentType = readHeader(init, "Content-Type");
      headersSeen.artifactMimeType = readHeader(init, "X-Artifact-Mime-Type");
      headersSeen.ifMatch = readHeader(init, "If-Match");
      headersSeen.baseSha = readHeader(init, "X-Base-Sha256");
      headersSeen.checkpoint = readHeader(init, "X-Checkpoint");
      headersSeen.clientMutationId = readHeader(init, "X-Client-Mutation-Id");
      return new Response(
        JSON.stringify({
          id: "int-1",
          revision: 2,
          size: 11,
          sha256: "b".repeat(64),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.saveWorkspaceArtifactContent("int-1", "hello world", {
      baseRevision: 1,
      baseSha256: "a".repeat(64),
      checkpoint: true,
      mimeType: "text/markdown",
      clientMutationId: "mutation-123",
    });
    expect(seenMethod).toBe("PUT");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/int-1/content");
    expect(seenBody).toBe("hello world");
    expect(headersSeen.contentType).toBe("text/plain; charset=utf-8");
    expect(headersSeen.artifactMimeType).toBe("text/markdown");
    expect(headersSeen.ifMatch).toBe("1");
    expect(headersSeen.baseSha).toBe("a".repeat(64));
    expect(headersSeen.checkpoint).toBe("1");
    expect(headersSeen.clientMutationId).toBe("mutation-123");
    expect(out).toEqual({ id: "int-1", revision: 2, size: 11, sha256: "b".repeat(64) });
  });

  test("saveWorkspaceArtifactContent — omits optional headers when tokens are null", async () => {
    const headersSeen = {
      ifMatch: null as string | null,
      baseSha: null as string | null,
      checkpoint: null as string | null,
      contentType: null as string | null,
      artifactMimeType: null as string | null,
    };
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      headersSeen.ifMatch = readHeader(init, "If-Match");
      headersSeen.baseSha = readHeader(init, "X-Base-Sha256");
      headersSeen.checkpoint = readHeader(init, "X-Checkpoint");
      headersSeen.contentType = readHeader(init, "Content-Type");
      headersSeen.artifactMimeType = readHeader(init, "X-Artifact-Mime-Type");
      return new Response(
        JSON.stringify({ id: "x", revision: 1, size: 0, sha256: "c".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.saveWorkspaceArtifactContent("x", "", {
      baseRevision: null,
      baseSha256: null,
      checkpoint: false,
    });
    expect(headersSeen.ifMatch).toBeNull();
    expect(headersSeen.baseSha).toBeNull();
    expect(headersSeen.checkpoint).toBeNull();
    expect(headersSeen.contentType).toBe("text/plain; charset=utf-8");
    expect(headersSeen.artifactMimeType).toBeNull();
  });

  test("saveWorkspaceArtifactContent — roomId in URL", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(
        JSON.stringify({ id: "x", revision: 1, size: 1, sha256: "d".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.saveWorkspaceArtifactContent("x", "a", {
      baseRevision: null,
      baseSha256: null,
      checkpoint: false,
      roomId: "room-9",
    });
    expect(seenUrl).toContain("roomId=room-9");
    expect(seenUrl).toContain("/content");
  });

  test("saveWorkspaceArtifactContent — 409 throws ConflictError with currentSha256", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "external_change", currentSha256: "e".repeat(64) }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let err: unknown;
    try {
      await client.saveWorkspaceArtifactContent("x", "stale", {
        baseRevision: 1,
        baseSha256: null,
        checkpoint: false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentSha256).toBe("e".repeat(64));
  });

  test("saveWorkspaceArtifactContent — non-2xx throws ApiError", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "No mutable namespace" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let err: unknown;
    try {
      await client.saveWorkspaceArtifactContent("x", "nope", {
        baseRevision: null,
        baseSha256: null,
        checkpoint: false,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe("No mutable namespace");
  });

  test("applyWorkspaceArtifactPatch — POST body and applied response", async () => {
    let seenUrl = "";
    let seenBody = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          kind: "applied",
          target: {
            kind: "artifact",
            artifactInternalId: "int-1",
            path: "notes/hello.md",
          },
          patchId: "patch-1",
          requestId: "req-1",
          revision: 2,
          sha256: "abc",
          content: "canonical text",
          author: { kind: "human", displayName: "User" },
          patch: { kind: "anchored_text", oldString: "a", newString: "b" },
          unifiedDiff: "diff",
          rebased: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.applyWorkspaceArtifactPatch("int-1", {
      requestId: "req-1",
      target: { kind: "artifact", artifactInternalId: "int-1", path: "notes/hello.md" },
      baseRevision: 1,
      baseSha256: "base",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
    });
    expect(seenUrl).toBe("http://127.0.0.1:9/api/workspace/artifacts/int-1/patch");
    const parsedBody = JSON.parse(seenBody) as { requestId?: unknown };
    expect(parsedBody.requestId).toBe("req-1");
    expect(out.kind).toBe("applied");
    expect(out.rebased).toBe(true);
    expect(out.content).toBe("canonical text");
  });

  test("applyWorkspaceArtifactPatch — 409 throws DocumentPatchConflictError", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          kind: "anchor_not_found",
          latestRevision: 3,
          latestSha256: "latest",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let err: unknown;
    try {
      await client.applyWorkspaceArtifactPatch("int-1", {
        requestId: "req-1",
        target: { kind: "artifact", artifactInternalId: "int-1", path: "x" },
        baseRevision: 1,
        baseSha256: "base",
        patch: { kind: "anchored_text", oldString: "gone", newString: "b" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentPatchConflictError);
    expect((err as DocumentPatchConflictError).rejection.kind).toBe("anchor_not_found");
  });

  test("subscribeWorkspaceArtifactEvents — parses reloadRequired on changed", () => {
    type Listener = (ev: MessageEvent) => void;
    const listeners = new Map<string, Listener>();
    class MockEventSource {
      static OPEN = 1;
      readyState = MockEventSource.OPEN;
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, fn: Listener) {
        listeners.set(type, fn);
      }
      removeEventListener(type: string) {
        listeners.delete(type);
      }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const received: WorkspaceArtifactEvent[] = [];
    client.subscribeWorkspaceArtifactEvents((e) => received.push(e));

    const onChanged = listeners.get("changed");
    expect(onChanged).toBeDefined();
    onChanged?.({
      data: JSON.stringify({
        id: "i",
        artifactId: "a",
        path: "p",
        reloadRequired: true,
      }),
    } as MessageEvent);

    expect(received).toEqual([
      {
        type: "changed",
        id: "i",
        artifactId: "a",
        path: "p",
        reloadRequired: true,
      },
    ]);
  });

  test("subscribeWorkspaceArtifactEvents — parses document.patch.applied SSE payload", () => {
    type Listener = (ev: MessageEvent) => void;
    const listeners = new Map<string, Listener>();
    class MockEventSource {
      static OPEN = 1;
      readyState = MockEventSource.OPEN;
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, fn: Listener) {
        listeners.set(type, fn);
      }
      removeEventListener(type: string) {
        listeners.delete(type);
      }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const received: WorkspaceArtifactEvent[] = [];
    client.subscribeWorkspaceArtifactEvents((e) => received.push(e));

    const onPatch = listeners.get("document.patch.applied");
    expect(onPatch).toBeDefined();
    onPatch?.({
      data: JSON.stringify({
        target: { kind: "artifact", artifactInternalId: "int-1", path: "a.md" },
        patchId: "p9",
        revision: 4,
        sha256: "s4",
        previousRevision: 3,
        previousSha256: "s3",
        patch: { kind: "anchored_text", oldString: "x", newString: "y" },
        author: { kind: "agent", displayName: "Bot" },
        rebased: true,
      }),
    } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("document.patch.applied");
    if (received[0]?.type === "document.patch.applied") {
      expect(received[0].patchId).toBe("p9");
      expect(received[0].rebased).toBe(true);
    }
  });

  test("subscribeWorkspaceArtifactEvents — parses durable committed editor save", () => {
    type Listener = (ev: MessageEvent) => void;
    const listeners = new Map<string, Listener>();
    class MockEventSource {
      static OPEN = 1;
      readyState = MockEventSource.OPEN;
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, fn: Listener) {
        listeners.set(type, fn);
      }
      removeEventListener(type: string) {
        listeners.delete(type);
      }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const received: WorkspaceArtifactEvent[] = [];
    client.subscribeWorkspaceArtifactEvents((event) => received.push(event));

    listeners.get("document.mutation.committed")?.({
      data: JSON.stringify({
        type: "document.mutation.committed",
        operationId: "workspace-editor:abc",
        revisionGroupId: "group-abc",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: "human-1" },
        mutation: "update",
        path: {
          kind: "update",
          before: {
            kind: "workspace_artifact",
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "note.md",
          },
          after: {
            kind: "workspace_artifact",
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "note.md",
          },
        },
        before: {
          identity: {
            kind: "workspace_artifact",
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "note.md",
          },
          backendVersion: { kind: "artifact_revision", revision: 1 },
          sha256: "a".repeat(64),
        },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "note.md",
          },
          backendVersion: { kind: "artifact_revision", revision: 2 },
          sha256: "b".repeat(64),
        },
        editorSave: {
          checkpoint: false,
          clientMutationId: "client-1",
          anchoredPatch: { kind: "anchored_text", oldString: "a", newString: "b" },
        },
      }),
    } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("document.mutation.committed");
    if (
      received[0]?.type === "document.mutation.committed" &&
      received[0].mutation === "update"
    ) {
      expect(received[0].editorSave?.anchoredPatch?.newString).toBe("b");
    }
  });
});
