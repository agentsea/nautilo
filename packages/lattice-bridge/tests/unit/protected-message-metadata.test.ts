import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";

import { PostgresProtectedReflectionMessageMetadata } from
  "../../src/server/reflection/protected-message-metadata.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ROOM_ID = "20000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_NAMESPACE_ID = "30000000-0000-4000-8000-000000000002";
const OBJECT_ID = "conversation.message.17.3";

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    session_id: SESSION_ID,
    edit_revision: 3,
    role: "assistant",
    crypto_object_id: OBJECT_ID,
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    namespace_access_revision: 4,
    lifecycle_object_id: OBJECT_ID,
    namespace_id_at_allocation: NAMESPACE_ID,
    payload_version: 2,
    key_class: "ai",
    completion: "complete",
    disposition: "mapped",
    ...overrides,
  };
}

function metadata(
  rows: readonly Record<string, unknown>[],
  statements: string[] = [],
) {
  return new PostgresProtectedReflectionMessageMetadata({
    query: async (statement: string) => {
      statements.push(statement);
      return rows;
    },
  } as unknown as Pick<PostgresJsBridgeConnection, "query">);
}

const resolve = (
  rows: readonly Record<string, unknown>[],
  overrides: Partial<Parameters<
    PostgresProtectedReflectionMessageMetadata["resolveMessage"]
  >[0]> = {},
) => metadata(rows).resolveMessage({
  messageId: 17,
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  observedRevision: "3",
  ...overrides,
});

describe("protected Reflection Message metadata", () => {
  test("resolves one current mapped AI-readable Message without content", async () => {
    const statements: string[] = [];
    const result = await metadata([productRow()], statements).resolveMessage({
      messageId: 17,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      observedRevision: "3",
    });

    expect(result).toEqual({
      status: "available",
      metadata: {
        messageId: 17,
        logicalSourceRef: "message:17",
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        namespaceAccessRevision: 4,
        editRevision: 3,
        role: "assistant",
        inputBinding: {
          objectId: OBJECT_ID,
          namespaceId: NAMESPACE_ID,
          objectType: "nautilo-message-v2",
        },
      },
    });
    const statement = statements[0]!;
    expect(statement).toContain("session_message_crypto_revisions");
    expect(statement).toContain("left join");
    expect(statement).not.toMatch(/session_messages"\."(?:content|tool_calls)/u);
  });

  test("classifies a current Message whose protected mapping is pending", async () => {
    expect(await resolve([productRow({
      crypto_object_id: null,
      lifecycle_object_id: null,
      namespace_id_at_allocation: null,
      payload_version: null,
      key_class: null,
      completion: null,
      disposition: null,
    })])).toEqual({ status: "waiting" });
    expect(await resolve([productRow({
      completion: "pending",
      disposition: "active",
    })])).toEqual({ status: "waiting" });
  });

  test("classifies changed current product coordinates", async () => {
    expect(await resolve([productRow({ edit_revision: 4 })])).toEqual({
      status: "changed",
    });
    expect(await resolve([productRow({ room_id: OTHER_ROOM_ID })])).toEqual({
      status: "changed",
    });
    expect(await resolve([productRow({
      namespace_id: OTHER_NAMESPACE_ID,
      namespace_id_at_allocation: OTHER_NAMESPACE_ID,
    })])).toEqual({ status: "changed" });
  });

  test("classifies a missing logical Message", async () => {
    expect(await resolve([])).toEqual({ status: "missing" });
  });

  test("rejects mappings outside the protected Reflection contract", async () => {
    expect(await resolve([productRow({ key_class: "human" })])).toEqual({
      status: "unavailable",
    });
    expect(await resolve([productRow({ payload_version: 1 })])).toEqual({
      status: "unavailable",
    });
    expect(await resolve([productRow({
      namespace_id_at_allocation: OTHER_NAMESPACE_ID,
    })])).toEqual({ status: "unavailable" });
  });

  test("resolves a pending-descriptor object through the same validation", async () => {
    expect(await metadata([productRow()]).resolveMessageObject({
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
    })).toEqual({
      messageId: 17,
      logicalSourceRef: "message:17",
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 4,
      editRevision: 3,
      role: "assistant",
      inputBinding: {
        objectId: OBJECT_ID,
        namespaceId: NAMESPACE_ID,
        objectType: "nautilo-message-v2",
      },
    });
    expect(await metadata([productRow({
      crypto_object_id: "conversation.message.changed",
    })]).resolveMessageObject({
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
    })).toBeNull();
  });
});
