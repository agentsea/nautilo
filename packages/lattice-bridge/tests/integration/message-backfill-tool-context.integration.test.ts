import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@nautilo/db/schema";
import {
  actors,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import { decodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";
import {
  activateMessageBackfillToolContext,
  MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS,
} from "../../src/server/message/message-backfill-tool-context.ts";
import { readMessageBackfillOrdinarySource } from
  "../../src/server/message/postgres-message-backfill-source.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
} from "../../src/server/message/postgres-conversation-product-store.ts";

bootstrapTestDbInstance();

const productUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_APP_DATABASE_URL",
);
const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const ROLLBACK = new Error("Message backfill Tool-context fixture rollback");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for this integration test`);
  }
  return value;
}

function assertSameDatabase(
  adminConnection: string,
  productConnection: string,
): void {
  const admin = new URL(adminConnection);
  const product = new URL(productConnection);
  if (
    admin.hostname !== product.hostname
    || admin.port !== product.port
    || admin.pathname !== product.pathname
    || product.username !== "nautilo"
  ) {
    throw new Error("Integration database URLs do not identify one product clone");
  }
}

assertSameDatabase(adminUrl, productUrl);

describe("M314 bounded Message Tool context", () => {
  test.each(["group", "open"] as const)(
    "reuses exact cross-page Tool evidence in a %s parent topology",
    async (parentKind) => {
    const client = postgres(productUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    let rolledBackHumanId: string | undefined;
    try {
      const handle = await verifyConversationProductPostgresHandle(
        createPostgresJsBridgeConnection({ $client: client }),
      );
      const rootRunner = bindConversationProductCanonicalTransactionRunner(
        handle,
        createPostgresJsCanonicalBridgeConnection(drizzle(client, { schema })),
      );
      await rootRunner.transaction(async (database, executor) => {
        const userId = randomUUID();
        const humanActorId = randomUUID();
        const namespaceId = randomUUID();
        const roomId = randomUUID();
        const sessionId = randomUUID();
        const assistantCreatedAt = new Date("2026-09-08T14:00:00.000Z");
        const targetCreatedAt = new Date("2026-09-08T14:00:02.000Z");
        rolledBackHumanId = humanActorId;

        await database.insert(users).values({
          id: userId,
          name: "M313 Tool-context integration",
        });
        await database.insert(actors).values({
          id: humanActorId,
          ownerId: userId,
          displayName: "M313 Tool-context Human",
          trustState: "verified",
          kind: "user",
        });
        await database.insert(namespaces).values({
          id: namespaceId,
          scope: "room",
          label: "M313 Tool-context Namespace",
        });
        await database.insert(rooms).values({
          id: roomId,
          ownerId: userId,
          type: "shared",
          label: `M314 ${parentKind} Tool-context Room`,
          graphThreadId: `m314-tool-context:${roomId}`,
          namespaceId,
          kind: parentKind,
          createdBy: humanActorId,
        });
        await database.insert(roomMembers).values({
          roomId,
          actorId: humanActorId,
          roomRole: "admin",
        });
        await database.insert(sessions).values({
          id: sessionId,
          threadId: `m313-tool-context:${sessionId}`,
          ownerId: userId,
          personaId: "owner",
          roomId,
          channel: "integration",
        });
        let sourceRoomId = roomId;
        if (parentKind === "open") {
          const [threadRoot] = await database.insert(sessionMessages).values({
            sessionId,
            role: "user",
            content: "public Subthread anchor",
            humanTurnId: `turn-${randomUUID()}`,
            createdAt: new Date(assistantCreatedAt.getTime() - 1_000),
          }).returning({id: sessionMessages.id});
          if (threadRoot === undefined) {
            throw new Error("Missing public Subthread root fixture");
          }
          sourceRoomId = randomUUID();
          await database.insert(rooms).values({
            id: sourceRoomId,
            ownerId: userId,
            type: "shared",
            label: "M314 public Tool-context Subthread",
            graphThreadId: `m314-tool-context:${sourceRoomId}`,
            namespaceId,
            kind: "subthread",
            parentRoomId: roomId,
            threadRootMessageId: threadRoot.id,
            createdBy: humanActorId,
          });
          await database.insert(roomMembers).values({
            roomId: sourceRoomId,
            actorId: humanActorId,
            roomRole: "admin",
          });
        }
        const [assistant] = await database.insert(sessionMessages).values({
          sessionId,
          role: "assistant",
          content: "calling lookup",
          toolCalls: JSON.stringify([{
            id: "call-original",
            name: "lookup",
            args: { query: "fixture" },
          }]),
          fingerprint: `m313-tool-call-${randomUUID()}`,
          createdAt: assistantCreatedAt,
          ...(sourceRoomId === roomId ? {} : {subthreadRoomId: sourceRoomId}),
        }).returning({ id: sessionMessages.id });
        await database.insert(sessionMessages).values(Array.from(
          {length: MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS + 5},
          (_, index) => ({
            sessionId,
            role: "system" as const,
            content: `cross-page filler ${index}`,
            fingerprint: `m314-tool-filler-${index}-${randomUUID()}`,
            createdAt: new Date(assistantCreatedAt.getTime() + index + 1),
            ...(sourceRoomId === roomId
              ? {}
              : {subthreadRoomId: sourceRoomId}),
          }),
        ));
        const [target] = await database.insert(sessionMessages).values({
          sessionId,
          role: "tool",
          content: "fixture result",
          toolName: "lookup",
          fingerprint: `m313-tool-result-${randomUUID()}`,
          createdAt: targetCreatedAt,
          ...(sourceRoomId === roomId ? {} : {subthreadRoomId: sourceRoomId}),
        }).returning({ id: sessionMessages.id });
        if (assistant === undefined || target === undefined) {
          throw new Error("Missing Tool-context Message fixture");
        }

        const sameTransactionConnection: ConversationProductCanonicalTransactionConnection = {
          transaction: (callback) => callback(database, executor),
        };
        const runner = bindConversationProductCanonicalTransactionRunner(
          handle,
          sameTransactionConnection,
        );
        const input = {
          humanActorId,
          sessionId,
          messageId: target.id,
          revision: 0,
          createdAt: targetCreatedAt,
        };
        const prepareUntilSettled = async () => {
          let status: "more" | "ready" | "invalid" = "more";
          let activations = 0, terminalEdges = 0;
          while (status === "more" && activations < 4) {
            const activation = await activateMessageBackfillToolContext(runner, input);
            status = activation.status;
            if (activation.becameTerminal) terminalEdges += 1;
            activations += 1;
          }
          return {status, activations, terminalEdges};
        };
        const initial = await prepareUntilSettled();
        expect(initial).toMatchObject({status: "ready", terminalEdges: 1});
        expect(initial.activations).toBeGreaterThan(1);
        expect(await activateMessageBackfillToolContext(runner, input)).toEqual({
          status: "ready", becameTerminal: false,
        });
        const original = await readMessageBackfillOrdinarySource(executor, input);
        expect(decodeMessagePayloadV2(original!)).toMatchObject({
          role: "tool",
          content: "fixture result",
          sensitiveMetadata: { toolCallId: "call-original" },
        });

        await database.insert(sessionMessages).values({
          sessionId,
          role: "system",
          content: "ordinary append after target",
          fingerprint: `m313-tool-append-${randomUUID()}`,
          createdAt: new Date(targetCreatedAt.getTime() + 1_000),
        });
        const afterAppend = await readMessageBackfillOrdinarySource(
          executor,
          input,
        );
        expect(decodeMessagePayloadV2(afterAppend!)).toMatchObject({
          sensitiveMetadata: { toolCallId: "call-original" },
        });

        await database.insert(sessionMessages).values({
          sessionId,
          role: "user",
          content: "backdated predecessor",
          humanTurnId: `turn-${randomUUID()}`,
          createdAt: new Date(assistantCreatedAt.getTime() + 1_000),
        });
        expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull();
        expect(await prepareUntilSettled()).toMatchObject({status: "ready", terminalEdges: 1});
        expect(decodeMessagePayloadV2(
          (await readMessageBackfillOrdinarySource(executor, input))!,
        )).toMatchObject({
          sensitiveMetadata: { toolCallId: "call-original" },
        });

        await database.update(sessionMessages).set({
          editRevision: 1,
          toolCalls: JSON.stringify([{
            id: "call-edited",
            name: "lookup",
            args: { query: "fixture" },
          }]),
        }).where(eq(sessionMessages.id, assistant.id));
        expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull();
        expect(await prepareUntilSettled()).toMatchObject({status: "ready", terminalEdges: 1});
        expect(decodeMessagePayloadV2(
          (await readMessageBackfillOrdinarySource(executor, input))!,
        )).toMatchObject({
          sensitiveMetadata: { toolCallId: "call-edited" },
        });

        await database.delete(sessionMessages).where(eq(
          sessionMessages.id,
          assistant.id,
        ));
        expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull();
        expect(await prepareUntilSettled()).toMatchObject({status: "invalid", terminalEdges: 1});

        throw ROLLBACK;
      }, { isolationLevel: "serializable" });
      throw new Error("Expected Tool-context fixture rollback");
    } catch (error) {
      if (error !== ROLLBACK) throw error;
      if (rolledBackHumanId === undefined) {
        throw new Error("Tool-context fixture did not reach rollback proof");
      }
      const remaining = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM actors
         WHERE id = ${rolledBackHumanId}
      `;
      expect(remaining[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
    },
    60_000,
  );
});
