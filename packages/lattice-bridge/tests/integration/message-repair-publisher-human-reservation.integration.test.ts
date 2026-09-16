import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@nautilo/db/schema";
import {
  actors,
  agents,
  namespaces,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

bootstrapTestDbInstance();

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const productUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_APP_DATABASE_URL",
);
const ROLLBACK = new Error("Message repair publisher fixture rollback");

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

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

interface ReservationFixture {
  readonly humanActorId: string;
  readonly agentId: string;
  readonly pendingForegroundMessageId: number;
  readonly completedHumanMessageId: number;
  readonly pendingHumanMessageId: number;
}

async function createReservationFixture(
  database: CanonicalTranscriptTx,
): Promise<ReservationFixture> {
  const userId = randomUUID();
  const humanActorId = randomUUID();
  const agentId = randomUUID();
  const agentActorId = randomUUID();
  const namespaceId = randomUUID();
  const roomId = randomUUID();
  const sessionId = randomUUID();

  await database.insert(users).values({
    id: userId,
    name: "M313 reservation integration",
  });
  await database.insert(agents).values({
    id: agentId,
    handle: `m313-reservation-${agentId}`,
  });
  await database.insert(actors).values([
    {
      id: humanActorId,
      ownerId: userId,
      displayName: "M313 reservation Human",
      trustState: "verified",
      kind: "user",
    },
    {
      id: agentActorId,
      ownerId: userId,
      displayName: "M313 reservation Agent",
      trustState: "verified",
      kind: "agent",
      agentId,
    },
  ]);
  await database.insert(namespaces).values({
    id: namespaceId,
    scope: "room",
    label: "M313 reservation Namespace",
  });
  await database.insert(rooms).values({
    id: roomId,
    ownerId: userId,
    type: "private",
    label: "M313 reservation Room",
    graphThreadId: `m313-reservation:${roomId}`,
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
    threadId: `m313-reservation:${sessionId}`,
    ownerId: userId,
    personaId: "owner",
    agentId,
    roomId,
    channel: "integration",
  });
  const messages = await database.insert(sessionMessages).values(
    Array.from({ length: 3 }, (_, index) => ({
      sessionId,
      role: "assistant",
      content: `M313 reservation ${index}`,
      fingerprint: `m313-reservation-${index}-${randomUUID()}`,
    })),
  ).returning({ id: sessionMessages.id });
  const [pendingForeground, completedHuman, pendingHuman] = messages;
  if (
    pendingForeground === undefined
    || completedHuman === undefined
    || pendingHuman === undefined
  ) throw new Error("Missing reservation Message fixture");

  await database.insert(sessionMessageCryptoRevisions).values([
    {
      sessionId,
      messageId: pendingForeground.id,
      editRevision: 0,
      roomId,
      namespaceIdAtAllocation: namespaceId,
      cryptoObjectId: `message:v2:reservation-foreground-${randomUUID()}`,
      keyClass: "ai",
      authorRole: "assistant",
      appendIdempotencyKey: `reservation-foreground-${randomUUID()}`,
      allocationRequestDigest: digest(0x11),
      repairIdentityDigest: digest(0x12),
      repairPublisherKind: "foreground_runtime",
      repairPublisherId: "reservation-agent",
      repairAttestationDigest: digest(0x13),
    },
    {
      sessionId,
      messageId: completedHuman.id,
      editRevision: 0,
      roomId,
      namespaceIdAtAllocation: namespaceId,
      cryptoObjectId: `message:v2:reservation-complete-${randomUUID()}`,
      keyClass: "ai",
      authorRole: "assistant",
      appendIdempotencyKey: `reservation-complete-${randomUUID()}`,
      allocationRequestDigest: digest(0x21),
      repairIdentityDigest: digest(0x22),
      repairPublisherKind: "human_device",
      repairPublisherId: "reservation-device",
      repairPublisherHumanId: humanActorId,
      repairAttestationDigest: digest(0x23),
      completion: "complete",
      cryptoCompletedAt: new Date(),
    },
    {
      sessionId,
      messageId: pendingHuman.id,
      editRevision: 0,
      roomId,
      namespaceIdAtAllocation: namespaceId,
      cryptoObjectId: `message:v2:reservation-pending-${randomUUID()}`,
      keyClass: "ai",
      authorRole: "assistant",
      appendIdempotencyKey: `reservation-pending-${randomUUID()}`,
      allocationRequestDigest: digest(0x31),
      repairIdentityDigest: digest(0x32),
      repairPublisherKind: "human_device",
      repairPublisherId: "reservation-device",
      repairPublisherHumanId: humanActorId,
      repairAttestationDigest: digest(0x33),
    },
  ]);

  return {
    humanActorId,
    agentId,
    pendingForegroundMessageId: pendingForeground.id,
    completedHumanMessageId: completedHuman.id,
    pendingHumanMessageId: pendingHuman.id,
  };
}

