import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ApiError,
  ContentAccessApiError,
  NautiloApiClient,
  contentAccessCommitRequestSchema,
  contentAccessPrepareRequestSchema,
} from "../../src/client";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_ROOM_ID = "66666666-6666-4666-8666-666666666666";

const normalizedCommand = {
  operationId: OPERATION_ID,
  object: { kind: "artifact" as const, id: OBJECT_ID },
  change: { kind: "grant_people" as const, selectedActorIds: [ACTOR_ID] },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parsedJsonBody(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  return JSON.parse(body) as unknown;
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected request to reject");
}

describe("content access API", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("uses the explicit Room, resolves people to actors, and reuses the preview token", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({
        outcome: "prepared",
        command: { ...normalizedCommand, serverCommandRevision: 7 },
        previewToken: "signed-preview",
        expiresAt: 1_800_000_000_000,
        preview: {
          humanActorIds: [ACTOR_ID],
          publicRoom: false,
          skippedAttachmentCount: 0,
          serverLabel: "One person",
        },
        serverGeneration: 3,
      }),
      jsonResponse({
        operationId: OPERATION_ID,
        outcome: "applied",
        stateChanged: true,
        originalStateChanged: true,
        replayed: false,
        attachedCount: 1,
        detachedCount: 0,
        skippedCount: 0,
        serverReceiptVersion: 2,
      }),
    ];
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        init,
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    const prepared = await client.prepareContentAccess({
      operationId: OPERATION_ID,
      object: { kind: "artifact", id: OBJECT_ID },
      change: { kind: "grant_people", selectedUserIds: [USER_ID] },
    }, { roomId: ROOM_ID });
    expect((prepared as Record<string, unknown>)["serverGeneration"]).toBe(3);
    expect((prepared.command as Record<string, unknown>)["serverCommandRevision"]).toBe(7);
    expect((prepared.preview as Record<string, unknown>)["serverLabel"]).toBe("One person");

    const receipt = await client.commitContentAccess(
      prepared.command,
      prepared.previewToken,
      { roomId: ROOM_ID },
    );
    expect((receipt as Record<string, unknown>)["serverReceiptVersion"]).toBe(2);

    expect(requests.map(({ url, init }) => ({
      url,
      method: init?.method,
      body: parsedJsonBody(init?.body),
    }))).toEqual([
      {
        url: `http://127.0.0.1:9/api/content-access/prepare?roomId=${ROOM_ID}`,
        method: "POST",
        body: {
          operationId: OPERATION_ID,
          object: { kind: "artifact", id: OBJECT_ID },
          change: { kind: "grant_people", selectedUserIds: [USER_ID] },
        },
      },
      {
        url: `http://127.0.0.1:9/api/content-access/commit?roomId=${ROOM_ID}`,
        method: "POST",
        body: { ...normalizedCommand, previewToken: "signed-preview" },
      },
    ]);
  });

  test("supports every public prepare change and normalized commit change", () => {
    for (const change of [
      { kind: "grant_room" as const, targetRoomId: TARGET_ROOM_ID },
      { kind: "remove_person" as const, actorId: ACTOR_ID },
      { kind: "detach_room" as const, targetRoomId: TARGET_ROOM_ID },
      { kind: "make_private" as const },
    ]) {
      expect(contentAccessPrepareRequestSchema.parse({
        operationId: OPERATION_ID,
        object: { kind: "memory", id: OBJECT_ID },
        change,
      }).change).toEqual(change);
      expect(contentAccessCommitRequestSchema.parse({
        operationId: OPERATION_ID,
        object: { kind: "memory", id: OBJECT_ID },
        change,
        previewToken: "preview",
      }).change).toEqual(change);
    }
  });

  test("rejects malformed successes, including a failure body returned with 200", async () => {
    const responses = [
      jsonResponse({
        outcome: "prepared",
        command: normalizedCommand,
        previewToken: "signed-preview",
        preview: {
          humanActorIds: [ACTOR_ID],
          publicRoom: false,
          skippedAttachmentCount: 0,
        },
      }),
      jsonResponse({
        error: "Content access result unavailable",
        outcome: "failed",
        stateChanged: "unknown",
        receiptPersisted: false,
        recovery: "retry_receipt",
      }),
    ];
    globalThis.fetch = Object.assign(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect(await caughtFrom(client.prepareContentAccess({
      operationId: OPERATION_ID,
      object: { kind: "artifact", id: OBJECT_ID },
      change: { kind: "grant_people", selectedUserIds: [USER_ID] },
    }, { roomId: ROOM_ID }))).toBeDefined();
    expect(await caughtFrom(client.commitContentAccess(
      normalizedCommand,
      "signed-preview",
      { roomId: ROOM_ID },
    ))).toBeDefined();
  });

  test("preserves typed recovery facts for 403, 409, and 503", async () => {
    const failures = [
      {
        status: 403,
        body: {
          error: "Content access denied",
          outcome: "denied",
          stateChanged: false,
          receiptPersisted: true,
          recovery: "prepare_again",
        },
      },
      {
        status: 409,
        body: {
          error: "Content access changed. Prepare again.",
          outcome: "stale",
          stateChanged: false,
          receiptPersisted: false,
          recovery: "retry_operation",
        },
      },
      {
        status: 503,
        body: {
          error: "Content access result unavailable",
          outcome: "failed",
          stateChanged: "unknown",
          receiptPersisted: false,
          recovery: "retry_receipt",
        },
      },
    ];
    globalThis.fetch = Object.assign(async () => {
      const failure = failures.shift();
      if (!failure) throw new Error("Unexpected request");
      return jsonResponse(failure.body, failure.status);
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    for (const expected of [
      { status: 403, outcome: "denied", stateChanged: false, receiptPersisted: true, recovery: "prepare_again" },
      { status: 409, outcome: "stale", stateChanged: false, receiptPersisted: false, recovery: "retry_operation" },
      { status: 503, outcome: "failed", stateChanged: "unknown", receiptPersisted: false, recovery: "retry_receipt" },
    ] as const) {
      let caught: unknown;
      try {
        await client.prepareContentAccess({
          operationId: OPERATION_ID,
          object: { kind: "artifact", id: OBJECT_ID },
          change: { kind: "make_private" },
        }, { roomId: ROOM_ID });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ContentAccessApiError);
      expect(caught).toMatchObject(expected);
    }
  });

  test("does not manufacture typed recovery facts from a malformed error body", async () => {
    globalThis.fetch = Object.assign(async () => jsonResponse({
      error: "temporarily unavailable",
      outcome: "failed",
      stateChanged: true,
      recovery: "retry_receipt",
    }, 503), { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let caught: unknown;
    try {
      await client.prepareContentAccess({
        operationId: OPERATION_ID,
        object: { kind: "artifact", id: OBJECT_ID },
        change: { kind: "make_private" },
      }, { roomId: ROOM_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(ContentAccessApiError);
  });

  test("forwards AbortSignal to prepare and commit", async () => {
    let started: (() => void) | undefined;
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = Object.assign(async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const signal = init?.signal;
      seenSignals.push(signal);
      started?.();
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
        if (signal?.aborted) return rejectAborted();
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const requests = [
      (signal: AbortSignal) => client.prepareContentAccess({
        operationId: OPERATION_ID,
        object: { kind: "artifact" as const, id: OBJECT_ID },
        change: { kind: "make_private" as const },
      }, { roomId: ROOM_ID, signal }),
      (signal: AbortSignal) => client.commitContentAccess(
        normalizedCommand,
        "signed-preview",
        { roomId: ROOM_ID, signal },
      ),
    ];
    for (const request of requests) {
      const controller = new AbortController();
      const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
      const pending = request(controller.signal);
      await fetchStarted;
      expect(seenSignals.at(-1)).toBe(controller.signal);
      controller.abort();
      expect(await caughtFrom(pending)).toMatchObject({ name: "AbortError" });
    }
  });
});
