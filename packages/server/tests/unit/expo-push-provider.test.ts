import { describe, expect, test } from "bun:test";
import type { MobilePushEnvelopeV1 } from "@nautilo/types";
import {
  EXPO_PUSH_GENERIC_PRESENTATIONS,
  EXPO_PUSH_ANDROID_CHANNEL_ID,
  EXPO_PUSH_MAX_MESSAGES_PER_REQUEST,
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_SEND_URL,
  ExpoPushProvider,
  type ExpoPushDelivery,
  type ExpoPushFetch,
} from "../../src/push/expo-push-provider";

const FIRST_TICKET_ID = "ticket-first";
const SECOND_TICKET_ID = "ticket-second";

function envelope(
  overrides: Partial<MobilePushEnvelopeV1> = {},
): MobilePushEnvelopeV1 {
  return {
    version: 1,
    notificationId: "11111111-1111-4111-8111-111111111111",
    bindingId: "22222222-2222-4222-8222-222222222222",
    kind: "important_message",
    roomId: "33333333-3333-4333-8333-333333333333",
    topLevelRoomId: "33333333-3333-4333-8333-333333333333",
    messageId: 42,
    occurredAt: "2026-08-05T20:00:00.000Z",
    ...overrides,
  } as MobilePushEnvelopeV1;
}

function delivery(
  deliveryId = "delivery-one",
  overrides: Partial<ExpoPushDelivery> = {},
): ExpoPushDelivery {
  return {
    deliveryId,
    expoPushToken: "ExponentPushToken[token-for-test-only]",
    envelope: envelope(),
    presentation: {
      kind: "important_message",
      senderDisplayName: "Ada",
      roomLabel: "Launch room",
    },
    ...overrides,
  };
}

function responseJson(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const responseHeaders = new Headers();
  for (const [name, headerValue] of Object.entries(headers)) {
    responseHeaders.set(name, headerValue);
  }
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function requestJsonBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as unknown;
}

