import { describe, expect, test } from "bun:test";

import {
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";
import {
  messageBackfillProgressSchema,
  messageBackfillPublishRequestSchema,
} from
  "../../src/schemas/message-backfill";

const CLAIM_ID = "40000000-0000-4000-8000-000000000313";
const ROOM_ID = "42000000-0000-4000-8000-000000000313";
const DIGEST = "A".repeat(43);

const urgent = {
  messageId: 27,
  revision: 2,
  roomId: ROOM_ID,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Message backfill HTTP methods", () => {
  test("derives every publication carrier bound from its canonical codec", () => {
    const maxima = {
      requestBytesBase64url:
        MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
      payloadBytesBase64url: MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
      manifestBytesBase64url: MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
      envelopeBytesBase64url: MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
    } as const;
    const base = {
      claimId: CLAIM_ID,
      requestBytesBase64url: "AQ",
      payloadBytesBase64url: "AQ",
      manifestBytesBase64url: "AQ",
      envelopeBytesBase64url: "AQ",
    };

    for (const [field, maximumBytes] of Object.entries(maxima)) {
      const maximumCharacters = Math.ceil(maximumBytes * 4 / 3);
      expect(messageBackfillPublishRequestSchema.safeParse({
        ...base,
        [field]: "A".repeat(maximumCharacters),
      }).success, `${field} maximum`).toBeTrue();
      expect(messageBackfillPublishRequestSchema.safeParse({
        ...base,
        [field]: "A".repeat(Math.ceil((maximumBytes + 1) * 4 / 3)),
      }).success, `${field} above maximum`).toBeFalse();
    }
  });

  test("uses current-session transport and preserves exact request bodies", async () => {
    const requests: Array<Readonly<{
      path: string;
      search: string;
      method: string;
      authorization: string | null;
      body: unknown;
      signal: AbortSignal | null | undefined;
    }>> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = new URL(typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url);
      requests.push({
        path: url.pathname,
        search: url.search,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal,
      });
      if (url.pathname.endsWith("/next")) {
        return json({ status: "more", resumeAt: 2_000, snapshotAt: 1_000, complete: false });
      }
      if (url.pathname.endsWith("/source")) {
        return json({ status: "stale", resumeAt: 2_000 });
      }
      if (url.pathname.endsWith("/publish")) return json({ status: "published" });
      if (url.pathname.endsWith("/ack")) {
        return json({ status: "more", resumeAt: 2_000 });
      }
      return json({
        status: "active",
        snapshotAt: 1_000,
        snapshotComplete: true,
        caughtUp: false,
        lastSweepAt: 900,
        activeLease: true,
        counts: {
          eligible: 8,
          alreadyAuthenticated: 3,
          independentlyParityVerified: 2,
          claimedRepairing: 1,
          repairedAndVerified: 1,
          unsupported: 1,
          failed: 0,
        },
        waiting: {authorizedDevice: null, authority: null},
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");
    const controller = new AbortController();

    await client.nextMessageBackfill({ urgent }, {signal: controller.signal});
    await client.readMessageBackfillSource({ claimId: CLAIM_ID }, {signal: controller.signal});
    await client.publishMessageBackfill({
      claimId: CLAIM_ID,
      requestBytesBase64url: "AQ",
      payloadBytesBase64url: "Ag",
      manifestBytesBase64url: "Aw",
      envelopeBytesBase64url: "BA",
    }, {signal: controller.signal});
    await client.acknowledgeMessageBackfill({
      claimId: CLAIM_ID,
      outcome: "reconciled",
      claimDigestBase64url: DIGEST,
      sourceDigestBase64url: DIGEST,
      manifestDigestBase64url: DIGEST,
      signatureBase64url: "A".repeat(86),
    }, {signal: controller.signal});
    await client.getMessageBackfillProgress({signal: controller.signal});

    expect(requests.map(({ path, method }) => [method, path])).toEqual([
      ["POST", "/api/message-backfill/next"],
      ["POST", "/api/message-backfill/source"],
      ["POST", "/api/message-backfill/publish"],
      ["POST", "/api/message-backfill/ack"],
      ["GET", "/api/message-backfill/progress"],
    ]);
    expect(requests.find(({ path }) => path.endsWith("/source"))?.search)
      .toBe("?shadowReadMetadataVersion=1");
    expect(requests.filter(({ path }) => !path.endsWith("/source"))
      .every(({ search }) => search === "")).toBeTrue();
    expect(requests.every(({ authorization }) => authorization === "Bearer session-token"))
      .toBeTrue();
    expect(requests.every(({signal}) => signal === controller.signal)).toBeTrue();
    expect(requests.map(({ body }) => body)).toEqual([
      { urgent },
      { claimId: CLAIM_ID },
      {
        claimId: CLAIM_ID,
        requestBytesBase64url: "AQ",
        payloadBytesBase64url: "Ag",
        manifestBytesBase64url: "Aw",
        envelopeBytesBase64url: "BA",
      },
      {
        claimId: CLAIM_ID,
        outcome: "reconciled",
        claimDigestBase64url: DIGEST,
        sourceDigestBase64url: DIGEST,
        manifestDigestBase64url: DIGEST,
        signatureBase64url: "A".repeat(86),
      },
      null,
    ]);
  });

  test("aborts an in-flight backfill transport without converting response loss", async () => {
    const controller = new AbortController();
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async (_target, init) => await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, {once: true});
      }),
    });
    client.setToken("session-token");

    const request = client.nextMessageBackfill({}, {signal: controller.signal});
    controller.abort();
    expect(await request.then(() => null, (error: unknown) => error)).toMatchObject({
      name: "AbortError",
    });
  });

  test("rejects inline device identity and malformed responses at the schema boundary", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => {
        calls += 1;
        return json({ status: "more", resumeAt: null });
      },
    });
    client.setToken("session-token");

    expect(client.nextMessageBackfill({
      urgent,
      deviceId: "caller-chosen-device",
    } as never)).rejects.toThrow();
    expect(client.readMessageBackfillSource({
      claimId: CLAIM_ID,
      deviceId: "caller-chosen-device",
    } as never)).rejects.toThrow();
    expect(calls).toBe(0);

    expect(client.nextMessageBackfill({})).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("distinguishes complete enumeration from caught-up repair state", () => {
    const progress = messageBackfillProgressSchema.parse({
      status: "waiting",
      snapshotAt: 1_000,
      snapshotComplete: true,
      caughtUp: false,
      lastSweepAt: 900,
      activeLease: false,
      counts: {eligible: 8, alreadyAuthenticated: 3,
        independentlyParityVerified: 2, claimedRepairing: 0,
        repairedAndVerified: 1, unsupported: 1, failed: 0},
      waiting: {authorizedDevice: null, authority: null},
    });
    expect(progress.snapshotComplete).toBeTrue();
    expect(progress.caughtUp).toBeFalse();
    expect(messageBackfillProgressSchema.safeParse({
      ...progress,
      complete: false,
    }).success).toBeFalse();
  });
});
