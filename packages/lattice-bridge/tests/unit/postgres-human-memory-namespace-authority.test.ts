import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeExecutor,
  PostgresJsBridgeRow } from "@nautilo/db";

import { createPostgresHumanMemoryNamespaceAuthorityResolver } from
  "../../src/server/memory/postgres-human-memory-namespace-authority.ts";
import { PostgresNamespaceProductAuthority } from
  "../../src/server/delivery/postgres-namespace-product-authority.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresTransaction,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const USER = "11000000-0000-4000-8000-000000000001";
const HUMAN = "11000000-0000-4000-8000-000000000002";
const NAMESPACE = "11000000-0000-4000-8000-000000000003";
const ROOM = "11000000-0000-4000-8000-000000000004";

class ProductConnection implements ConversationProductPostgresConnection {
  room = ROOM;
  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) return Promise.resolve([
      { current_user: "nautilo", session_user: "nautilo" },
    ] as unknown as Row[]);
    throw new Error(`unexpected query: ${statement}`);
  }
  transaction<Result>(callback: (
    transaction: ConversationProductPostgresTransaction,
  ) => Promise<Result>): Promise<Result> {
    return callback({ query: async <Row extends ConversationProductDatabaseRow>(
      statement: string,
    ): Promise<readonly Row[]> => {
      const normalized = statement.replaceAll('"', "").toLowerCase();
      if (normalized.includes("from rooms") && !normalized.includes("room_members")) {
        return [{ id: this.room, parent_room_id: null }] as unknown as Row[];
      }
      throw new Error(`unexpected transaction query: ${statement}`);
    } });
  }
}

