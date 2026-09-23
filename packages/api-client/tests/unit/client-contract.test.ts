import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ZodError } from "zod";
import {
  NautiloApiClient,
  ApiError,
  InvalidCredentialsError,
  WrongCurrentPasswordError,
  LockedOutError,
  pickHighestRoleSlug,
  MemoryHardDeleteConflictError,
  MessageEditConflictError,
} from "../../src/client";
import type {
  ChatSearchOptions,
  ChatSearchValidationError,
  RoomMessageSearchOptions,
  RoomMessageSearchValidationError,
} from "@nautilo/types";

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

describe("NautiloApiClient HTTP contracts (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("getJobStatus — builds GET /api/jobs/:id with auth header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let authHeader: string | null = null;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      authHeader = readAuthHeader(init);
      return new Response(
        JSON.stringify({
          id: "job-1",
          type: "background",
          status: "completed",
          message: null,
          input: null,
          result: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok-123");
    const out = await client.getJobStatus("job-1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/jobs/job-1");
    expect(authHeader === "Bearer tok-123").toBe(true);
    expect(out.id).toBe("job-1");
  });

  test("getJobStatus — non-2xx throws ApiError", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.getJobStatus("missing");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
  });

  test("getJobStatus — malformed JSON still throws", async () => {
    const mockFetch = async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.getJobStatus("x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  test("getLatestSession — serializes limit, offset, roomId query params", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(JSON.stringify({ session: null, messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.getLatestSession({ limit: 12, offset: 3, roomId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(seenUrl).toContain("limit=12");
    expect(seenUrl).toContain("offset=3");
    expect(seenUrl).toContain("roomId=550e8400-e29b-41d4-a716-446655440000");
  });

  test("runMiniAppConversion — carries Design export scope with its source room", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      const requestBody = init?.body;
      expect(typeof requestBody).toBe("string");
      seenBody = JSON.parse(typeof requestBody === "string" ? requestBody : "null");
      return new Response(JSON.stringify({ ok: true, result: { status: "exported" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const roomId = "33333333-3333-4333-8333-333333333333";
    const body = {
      actionId: "export-svg",
      direction: "export" as const,
      source: { surface: "workspace" as const, path: "shared/report.html" },
      target: { surface: "workspace" as const, path: "shared/report.svg" },
      roomId,
      scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-9"] },
    };
    await client.runMiniAppConversion("nautilo-design", body);

    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/apps/nautilo-design/conversions/run?roomId=${roomId}`,
    );
    expect(seenBody).toEqual(body);
  });

  test("getOlderRoomMessages — preserves absent and revisioned D426 root summaries", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "41",
              role: "user",
              content: "anchor",
              createdAt: "2026-01-01T00:00:00.000Z",
              replyToMessageId: 17,
              replyCount: 3,
              lastReplyAt: "2026-01-02T00:00:00.000Z",
              summaryRevision: 9,
              attachments: [{
                attachmentId: "44444444-4444-4444-8444-444444444444",
                filename: "screen.png",
                mimeType: "image/png",
                sizeBytes: 73,
              }],
              artifacts: [{
                artifactInternalId: "550e8400-e29b-41d4-a716-446655440001",
                roomId: "550e8400-e29b-41d4-a716-446655440000",
                basename: "plan.md",
                mimeType: "text/markdown",
                sizeBytes: 42,
              }],
            },
            {
              id: "42",
              role: "assistant",
              content: "ordinary",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
          ],
          pageInfo: { hasMoreBefore: false, oldestCursor: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getOlderRoomMessages({
      roomId: "550e8400-e29b-41d4-a716-446655440000",
      beforeId: "99",
      beforeCreatedAt: "2026-01-03T00:00:00.000Z",
      limit: 2,
    });

    expect(seenUrl).toContain("beforeId=99");
    expect(seenUrl).toContain("limit=2");
    expect(out.messages[0]).toMatchObject({
      replyToMessageId: 17,
      replyCount: 3,
      lastReplyAt: "2026-01-02T00:00:00.000Z",
      summaryRevision: 9,
      attachments: [{
        attachmentId: "44444444-4444-4444-8444-444444444444",
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 73,
      }],
      artifacts: [{
        artifactInternalId: "550e8400-e29b-41d4-a716-446655440001",
        roomId: "550e8400-e29b-41d4-a716-446655440000",
        basename: "plan.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
      }],
    });
    expect(out.messages[1]).not.toHaveProperty("replyCount");
    expect(out.messages[1]).not.toHaveProperty("lastReplyAt");
    expect(out.messages[1]).not.toHaveProperty("summaryRevision");
  });

  test("searchRoomMessages — encodes one cursor-paged request and preserves cursor/asOf fields", async () => {
    const urls: string[] = [];
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      urls.push(requestUrl(input));
      return new Response(
        JSON.stringify({
          hits: [{
            messageId: "42",
            createdAt: "2026-01-02T03:04:05.000Z",
            role: "tool",
            snippet: "launch &amp; plan",
            toolName: "lookup",
            sourceUserId: "user-1",
            authorDisplayName: "Nautilo",
          }],
          asOf: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" },
          nextOlderCursor: { createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" },
          hasMoreOlder: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const options: RoomMessageSearchOptions = {
      roomId: "room/a?b",
      query: "launch & plan",
      mode: "prefix",
      ignoreCase: false,
      limit: 20,
      cursor: { createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" },
      asOf: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" },
    };
    const out = await client.searchRoomMessages(options);

    expect(urls).toEqual([
      "http://127.0.0.1:9/api/rooms/room%2Fa%3Fb/messages/search?query=launch+%26+plan&mode=prefix&ignoreCase=false&limit=20&cursorCreatedAt=2026-01-01T03%3A04%3A05.000Z&cursorMessageId=41&asOfCreatedAt=2026-01-02T03%3A04%3A05.000Z&asOfMessageId=42",
    ]);
    expect(out.asOf).toEqual({ createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" });
    expect(out.nextOlderCursor).toEqual({ createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" });
    expect(out.hits[0]).toMatchObject({ messageId: "42", toolName: "lookup" });
    expect(urls).toHaveLength(1);
  });

  test("D430 public validation DTO uses HTTP error codes", () => {
    const error: RoomMessageSearchValidationError = {
      code: "invalid_search_cursor",
      error: "cursor and asOf must be supplied together",
    };
    expect(error).toEqual({
      code: "invalid_search_cursor",
      error: "cursor and asOf must be supplied together",
    });
  });

  test("searchRoomMessages — forwards the exact AbortSignal", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response(
        JSON.stringify({
          hits: [],
          asOf: null,
          nextOlderCursor: null,
          hasMoreOlder: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const controller = new AbortController();
    await client.searchRoomMessages(
      { roomId: "room-1", query: "launch", mode: "prefix" },
      { signal: controller.signal },
    );

    expect(seenSignal).toBe(controller.signal);
  });

  test("searchChats — encodes first and paired continuation pages with one request per call", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      urls.push(requestUrl(input));
      methods.push(init?.method ?? "GET");
      return new Response(
        JSON.stringify({
          conversations: [],
          conversationsTruncated: false,
          messages: [],
          messageAsOf: null,
          nextOlderMessageCursor: null,
          hasMoreOlderMessages: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const first: ChatSearchOptions = {
      query: "launch & plan",
      mode: "prefix",
      archiveScope: "archived",
      ignoreCase: false,
      limit: 20,
    };
    const continuation: ChatSearchOptions = {
      ...first,
      cursor: { createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" },
      asOf: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" },
    };

    await client.searchChats(first);
    expect(urls).toEqual([
      "http://127.0.0.1:9/api/rooms/search?query=launch+%26+plan&mode=prefix&archiveScope=archived&ignoreCase=false&limit=20",
    ]);
    expect(methods).toEqual(["GET"]);

    await client.searchChats(continuation);
    expect(urls).toEqual([
      "http://127.0.0.1:9/api/rooms/search?query=launch+%26+plan&mode=prefix&archiveScope=archived&ignoreCase=false&limit=20",
      "http://127.0.0.1:9/api/rooms/search?query=launch+%26+plan&mode=prefix&archiveScope=archived&ignoreCase=false&limit=20&cursorCreatedAt=2026-01-01T03%3A04%3A05.000Z&cursorMessageId=41&asOfCreatedAt=2026-01-02T03%3A04%3A05.000Z&asOfMessageId=42",
    ]);
    expect(methods).toEqual(["GET", "GET"]);
    expect(urls).toHaveLength(2);
  });

  test("searchChats — forwards the exact AbortSignal and aborts without another request", async () => {
    let requests = 0;
    let seenSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests += 1;
      seenSignal = init?.signal;
      markFetchStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAborted = () => reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const controller = new AbortController();
    const pending = client.searchChats(
      { query: "launch plan", mode: "whole" },
      { signal: controller.signal },
    );
    await fetchStarted;
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(seenSignal).toBe(controller.signal);
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
    expect(requests).toBe(1);
  });

  test("searchChats — preserves Conversation truncation and Subthread breadcrumb metadata", async () => {
    let requests = 0;
    const mockFetch = async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          conversations: [{
            room: {
              id: "room-parent",
              label: "Product planning",
              type: "private",
              graphThreadId: "room:room-parent",
              createdAt: "2026-01-01T00:00:00.000Z",
              memberCount: 2,
              kind: "private",
            },
            matchedBy: "participant",
          }],
          conversationsTruncated: true,
          messages: [{
            messageId: "42",
            createdAt: "2026-01-02T03:04:05.000Z",
            role: "user",
            snippet: "launch plan reply",
            roomId: "room-thread",
            roomLabel: "Thread",
            roomKind: "subthread",
            parentRoomId: "room-parent",
            parentRoomLabel: "Product planning",
          }],
          messageAsOf: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" },
          nextOlderMessageCursor: { createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" },
          hasMoreOlderMessages: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.searchChats({ query: "plan", mode: "whole" });

    expect(out.conversationsTruncated).toBe(true);
    expect(out.conversations[0]).toMatchObject({
      matchedBy: "participant",
      room: { id: "room-parent", kind: "private" },
    });
    expect(out.messages[0]).toMatchObject({
      roomId: "room-thread",
      roomKind: "subthread",
      parentRoomId: "room-parent",
      parentRoomLabel: "Product planning",
    });
    expect(out.messageAsOf).toEqual({ createdAt: "2026-01-02T03:04:05.000Z", messageId: "42" });
    expect(out.nextOlderMessageCursor).toEqual({ createdAt: "2026-01-01T03:04:05.000Z", messageId: "41" });
    expect(requests).toBe(1);
  });

  test("D470 public validation DTO uses Chats-search HTTP error codes", () => {
    const error: ChatSearchValidationError = {
      code: "invalid_search_case",
      error: "ignoreCase must be true or false",
    };
    expect(error).toEqual({
      code: "invalid_search_case",
      error: "ignoreCase must be true or false",
    });
  });

  test("searchRoomMessages and getRoomMessagesAround — omit absent optionals and each issue one request", async () => {
    const urls: string[] = [];
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      urls.push(requestUrl(input));
      const isSearch = requestUrl(input).includes("/search?");
      return new Response(
        JSON.stringify(
          isSearch
            ? { hits: [], asOf: null, nextOlderCursor: null, hasMoreOlder: true }
            : {
                messages: [{
                  id: "7",
                  role: "tool",
                  content: "result",
                  toolCalls: null,
                  createdAt: "2026-01-02T03:04:05.000Z",
                }],
                target: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "7" },
                includedToolCallCompanion: false,
                hasOlder: true,
                hasNewer: true,
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const search = await client.searchRoomMessages({
      roomId: "room id",
      query: "one page",
      mode: "whole",
    });
    const around = await client.getRoomMessagesAround({
      roomId: "room id",
      messageId: "7/around?no",
    });

    expect(urls).toEqual([
      "http://127.0.0.1:9/api/rooms/room%20id/messages/search?query=one+page&mode=whole",
      "http://127.0.0.1:9/api/rooms/room%20id/messages/7%2Faround%3Fno/around",
    ]);
    expect(search.hasMoreOlder).toBe(true);
    expect(around).toMatchObject({
      target: { createdAt: "2026-01-02T03:04:05.000Z", messageId: "7" },
      hasOlder: true,
      hasNewer: true,
    });
    expect(urls).toHaveLength(2);
  });

  test("sendMessage — POST /api/chat with JSON body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let bodyText = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          jobId: "j1",
          laneKey: "app:default",
          accepted: true,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.sendMessage({
      message: "hello",
      laneKey: "app:default",
      clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
    } as Parameters<NautiloApiClient["sendMessage"]>[0]);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/chat");
    const parsed = JSON.parse(bodyText) as { message?: string; clientActionSessionId?: string };
    expect(parsed.message).toBe("hello");
    expect(parsed.clientActionSessionId).toBe("A1b2C3d4E5f6G7h8I9j0K_");
  });

  test("sendMessage — forwards userTimezone in POST /api/chat body (M087)", async () => {
    let bodyText = "";
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          jobId: "j1",
          laneKey: "app:default",
          accepted: true,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.sendMessage({ message: "hi", userTimezone: "Asia/Tokyo" });
    const parsed = JSON.parse(bodyText) as { message?: string; userTimezone?: string };
    expect(parsed.message).toBe("hi");
    expect(parsed.userTimezone).toBe("Asia/Tokyo");
  });

  test("sendMessage — accepts coalesced 202 with jobId null (M074)", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          jobId: null,
          laneKey: "room:550e8400-e29b-41d4-a716-446655440000",
          accepted: true,
          coalesced: true,
          attachments: [],
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.sendMessage({
      message: "hello",
      laneKey: "room:550e8400-e29b-41d4-a716-446655440000",
    });
    expect(out.jobId).toBeNull();
    expect(out.coalesced).toBe(true);
  });

  test("deleteRoomMessage — DELETE /api/rooms/:roomId/messages/:messageId (M172)", async () => {
    const roomId = "550e8400-e29b-41d4-a716-446655440000";
    const messageId = "42";
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: string | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : undefined;
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
    const out = await client.deleteRoomMessage(roomId, messageId);

    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
    );
    expect(seenMethod).toBe("DELETE");
    expect(seenBody).toBeUndefined();
    expect(out).toEqual({ ok: true });
  });

  test("deleteRoomMessage — non-2xx throws ApiError", async () => {
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
    let caught: unknown;
    try {
      await client.deleteRoomMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        "42",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).message).toBe("forbidden");
  });

  test("editRoomMessage — PATCHes content and expected revision (M230)", async () => {
    const roomId = "550e8400-e29b-41d4-a716-446655440000";
    const messageId = "42";
    let seenMethod = "";
    let seenBody = "";
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenMethod = init?.method ?? "GET";
      seenBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({
        message: {
          id: messageId,
          logicalMessageKey: "turn:fp-1",
          content: "fixed",
          editedAt: "2026-08-01T10:00:00.000Z",
          editRevision: 2,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.editRoomMessage(roomId, messageId, {
      content: "fixed",
      expectedRevision: 1,
    });

    expect(seenMethod).toBe("PATCH");
    expect(JSON.parse(seenBody)).toEqual({ content: "fixed", expectedRevision: 1 });
    expect(out.message.editRevision).toBe(2);
  });

  test("editRoomMessage — exposes the current canonical value on 409", async () => {
    const current = {
      id: "42",
      logicalMessageKey: "turn:fp-1",
      content: "newer",
      editedAt: "2026-08-01T10:00:00.000Z",
      editRevision: 3,
    };
    const mockFetch = async () =>
      new Response(
        JSON.stringify({ error: "message_edit_conflict", current }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.editRoomMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        "42",
        { content: "stale draft", expectedRevision: 2 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MessageEditConflictError);
    expect((caught as MessageEditConflictError).current).toEqual(current);
  });

  test("createBackgroundJob — POST /api/jobs with task body", async () => {
    let seenUrl = "";
    let bodyText = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ jobId: "bg1", accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.createBackgroundJob({ task: "do work" });
    expect(seenUrl).toBe("http://127.0.0.1:9/api/jobs");
    const parsed = JSON.parse(bodyText) as { task?: string };
    expect(parsed.task).toBe("do work");
    expect(out.jobId).toBe("bg1");
  });

  test("admin.users — builds expected methods, paths, and bodies", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const userRow = {
      id: "u1",
      handle: "ada",
      displayName: "Ada",
      groups: [{ id: "g1", type: "admins", label: "Admins", roleSlug: "admin" }],
      server: null,
      lastSeenAt: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      disabledAt: null,
      disabledBy: null,
      disabledReason: null,
    };
    const responses = [
      { users: [userRow], nextCursor: "cursor-1" },
      userRow,
      { ok: true },
      { ok: true },
      { ok: true, url: "http://localhost:3001/reset?token=stub-ott", token: "stub-ott" },
    ];
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: requestUrl(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify(responses[calls.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.admin.users.list({ cursor: "cursor-0", limit: 25, includeFederated: true });
    await client.admin.users.get("u1");
    await client.admin.users.disable("u1", "compromised");
    await client.admin.users.enable("u1");
    const reset = await client.admin.users.resetPassword("u1");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:9/api/admin/users?cursor=cursor-0&limit=25&include_federated=true",
    );
    expect(calls[1]).toEqual({
      url: "http://127.0.0.1:9/api/admin/users/u1",
      method: "GET",
      body: "",
    });
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.url).toBe("http://127.0.0.1:9/api/admin/users/u1/disable");
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({ reason: "compromised" });
    expect(calls[3]?.method).toBe("POST");
    expect(calls[3]?.url).toBe("http://127.0.0.1:9/api/admin/users/u1/enable");
    expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({});
    expect(calls[4]?.method).toBe("POST");
    expect(calls[4]?.url).toBe("http://127.0.0.1:9/api/admin/users/u1/reset-password");
    expect(JSON.parse(calls[4]?.body ?? "{}")).toEqual({});
    expect(reset.delivery).toBe("one_time_url");
    if (reset.delivery !== "one_time_url") throw new Error("expected one-time URL delivery");
    expect(reset.token).toBe("stub-ott");
  });

  test("admin.users.provision sends a non-secret intent with an idempotency header", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { url: requestUrl(input), init };
      return new Response(JSON.stringify({
        ok: true,
        receiptId: "receipt-1",
        memberId: "member-1",
        actorId: "actor-1",
        landingRoomId: "room-1",
        roleSlug: "member",
        idempotent: false,
        auditRecorded: true,
        credential: {
          disposition: "issued",
          temporaryPassword: "TEMP-CANARY",
          pin: "123456",
          recoveryCodes: ["RECOVERY-CANARY"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-token");

    const result = await client.admin.users.provision({
      handle: "person",
      displayName: "Person",
      roleSlug: "member",
    }, "provision-key-123456789");

    expect(seen?.url).toBe("http://127.0.0.1:9/api/admin/users/provision");
    expect(seen?.init?.method).toBe("POST");
    expect(seen?.init?.headers).toMatchObject({
      "Idempotency-Key": "provision-key-123456789",
    });
    const requestBody = seen?.init?.body;
    if (typeof requestBody !== "string") throw new Error("missing JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      handle: "person",
      displayName: "Person",
      roleSlug: "member",
    });
    expect(result.credential.disposition).toBe("issued");
  });

  test("admin.users.planRollout sends the manifest and validates the server-bound plan", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const manifest = {
      schemaVersion: 1,
      members: [{ handle: "person", displayName: "Person", roleSlug: "member" }],
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { url: requestUrl(input), init };
      return new Response(JSON.stringify({
        ok: true,
        schemaVersion: 1,
        fingerprint: "a".repeat(64),
        serverInstanceId: "instance-1",
        operations: [{
          index: 0,
          handle: "person",
          displayName: "Person",
          roleSlug: "member",
          idempotencyKey: `rollout:${"a".repeat(64)}:0`,
        }],
        warnings: [],
        bounds: { maxMembers: 100, requestedMembers: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-token");

    const result = await client.admin.users.planRollout(manifest);

    expect(seen?.url).toBe("http://127.0.0.1:9/api/admin/users/rollout/plan");
    expect(seen?.init?.method).toBe("POST");
    const requestBody = seen?.init?.body;
    if (typeof requestBody !== "string") throw new Error("missing JSON request body");
    expect(JSON.parse(requestBody)).toEqual(manifest);
    expect(result.bounds).toEqual({ maxMembers: 100, requestedMembers: 1 });
  });

  describe("D130 pre-flight — typed password errors + whoami fallback + setup status parse", () => {
    test("changePassword — 401 throws InvalidCredentialsError with body error string", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ error: "bad_credentials_msg" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.changePassword({
          currentPassword: "old",
          newPassword: "new-new-new",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidCredentialsError);
      expect((caught as InvalidCredentialsError).message).toBe("bad_credentials_msg");
      expect((caught as InvalidCredentialsError).status).toBe(401);
    });

    test("changePassword — 422 throws WrongCurrentPasswordError", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ error: "wrong old password" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.changePassword({
          currentPassword: "old",
          newPassword: "new-new-new",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WrongCurrentPasswordError);
      expect((caught as WrongCurrentPasswordError).message).toBe("wrong old password");
    });

    test("changePassword — 423 throws LockedOutError", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 423,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.changePassword({
          currentPassword: "old",
          newPassword: "new-new-new",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LockedOutError);
      expect((caught as LockedOutError).message).toBe("rate_limited");
    });

    test("whoami — reuses latched bearer without second provider call (D420)", async () => {
      let providerCalls = 0;
      let authHeader: string | null = null;
      const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        authHeader = readAuthHeader(init);
        return new Response(
          JSON.stringify({
            sessionUserId: "u1",
            sessionActorId: "a1",
            userIdentity: "@a@l",
            handle: "a",
            displayName: "A",
            externalId: "sub",
            instanceId: "i1",
            mustChangePassword: false,
            groups: [{ id: "g1", type: "owners", label: "Owners", roleSlug: "owner" }],
            capabilities: [],
            highestRole: "owner",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      // Caller (e.g. useViewerAuth.checkViewer) latches a fresh bearer before whoami.
      client.setToken("latched-token");
      client.setTokenProvider(async () => {
        providerCalls += 1;
        // D420 failure mode: a second refresh can transiently return null and
        // clear the valid latched bearer, turning whoami into an anonymous call.
        return null;
      });

      await client.whoami();

      expect(providerCalls).toBe(0);
      expect(authHeader === "Bearer latched-token").toBe(true);
      expect(client.getToken()).toBe("latched-token");
    });

    test("whoami — 401 returns guest-shaped payload (no throw)", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      const out = await client.whoami();
      expect(pickHighestRoleSlug(out.groups)).toBe("guest");
      expect(out.instanceId).toBe("");
      expect(out.mustChangePassword).toBe(false);
      // M129 — guest fallback carries an empty capability list.
      expect(out.capabilities).toEqual([]);
    });

    test("whoami — 200 parses capabilities and tolerates unknown slugs (M129)", async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            sessionUserId: "u1",
            sessionActorId: "a1",
            userIdentity: "@a@l",
            handle: "a",
            displayName: "A",
            externalId: "sub",
            instanceId: "i1",
            mustChangePassword: false,
            groups: [{ id: "g1", type: "owners", label: "Owners", roleSlug: "owner" }],
            // includes a slug the client doesn't recognize — must be tolerated.
            capabilities: ["manage_members", "some_future_cap"],
            highestRole: "owner",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      const out = await client.whoami();
      // The client schema is `z.array(z.string())` (tolerant); the unknown
      // slug survives the round-trip. Compare as a plain string array.
      expect(out.capabilities as string[]).toEqual(["manage_members", "some_future_cap"]);
    });

    test("whoami — 5xx propagates a transient failure instead of a guest fallback", async () => {
      const mockFetch = async () =>
        new Response("not-json-at-all", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      let caught: unknown;
      try {
        await client.whoami();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        status: 503,
        message: "GET /api/auth/whoami failed: 503",
      });
    });

    test("getSetupStatus — 200 with JSON that fails schema parse throws ZodError", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ not: "a setup status" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.getSetupStatus();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ZodError);
    });
  });

  describe("Stack 195 follow-up — retired agent-roster client methods", () => {
    test("listAgents is preserved (manageable/personal Agent listing)", () => {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      expect(typeof client.listAgents).toBe("function");
    });

    test("getAgentMembers is removed — no roster-enumeration client method", () => {
      const client = new NautiloApiClient("http://127.0.0.1:9") as unknown as Record<string, unknown>;
      // The legacy read returned the server-wide roster through a
      // personal-Agent auth path; it is retired (server returns 410).
      expect(client["getAgentMembers"]).toBeUndefined();
    });

    test("listAddableUsersForAgent is removed — no directory-enumeration client method", () => {
      const client = new NautiloApiClient("http://127.0.0.1:9") as unknown as Record<string, unknown>;
      // The legacy read returned the server-wide addable-user directory
      // through a personal-Agent auth path; it is retired (server 410).
      expect(client["listAddableUsersForAgent"]).toBeUndefined();
    });

    test("groups.listGroups is preserved (the canonical Group-catalogue read)", () => {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      expect(typeof client.groups.listGroups).toBe("function");
    });
  });

  describe("D424 Phase 1.2 — memory list/search/detail wrappers", () => {
    function installMock(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response | Promise<Response>): void {
      globalThis.fetch = Object.assign(handler, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;
    }

    const memoryRow = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "fact",
      content: "likes oolong",
      importance: 0.5,
      tier: 1,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      namespaceIds: ["ns-1"],
      accessList: [{ userHandle: "ada", displayName: "Ada" }],
    };

    test("listMemories — GET /api/memory with serialized cursor/limit/includeArchive/room filters + auth", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let authHeader: string | null = null;
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        authHeader = readAuthHeader(init);
        return new Response(
          JSON.stringify({
            items: [memoryRow],
            nextCursor: "cursor-2",
            memoryMode: "namespace",
            total: 42,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok-123");
      const out = await client.listMemories({
        cursor: "cursor-1",
        limit: 25,
        includeArchive: true,
        room: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(seenMethod).toBe("GET");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory?cursor=cursor-1&limit=25&includeArchive=true&room=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(authHeader === "Bearer tok-123").toBe(true);
      expect(out.items[0]?.id).toBe(memoryRow.id);
      expect(out.nextCursor).toBe("cursor-2");
      expect(out.memoryMode).toBe("namespace");
      expect(out.total).toBe(42);
    });

    test("listMemories — omits query string when no opts given", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ items: [], nextCursor: null, memoryMode: "scope" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.listMemories();
      expect(seenUrl).toBe("http://127.0.0.1:9/api/memory");
    });

    test("memory reads resolve a fresh session token before requesting", async () => {
      const seenAuth: Array<string | null> = [];
      installMock((_input, init) => {
        seenAuth.push(readAuthHeader(init));
        return new Response(
          JSON.stringify({ items: [], nextCursor: null, memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      let providerCalls = 0;
      client.setToken("stale-token");
      client.setTokenProvider(async () => {
        providerCalls += 1;
        return "fresh-token";
      });

      await client.listMemories();

      expect(providerCalls).toBe(1);
      expect(seenAuth).toEqual(["Bearer fresh-token"]);
    });

    test("listMemories — serializes audience=private and person filter", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ items: [], nextCursor: null, memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.listMemories({ audience: "private", person: "ada" });
      expect(seenUrl).toContain("audience=private");
      expect(seenUrl).toContain("person=ada");
    });

    test("listMemories — non-2xx throws ApiError with status", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "read_memories capability required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.listMemories();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(403);
      expect((caught as ApiError).message).toBe("read_memories capability required");
    });

    test("searchMemories — translates semantic→vector and serializes q/mode/limit", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({
            results: [
              {
                id: memoryRow.id,
                type: "fact",
                content: "oolong",
                importance: 0.5,
                tier: 1,
                score: 0.91,
                createdAt: "2026-07-14T10:00:00.000Z",
              },
            ],
            memoryMode: "namespace",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.searchMemories({ q: "tea", mode: "semantic", limit: 10 });

      expect(seenUrl).toBe("http://127.0.0.1:9/api/memory/search?q=tea&mode=vector&limit=10");
      expect(out.results[0]?.score).toBe(0.91);
      expect(out.memoryMode).toBe("namespace");
    });

    test("searchMemories — text mode passes mode=text", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ results: [], memoryMode: "scope" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.searchMemories({ q: "tea", mode: "text", includeArchive: true });
      expect(seenUrl).toContain("q=tea");
      expect(seenUrl).toContain("mode=text");
      expect(seenUrl).toContain("includeArchive=true");
    });

    test("searchMemories — non-2xx throws ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Query parameter q is required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.searchMemories({ q: "", mode: "text" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    });

    test("getMemory — GET /api/memory/:id with encoded id + parses detail envelope", async () => {
      let seenUrl = "";
      let seenMethod = "";
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        return new Response(
          JSON.stringify({
            memory: { ...memoryRow, demotedAt: null, demotedFrom: null },
            memoryMode: "namespace",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const id = "550e8400-e29b-41d4-a716-446655440000";
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.getMemory(id);

      expect(seenMethod).toBe("GET");
      expect(seenUrl).toBe(`http://127.0.0.1:9/api/memory/${id}`);
      expect(out.memory.id).toBe(id);
      expect(out.memory.demotedAt).toBeNull();
      expect(out.memory.accessList?.[0]?.userHandle).toBe("ada");
      expect(out.memoryMode).toBe("namespace");
    });

    test("getMemory — 404 throws ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Memory not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.getMemory("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
      expect((caught as ApiError).message).toBe("Memory not found");
    });
  });

  describe("D442 Phase 1.1 — memory mutation wrappers", () => {
    function installMock(
      handler: (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => Response | Promise<Response>,
    ): void {
      globalThis.fetch = Object.assign(handler, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;
    }

    const memoryDetailRow = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "fact",
      content: "likes oolong",
      importance: 0.8,
      tier: 1,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T11:00:00.000Z",
      namespaceIds: ["ns-1"],
      demotedAt: null,
      demotedFrom: null,
      accessList: [{ userHandle: "ada", displayName: "Ada" }],
    };

    test("updateMemory — PATCH /api/memory/:id with JSON body + auth", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let bodyText = "";
      let authHeader: string | null = null;
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        bodyText = typeof init?.body === "string" ? init.body : "";
        authHeader = readAuthHeader(init);
        return new Response(
          JSON.stringify({ memory: memoryDetailRow, memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok-123");
      const out = await client.updateMemory(
        "550e8400-e29b-41d4-a716-446655440000",
        { content: "likes matcha", importance: 0.9 },
      );

      expect(seenMethod).toBe("PATCH");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000",
      );
      expect(authHeader === "Bearer tok-123").toBe(true);
      const parsed = JSON.parse(bodyText) as {
        content?: string;
        importance?: number;
      };
      expect(parsed.content).toBe("likes matcha");
      expect(parsed.importance).toBe(0.9);
      expect(out.memory.id).toBe(memoryDetailRow.id);
      expect(out.memoryMode).toBe("namespace");
    });

    test("updateMemory — 403 manage_memories surfaces as ApiError", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "manage_memories capability required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.updateMemory("550e8400-e29b-41d4-a716-446655440000", {
          content: "x",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(403);
      expect((caught as ApiError).message).toBe(
        "manage_memories capability required",
      );
    });

    test("updateMemory — 404 not found surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Memory not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.updateMemory("550e8400-e29b-41d4-a716-446655440000", {
          content: "x",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
    });

    test("updateMemory — 400 invalid id surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Invalid memory id" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.updateMemory("not-a-uuid", { content: "x" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    });

    test("archiveMemory — DELETE /api/memory/:id?mode=archive, no body, parses status envelope", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let seenBody: string | undefined;
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        seenBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({ status: "archived", memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.archiveMemory(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(seenMethod).toBe("DELETE");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000?mode=archive",
      );
      expect(seenBody).toBeUndefined();
      expect(out.status).toBe("archived");
      expect(out.memoryMode).toBe("namespace");
    });

    test("archiveMemory — 403 surfaces as ApiError", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "manage_memories capability required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.archiveMemory("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(403);
    });

    test("hardDeleteMemory — DELETE ?mode=hard without confirmShared", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ status: "deleted", memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.hardDeleteMemory(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000?mode=hard",
      );
      expect(out.status).toBe("deleted");
    });

    test("hardDeleteMemory — appends confirmShared=true when requested", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ status: "detached", memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.hardDeleteMemory(
        "550e8400-e29b-41d4-a716-446655440000",
        { confirmShared: true },
      );

      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000?mode=hard&confirmShared=true",
      );
    });

    test("hardDeleteMemory — 409 shared conflict throws MemoryHardDeleteConflictError with count/ids/hint", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({
            error: "Memory is shared across multiple namespaces",
            namespaceCount: 3,
            namespaceIds: ["ns-1", "ns-2", "ns-3"],
            hint: "Deleting removes it from your writable namespace. Others may keep access.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.hardDeleteMemory("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MemoryHardDeleteConflictError);
      const err = caught as MemoryHardDeleteConflictError;
      expect(err.namespaceCount).toBe(3);
      expect(err.namespaceIds).toEqual(["ns-1", "ns-2", "ns-3"]);
      expect(err.hint).toBe(
        "Deleting removes it from your writable namespace. Others may keep access.",
      );
      expect(err.message).toBe("Memory is shared across multiple namespaces");
      expect(err.name).toBe("MemoryHardDeleteConflictError");
    });

    test("hardDeleteMemory — scope-mode 409 omits hint (optional field)", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({
            error:
              "Memory is attached to shared namespaces and cannot be hard-deleted from scope",
            namespaceCount: 2,
            namespaceIds: ["ns-a", "ns-b"],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.hardDeleteMemory("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MemoryHardDeleteConflictError);
      const err = caught as MemoryHardDeleteConflictError;
      expect(err.namespaceCount).toBe(2);
      expect(err.namespaceIds).toEqual(["ns-a", "ns-b"]);
      expect(err.hint).toBeUndefined();
    });

    test("hardDeleteMemory — 404 surfaces as ApiError (not the conflict type)", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Memory not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.hardDeleteMemory("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).not.toBeInstanceOf(MemoryHardDeleteConflictError);
      expect((caught as ApiError).status).toBe(404);
    });

    test("grantMemory — POST /api/memory/:id/grant with room_id body", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let bodyText = "";
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        bodyText = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({ status: "granted", namespaceId: "ns-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.grantMemory(
        "550e8400-e29b-41d4-a716-446655440000",
        { roomId: "660e8400-e29b-41d4-a716-446655440000" },
      );

      expect(seenMethod).toBe("POST");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000/grant",
      );
      const parsed = JSON.parse(bodyText) as { room_id?: string };
      expect(parsed.room_id).toBe("660e8400-e29b-41d4-a716-446655440000");
      expect(out.status).toBe("granted");
      expect(out.namespaceId).toBe("ns-1");
    });

    test("grantMemory — user_handle path returns roomLabel + minted", async () => {
      let bodyText = "";
      installMock((_input, init) => {
        bodyText = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            status: "granted",
            roomLabel: "ada + bob",
            minted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.grantMemory(
        "550e8400-e29b-41d4-a716-446655440000",
        { userHandle: "ada" },
      );

      const parsed = JSON.parse(bodyText) as { user_handle?: string };
      expect(parsed.user_handle).toBe("ada");
      expect(out.roomLabel).toBe("ada + bob");
      expect(out.minted).toBe(true);
    });

    test("grantMemory — 400 (neither/both of room_id/user_handle) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "Provide exactly one of room_id or user_handle" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.grantMemory("550e8400-e29b-41d4-a716-446655440000", {
          userHandle: "",
        } as { userHandle: string });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    });

    test("grantMemory — 404 (room not found) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Room not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.grantMemory("550e8400-e29b-41d4-a716-446655440000", {
          roomId: "660e8400-e29b-41d4-a716-446655440000",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
    });

    test("revokeMemory — POST /api/memory/:id/revoke with user_handle body", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let bodyText = "";
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        bodyText = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({ status: "revoked", reHomed: 2, skipped: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.revokeMemory(
        "550e8400-e29b-41d4-a716-446655440000",
        "ada",
      );

      expect(seenMethod).toBe("POST");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000/revoke",
      );
      const parsed = JSON.parse(bodyText) as { user_handle?: string };
      expect(parsed.user_handle).toBe("ada");
      expect(out.status).toBe("revoked");
      expect(out.reHomed).toBe(2);
      expect(out.skipped).toEqual([]);
    });

    test("revokeMemory — 400 (self-revoke) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "use make_private to remove your own access" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.revokeMemory("550e8400-e29b-41d4-a716-446655440000", "me");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    });

    test("revokeMemory — non-shared 409 stays ApiError (not the hard-delete conflict)", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "No private namespace to re-home into" }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.revokeMemory("550e8400-e29b-41d4-a716-446655440000", "ada");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).not.toBeInstanceOf(MemoryHardDeleteConflictError);
      expect((caught as ApiError).status).toBe(409);
    });

    test("makeMemoryPrivate — POST /api/memory/:id/make_private with empty body", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let bodyText = "";
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        bodyText = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({ status: "private", skipped: ["ns-2"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.makeMemoryPrivate(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(seenMethod).toBe("POST");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/memory/550e8400-e29b-41d4-a716-446655440000/make_private",
      );
      expect(bodyText).toBe("{}");
      expect(out.status).toBe("private");
      expect(out.skipped).toEqual(["ns-2"]);
    });

    test("makeMemoryPrivate — 403 surfaces as ApiError", async () => {
      installMock(() =>
        new Response(
          JSON.stringify({ error: "manage_memories capability required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.makeMemoryPrivate("550e8400-e29b-41d4-a716-446655440000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(403);
    });

    test("memory mutations resolve a fresh session token before requesting", async () => {
      const seenAuth: Array<string | null> = [];
      installMock((_input, init) => {
        seenAuth.push(readAuthHeader(init));
        return new Response(
          JSON.stringify({ status: "archived", memoryMode: "namespace" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      let providerCalls = 0;
      client.setToken("stale-token");
      client.setTokenProvider(async () => {
        providerCalls += 1;
        return "fresh-token";
      });

      await client.archiveMemory("550e8400-e29b-41d4-a716-446655440000");

      expect(providerCalls).toBe(1);
      expect(seenAuth).toEqual(["Bearer fresh-token"]);
    });
  });

  describe("D442 Phase 4.1 — artifact discussion-rooms wrapper", () => {
    function installMock(
      handler: (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => Response | Promise<Response>,
    ): void {
      globalThis.fetch = Object.assign(handler, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;
    }

    test("listArtifactDiscussionRooms — GET /api/workspace/artifacts/:id/discussion-rooms with auth + encoded id", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let authHeader: string | null = null;
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        authHeader = readAuthHeader(init);
        return new Response(
          JSON.stringify({
            rooms: [
              { id: "room-a", label: "Room A", kind: "private" },
              { id: "room-b", label: "Room B", kind: "group" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok-123");
      const out = await client.listArtifactDiscussionRooms(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(seenMethod).toBe("GET");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/550e8400-e29b-41d4-a716-446655440000/discussion-rooms",
      );
      expect(authHeader === "Bearer tok-123").toBe(true);
      expect(out.rooms).toEqual([
        { id: "room-a", label: "Room A", kind: "private" },
        { id: "room-b", label: "Room B", kind: "group" },
      ]);
    });

    test("listArtifactDiscussionRooms — URL-encodes the artifact id", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(JSON.stringify({ rooms: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.listArtifactDiscussionRooms("art with spaces/odd");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/art%20with%20spaces%2Fodd/discussion-rooms",
      );
    });

    test("listArtifactDiscussionRooms — resolves a fresh session token before requesting", async () => {
      const seenAuth: Array<string | null> = [];
      let providerCalls = 0;
      installMock((_input, init) => {
        seenAuth.push(readAuthHeader(init));
        return new Response(JSON.stringify({ rooms: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("stale-token");
      client.setTokenProvider(async () => {
        providerCalls += 1;
        return "fresh-token";
      });

      await client.listArtifactDiscussionRooms("art-1");

      expect(providerCalls).toBe(1);
      expect(seenAuth).toEqual(["Bearer fresh-token"]);
    });

    test("listArtifactDiscussionRooms — empty rooms envelope parses to []", async () => {
      installMock(() =>
        new Response(JSON.stringify({ rooms: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      const out = await client.listArtifactDiscussionRooms("art-1");
      expect(out.rooms).toEqual([]);
    });

    test("listArtifactDiscussionRooms — 404 surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.listArtifactDiscussionRooms("art-missing");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
      expect((caught as ApiError).message).toBe("Not found");
    });

    test("listArtifactDiscussionRooms — 403 (no agent context) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Agent context required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.listArtifactDiscussionRooms("art-1");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(403);
      expect((caught as ApiError).message).toBe("Agent context required");
    });

    test("listArtifactDiscussionRooms — 501 (scope mode) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Scope memory mode is not supported" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.listArtifactDiscussionRooms("art-1");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(501);
    });
  });

  describe("D442 Phase 4.2 — createArtifactDiscussionRoom wrapper", () => {
    function installMock(
      handler: (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => Response | Promise<Response>,
    ): void {
      globalThis.fetch = Object.assign(handler, {
        preconnect: realFetch.preconnect.bind(realFetch),
      }) as typeof fetch;
    }

    test("createArtifactDiscussionRoom — POST with auth + encoded id + returns { id, label, kind }", async () => {
      let seenUrl = "";
      let seenMethod = "";
      let authHeader: string | null = null;
      let bodyText = "";
      installMock((input, init) => {
        seenUrl = requestUrl(input);
        seenMethod = init?.method ?? "GET";
        bodyText = typeof init?.body === "string" ? init.body : "";
        authHeader = readAuthHeader(init);
        return new Response(
          JSON.stringify({ id: "room-new", label: "Project Q3", kind: "private" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok-123");
      const out = await client.createArtifactDiscussionRoom(
        "550e8400-e29b-41d4-a716-446655440000",
        { label: "Project Q3" },
      );

      expect(seenMethod).toBe("POST");
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/550e8400-e29b-41d4-a716-446655440000/discussion-rooms",
      );
      expect(authHeader === "Bearer tok-123").toBe(true);
      const parsed = JSON.parse(bodyText) as { label?: string };
      expect(parsed.label).toBe("Project Q3");
      expect(out).toEqual({ id: "room-new", label: "Project Q3", kind: "private" });
    });

    test("createArtifactDiscussionRoom — omits body when no label given (server defaults)", async () => {
      let bodyText: string | undefined;
      installMock((_input, init) => {
        bodyText = typeof init?.body === "string" ? init.body : undefined;
        return new Response(
          JSON.stringify({ id: "room-new", label: "q3.md", kind: "private" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.createArtifactDiscussionRoom("art-1");
      // No JSON body written when no label is supplied — the server
      // derives the label from the artifact path basename.
      expect(bodyText).toBeUndefined();
    });

    test("createArtifactDiscussionRoom — URL-encodes the artifact id", async () => {
      let seenUrl = "";
      installMock((input) => {
        seenUrl = requestUrl(input);
        return new Response(
          JSON.stringify({ id: "r", label: "x", kind: "private" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.createArtifactDiscussionRoom("art with spaces/odd", { label: "L" });
      expect(seenUrl).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/art%20with%20spaces%2Fodd/discussion-rooms",
      );
    });

    test("createArtifactDiscussionRoom — resolves a fresh session token before requesting", async () => {
      const seenAuth: Array<string | null> = [];
      let providerCalls = 0;
      installMock((_input, init) => {
        seenAuth.push(readAuthHeader(init));
        return new Response(
          JSON.stringify({ id: "r", label: "x", kind: "private" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      });

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("stale-token");
      client.setTokenProvider(async () => {
        providerCalls += 1;
        return "fresh-token";
      });

      await client.createArtifactDiscussionRoom("art-1", { label: "L" });

      expect(providerCalls).toBe(1);
      expect(seenAuth).toEqual(["Bearer fresh-token"]);
    });

    test("createArtifactDiscussionRoom — 404 (unreadable artifact) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.createArtifactDiscussionRoom("art-missing", { label: "L" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
      expect((caught as ApiError).message).toBe("Not found");
    });

    test("createArtifactDiscussionRoom — 400 (no default agent) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "no_default_agent", code: "no_default_agent" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.createArtifactDiscussionRoom("art-1", { label: "L" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    });

    test("createArtifactDiscussionRoom — 501 (scope mode) surfaces as ApiError", async () => {
      installMock(() =>
        new Response(JSON.stringify({ error: "Scope memory mode is not supported" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      let caught: unknown;
      try {
        await client.createArtifactDiscussionRoom("art-1", { label: "L" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(501);
    });
  });
});
