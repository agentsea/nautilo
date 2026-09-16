import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@nautilo/db/schema";
import {
  actors,
  agents,
  cryptoObjects,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

bootstrapTestDbInstance();

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const productUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_APP_DATABASE_URL",
);
const ROLLBACK = new Error("Message source revision fixture rollback");

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

async function expectDenied(
  work: Promise<unknown>,
  expectedMessage?: string,
): Promise<void> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const code = "code" in current
        ? (current as Error & { readonly code?: unknown }).code
        : undefined;
      if (code !== undefined) {
        expect(code).toBe("42501");
        if (expectedMessage !== undefined) {
          expect(current.message).toContain(expectedMessage);
        }
        return;
      }
      current = current.cause;
    }
    throw new Error("Expected PostgreSQL insufficient-privilege error");
  }
  throw new Error("Expected direct Session revision update to be denied");
}

describe("M313 Message source revision", () => {
  test("tracks source-affecting Message changes and rejects direct rewrites", async () => {
    const client = postgres(adminUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      const rootDatabase = drizzle(client, { schema });
      await rootDatabase.transaction(async (database) => {
        const userId = randomUUID();
        const humanActorId = randomUUID();
        const agentId = randomUUID();
        const agentActorId = randomUUID();
        const namespaceId = randomUUID();
        const roomId = randomUUID();
        const sessionId = randomUUID();
        const baseTime = new Date("2026-09-08T12:00:00.000Z");

        await database.insert(users).values({
          id: userId,
          name: "M313 source revision integration",
        });
        await database.insert(agents).values({
          id: agentId,
          handle: `m313-source-revision-${agentId}`,
        });
        await database.insert(actors).values([
          {
            id: humanActorId,
            ownerId: userId,
            displayName: "M313 source revision Human",
            trustState: "verified",
            kind: "user",
          },
          {
            id: agentActorId,
            ownerId: userId,
            displayName: "M313 source revision Agent",
            trustState: "verified",
            kind: "agent",
            agentId,
          },
        ]);
        await database.insert(namespaces).values({
          id: namespaceId,
          scope: "room",
          label: "M313 source revision Namespace",
        });
        await database.insert(rooms).values({
          id: roomId,
          ownerId: userId,
          type: "private",
          label: "M313 source revision Room",
          graphThreadId: `m313-source-revision:${roomId}`,
          namespaceId,
          kind: "private",
          createdBy: humanActorId,
        });
        await database.insert(roomMembers).values([
          { roomId, actorId: humanActorId, roomRole: "admin" },
          {
            roomId,
            actorId: agentActorId,
            roomRole: "member",
            agentResponseMode: "active",
          },
        ]);
        await database.insert(sessions).values({
          id: sessionId,
          threadId: `m313-source-revision:${sessionId}`,
          ownerId: userId,
          personaId: "owner",
          agentId,
          roomId,
          channel: "integration",
        });

        const revision = async (): Promise<number> => {
          const [row] = await database.select({
            value: sessions.messageSourceRevision,
          }).from(sessions).where(eq(sessions.id, sessionId));
          if (row === undefined) throw new Error("Missing Session fixture");
          return row.value;
        };

        const [first] = await database.insert(sessionMessages).values({
          sessionId,
          role: "assistant",
          content: "first",
          fingerprint: `m313-source-first-${randomUUID()}`,
          createdAt: baseTime,
        }).returning({ id: sessionMessages.id });
        const [second] = await database.insert(sessionMessages).values({
          sessionId,
          role: "tool",
          content: "second",
          toolName: "fixture_tool",
          fingerprint: `m313-source-second-${randomUUID()}`,
          createdAt: new Date(baseTime.getTime() + 2_000),
        }).returning({ id: sessionMessages.id });
        if (first === undefined || second === undefined) {
          throw new Error("Missing Message fixture");
        }
        expect(await revision()).toBe(0);

        const [backdated] = await database.insert(sessionMessages).values({
          sessionId,
          role: "system",
          content: "backdated",
          fingerprint: `m313-source-backdated-${randomUUID()}`,
          createdAt: new Date(baseTime.getTime() + 1_000),
        }).returning({ id: sessionMessages.id });
        if (backdated === undefined) throw new Error("Missing backdated fixture");
        expect(await revision()).toBe(1);

        await database.update(sessionMessages).set({
          content: "first edited",
          editRevision: 1,
        }).where(eq(sessionMessages.id, first.id));
        expect(await revision()).toBe(2);

        await database.update(sessionMessages).set({
          toolCalls: JSON.stringify([{
            id: "call_fixture",
            name: "fixture_tool",
            args: { value: 1 },
          }]),
        }).where(eq(sessionMessages.id, first.id));
        expect(await revision()).toBe(3);

        await database.update(sessionMessages).set({ content: null })
          .where(eq(sessionMessages.id, first.id));
        expect(await revision()).toBe(4);
        await database.update(sessionMessages).set({ content: "restored" })
          .where(eq(sessionMessages.id, first.id));
        expect(await revision()).toBe(5);

        const cryptoObjectId = `message:v2:source-revision-${randomUUID()}`;
        await database.insert(cryptoObjects).values({
          objectId: cryptoObjectId,
          payloadHash: new Uint8Array(32).fill(0x41),
          payloadBytes: new Uint8Array([0x02]),
        });
        await database.update(sessionMessages).set({ cryptoObjectId })
          .where(eq(sessionMessages.id, first.id));
        expect(await revision()).toBe(5);

        await database.delete(sessionMessages).where(eq(
          sessionMessages.id,
          backdated.id,
        ));
        expect(await revision()).toBe(6);

        await database.execute(sql`SET LOCAL ROLE nautilo`);
        await expectDenied(database.transaction(async (savepoint) => {
          await savepoint.update(sessions).set({ messageSourceRevision: 7 })
            .where(eq(sessions.id, sessionId));
        }), "Message source revision is maintained by canonical Message changes");
        await database.execute(sql`RESET ROLE`);
        await database.execute(sql`
          SELECT set_config('app.current_user_id', ${userId}, true),
                 set_config('app.current_agent_id', ${agentId}, true)
        `);
        await database.execute(sql`SET LOCAL ROLE nautilo_agent`);
        await expectDenied(database.transaction(async (savepoint) => {
          await savepoint.update(sessions).set({ messageSourceRevision: 7 })
            .where(eq(sessions.id, sessionId));
        }));

        throw ROLLBACK;
      });
      throw new Error("Expected Message source revision fixture rollback");
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end();
    }
  }, 60_000);
});
