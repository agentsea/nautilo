import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { NautiloApiClient } from "@nautilo/api-client";
import { canonicalRemoteOrdinaryRequestBody } from "@nautilo/types";

import { createDesktopForegroundShadowOriginSender } from
  "../../electron/foreground-shadow-origin-sender";

type RoomBody = Parameters<NautiloApiClient["sendRoomMessage"]>[1];

const response = Object.freeze({
  messageId: 42,
  jobId: null,
  laneKey: "room:room-m300",
});

function preparedBody(): RoomBody {
  return {
    content: "Desktop protected message",
    activeMiniApp: {
      kind: "document" as const,
      id: "doc-m300",
      title: "M300",
      selection: {
        anchor: { row: 2, column: 3 },
        focus: { row: 2, column: 3 },
        tableCellRange: undefined,
      },
    },
    liveShadow: {
      requestVersion: 1,
      operationId: "operation-m300",
      idempotencyKey: "idempotency-m300",
      clientDeviceId: "device-m300",
    } as RoomBody["liveShadow"],
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("Desktop foreground Shadow origin sender", () => {
  test("normalizes once and sends the exact credentialed body once", async () => {
    const calls: Array<readonly unknown[]> = [];
    let mintInput: Record<string, unknown> | undefined;
    const send = createDesktopForegroundShadowOriginSender({
      api: {
        mintElectronOriginCredential: async (value) => {
          mintInput = value as unknown as Record<string, unknown>;
          return { credential: "credential-m300", expiresAt: "2099-01-01" };
        },
        sendRoomMessage: async (...args) => {
          calls.push(args);
          return response as never;
        },
      },
      resolveOriginAuthority: () => ({
        relayId: "relay-m300",
        desktopSessionId: "session-m300",
        relayToken: "relay-token-m300",
      }),
      createRequestId: () => "request-m300",
    });

    await send("room/m300", preparedBody());

    expect(calls).toHaveLength(1);
    const [roomId, sentBody, options] = calls[0]!;
    expect(roomId).toBe("room/m300");
    expect((sentBody as RoomBody).activeMiniApp).toEqual({
      kind: "document",
      id: "doc-m300",
      title: "M300",
      selection: {
        anchor: { row: 2, column: 3 },
        focus: { row: 2, column: 3 },
      },
    });
    expect(options).toEqual({ electronOriginCredential: "credential-m300" });
    expect(mintInput).toMatchObject({
      requestId: "request-m300",
      relayId: "relay-m300",
      desktopSessionId: "session-m300",
      method: "POST",
      path: "/api/rooms/room%2Fm300/messages",
      bodySha256: createHash("sha256")
        .update(canonicalRemoteOrdinaryRequestBody(sentBody), "utf8")
        .digest("hex"),
    });
  });

  test("uses one server-authenticated POST when origin is absent", async () => {
    const calls: Array<readonly unknown[]> = [];
    const send = createDesktopForegroundShadowOriginSender({
      api: {
        mintElectronOriginCredential: () => {
          throw new Error("must not mint");
        },
        sendRoomMessage: async (...args) => {
          calls.push(args);
          return response as never;
        },
      },
      resolveOriginAuthority: () => null,
    });

    await send("room-m300", preparedBody());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  test("falls back before the Message POST when credential minting fails", async () => {
    const calls: Array<readonly unknown[]> = [];
    const send = createDesktopForegroundShadowOriginSender({
      api: {
        mintElectronOriginCredential: () => {
          throw new Error("origin unavailable");
        },
        sendRoomMessage: async (...args) => {
          calls.push(args);
          return response as never;
        },
      },
      resolveOriginAuthority: () => ({
        relayId: "relay-m300",
        desktopSessionId: "session-m300",
        relayToken: "relay-token-m300",
      }),
    });

    await send("room-m300", preparedBody());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  test("never retries an ambiguous Message POST", async () => {
    let posts = 0;
    const send = createDesktopForegroundShadowOriginSender({
      api: {
        mintElectronOriginCredential: async () => ({
          credential: "credential-m300",
          expiresAt: "2099-01-01",
        }),
        sendRoomMessage: () => {
          posts += 1;
          throw new Error("socket closed after write");
        },
      },
      resolveOriginAuthority: () => ({
        relayId: "relay-m300",
        desktopSessionId: "session-m300",
        relayToken: "relay-token-m300",
      }),
    });

    expect(await rejected(send("room-m300", preparedBody())))
      .toEqual(expect.objectContaining({ message: "socket closed after write" }));
    expect(posts).toBe(1);
  });
});
