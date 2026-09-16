import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AgentPhotoLibraryApiError,
  NautiloApiClient,
  type AgentPhotoLibraryFence,
  type UnauthorizedResponse,
} from "../../src/client";

const BASE = "https://nautilo.test";
const SERVER_ID = "10000000-0000-4000-8000-000000000001";
const VIEWER_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const ENTRY_ID = "40000000-0000-4000-8000-000000000004";
const REVISION_ID = "50000000-0000-4000-8000-000000000005";

const scope = {
  serverInstanceId: SERVER_ID,
  viewerUserId: VIEWER_ID,
  agentId: AGENT_ID,
  selectionRevision: "7",
  libraryRevision: "11",
} as const;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function parseJsonBody(body: RequestInit["body"]): unknown {
  return typeof body === "string" ? JSON.parse(body) as unknown : null;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

function currentBody() {
  return {
    current: {
      avatarRef: { kind: "uploaded", blobId: "owned-blob" },
      entryId: ENTRY_ID,
      lastUndoableRevisionId: REVISION_ID,
      scope,
    },
    scope,
  };
}

function mutationOptions() {
  return {
    idempotencyKey: "60000000-0000-4000-8000-000000000006",
    origin: "mobile" as const,
  };
}

describe("D487 canonical Agent photo-library client", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("reads current/list/detail/presets through canonical scoped DTOs", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.endsWith("/current")) return json(200, currentBody());
      if (url.includes("/entries/")) {
        return json(200, {
          entry: {
            id: ENTRY_ID,
            source: "upload",
            origin: "mobile",
            createdAt: "2026-08-04T12:00:00.000Z",
            deletedAt: null,
            purgeAfter: null,
            isCurrent: true,
            media: {
              thumbnailUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=thumb`,
              fullUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=full`,
            },
          },
          scope,
        });
      }
      if (url.endsWith("/presets")) {
        return json(200, {
          presets: [{ id: "avatar-01", thumbnailUrl: "/api/onboarding/images/avatars/avatar-01.webp" }],
          scope,
        });
      }
      return json(200, { entries: [], nextCursor: "opaque", scope });
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    expect((await client.getAgentPhotoLibraryCurrent()).current.entryId).toBe(ENTRY_ID);
    expect((await client.listAgentPhotoLibrary({ projection: "deleted", limit: 12, cursor: "cursor" })).nextCursor).toBe("opaque");
    expect((await client.getAgentPhotoLibraryEntry(ENTRY_ID)).entry.media.fullUrl).toContain("size=full");
    expect((await client.listAgentPhotoLibraryPresets()).presets[0]?.id).toBe("avatar-01");
    expect(urls[1]).toBe(`${BASE}/api/profile/agent-photo-library?projection=deleted&limit=12&cursor=cursor`);
  });

  test("sends idempotency, origin, revision, target, prompt, and 1-4 count", async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body);
      calls.push({ url: requestUrl(input), headers: new Headers(init?.headers), body });
      if (requestUrl(input).endsWith("/generate")) {
        return json(201, {
          operation: "create",
          entryIds: [ENTRY_ID],
          entries: [{
            id: ENTRY_ID,
            source: "generation",
            origin: "mobile",
            createdAt: "2026-08-04T12:00:00.000Z",
            media: {
              thumbnailUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=thumb`,
              fullUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=full`,
            },
          }],
          scope,
        });
      }
      return json(200, {
        operation: requestUrl(input).endsWith("/undo") ? "undo" : "select",
        changed: true,
        currentAvatarRef: { kind: "uploaded", blobId: "owned-blob" },
        currentEntryId: ENTRY_ID,
        revisionId: REVISION_ID,
        scope,
      });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    client.setTokenProvider(async () => "fresh");

    await client.generateAgentPhotoLibraryEntries(
      { prompt: "Warm and curious", count: 4 },
      mutationOptions(),
    );
    await client.selectAgentPhotoLibraryEntry(
      { target: { kind: "entry", entryId: ENTRY_ID }, expectedSelectionRevision: "6" },
      mutationOptions(),
    );
    await client.undoAgentPhotoLibrarySelection(
      { revisionId: REVISION_ID, expectedSelectionRevision: "7" },
      mutationOptions(),
    );

    expect(calls.map((call) => call.body)).toEqual([
      { prompt: "Warm and curious", count: 4 },
      { target: { kind: "entry", entryId: ENTRY_ID }, expectedSelectionRevision: "6" },
      { revisionId: REVISION_ID, expectedSelectionRevision: "7" },
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer fresh");
      expect(call.headers.get("idempotency-key")).toBe(mutationOptions().idempotencyKey);
      expect(call.headers.get("x-agent-photo-origin")).toBe("mobile");
    }
  });

  test("uploads multipart and exposes delete/restore as first-class operations", async () => {
    const calls: Array<{ url: string; body: RequestInit["body"]; headers: Headers }> = [];
    let generation = 1;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), body: init?.body, headers: new Headers(init?.headers) });
      if (requestUrl(input).endsWith("/upload")) {
        generation = 2;
        return json(201, {
          operation: "create",
          entryIds: [ENTRY_ID],
          entries: [{
            id: ENTRY_ID,
            source: "upload",
            origin: "mobile",
            createdAt: "2026-08-04T12:00:00.000Z",
            media: {
              thumbnailUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=thumb`,
              fullUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=full`,
            },
          }],
          scope,
        });
      }
      const operation = requestUrl(input).endsWith("/delete") ? "delete" : "restore";
      return json(200, { operation, changed: true, entryId: ENTRY_ID, scope });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);

    await client.uploadAgentPhotoLibraryEntry(
      new Blob(["png"], { type: "image/png" }),
      {
        ...mutationOptions(),
        fence: {
          ...scope,
          requestGeneration: 1,
          getCurrentGeneration: () => generation,
        },
      },
    );
    await client.deleteAgentPhotoLibraryEntry(ENTRY_ID, mutationOptions());
    await client.restoreAgentPhotoLibraryEntry(ENTRY_ID, mutationOptions());

    expect(calls[0]?.body).toBeInstanceOf(FormData);
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(((calls[0]?.body as FormData).get("file") as File).name).toBe("agent-photo.png");
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/profile/agent-photo-library/upload`,
      `${BASE}/api/profile/agent-photo-library/entries/${ENTRY_ID}/delete`,
      `${BASE}/api/profile/agent-photo-library/entries/${ENTRY_ID}/restore`,
    ]);
  });

  test("preserves an Expo File-shaped upload filename on the canonical route", async () => {
    let uploadedName = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      uploadedName = ((init?.body as FormData).get("file") as File).name;
      return json(201, {
        operation: "create",
        entryIds: [ENTRY_ID],
        entries: [{
          id: ENTRY_ID,
          source: "upload",
          origin: "mobile",
          createdAt: "2026-08-04T12:00:00.000Z",
          media: {
            thumbnailUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=thumb`,
            fullUrl: `/api/profile/agent-photo-library/entries/${ENTRY_ID}/media?size=full`,
          },
        }],
        scope,
      });
    }) as typeof fetch;
    const expoFile = Object.assign(new Blob(["expo-png"], { type: "image/png" }), {
      name: "picked-photo.png",
      bytes: () => new Uint8Array([1, 2, 3]),
    });

    await new NautiloApiClient(BASE).uploadAgentPhotoLibraryEntry(expoFile, mutationOptions());

    expect(uploadedName).toBe("picked-photo.png");
  });

  test("maps nested server failures and keeps the app-wide auth-expiry recovery path", async () => {
    const observed: UnauthorizedResponse[] = [];
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return json(401, {
        error: { code: "authentication_required", message: "Session expired", retryable: false },
      });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    client.setToken("expired");
    client.setUnauthorizedResponseHandler((response) => {
      observed.push(response);
      return attempts === 1 ? "also-expired" : null;
    });

    const error = await captureError(client.getAgentPhotoLibraryCurrent());
    expect(error).toBeInstanceOf(AgentPhotoLibraryApiError);
    expect(error).toMatchObject({ status: 401, code: "authentication_required", retryable: false });
    expect(attempts).toBe(2);
    expect(observed.map((item) => item.retryAttempted)).toEqual([false, true]);
  });

  test("rejects stale local generations and mismatched response scope", async () => {
    let generation = 9;
    const fence: AgentPhotoLibraryFence = {
      serverInstanceId: SERVER_ID,
      viewerUserId: VIEWER_ID,
      agentId: AGENT_ID,
      requestGeneration: 9,
      getCurrentGeneration: () => generation,
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return json(200, {
        ...currentBody(),
        scope: { ...scope, agentId: "70000000-0000-4000-8000-000000000007" },
      });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);

    const wrongScope = await captureError(client.getAgentPhotoLibraryCurrent({ fence }));
    expect(wrongScope).toMatchObject({ code: "stale_viewer_scope" });
    generation = 10;
    const staleBeforeDispatch = await captureError(client.getAgentPhotoLibraryCurrent({ fence }));
    expect(staleBeforeDispatch).toMatchObject({ code: "stale_viewer_scope" });
    expect(calls).toBe(1);
  });

  test("accepts canonical mutation responses after their websocket advances the local generation", async () => {
    let generation = 4;
    globalThis.fetch = (async () => {
      generation = 5;
      return json(200, {
        operation: "select",
        changed: true,
        currentAvatarRef: { kind: "uploaded", blobId: "owned-blob" },
        currentEntryId: ENTRY_ID,
        revisionId: REVISION_ID,
        scope: { ...scope, selectionRevision: "8", libraryRevision: "12" },
      });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    const fence: AgentPhotoLibraryFence = {
      ...scope,
      requestGeneration: 4,
      getCurrentGeneration: () => generation,
    };

    const result = await client.selectAgentPhotoLibraryEntry(
      { target: { kind: "entry", entryId: ENTRY_ID }, expectedSelectionRevision: "7" },
      { ...mutationOptions(), fence },
    );

    expect(result.scope.selectionRevision).toBe("8");
    expect(result.scope.libraryRevision).toBe("12");
  });

  test("discards a structured error when the local generation changed in flight", async () => {
    let generation = 3;
    globalThis.fetch = (async () => {
      generation = 4;
      return json(409, {
        error: {
          code: "selection_conflict",
          message: "Another selection won",
          retryable: false,
          scope,
        },
      });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    const error = await captureError(client.getAgentPhotoLibraryCurrent({
      fence: {
        ...scope,
        requestGeneration: 3,
        getCurrentGeneration: () => generation,
      },
    }));

    expect(error).toMatchObject({ code: "stale_viewer_scope" });
  });

  test("propagates AbortSignal and distinguishes abort from offline", async () => {
    const controller = new AbortController();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
    const client = new NautiloApiClient(BASE);
    const pending = client.listAgentPhotoLibrary({ signal: controller.signal });
    controller.abort();
    expect(await captureError(pending)).toMatchObject({ name: "AbortError" });

    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect(await captureError(client.getAgentPhotoLibraryCurrent())).toMatchObject({
      code: "offline",
      status: 0,
      retryable: true,
    });
  });

  test("reads only non-empty PNG/WebP authenticated media", async () => {
    globalThis.fetch = (async () => new Response("png", {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
    const client = new NautiloApiClient(BASE);
    const media = await client.getAgentPhotoLibraryMedia(ENTRY_ID, "full");
    expect(media.contentType).toBe("image/png");
    expect(media.blob.size).toBe(3);
  });
});
