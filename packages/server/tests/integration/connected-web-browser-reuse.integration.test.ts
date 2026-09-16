import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agents, connectedWebAccounts, connectedWebOperations, createDirectDb, ensureDatabase, eq, namespaces, rooms, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createConnectedWebAccountStore, type ConnectedWebOperationAdmission, type ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";

let db: ReturnType<typeof createDirectDb>;
let store: ReturnType<typeof createConnectedWebAccountStore>;
const owner = randomUUID();
const agent = randomUUID();
const room = randomUUID();
const namespace = randomUUID();
const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "d568-disposable-test-only-secret-material" });
const now = new Date();

beforeAll(async () => {
  if (bootstrapTestDbInstance() !== "test-cruft") throw new Error("This fixture requires test-cruft");
  // Never reset a shared scratch DB merely to make this focused test pass.
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase();
  db = createDirectDb(5);
  store = createConnectedWebAccountStore(db);
  await db.insert(users).values({ id: owner, name: "Browser reuse fixture", email: `${owner}@test.local` });
  await db.insert(agents).values({ id: agent, handle: `browser-reuse-${agent}` });
  await db.insert(namespaces).values({ id: namespace, scope: "room", label: "Browser reuse fixture" });
  await db.insert(rooms).values({ id: room, ownerId: owner, namespaceId: namespace, type: "private", label: "Browser reuse fixture", graphThreadId: `fixture:${room}` });
}, 60_000);

afterAll(async () => {
  if (!db) return;
  await db.delete(connectedWebOperations).where(eq(connectedWebOperations.ownerUserId, owner));
  await db.delete(connectedWebAccounts).where(eq(connectedWebAccounts.ownerUserId, owner));
  await db.delete(rooms).where(eq(rooms.id, room));
  await db.delete(namespaces).where(eq(namespaces.id, namespace));
  await db.delete(agents).where(eq(agents.id, agent));
  await db.delete(users).where(eq(users.id, owner));
  await db.end();
});

async function account(): Promise<string> {
  const id = randomUUID();
  await db.insert(connectedWebAccounts).values({ id, ownerUserId: owner, service: "example", origin: "https://example.com", label: "Fixture", status: "connected", profileRef: `fixture-profile-${id}` });
  return id;
}

function context(id: string, accountId: string) { return { operationId: id, ownerUserId: owner, accountId }; }

async function admit(accountId: string, at: Date, thread = "same-thread") {
  const id = randomUUID();
  const reservationToken = randomUUID();
  const admission: ConnectedWebOperationAdmission = {
    id, ownerUserId: owner, accountId, initiatingAgentId: agent, initiatingRoomId: room,
    initiatingThreadId: thread, initiatingLane: "foreground", deliveryId: randomUUID(), requestDigest: "a".repeat(64),
    sealedIntent: secrets.sealIntent({ context: context(id, accountId), intent: "fixture read" }),
    safeActivity: { version: 1, phase: "starting", code: "start", summary: "Starting." }, remainingBudgetUsdMicros: 1_000_000,
  };
  const result = await store.admitReadOperation({ admission,
    checkpoint: { resource: "read", phase: "reserving", reservationToken, recordedAt: at.toISOString() },
    rebindBrowserSession: (source) => {
      const old = secrets.unsealProviderReferences({ context: context(source.id, accountId), references: source.sealedProviderRefs });
      return secrets.sealProviderReferences({ context: context(id, accountId), coordinates: { sessionId: old.sessionId!, workspaceId: old.workspaceId! } });
    },
  });
  return { ...result, reservationToken };
}