function queuedFetch(
  responses: readonly (Response | Error)[],
  seen: Array<{ readonly url: string; readonly init: RequestInit }>,
): ExpoPushFetch {
  let index = 0;
  return async (url, init) => {
    seen.push({ url, init });
    const next = responses[index++];
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
}

describe("ExpoPushProvider.send", () => {
  test("uses a target-free fixed presentation for a user-requested test", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({ data: [{ status: "ok", id: FIRST_TICKET_ID }] }),
      ], seen),
    });
    const testEnvelope: MobilePushEnvelopeV1 = {
      version: 1,
      notificationId: "11111111-1111-4111-8111-111111111111",
      bindingId: "22222222-2222-4222-8222-222222222222",
      kind: "test",
      occurredAt: "2026-08-05T20:00:00.000Z",
    };
    expect(await provider.send([delivery("test", {
      envelope: testEnvelope,
      presentation: EXPO_PUSH_GENERIC_PRESENTATIONS.test,
    })])).toEqual([
      { kind: "accepted_ticket", deliveryId: "test", ticketId: FIRST_TICKET_ID },
    ]);
    expect(requestJsonBody(seen[0]!.init)).toMatchObject([
      { title: "Nautilo", body: "Test notification", data: testEnvelope },
    ]);
    expect((requestJsonBody(seen[0]!.init) as Array<Record<string, unknown>>)[0]).not.toHaveProperty("badge");
  });

  test("includes the absolute unread badge value requested by the worker", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({ data: [{ status: "ok", id: FIRST_TICKET_ID }] }),
      ], seen),
    });
    await provider.send([delivery("badged", { badge: 7 })]);
    expect(requestJsonBody(seen[0]!.init)).toMatchObject([{ badge: 7 }]);
  });

  test("uses Desktop-equivalent sender and Room copy and preserves partial ticket ordering", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({
          data: [
            { status: "error", details: { error: "DeviceNotRegistered" } },
            { status: "ok", id: SECOND_TICKET_ID },
          ],
        }),
      ], seen),
    });

    expect(await provider.send([delivery("delivery-first"), delivery("delivery-second")])).toEqual([
      { kind: "device_not_registered", deliveryId: "delivery-first" },
      { kind: "accepted_ticket", deliveryId: "delivery-second", ticketId: SECOND_TICKET_ID },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(EXPO_PUSH_SEND_URL);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers).toEqual({
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    });
    expect(requestJsonBody(seen[0]!.init)).toEqual([
      {
        to: "ExponentPushToken[token-for-test-only]",
        title: "Ada",
        body: "New message in Launch room",
        sound: "default",
        priority: "high",
        ttl: 3600,
        channelId: EXPO_PUSH_ANDROID_CHANNEL_ID,
        data: envelope(),
      },
      {
        to: "ExponentPushToken[token-for-test-only]",
        title: "Ada",
        body: "New message in Launch room",
        sound: "default",
        priority: "high",
        ttl: 3600,
        channelId: EXPO_PUSH_ANDROID_CHANNEL_ID,
        data: envelope(),
      },
    ]);
  });

  test("formats subthread replies with the same context as Desktop", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({ data: [{ status: "ok", id: FIRST_TICKET_ID }] }),
      ], seen),
    });

    await provider.send([delivery("reply", {
      envelope: envelope({ roomId: "55555555-5555-4555-8555-555555555555" }),
      presentation: {
        kind: "important_message",
        senderDisplayName: "Ada",
        roomLabel: "Release thread",
        parentRoomLabel: "Launch room",
      },
    })]);

    expect(requestJsonBody(seen[0]!.init)).toMatchObject([{
      title: "Ada",
      body: "New reply in Release thread, Launch room",
    }]);
  });

  test("never sends arbitrary presentation copy, malformed envelopes, or batches over Expo's limit", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({ fetch: queuedFetch([], seen) });
    const forgedPresentation = {
      kind: "important_message",
      senderDisplayName: "Private\nmessage text",
      roomLabel: "Private room title",
    } as unknown as ExpoPushDelivery["presentation"];

    expect(await provider.send([delivery("forged", { presentation: forgedPresentation })])).toEqual([
      { kind: "permanent_provider_failure", deliveryId: "forged", code: "invalid_payload" },
    ]);
    const malformedEnvelope = { ...envelope(), messageId: undefined } as unknown as MobilePushEnvelopeV1;
    expect(await provider.send([delivery("malformed-envelope", { envelope: malformedEnvelope })])).toEqual([
      { kind: "permanent_provider_failure", deliveryId: "malformed-envelope", code: "invalid_payload" },
    ]);
    expect(await provider.send([delivery("bad-badge", { badge: 0 })])).toEqual([
      { kind: "permanent_provider_failure", deliveryId: "bad-badge", code: "invalid_payload" },
    ]);
    expect(await provider.send(
      Array.from({ length: EXPO_PUSH_MAX_MESSAGES_PER_REQUEST + 1 }, (_, index) => delivery(`delivery-${index}`)),
    )).toHaveLength(EXPO_PUSH_MAX_MESSAGES_PER_REQUEST + 1);
    expect(seen).toHaveLength(0);
  });

  test("maps 429, 5xx, 4xx, and malformed 200 responses without provider-success fiction", async () => {
    const results = await Promise.all([
      new ExpoPushProvider({
        fetch: queuedFetch([responseJson({ errors: [] }, 429, { "retry-after": "3" })], []),
      }).send([delivery("rate")]),
      new ExpoPushProvider({
        fetch: queuedFetch([responseJson({ errors: [] }, 503)], []),
      }).send([delivery("outage")]),
      new ExpoPushProvider({
        fetch: queuedFetch([responseJson({ errors: [] }, 400)], []),
      }).send([delivery("bad-request")]),
      new ExpoPushProvider({
        fetch: queuedFetch([new Response("not-json", { status: 200 })], []),
      }).send([delivery("bad-json")]),
    ]);

    expect(results).toEqual([
      [{ kind: "retryable_provider_failure", deliveryId: "rate", code: "rate_limited", retryAfterMs: 3000 }],
      [{ kind: "retryable_provider_failure", deliveryId: "outage", code: "server_error" }],
      [{ kind: "permanent_provider_failure", deliveryId: "bad-request", code: "provider_rejected" }],
      [{ kind: "retryable_provider_failure", deliveryId: "bad-json", code: "malformed_response" }],
    ]);
  });

  test("maps network, cancellation, and adapter timeout to explicit retryable states", async () => {
    const network = new ExpoPushProvider({ fetch: queuedFetch([new Error("network unavailable")], []) });
    expect(await network.send([delivery("network")])).toEqual([
      { kind: "retryable_provider_failure", deliveryId: "network", code: "network_error" },
    ]);

    const waitsForAbort: ExpoPushFetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const controller = new AbortController();
    const aborted = new ExpoPushProvider({ fetch: waitsForAbort }).send([delivery("aborted")], {
      signal: controller.signal,
    });
    controller.abort();
    expect(await aborted).toEqual([
      { kind: "retryable_provider_failure", deliveryId: "aborted", code: "aborted" },
    ]);

    const timeout = new ExpoPushProvider({ fetch: waitsForAbort, timeoutMs: 1 });
    expect(await timeout.send([delivery("timeout")])).toEqual([
      { kind: "retryable_provider_failure", deliveryId: "timeout", code: "timeout" },
    ]);
  });
});