async function expectAgentDenied(work: Promise<unknown>): Promise<void> {
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
        expect(current.message).toContain(
          "Agent cannot create or rewrite Human Message publisher evidence",
        );
        return;
      }
      current = current.cause;
    }
    throw new Error("Expected PostgreSQL insufficient-privilege error");
  }
  throw new Error("Expected Agent publisher update to be denied");
}

describe("M313 Message repair publisher reservation", () => {
  test("enforces Agent mutation rules through the applied trigger", async () => {
    const client = postgres(adminUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      const rootDatabase = drizzle(client, { schema });
      await rootDatabase.transaction(async (database) => {
        const fixture = await createReservationFixture(database);
        await database.execute(sql`
          SELECT set_config('app.current_user_id', ${fixture.humanActorId}, true),
                 set_config('app.current_agent_id', ${fixture.agentId}, true)
        `);
        await database.execute(sql`SET LOCAL ROLE nautilo_agent`);

        await expectAgentDenied(database.transaction(async (savepoint) => {
          await savepoint
            .update(sessionMessageCryptoRevisions)
            .set({ repairPublisherHumanId: fixture.humanActorId })
            .where(eq(
              sessionMessageCryptoRevisions.messageId,
              fixture.pendingForegroundMessageId,
            ));
        }));
        await expectAgentDenied(database.transaction(async (savepoint) => {
          await savepoint
            .update(sessionMessageCryptoRevisions)
            .set({
              repairPublisherHumanId: null,
              repairPublisherKind: "foreground_runtime",
            })
            .where(eq(
              sessionMessageCryptoRevisions.messageId,
              fixture.completedHumanMessageId,
            ));
        }));
        await expectAgentDenied(database.transaction(async (savepoint) => {
          await savepoint
            .update(sessionMessageCryptoRevisions)
            .set({ repairPublisherHumanId: null })
            .where(eq(
              sessionMessageCryptoRevisions.messageId,
              fixture.pendingHumanMessageId,
            ));
        }));

        const [cleared] = await database
          .update(sessionMessageCryptoRevisions)
          .set({
            repairPublisherHumanId: null,
            repairPublisherKind: "foreground_runtime",
          })
          .where(eq(
            sessionMessageCryptoRevisions.messageId,
            fixture.pendingHumanMessageId,
          ))
          .returning({
            repairPublisherKind:
              sessionMessageCryptoRevisions.repairPublisherKind,
            repairPublisherHumanId:
              sessionMessageCryptoRevisions.repairPublisherHumanId,
          });
        expect(cleared).toEqual({
          repairPublisherKind: "foreground_runtime",
          repairPublisherHumanId: null,
        });

        const protectedRows = await database.select({
          messageId: sessionMessageCryptoRevisions.messageId,
          repairPublisherKind:
            sessionMessageCryptoRevisions.repairPublisherKind,
          repairPublisherHumanId:
            sessionMessageCryptoRevisions.repairPublisherHumanId,
        }).from(sessionMessageCryptoRevisions).where(inArray(
          sessionMessageCryptoRevisions.messageId,
          [
            fixture.pendingForegroundMessageId,
            fixture.completedHumanMessageId,
          ],
        ));
        expect(protectedRows).toEqual([
          {
            messageId: fixture.pendingForegroundMessageId,
            repairPublisherKind: "foreground_runtime",
            repairPublisherHumanId: null,
          },
          {
            messageId: fixture.completedHumanMessageId,
            repairPublisherKind: "human_device",
            repairPublisherHumanId: fixture.humanActorId,
          },
        ]);

        throw ROLLBACK;
      });
      throw new Error("Expected reservation fixture rollback");
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end();
    }
  }, 60_000);
});
