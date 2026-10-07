import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { beginToolProviderCostAttempt } from "../../../agent/src/usage/provider-cost-recorder";
import {
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  providerCostEvents,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import { safelyRecordProviderCost } from "../../src/costs/provider-cost-recorder";

const PROVIDER = `personal-service-cost-${randomUUID()}`;
const operations = ["attempt", "shared-receipt"] as const;
const userIds: string[] = [];
let db: DirectDatabase;

async function createUser(label: string): Promise<string> {
  const [row] = await db.insert(users).values({
    name: `${PROVIDER}:${label}`,
  }).returning({ id: users.id });
  if (!row) throw new Error("Personal service cost fixture user was not created");
  userIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
}, 120_000);

afterAll(async () => {
  await db?.delete(providerCostEvents).where(and(
    eq(providerCostEvents.provider, PROVIDER),
    inArray(providerCostEvents.operation, operations),
  ));
  if (userIds.length > 0) {
    await db?.delete(users).where(inArray(users.id, userIds));
  }
  await db?.end();
});

test("a personal service attempt settles its existing unknown row without changing provenance", async () => {
  const payerHumanId = await createUser("attempt");
  const credentialId = randomUUID();
  const usageFunding = {
    kind: "personal" as const,
    humanUserId: payerHumanId,
    payerHumanId,
    providerRoute: "tavily",
    credentialId,
    credentialRevision: 4,
  };
  const settle = await beginToolProviderCostAttempt(undefined, {
    provider: PROVIDER,
    operation: operations[0],
    usageFunding,
  });

  const unknownRows = await db.select().from(providerCostEvents).where(and(
    eq(providerCostEvents.provider, PROVIDER),
    eq(providerCostEvents.operation, operations[0]),
  ));
  expect(unknownRows).toHaveLength(1);
  expect(unknownRows[0]).toMatchObject({
    userId: payerHumanId,
    fundingKind: "personal",
    payerHumanId,
    providerRoute: "tavily",
    credentialId,
    credentialRevision: 4,
    evidenceState: "unknown",
    estimatedCostUsd: null,
    actualCostUsd: null,
  });

  await settle({
    provider: PROVIDER,
    operation: operations[0],
    usageFunding,
    estimatedCostUsd: "0.008",
    evidenceState: "estimated",
  });

  const settledRows = await db.select().from(providerCostEvents).where(and(
    eq(providerCostEvents.provider, PROVIDER),
    eq(providerCostEvents.operation, operations[0]),
  ));
  expect(settledRows).toHaveLength(1);
  expect(settledRows[0]).toMatchObject({
    id: unknownRows[0]?.id,
    idempotencyKey: unknownRows[0]?.idempotencyKey,
    userId: payerHumanId,
    fundingKind: "personal",
    payerHumanId,
    providerRoute: "tavily",
    credentialId,
    credentialRevision: 4,
    evidenceState: "estimated",
    estimatedCostUsd: "0.00800000",
    actualCostUsd: null,
  });
});

test("an identical provider receipt remains distinct for two paying Humans", async () => {
  const firstHumanId = await createUser("first-human");
  const secondHumanId = await createUser("second-human");
  const receiptIdentity = `shared-${randomUUID()}`;
  const record = (payerHumanId: string, credentialId: string) => safelyRecordProviderCost({
    identity: receiptIdentity,
    usageFunding: {
      kind: "personal",
      humanUserId: payerHumanId,
      payerHumanId,
      providerRoute: "tavily",
      credentialId,
      credentialRevision: 1,
    },
    userId: payerHumanId,
    provider: PROVIDER,
    operation: operations[1],
    estimatedCostUsd: "0.008",
    evidenceState: "estimated",
  });

  await record(firstHumanId, randomUUID());
  await record(secondHumanId, randomUUID());

  const rows = await db.select().from(providerCostEvents).where(and(
    eq(providerCostEvents.provider, PROVIDER),
    eq(providerCostEvents.operation, operations[1]),
  ));
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
  expect(new Set(rows.map((row) => row.payerHumanId))).toEqual(
    new Set([firstHumanId, secondHumanId]),
  );
});