describe("ExpoPushProvider.getReceipts", () => {
  test("uses the receipt endpoint, marks omission as not-ready, and never exposes a token", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({ data: { [FIRST_TICKET_ID]: { status: "ok" } } }),
      ], seen),
    });

    expect(await provider.getReceipts([
      { deliveryId: "first", ticketId: FIRST_TICKET_ID },
      { deliveryId: "second", ticketId: SECOND_TICKET_ID },
    ])).toEqual([
      { kind: "delivered", deliveryId: "first", ticketId: FIRST_TICKET_ID },
      { kind: "retryable_provider_failure", deliveryId: "second", code: "receipt_not_ready" },
    ]);
    expect(seen[0]!.url).toBe(EXPO_PUSH_RECEIPTS_URL);
    expect(requestJsonBody(seen[0]!.init)).toEqual({ ids: [FIRST_TICKET_ID, SECOND_TICKET_ID] });
    expect(JSON.stringify(requestJsonBody(seen[0]!.init))).not.toContain("ExponentPushToken");
  });

  test("maps terminal, retryable, and credential receipt errors explicitly", async () => {
    const provider = new ExpoPushProvider({
      fetch: queuedFetch([
        responseJson({
          data: {
            [FIRST_TICKET_ID]: { status: "error", details: { error: "DeviceNotRegistered" } },
            [SECOND_TICKET_ID]: { status: "error", details: { error: "MessageRateExceeded" } },
            "ticket-credentials": { status: "error", details: { error: "InvalidCredentials" } },
          },
        }),
      ], []),
    });

    expect(await provider.getReceipts([
      { deliveryId: "retire", ticketId: FIRST_TICKET_ID },
      { deliveryId: "retry", ticketId: SECOND_TICKET_ID },
      { deliveryId: "credentials", ticketId: "ticket-credentials" },
    ])).toEqual([
      { kind: "device_not_registered", deliveryId: "retire" },
      { kind: "retryable_provider_failure", deliveryId: "retry", code: "message_rate_exceeded" },
      { kind: "permanent_provider_failure", deliveryId: "credentials", code: "invalid_credentials" },
    ]);
  });

  test("fails closed for malformed receipt mappings and request-limit violations", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const malformed = new ExpoPushProvider({
      fetch: queuedFetch([responseJson({ data: { "unrequested-ticket": { status: "ok" } } })], seen),
    });
    expect(await malformed.getReceipts([{ deliveryId: "one", ticketId: FIRST_TICKET_ID }])).toEqual([
      { kind: "retryable_provider_failure", deliveryId: "one", code: "malformed_response" },
    ]);

    const tooMany = new ExpoPushProvider({ fetch: queuedFetch([], seen) });
    expect(await tooMany.getReceipts(
      Array.from({ length: 1001 }, (_, index) => ({ deliveryId: `delivery-${index}`, ticketId: `ticket-${index}` })),
    )).toHaveLength(1001);
    expect(seen).toHaveLength(1);
  });
});
