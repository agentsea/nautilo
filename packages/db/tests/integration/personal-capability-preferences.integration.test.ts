import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  getPersonalCapabilityPreferences,
  replacePersonalCapabilityPreferences,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: DirectDatabase;
const userIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const [row] = await db.insert(users).values({
    name: `personal-capability-preferences:${label}:${randomUUID()}`,
  }).returning({ id: users.id });
  if (!row) throw new Error("Personal capability preference fixture user was not created");
  userIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
}, 120_000);

afterAll(async () => {
  for (const userId of userIds) {
    await db?.delete(users).where(eq(users.id, userId));
  }
  await db?.end();
});

test("personal capability preferences use an exact revision CAS and stay Human-scoped", async () => {
  const firstHumanId = await createUser("first");
  const secondHumanId = await createUser("second");

  expect(await getPersonalCapabilityPreferences(db, firstHumanId)).toEqual({
    revision: 0,
    overrides: {},
  });

  const competing = await Promise.all([
    replacePersonalCapabilityPreferences(db, {
      humanId: firstHumanId,
      expectedRevision: 0,
      overrides: { webSearchSynthesis: "openrouter:model-a" },
    }),
    replacePersonalCapabilityPreferences(db, {
      humanId: firstHumanId,
      expectedRevision: 0,
      overrides: { decision: "openrouter:model-b" },
    }),
  ]);
  expect(competing.filter((result) => result.status === "updated")).toHaveLength(1);
  expect(competing.filter((result) => result.status === "conflict")).toEqual([
    { status: "conflict", currentRevision: 1 },
  ]);

  const firstCurrent = await getPersonalCapabilityPreferences(db, firstHumanId);
  expect(firstCurrent.revision).toBe(1);
  const replacement = await replacePersonalCapabilityPreferences(db, {
    humanId: firstHumanId,
    expectedRevision: firstCurrent.revision,
    overrides: { deepResearchFinalReport: "openrouter:model-c" },
  });
  expect(replacement).toMatchObject({
    status: "updated",
    preferences: {
      revision: 2,
      overrides: { deepResearchFinalReport: "openrouter:model-c" },
    },
  });
  expect(await replacePersonalCapabilityPreferences(db, {
    humanId: firstHumanId,
    expectedRevision: 1,
    overrides: {},
  })).toEqual({ status: "conflict", currentRevision: 2 });

  expect(await getPersonalCapabilityPreferences(db, secondHumanId)).toEqual({
    revision: 0,
    overrides: {},
  });
});
