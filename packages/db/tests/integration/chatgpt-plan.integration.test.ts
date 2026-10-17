import { CHATGPT_RESTORE_FENCE_SQL } from "@nautilo/operator-secrets";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  beginPersonalLlmAttempt, settlePersonalLlmAttempt, chatgptRegistrations, createDirectDb, ensureDatabase, getChatGPTRegistration,
  getPersonalCostsSummary, getSelectedChatGPTRegistration, insertChatGPTRegistration,
  llmUsageEvents, personalProviderCredentials, selectChatGPTRegistration, users,
  withLockedChatGPTRegistration, type DirectDatabase,
} from "@nautilo/db";
import { __setLlmUsageDbForTests } from "../../src/queries/llm-usage";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: DirectDatabase;
const humans: string[] = [];
const attempts: string[] = [];
const envelope = { formatVersion: 1 as const, keyId: randomUUID(), nonceBase64: "c3ludGhldGlj", ciphertextBase64: "c3ludGhldGlj", authTagBase64: "c3ludGhldGlj" };
async function human() {
  const id = randomUUID();
  await db.insert(users).values({ id, name: `subscription-fixture-${id}` });
  humans.push(id);
  return id;
}
async function registration(userId: string) {
  const id = randomUUID(); const serverInstanceId = randomUUID();
  expect(await insertChatGPTRegistration(db, { id, userId, clientId: `synthetic-${id}`, serverInstanceId,
    hostId: `urn:uuid:${serverInstanceId}`, authorityRevision: 1, tokenGeneration: 1,
    state: "connected", identityEnvelope: envelope, envelope })).toBe(true);
  return id;
}
beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  __setLlmUsageDbForTests(db);
}, 60_000);
afterAll(async () => {
  __setLlmUsageDbForTests(null);
  if (attempts.length) await db?.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, attempts));
  if (humans.length) await db?.delete(users).where(inArray(users.id, humans));
  await db?.end();
});