describe("Postgres Human Memory Namespace authority resolver", () => {
  test("canonical Memory authority admits an open Human-only Room", async () => {
    const executor: PostgresJsBridgeExecutor = { query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      if (statement.startsWith("select \"id\", \"namespace_id\", \"parent_room_id\" from \"rooms\"")) {
        return [{ id: ROOM, namespace_id: NAMESPACE,
          parent_room_id: null }] as unknown as readonly Row[];
      }
      if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
        return [{ room_id: ROOM }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_actor")) {
        return [{ subject_user_id: USER }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_source_room")) {
        return [{ source_room_id: ROOM, source_access_allowed: true, source_kind: "open", source_parent_room_id: null,
          source_archived_at: null, room_id: ROOM, namespace_id: NAMESPACE,
          kind: "open", parent_room_id: null, archived_at: null,
          namespace_access_revision: 2, human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN],
          subject_user_id: USER }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_authority_members")) {
        return [{ actor_id: HUMAN, kind: "user", agent_id: null }] as unknown as readonly Row[];
      }
      throw new Error(`unexpected query: ${statement}`);
    } };
    const connection = { query: executor.query,
      transaction: <Result>(use: (tx: PostgresJsBridgeExecutor) => Promise<Result>) => use(executor),
      transactionOnce: <Result>(use: (tx: PostgresJsBridgeExecutor) => Promise<Result>) => use(executor),
    } satisfies PostgresJsBridgeConnection;
    const authority = new PostgresNamespaceProductAuthority(connection);
    expect(await authority.withCurrentHumanNamespaceRoom({ subjectUserId: USER,
      subjectHumanId: HUMAN, roomId: ROOM, namespaceId: NAMESPACE,
      use: async () => "authorized" })).toBe("authorized");
    expect(await authority.withCurrentHumanAiReadableRoom({ subjectUserId: USER,
      subjectHumanId: HUMAN, roomId: ROOM, namespaceId: NAMESPACE,
      use: async () => "wrong" })).toBeNull();
  });

  test("canonical Memory authority admits an exact access Room", async () => {
    const executor: PostgresJsBridgeExecutor = { query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      if (statement.startsWith("select \"id\", \"namespace_id\", \"parent_room_id\" from \"rooms\"")) {
        return [{ id: ROOM, namespace_id: NAMESPACE,
          parent_room_id: null }] as unknown as readonly Row[];
      }
      if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
        return [{ room_id: ROOM }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_actor")) {
        return [{ subject_user_id: USER }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_source_room")) {
        return [{ source_room_id: ROOM, source_access_allowed: true, source_kind: "access",
          source_parent_room_id: null, source_archived_at: null,
          room_id: ROOM, namespace_id: NAMESPACE, kind: "access",
          parent_room_id: null, archived_at: null,
          namespace_access_revision: 2, human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN] }] as unknown as readonly Row[];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_authority_members")) {
        return [{ actor_id: HUMAN, kind: "user", agent_id: null }] as unknown as readonly Row[];
      }
      throw new Error(`unexpected query: ${statement}`);
    } };
    const connection = { query: executor.query,
      transaction: <Result>(use: (tx: PostgresJsBridgeExecutor) => Promise<Result>) => use(executor),
      transactionOnce: <Result>(use: (tx: PostgresJsBridgeExecutor) => Promise<Result>) => use(executor),
    } satisfies PostgresJsBridgeConnection;
    const authority = new PostgresNamespaceProductAuthority(connection);
    expect(await authority.withCurrentHumanNamespaceRoom({ subjectUserId: USER,
      subjectHumanId: HUMAN, roomId: ROOM, namespaceId: NAMESPACE,
      use: async () => "access-ready" })).toBe("access-ready");
    expect(await authority.withCurrentHumanAiReadableRoom({ subjectUserId: USER,
      subjectHumanId: HUMAN, roomId: ROOM, namespaceId: NAMESPACE,
      use: async () => "foreground-widened" })).toBeNull();
  });

  test("exports exact sparse and current descriptors only for a current member", async () => {
    const connection = new ProductConnection();
    const product = await verifyConversationProductPostgresHandle(connection);
    const calls: unknown[] = [];
    const resolve = createPostgresHumanMemoryNamespaceAuthorityResolver({
      product,
      productAuthority: { withCurrentHumanNamespaceRoom: async (input) =>
        input.use(Object.freeze({}) as never) },
      domainKeys: { inspectNamespaceGenerationAuthorityMetadata: async (input) => {
        calls.push(input);
        return { status: "ready", namespaceId: NAMESPACE, currentGeneration: 3,
          retainedGenerations: [
            { generation: 0, accessRevision: 1, headDigest: new Uint8Array([1]),
              publicationDigest: new Uint8Array([2]),
              publicationSetDigest: new Uint8Array([3]),
              audienceFingerprint: new Uint8Array([4]) },
            { generation: 3, accessRevision: 5, headDigest: new Uint8Array([5]),
              publicationDigest: new Uint8Array([6]),
              publicationSetDigest: new Uint8Array([7]),
              audienceFingerprint: new Uint8Array([8]) },
          ] };
      } },
    });
    expect(await resolve({ subjectUserId: USER, subjectHumanId: HUMAN,
      preferredSourceRoomId: null, namespaceId: NAMESPACE,
      requested: [{ generation: 0, accessRevision: 1 }] })).toEqual({
        sourceRoomId: ROOM, namespaceId: NAMESPACE, currentGeneration: 3,
        retainedGenerations: [
          { generation: 0, accessRevision: 1, headDigestBase64url: "AQ",
            publicationDigestBase64url: "Ag", publicationSetDigestBase64url: "Aw",
            audienceFingerprintBase64url: "BA" },
          { generation: 3, accessRevision: 5, headDigestBase64url: "BQ",
            publicationDigestBase64url: "Bg", publicationSetDigestBase64url: "Bw",
            audienceFingerprintBase64url: "CA" },
        ],
      });
    expect(calls).toEqual([{ namespaceId: NAMESPACE, keyClass: "ai",
      requested: [{ generation: 0, accessRevision: 1 }] }]);
  });

  test("does not inspect Domain metadata when canonical product authority denies", async () => {
    const connection = new ProductConnection();
    const product = await verifyConversationProductPostgresHandle(connection);
    const resolve = createPostgresHumanMemoryNamespaceAuthorityResolver({
      product,
      productAuthority: { withCurrentHumanNamespaceRoom: async () => null },
      domainKeys: { inspectNamespaceGenerationAuthorityMetadata: async () => {
        throw new Error("Domain metadata must follow product authority");
      } },
    });
    expect(await resolve({ subjectUserId: USER, subjectHumanId: HUMAN,
      preferredSourceRoomId: null, namespaceId: NAMESPACE, requested: [] })).toBeNull();
  });
});