async function complete(first: Awaited<ReturnType<typeof admit>>, at: Date): Promise<ConnectedWebOperation> {
  const op = first.operation!;
  if (op.accountId === null) throw new Error("Expected authenticated reuse fixture");
  const inherited = secrets.unsealProviderReferences({ context: context(op.id, op.accountId), references: op.sealedProviderRefs });
  const refs = secrets.sealProviderReferences({ context: context(op.id, op.accountId), coordinates: {
    runId: `run-${op.id}`, sessionId: inherited.sessionId ?? `session-${op.id}`, workspaceId: inherited.workspaceId ?? `workspace-${op.id}`,
  } });
  expect(await store.activateReadOperation({ ownerUserId: owner, accountId: op.accountId, operationId: op.id, reservationToken: first.reservationToken,
    opaqueExecutionRef: `run-${op.id}`, sealedProviderRefs: refs, safeActivity: op.safeActivity, now: at })).toBe(true);
  expect(await store.terminalizeReadOperationAndCompleteExecution({ operationId: op.id, ownerUserId: owner, accountId: op.accountId,
    cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: op.remainingBudgetUsdMicros, safeActivity: op.safeActivity, wakeFingerprint: "terminal-read",
    expectedControlEpoch: 1, expectedRunRef: refs.runRef!, opaqueExecutionRef: `run-${op.id}`, now: at,
    receipt: { version: 1, outcome: "completed", code: "completed", summary: "Done." } })).toBe(true);
  return store.getOperationForOwner({ ownerUserId: owner, operationId: op.id });
}

test("a later turn reuses persisted custody after a store restart; old cleanup cannot touch it", async () => {
  const id = await account();
  const first = await complete(await admit(id, now), now);
  store = createConnectedWebAccountStore(db);
  const next = await admit(id, new Date(now.getTime() + 120_000));
  expect(next.kind).toBe("new");
  const refs = secrets.unsealProviderReferences({ context: context(next.operation!.id, id), references: next.operation!.sealedProviderRefs });
  expect(refs.sessionId).toBe(`session-${first.id}`);
  expect(refs.runId).toBeUndefined();
  expect((await store.getOperationForOwner({ ownerUserId: owner, operationId: first.id })).browserIdleUntil).toBeNull();
  const expired = await store.claimIdleBrowserOperations({ now: new Date(now.getTime() + 600_000), batch: 32 });
  expect(expired.some((op) => op.id === first.id || op.id === next.operation!.id)).toBe(false);
  const second = await complete(next, new Date(now.getTime() + 200_000));
  expect(second.browserIdleUntil).toEqual(new Date(now.getTime() + 500_000));
});

test("concurrent new turns cannot both inherit the warm browser", async () => {
  const id = await account();
  await complete(await admit(id, now), now);
  const attempts = await Promise.all([admit(id, now), admit(id, now)]);
  expect(attempts.map((entry) => entry.kind).sort()).toEqual(["busy", "new"]);
});

test("expiry and another conversation retire the browser instead of reusing it", async () => {
  for (const [offset, thread] of [[300_000, "same-thread"], [1, "another-thread"]] as const) {
    const id = await account();
    const first = await complete(await admit(id, now), now);
    const next = await admit(id, new Date(now.getTime() + offset), thread);
    expect(next.operation!.sealedProviderRefs).toEqual({ version: 1 });
    expect(next.retiredBrowsers?.map((op) => op.id)).toEqual([first.id]);
    expect((await store.getOperationForOwner({ ownerUserId: owner, operationId: first.id })).browserCleanupStartedAt).not.toBeNull();
  }
});

test("cleanup racing a follow-up has one irreversible custody winner", async () => {
  const id = await account();
  const first = await complete(await admit(id, now), now);
  const [next, cleaned] = await Promise.all([
    admit(id, new Date(now.getTime() + 299_999)),
    store.claimIdleBrowserOperations({ now: new Date(now.getTime() + 300_000), batch: 32 }),
  ]);
  const reused = Boolean(next.operation!.sealedProviderRefs.sessionRef);
  const claimed = cleaned.some((op) => op.id === first.id);
  expect(reused && claimed).toBe(false);
  expect(reused || claimed).toBe(true);
});