describe("ChatGPT registration migration and isolation", () => {
  test("registration grants keep agent and crypto roles out of operator custody", async () => {
    const [row] = await db.execute(sql`SELECT
      has_table_privilege('nautilo_agent', 'chatgpt_registrations', 'SELECT') AS agent_read,
      has_table_privilege('nautilo_crypto', 'chatgpt_registrations', 'SELECT') AS crypto_read,
      has_table_privilege('nautilo', 'chatgpt_registrations', 'SELECT,INSERT,UPDATE,DELETE') AS runtime_access`);
    expect(row).toMatchObject({ agent_read: false, crypto_read: false, runtime_access: true });
  });
  test("selection is Human-scoped and concurrent changes leave one selected account", async () => {
    const owner = await human(); const other = await human();
    const first = await registration(owner); const second = await registration(owner);
    expect(await getChatGPTRegistration(db, other, first)).toBeNull();
    expect(await selectChatGPTRegistration(db, other, first)).toBe(false);
    expect(await Promise.all([selectChatGPTRegistration(db, owner, first), selectChatGPTRegistration(db, owner, second)])).toEqual([true, true]);
    const rows = await db.select().from(chatgptRegistrations).where(eq(chatgptRegistrations.userId, owner));
    expect(rows.filter(row => row.selected)).toHaveLength(1);
    expect(await getSelectedChatGPTRegistration(db, other)).toBeNull();
  });
  test("rotation locks serialize generations and disconnect keeps explicit funding pinned", async () => {
    const owner = await human(); const id = await registration(owner);
    await selectChatGPTRegistration(db, owner, id);
    const rotate = () => withLockedChatGPTRegistration(db, owner, id, async row => ({ result: row.tokenGeneration,
      mutation: { state: row.state, envelope: row.envelope, identityEnvelope: row.identityEnvelope,
        authorityRevision: row.authorityRevision, tokenGeneration: row.tokenGeneration + 1 } }));
    expect((await Promise.all([rotate(), rotate()])).sort()).toEqual([1, 2]);
    await withLockedChatGPTRegistration(db, owner, id, async row => ({ result: undefined,
      mutation: { state: "disconnected", envelope: null, identityEnvelope: row.identityEnvelope,
        authorityRevision: row.authorityRevision + 1, tokenGeneration: row.tokenGeneration + 1 } }));
    expect(await getSelectedChatGPTRegistration(db, owner)).toMatchObject({ id, state: "disconnected", envelope: null, authorityRevision: 2, tokenGeneration: 4 });
    expect(await selectChatGPTRegistration(db, owner, id)).toBe(false);
  });
  test("connecting and disconnecting a subscription preserves an existing API key", async () => {
    const owner = await human(); const keyId = randomUUID();
    const { keyId: custodyKeyId, ...cipher } = envelope;
    await db.insert(personalProviderCredentials).values({ ...cipher, keyId: custodyKeyId, id: keyId, userId: owner, provider: "openai", revision: 1 });
    const [before] = await db.select().from(personalProviderCredentials).where(eq(personalProviderCredentials.id, keyId));
    const id = await registration(owner);
    await selectChatGPTRegistration(db, owner, id);
    await selectChatGPTRegistration(db, owner, null);
    const [after] = await db.select().from(personalProviderCredentials).where(eq(personalProviderCredentials.id, keyId));
    expect(after).toEqual(before);
  });
  test("subscription estimates and unresolved attempts never enter monetary totals or another Human's report", async () => {
    const owner = await human(); const other = await human(); const id = await registration(owner);
    const now = new Date(); const range = { sinceIso: new Date(now.getTime() - 60_000).toISOString(), untilIso: new Date(now.getTime() + 60_000).toISOString() };
    for (const [payer, route, estimate, actual, outcome] of [
      [owner, "openai", 2, 1, "succeeded"], [owner, "openai-chatgpt", 7, null, "succeeded"],
      [owner, "openai-chatgpt", 3, null, "unknown"], [other, "openai-chatgpt", 900, null, "succeeded"],
    ] as const) {
      const attempt = randomUUID(); attempts.push(attempt);
      const ownerToken = randomUUID();
      await beginPersonalLlmAttempt({ id: attempt, ownerToken, userId: payer,
        provider: "openai", providerRoute: route, credentialId: id, credentialRevision: 1,
        endpoint: "/v1/responses", model: "openai:synthetic-model", callType: "chat" });
      await settlePersonalLlmAttempt({ attemptId: attempt, ownerToken,
        inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, totalTokens: 130,
        estimatedCostUsd: estimate, actualCostUsd: actual, pricingVersion: "synthetic-v1",
        outcome, costState: outcome === "unknown" ? "unknown" : actual === null ? "estimated" : "actual" });
    }
    const report = await getPersonalCostsSummary({ payerHumanId: owner, range });
    expect(report.totals.totalCostUsd).toBe(1);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.unknownAttempts).toBe(0);
    expect(report.byProvider.map(row => row.provider)).toEqual(["openai"]);
    expect(report.recovery.attempts).toHaveLength(0);
    expect(report.subscriptions).toEqual([{ registrationId: id, model: "openai:synthetic-model", attempts: 2,
      unresolvedAttempts: 1, inputTokens: 200, cachedInputTokens: 40, outputTokens: 60, totalTokens: 260, apiEquivalentCostUsd: 10 }]);
    const newcomer = await human(); await registration(newcomer);
    const empty = await getPersonalCostsSummary({ payerHumanId: newcomer, range });
    expect(empty.entry).toEqual({ available: true, hasPersonalCredentials: true, hasHistory: false });
    expect(empty.subscriptions).toEqual([]);
  });
});

test("restore fences renewable tokens without losing selected identity or affecting API keys", async () => {
  // Transaction rollback confines the whole-table restore operation to this
  // fixture, including when other scratch tests are using the same database.
  const owner = await human(); const id = await registration(owner);
  await selectChatGPTRegistration(db, owner, id);
  const before = await getChatGPTRegistration(db, owner, id);
  class RollbackFixture extends Error {}
  try {
    await db.transaction(async tx => {
      await tx.execute(sql.raw(CHATGPT_RESTORE_FENCE_SQL));
      const [row] = await tx.select().from(chatgptRegistrations).where(eq(chatgptRegistrations.id, id));
      expect(row).toMatchObject({ selected: true, state: "reconnect_required", envelope: null,
        identityEnvelope: before!.identityEnvelope, authorityRevision: before!.authorityRevision,
        tokenGeneration: before!.tokenGeneration + 1 });
      await tx.execute(sql.raw(CHATGPT_RESTORE_FENCE_SQL));
      const [again] = await tx.select().from(chatgptRegistrations).where(eq(chatgptRegistrations.id, id));
      expect(again).toEqual(row);
      throw new RollbackFixture();
    });
  } catch (error) { if (!(error instanceof RollbackFixture)) throw error; }
});
