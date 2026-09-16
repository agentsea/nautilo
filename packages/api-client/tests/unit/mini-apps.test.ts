import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  NautiloApiClient,
  ApiError,
  ConflictError,
  LiveProposalAcceptanceError,
  type ListMiniAppsResponse,
  type MiniAppRuntimeResponse,
  type MiniAppSourceEvent,
  type PublicMiniAppDto,
} from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function samplePublicMiniApp(overrides?: Partial<PublicMiniAppDto>): PublicMiniAppDto {
  return {
    id: "sample-app",
    name: "Sample App",
    version: "0.1.0",
    status: "ready",
    sourceHash: "a".repeat(64),
    fileAssociations: {
      extensions: [],
      mimeTypes: [],
    },
    createActions: [
      {
        id: "new-document",
        label: "New document",
        defaultFilename: "Untitled document.html",
        mimeType: "text/html",
        targetSurfaces: ["workspace"],
        template: { kind: "file", path: "templates/empty-document.html" },
        openAfterCreate: true,
      },
    ],
    contentAssociations: [
      {
        id: "document-html",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: {
          documentType: "document",
          editor: "sample-editor",
          payloadFormat: "application/vnd.example.document+json",
        },
      },
    ],
    canEditSource: false,
    description: null,
    installedAt: null,
    enabled: true,
    ...overrides,
  };
}

function sampleRuntimePayload(): MiniAppRuntimeResponse {
  return {
    appId: "sample-app",
    sourceHash: "b".repeat(64),
    srcDoc: "<!DOCTYPE html><html><body>Sample app placeholder</body></html>",
    manifest: {
      id: "sample-app",
      name: "Sample App",
      version: "0.1.0",
      fileAssociations: {
        extensions: [],
      },
      capabilities: { document: { artifact: "readwrite" } },
    },
  };
}