test("activity and event cursor commit atomically; earlier pages preserve every action after restart", async () => {
  const id = await account();
  const first = await admit(id, now);
  const op = first.operation!;
  const refs = secrets.sealProviderReferences({ context: context(op.id, id), coordinates: { runId: "ledger-run", sessionId: "ledger-session" } });
  await store.activateReadOperation({ ownerUserId: owner, accountId: id, operationId: op.id, reservationToken: first.reservationToken,
    opaqueExecutionRef: "ledger-run", sealedProviderRefs: refs, safeActivity: op.safeActivity, now });
  const claims = await store.claimDueOperations({ workerId: "ledger-test", now, batch: 32, leaseMs: 60_000 });
  expect(claims.some((entry) => entry.id === op.id)).toBe(true);
  const checkpoint = { operationId: op.id, workerId: "ledger-test", now, expectedControlEpoch: 1, expectedEventCursor: 0,
    expectedRunRef: refs.runRef!, sealedProviderRefs: refs, eventCursor: 30, safeActivity: op.safeActivity,
    nextCheckAt: now, cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 1_000_000,
    activityEntries: Array.from({ length: 30 }, (_, index) => ({ providerEventId: index + 1, occurredAt: now, status: "completed" as const, summary: `Inspect section ${index + 1}` })),
  };
  expect(await store.recordOperationCheckpoint(checkpoint)).toBe(true);
  expect(await store.recordOperationCheckpoint(checkpoint)).toBe(false);
  store = createConnectedWebAccountStore(db);
  const latest = (await store.getOperationForOwner({ ownerUserId: owner, operationId: op.id })).activityLog!;
  expect(latest.entries).toHaveLength(25);
  expect(latest.entries[0]?.summary).toBe("Inspect section 6");
  expect(latest.hasMore).toBe(true);
  const earlier = (await store.getOperationForOwner({ ownerUserId: owner, operationId: op.id, activityBefore: latest.before! })).activityLog!;
  expect(earlier.entries).toHaveLength(5);
  expect(earlier.hasMore).toBe(false);
  expect(new Set([...earlier.entries, ...latest.entries].map((entry) => entry.id)).size).toBe(30);
  expect(JSON.stringify(latest)).not.toMatch(/ledger-run|ledger-session|providerEventId/);
  const denied = await store.getOperationForOwner({ ownerUserId: randomUUID(), operationId: op.id }).then(() => null, (cause: unknown) => cause);
  expect(denied).toMatchObject({ kind: "not_found" });
});

test("D585 public operation persists and cleans up without any account row", async () => {
  const id = randomUUID();
  const reservationToken = randomUUID();
  const admission: ConnectedWebOperationAdmission = {
    id, ownerUserId: owner, accountId: null, initiatingAgentId: agent, initiatingRoomId: room,
    initiatingThreadId: "public-thread", initiatingLane: "foreground", deliveryId: randomUUID(), requestDigest: "b".repeat(64),
    sealedIntent: secrets.sealIntent({ context: { operationId: id, ownerUserId: owner, accountId: null }, intent: "public fixture" }),
    safeActivity: { version: 1, phase: "starting", code: "start", summary: "Starting public research." }, remainingBudgetUsdMicros: 1_000_000,
  };
  const checkpoint = { resource: "read" as const, phase: "reserving" as const, reservationToken, recordedAt: now.toISOString() };
  expect((await store.admitReadOperation({ admission, checkpoint })).kind).toBe("new");
  expect((await store.admitReadOperation({ admission, checkpoint })).kind).toBe("existing");
  const refs = secrets.sealProviderReferences({ context: { operationId: id, ownerUserId: owner, accountId: null }, coordinates: { runId: "public-run", sessionId: "public-session" } });
  expect(await store.activateReadOperation({ ownerUserId: owner, accountId: null, operationId: id, reservationToken, opaqueExecutionRef: "public-run", sealedProviderRefs: refs, safeActivity: admission.safeActivity, now })).toBe(true);
  expect(await store.terminalizeReadOperationAndCompleteExecution({ operationId: id, ownerUserId: owner, accountId: null, expectedControlEpoch: 1, expectedRunRef: refs.runRef!, opaqueExecutionRef: "public-run", now,
    cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 1_000_000, safeActivity: admission.safeActivity, wakeFingerprint: "public-terminal",
    receipt: { version: 1, outcome: "completed", code: "done", summary: "Done." }, terminalReadResult: { version: 1, account: null,
      page: { ref: id, title: "example.com", origin: "https://example.com" },
      read: { answer: "Public answer", facts: [], completeness: "complete", provenance: "public_website", origin: "https://example.com" },
      cost: { currency: "USD", amountUsd: 0, state: "actual" }, outputs: [], outputsTruncated: false },
  })).toBe(true);
  const stored = await store.getOperationForOwner({ ownerUserId: owner, operationId: id });
  expect(stored).toMatchObject({ accountId: null, lifecycle: "terminal", browserIdleUntil: now, terminalReadResult: { read: { answer: "Public answer" } } });
});
