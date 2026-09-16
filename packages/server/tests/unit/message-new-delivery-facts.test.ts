import { describe, expect, test } from "bun:test";
import type {
  ProtectedMessageRealtimeEventV2,
  ServerEvent,
} from "@nautilo/types";

import {
  messageNewDeliveryFacts,
} from "../../src/realtime/message-new-delivery-facts";

type MessageNewServerEvent = Extract<ServerEvent, { type: "message.new" }>;

function protectedMessageNew(
  input: Readonly<{
    readonly role: "user" | "assistant";
    readonly sourceUserId?: string;
  }>,
): Extract<ProtectedMessageRealtimeEventV2, { type: "message.new" }> {
  return {
    wireVersion: 2,
    type: "message.new",
    protection: "protected",
    laneKey: "room:11111111-1111-4111-8111-111111111111",
    message: {
      dtoVersion: 2,
      projection: {
        messageId: "42",
        sessionId: "22222222-2222-4222-8222-222222222222",
        roomId: "11111111-1111-4111-8111-111111111111",
        namespaceId: "33333333-3333-4333-8333-333333333333",
        role: input.role,
        createdAt: "2026-08-03T09:10:11.000Z",
        editRevision: 0,
        ...(input.sourceUserId === undefined
          ? {}
          : { sourceUserId: input.sourceUserId }),
      },
      protectedPayload: {
        status: "pending",
        reason: "shadow_pending",
      },
    },
  };
}

describe("message.new delivery facts", () => {
  test("preserves the legacy message and sender identity", () => {
    const event: MessageNewServerEvent = {
      type: "message.new",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      messageId: "41",
      role: "user",
      content: "legacy plaintext",
      senderUserId: "44444444-4444-4444-8444-444444444444",
    };

    expect(messageNewDeliveryFacts(event)).toEqual({
      messageId: 41,
      senderUserId: "44444444-4444-4444-8444-444444444444",
    });
  });

  test("uses the protected structural projection without opening content", () => {
    expect(
      messageNewDeliveryFacts(
        protectedMessageNew({
          role: "user",
          sourceUserId: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    ).toEqual({
      messageId: 42,
      senderUserId: "44444444-4444-4444-8444-444444444444",
    });
  });

  test("never treats a protected Agent projection as a Human sender", () => {
    expect(
      messageNewDeliveryFacts(
        protectedMessageNew({
          role: "assistant",
          sourceUserId: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    ).toEqual({
      messageId: 42,
      senderUserId: null,
    });
  });

  test("fails closed on an invalid message identity", () => {
    const event = protectedMessageNew({ role: "user" });
    const malformed = {
      ...event,
      message: {
        ...event.message,
        projection: {
          ...event.message.projection,
          messageId: "0",
        },
      },
    } as unknown as MessageNewServerEvent;

    expect(messageNewDeliveryFacts(malformed)).toEqual({
      messageId: null,
      senderUserId: null,
    });
  });
});
