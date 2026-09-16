/**
 * D468 lifecycle integration uses the real Postgres/RLS path. It deliberately
 * fails rather than silently faking a database when the migration is absent:
 * that is an environment blocker, not evidence that binding security passed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  pushInstallationBindings,
  pushNotificationDeliveries,
  pushNotificationTestIntents,
  users,
  withTrustContext,
} from "@nautilo/db";
import type { MobilePushInstallationRegisterRequest } from "@nautilo/types";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createPushInstallationStore,
  PushInstallationStoreError,
} from "../../src/push/push-installation-store";
import { ExpoPushProvider } from "../../src/push/expo-push-provider";
import { createPushDeliveryWorker } from "../../src/push/push-delivery-worker";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;
let ownerId: string;
let otherUserId: string;
let bindingId: string;
let installationId: string;

const key = Buffer.alloc(32, 9);
const currentNow = new Date("2026-08-05T20:00:00.000Z");

function request(
  overrides: Partial<MobilePushInstallationRegisterRequest> = {},
): MobilePushInstallationRegisterRequest {
  return {
    version: 1,
    installationId,
    bindingId,
    platform: "ios" as const,
    expoPushToken: "ExponentPushToken[integration-capability-material]",
    enabled: true as const,
    tokenGeneration: 1,
    appVersion: "0.1.0",
    permission: "granted" as const,
    revokeProof: "p".repeat(48),
    ...overrides,
  };
}

async function expectStoreError(
  operation: Promise<unknown>,
  code: PushInstallationStoreError["code"],
) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PushInstallationStoreError);
  expect((caught as PushInstallationStoreError).code).toBe(code);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  // A missing relation means the test DB has not run migration 0147. Do not
  // replace this with a mock: server RLS and CAS require a migrated Postgres.
  const relation = await db.execute(
    "SELECT to_regclass('public.push_notification_deliveries') AS relation",
  ) as unknown as Array<{ relation: string | null }>;
  if (!relation[0]?.relation) {
    throw new Error(
      "D468 integration environment blocker: migration 0150_smooth_juggernaut is not applied",
    );
  }
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const [owner] = await db.insert(users).values({
    name: "D468 push owner",
    email: `d468-push-owner-${suffix}@test.invalid`,
    handle: `d468push${suffix}`,
  }).returning({ id: users.id });
  const [other] = await db.insert(users).values({
    name: "D468 push other",
    email: `d468-push-other-${suffix}@test.invalid`,
    handle: `d468other${suffix}`,
  }).returning({ id: users.id });
  if (!owner || !other) throw new Error("D468 push fixture users were not created");
  ownerId = owner.id;
  otherUserId = other.id;
  bindingId = randomUUID();
  installationId = randomUUID();
});

afterAll(async () => {
  if (!db) return;
  if (ownerId) {
    await withTrustContext({ userId: ownerId }, async (tx) => {
      await tx.delete(pushNotificationDeliveries).where(eq(pushNotificationDeliveries.userId, ownerId));
      await tx.delete(pushNotificationTestIntents).where(eq(pushNotificationTestIntents.userId, ownerId));
      await tx.delete(pushInstallationBindings).where(eq(pushInstallationBindings.userId, ownerId));
    }, db);
  }
  if (otherUserId) {
    await withTrustContext({ userId: otherUserId }, async (tx) => {
      await tx.delete(pushNotificationDeliveries).where(eq(pushNotificationDeliveries.userId, otherUserId));
      await tx.delete(pushNotificationTestIntents).where(eq(pushNotificationTestIntents.userId, otherUserId));
      await tx.delete(pushInstallationBindings).where(eq(pushInstallationBindings.userId, otherUserId));
    }, db);
  }
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherUserId));
  await db.end();
});

describe("D468 owner-scoped push installation persistence", () => {
  test("encrypts token material, isolates owners, fences stale generations, and terminalizes revocation", async () => {
    const store = createPushInstallationStore({
      db,
      getEncryptionKey: () => key,
      now: () => currentNow,
      newNotificationId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const first = await store.register({ userId: ownerId, request: request() });
    expect(first.state).toBe("active");
    expect(first).not.toHaveProperty("expoPushToken");
    expect(first).not.toHaveProperty("revokeProof");

    const [stored] = await withTrustContext({ userId: ownerId }, (tx) =>
      tx.select().from(pushInstallationBindings)
        .where(eq(pushInstallationBindings.bindingId, bindingId)), db);
    expect(stored?.tokenCiphertextBase64).not.toContain("integration-capability-material");
    expect(stored?.revokeVerifierDigest).not.toContain("p".repeat(48));

    await expectStoreError(
      store.getStatus({ userId: otherUserId, bindingId }),
      "not_found",
    );
    await expectStoreError(
      store.register({
        userId: ownerId,
        request: request({ expoPushToken: "ExponentPushToken[changed-without-generation]" }),
      }),
      "stale_generation",
    );

    const disabled = await store.disable({
      userId: ownerId,
      request: {
        version: 1,
        installationId,
        bindingId,
        enabled: false,
        tokenGeneration: 1,
        permission: "denied",
      },
    });
    expect(disabled.state).toBe("disabled");
    await expectStoreError(
      store.register({ userId: ownerId, request: request() }),
      "stale_generation",
    );

    await store.revokeWithProof({ bindingId, revokeProof: "w".repeat(48) });
    expect((await store.getStatus({ userId: ownerId, bindingId })).state).toBe("disabled");
    await store.revokeWithProof({ bindingId, revokeProof: "p".repeat(48) });
    expect((await store.getStatus({ userId: ownerId, bindingId })).state).toBe("revoked");
    await expectStoreError(
      store.register({ userId: ownerId, request: request({ tokenGeneration: 2 }) }),
      "revoked",
    );
  });

  test("persists a bounded generic test intent rather than arbitrary notification copy", async () => {
    const liveBindingId = randomUUID();
    const liveInstallationId = randomUUID();
    const store = createPushInstallationStore({
      db,
      getEncryptionKey: () => key,
      now: () => currentNow,
      newNotificationId: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await store.register({
      userId: ownerId,
      request: request({ bindingId: liveBindingId, installationId: liveInstallationId }),
    });
    const accepted = await store.enqueueGenericTest({ userId: ownerId, bindingId: liveBindingId });
    expect(accepted.notificationId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const [intent] = await withTrustContext({ userId: ownerId }, (tx) =>
      tx.select().from(pushNotificationTestIntents)
        .where(eq(pushNotificationTestIntents.notificationId, accepted.notificationId)), db);
    expect(intent).toMatchObject({
      notificationId: accepted.notificationId,
      userId: ownerId,
      bindingId: liveBindingId,
      tokenGeneration: 1,
      state: "pending",
    });
    expect(Object.keys(intent ?? {})).not.toContain("title");
    expect(Object.keys(intent ?? {})).not.toContain("body");
  });

  test("delivers the fixed generic test with an idempotent, receipt-confirmed lifecycle", async () => {
    const liveBindingId = randomUUID();
    const liveInstallationId = randomUUID();
    let clock = new Date("2026-08-05T21:00:00.000Z");
    // Earlier lifecycle cases intentionally leave their durable evidence for
    // assertions. Remove only this fixture owner's obsolete test work before
    // proving a single exact binding/generation through the worker.
    await withTrustContext({ userId: ownerId }, async (tx) => {
      await tx.delete(pushNotificationDeliveries).where(eq(pushNotificationDeliveries.userId, ownerId));
      await tx.delete(pushNotificationTestIntents).where(eq(pushNotificationTestIntents.userId, ownerId));
    }, db);
    const store = createPushInstallationStore({
      db,
      getEncryptionKey: () => key,
      now: () => clock,
      newNotificationId: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    await store.register({
      userId: ownerId,
      request: request({ bindingId: liveBindingId, installationId: liveInstallationId }),
    });
    await store.enqueueGenericTest({ userId: ownerId, bindingId: liveBindingId });

    const observedBodies: unknown[] = [];
    const provider = new ExpoPushProvider({
      fetch: async (url, init) => {
        if (typeof init.body !== "string") throw new Error("Expo adapter must send JSON text");
        observedBodies.push(JSON.parse(init.body));
        if (url.includes("/push/send")) {
          return new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket-d468-test" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { "ticket-d468-test": { status: "ok" } } }), { status: 200 });
      },
    });
    const worker = createPushDeliveryWorker({
      db,
      workerId: "d468-integration-worker",
      provider,
      now: () => clock,
      getEncryptionKey: () => key,
      newDeliveryId: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    const sent = await worker.runOnce();
    expect(sent.testsProcessed).toBe(1);
    expect(sent.sendsClaimed).toBe(1);
    expect(observedBodies[0]).toMatchObject([
      {
        title: "Nautilo",
        body: "Test notification",
        data: { version: 1, kind: "test", bindingId: liveBindingId },
      },
    ]);

    const [ticketed] = await withTrustContext({ userId: ownerId }, (tx) =>
      tx.select().from(pushNotificationDeliveries)
        .where(eq(pushNotificationDeliveries.eventId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")), db);
    expect(ticketed).toMatchObject({
      bindingId: liveBindingId,
      tokenGeneration: 1,
      kind: "test",
      state: "receipt_pending",
      ticketId: "ticket-d468-test",
    });

    clock = new Date(clock.getTime() + 15 * 60 * 1_000);
    const received = await worker.runOnce();
    expect(received.receiptsClaimed).toBe(1);
    const [delivered] = await withTrustContext({ userId: ownerId }, (tx) =>
      tx.select().from(pushNotificationDeliveries)
        .where(eq(pushNotificationDeliveries.id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")), db);
    expect(delivered).toMatchObject({
      state: "delivered",
      ticketId: "ticket-d468-test",
      attemptCount: 1,
      receiptAttemptCount: 1,
    });
    expect(delivered?.terminalAt).toBeInstanceOf(Date);
    expect(observedBodies).toHaveLength(2);

    // Expiry is terminalized by the same bounded maintenance pass, rather
    // than being sent after an offline/mobile delay made it stale.
    const expiredDeliveryId = randomUUID();
    const createdAt = new Date(clock.getTime() - 60 * 60 * 1_000);
    await withTrustContext({ userId: ownerId }, (tx) => tx.insert(pushNotificationDeliveries).values({
      id: expiredDeliveryId,
      userId: ownerId,
      bindingId: liveBindingId,
      tokenGeneration: 1,
      kind: "test",
      eventId: randomUUID(),
      roomId: null,
      topLevelRoomId: null,
      messageId: null,
      attentionRequestId: null,
      occurredAt: createdAt,
      state: "pending",
      attemptCount: 0,
      receiptAttemptCount: 0,
      nextAttemptAt: createdAt,
      ticketId: null,
      ticketAcceptedAt: null,
      claimOwner: null,
      claimPurpose: null,
      claimExpiresAt: null,
      lastFailureCode: null,
      terminalAt: null,
      expiresAt: new Date(clock.getTime() - 1_000),
      createdAt,
      updatedAt: createdAt,
    }), db);
    clock = new Date(clock.getTime() + 60_000);
    await worker.runOnce();
    const [expired] = await withTrustContext({ userId: ownerId }, (tx) =>
      tx.select().from(pushNotificationDeliveries)
        .where(eq(pushNotificationDeliveries.id, expiredDeliveryId)), db);
    expect(expired).toMatchObject({ state: "terminal", lastFailureCode: "expired" });
  });
});