describe("mini-apps client (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("listMiniApps — GET /api/apps and response shape", async () => {
    let seenUrl = "";
    const payload: ListMiniAppsResponse = { apps: [samplePublicMiniApp()] };
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listMiniApps();
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps");
    expect(out.apps).toHaveLength(1);
    expect(out.apps[0]!.id).toBe("sample-app");
  });

  test("listMiniApps — carries description from API response", async () => {
    const description =
      "Tables, formulas, and CSV — opens .html document docs in your workspace.";
    const payload: ListMiniAppsResponse = {
      apps: [samplePublicMiniApp({ description })],
    };
    const mockFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listMiniApps();
    expect(out.apps[0]!.description).toBe(description);
  });

  test("listMiniApps — carries installedAt from API response", async () => {
    const installedAt = "2026-01-15T12:00:00.000Z";
    const payload: ListMiniAppsResponse = {
      apps: [samplePublicMiniApp({ installedAt })],
    };
    const mockFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listMiniApps();
    expect(out.apps[0]!.installedAt).toBe(installedAt);
  });

  test("getMiniApp — GET /api/apps/:appId with encoded id", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(samplePublicMiniApp()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMiniApp("my app/id");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps/my%20app%2Fid");
    expect(out?.name).toBe("Sample App");
  });

  test("getMiniApp — 404 returns null", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "app not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMiniApp("missing");
    expect(out).toBeNull();
  });

  test("getMiniAppRuntime — GET /api/apps/:appId/runtime", async () => {
    let seenUrl = "";
    const payload = sampleRuntimePayload();
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMiniAppRuntime("sample-app");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps/sample-app/runtime");
    expect(out.srcDoc).toContain("Sample app placeholder");
    expect(out.manifest.name).toBe("Sample App");
    expect(out.sourceHash).toHaveLength(64);
  });

  test("getMiniAppCreateTemplate — GET /api/apps/:appId/create-templates/:actionId", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(
        JSON.stringify({
          appId: "sample-app",
          actionId: "new-document",
          content: "<!doctype html>",
          mimeType: "text/html",
          sha256: "c".repeat(64),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMiniAppCreateTemplate("my app", "new/document");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps/my%20app/create-templates/new%2Fdocument");
    expect(out.mimeType).toBe("text/html");
    expect(out.content).toBe("<!doctype html>");
  });

  test("getMiniAppRuntime — URL-encodes app id", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify(sampleRuntimePayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.getMiniAppRuntime("a/b c");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps/a%2Fb%20c/runtime");
  });

  test("getMiniAppRuntime — propagates 409 runtime unavailable", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          error: "app_runtime_unavailable",
          status: "needs_dependencies",
          message: "App dependencies are not installed.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.getMiniAppRuntime("sample-app");
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      name: "ApiError",
      status: 409,
      message: "App dependencies are not installed.",
    } satisfies Partial<ApiError>);
  });

  test("applyAcceptedLiveProposal posts the typed acceptance contract", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(
        JSON.stringify({
          documentVersion: { kind: "local_sha", sha256: "b".repeat(64) },
          localRevisionRef: "local:opaque",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const request = {
      requestId: "request-1",
      sessionToken: "session-token",
      proposalId: "proposal-1",
      documentVersion: { kind: "local_sha" as const, sha256: "a".repeat(64) },
      acceptedContent: "private accepted content",
      acceptedOperationIndexes: [0],
    };

    const result = await client.applyAcceptedLiveProposal("writer/app", request);
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/writer%2Fapp/live-session/apply-accepted",
    );
    expect(seenBody).toEqual(request);
    expect(result.localRevisionRef).toBe("local:opaque");
  });

  test("applyAcceptedLiveProposal maps safe errors without content diagnostics", async () => {
    const secret = "private accepted document bytes";
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "stale_version" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");

    let caught: unknown;
    try {
      await client.applyAcceptedLiveProposal("nautilo-writer", {
        requestId: "request-1",
        sessionToken: "session-token",
        proposalId: "proposal-1",
        documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
        acceptedContent: secret,
        acceptedOperationIndexes: [0],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveProposalAcceptanceError);
    expect(caught).toMatchObject({ status: 409, code: "stale_version" });
    expect(String(caught)).not.toContain(secret);
  });

  test("resolveLiveProposalReview posts the exact review receipt", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ ok: true, taskStatus: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const request = {
      sessionToken: "session-token",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision" as const, revision: 4 },
      outcome: "accepted" as const,
      resultDocumentVersion: { kind: "artifact_revision" as const, revision: 5 },
    };
    expect(await client.resolveLiveProposalReview("writer/app", request))
      .toEqual({ ok: true, taskStatus: "completed" });
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/writer%2Fapp/live-session/resolve-review",
    );
    expect(seenBody).toEqual(request);
  });

  test("invalidateLiveProposalReview posts the captured proposal capability", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ ok: true, taskStatus: "failed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const request = {
      sessionToken: "proposal-session-token",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision" as const, revision: 4 },
      reason: "remote_changed" as const,
    };

    expect(await client.invalidateLiveProposalReview("writer/app", request))
      .toEqual({ ok: true, taskStatus: "failed" });
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/writer%2Fapp/live-session/invalidate-review",
    );
    expect(seenBody).toEqual(request);
  });

  test("listPendingLiveProposalReviews posts the live session token", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const response = {
      proposals: [{
        proposalId: "proposal-1",
        appId: "nautilo-writer",
        sessionId: "session-1",
        documentVersion: { kind: "artifact_revision" as const, revision: 4 },
        operations: [{ kind: "replace" }],
      }],
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");

    expect(await client.listPendingLiveProposalReviews("writer/app", {
      sessionToken: "session-token",
    })).toEqual(response);
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/writer%2Fapp/live-session/reviews",
    );
    expect(seenBody).toEqual({ sessionToken: "session-token" });
  });

  test("listMiniAppSourceTree — GET /api/apps/:appId/source/tree with encoded id", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify({ files: [{ path: "manifest.json", kind: "file" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listMiniAppSourceTree("my app/id");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/apps/my%20app%2Fid/source/tree");
    expect(out.files[0]!.path).toBe("manifest.json");
  });

  test("getMiniAppSourceFile — URL-encodes app id and path query", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(
        JSON.stringify({ path: "src/index.ts", content: "export {}", sha256: "c".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getMiniAppSourceFile("sample-app", "src/index.ts");
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/sample-app/source/file?path=src%2Findex.ts",
    );
    expect(out.content).toBe("export {}");
    expect(out.sha256).toHaveLength(64);
  });

  test("saveMiniAppSourceFile — PUT body and 409 ConflictError mapping", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ currentSha256: "f".repeat(64) }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let err: unknown;
    try {
      await client.saveMiniAppSourceFile("sample-app", "src/a b/c.ts", {
        content: "updated",
        baseSha256: "e".repeat(64),
      });
    } catch (e) {
      err = e;
    }
    expect(seenMethod).toBe("PUT");
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/apps/sample-app/source/file?path=src%2Fa+b%2Fc.ts",
    );
    expect(seenBody).toEqual({ content: "updated", baseSha256: "e".repeat(64) });
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentSha256).toBe("f".repeat(64));
  });

  test("saveMiniAppSourceFile — success response shape", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          path: "manifest.json",
          sha256: "a".repeat(64),
          sourceHash: "b".repeat(64),
          status: "ready",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.saveMiniAppSourceFile("sample-app", "manifest.json", {
      content: "{}",
      baseSha256: "c".repeat(64),
    });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("ready");
    expect(out.sourceHash).toHaveLength(64);
  });

  test("subscribeMiniAppEvents — URL, listeners, unsubscribe closes; no token throws", () => {
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
        client.subscribeMiniAppEvents(() => {});
      } catch (e) {
        noTokenErr = e;
      }
      expect(noTokenErr).toBeInstanceOf(ApiError);

      client.setToken("jwt%token+value");
      const unsub = client.subscribeMiniAppEvents(() => {});
      expect(FakeEventSource.last!.url).toBe(
        "http://127.0.0.1:9/api/apps/events?token=" + encodeURIComponent("jwt%token+value"),
      );
      expect(FakeEventSource.last!.listeners.has("changed")).toBe(true);
      expect(FakeEventSource.last!.listeners.has("status")).toBe(true);
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

  test("subscribeMiniAppEvents — parses valid events and ignores malformed data", () => {
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
      const received: MiniAppSourceEvent[] = [];
      client.subscribeMiniAppEvents((e) => received.push(e));
      const inst = FakeEventSource2.last!;
      const changedCb = [...(inst.listeners.get("changed") ?? [])][0]!;
      const statusCb = [...(inst.listeners.get("status") ?? [])][0]!;

      changedCb({
        data: JSON.stringify({ appId: "sample-app", sourceHash: "d".repeat(64) }),
      } as MessageEvent);
      statusCb({
        data: JSON.stringify({ appId: "sample-app", status: "ready" }),
      } as MessageEvent);
      changedCb({ data: "not-json" } as MessageEvent);
      changedCb({ data: JSON.stringify({ appId: "", sourceHash: "x" }) } as MessageEvent);

      expect(received).toEqual([
        { type: "changed", appId: "sample-app", sourceHash: "d".repeat(64) },
        { type: "status", appId: "sample-app", status: "ready" },
      ]);
    } finally {
      if (origEs !== undefined) {
        (globalThis as { EventSource?: typeof EventSource }).EventSource = origEs;
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });
});
