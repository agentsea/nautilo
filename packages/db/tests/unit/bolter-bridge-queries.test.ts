import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL } from "drizzle-orm";
import { acceptBolterInboundWith, bolterReceiverMatches, canonicalBolterOrigin, claimBolterOutboxWith, createFreshBolterBindingWith, createBolterConnectionWith, recoverBolterOutboxWith, rotateBolterReceiverWith, setBolterConnectionStateWith, updateBolterBindingStateWith, type BolterBindingContext, type BolterBridgeDatabase } from "../../src/queries/bolter-bridge";
import { type BolterConnection, type BolterRoomBinding, type BolterInboxReceipt } from "../../src/schema/bolter-bridge";

const U = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const N = "55555555-5555-4555-8555-555555555555";
const A = "66666666-6666-4666-8666-666666666666";
const I = "77777777-7777-4777-8777-777777777777";
const now = new Date("2026-01-01T00:00:00Z");
const ctx: BolterBindingContext = { userId: U, connectionId: C, connectionGeneration: 3, relayId: "relay", desktopSessionId: "desktop", pairingGenerationRef: "pairing", bindingId: B, bindingRevision: 2 };
const connection: BolterConnection = { provider: "bolter", transportKind: "desktop-relay", operatorBindingId: null, id: C, userId: U, relayId: ctx.relayId, desktopSessionId: ctx.desktopSessionId, pairingGenerationRef: ctx.pairingGenerationRef, homeHandle: "home-handle", origin: "https://example.test", providerAgentId: "abc12345", identityFingerprint: "a".repeat(64), generation: 3, revision: 2, enabled: true, revokedAt: null, createdAt: now, updatedAt: now };
const binding: BolterRoomBinding = { provider: "bolter", id: B, userId: U, connectionId: C, roomId: R, namespaceId: N, agentId: A, origin: connection.origin, providerAgentId: connection.providerAgentId, chatId: "abc12345", threadId: "", revision: 2, modelSponsorshipAcceptedAt: now, state: "active", createdAt: now, updatedAt: now };
const receipt: BolterInboxReceipt = { id: I, userId: U, bindingId: B, bindingRevision: 2, connectionGeneration: 3, providerMessageId: "message", fingerprint: "b".repeat(64), externalSenderId: "outside-speaker", sessionMessageId: 91, controlInput: null, turnId: "external-turn", jobId: null, state: "accepted", createdAt: now, updatedAt: now };
const inbound = { providerMessageId: receipt.providerMessageId, fingerprint: receipt.fingerprint, externalSenderId: receipt.externalSenderId };
type Step = { op: "select" | "insert" | "update"; table: string; rows: unknown[] };
type Call = { op: Step["op"]; table: string; values?: Record<string, unknown>; predicate?: SQL };

/** A narrow transaction double: it verifies query order, scopes and writes without a service. */
function database(steps: Step[], roomAvailable = true) {
  const calls: Call[] = [];
  let transactions = 0;
  let rolledBack = false;
  const operation = (op: Step["op"], initialTable?: unknown) => {
    const call: Call = { op, table: initialTable ? getTableName(initialTable as Parameters<typeof getTableName>[0]) : "" };
    const rows = () => {
      if (call.table === "encryption_transition_policy") return [{ mode: "plaintext_only", shadowBehavior: "fallback", revision: 0 }];
      calls.push(call);
      const step = steps.shift();
      expect(step?.op).toBe(op);
      expect(step?.table).toBe(call.table);
      return step?.rows ?? [];
    };
    const chain = {
      from(table: unknown) { call.table = getTableName(table as Parameters<typeof getTableName>[0]); return chain; },
      where(predicate: SQL) { call.predicate = predicate; return chain; },
      values(value: Record<string, unknown>) { call.values = value; return chain; },
      set(value: Record<string, unknown>) { call.values = value; return chain; },
      orderBy() { return chain; }, onConflictDoNothing() { return chain; },
      for() { return Promise.resolve(rows()); }, limit() { return Promise.resolve(rows()); }, returning() { return Promise.resolve(rows()); },
      then(resolve: (value: unknown[]) => unknown) { return Promise.resolve(rows()).then(resolve); },
    };
    return chain;
  };
  const tx = { execute: async (query: SQL) => new PgDialect().sqlToQuery(query).sql.startsWith("SET LOCAL") ? [] : new PgDialect().sqlToQuery(query).sql.includes("current_user") ? [{ role: "nautilo" }] : roomAvailable ? [{ id: R }] : [], select: () => operation("select"), insert: (table: unknown) => operation("insert", table), update: (table: unknown) => operation("update", table) };
  const db = { async transaction<T>(run: (transaction: typeof tx) => Promise<T>): Promise<T> { transactions++; try { return await run(tx); } catch (error) { rolledBack = true; throw error; } } } as unknown as BolterBridgeDatabase;
  return { db, tx, calls, remaining: () => steps.length, transactions: () => transactions, rolledBack: () => rolledBack };
}
const authority = (): Step[] => [{ op: "select", table: "bolter_connections", rows: [connection] }, { op: "select", table: "bolter_room_bindings", rows: [binding] }];
const fence = (): Step[] => [{ op: "update", table: "bolter_inbox_receipts", rows: [] }, { op: "update", table: "bolter_outbox", rows: [] }, { op: "update", table: "bolter_outbox", rows: [] }];

describe("Bolter qualified identity and durable transactions", () => {
  test("rejects credential-bearing origins and filesystem handles before opening a transaction", async () => {
    for (const origin of ["http://example.test", "https://fixture@example.com", "https://example.test/path", "https://example.test?token=fixture", "https://example.test/#fixture"]) expect(() => canonicalBolterOrigin(origin)).toThrow();
    expect(canonicalBolterOrigin("https://EXAMPLE.test:443/")).toBe("https://example.test");
    const fake = database([]);
    expect(() => createBolterConnectionWith(fake.db, ctx, { ...connection, relayId: "relay", desktopSessionId: "desktop", pairingGenerationRef: "pairing", homeHandle: "/private/home" })).toThrow();
    expect(fake.transactions()).toBe(0);
  });

  test("short provider IDs never replace owner/device/generation identity", () => {
    expect(bolterReceiverMatches(connection, ctx)).toBe(true);
    for (const change of [{ userId: A }, { connectionId: A }, { connectionGeneration: 4 }, { relayId: "other" }, { desktopSessionId: "other" }, { pairingGenerationRef: "other" }]) expect(bolterReceiverMatches(connection, { ...ctx, ...change })).toBe(false);
    expect(bolterReceiverMatches({ ...connection, enabled: false }, ctx)).toBe(false);
    expect(bolterReceiverMatches({ ...connection, revokedAt: now }, ctx)).toBe(false);
  });

  test("stale receivers cannot invoke the fresh Room factory or canonical persistence", async () => {
    const fake = database([{ op: "select", table: "bolter_connections", rows: [connection] }]);
    let factories = 0;
    await Promise.resolve(expect(createFreshBolterBindingWith(fake.db, { ...ctx, connectionGeneration: 2 }, async () => { factories++; return binding; })).rejects.toThrow("unavailable"));
    expect(factories).toBe(0);
    const fakeInbound = database([{ op: "select", table: "bolter_connections", rows: [connection] }]);
    let inserts = 0;
    expect(await acceptBolterInboundWith(fakeInbound.db, { ...ctx, desktopSessionId: "stale" }, inbound, async () => { inserts++; return { jobId: "88888888-8888-4888-8888-888888888888", sessionMessageId: 91, controlInput: null, turnId: "turn" }; })).toEqual({ status: "unavailable" });
    expect(inserts).toBe(0);
  });

  test("fresh Room factory and immutable binding insertion share one transaction", async () => {
    const fake = database([{ op: "select", table: "bolter_connections", rows: [connection] }, { op: "insert", table: "bolter_room_bindings", rows: [binding] }]);
    let factoryCalls = 0;
    await createFreshBolterBindingWith(fake.db, ctx, async (tx, qualified) => { expect(tx as unknown).toBe(fake.tx); expect(qualified).toBe(connection); factoryCalls++; return binding; });
    expect(factoryCalls).toBe(1);
    expect(fake.transactions()).toBe(1);
    expect(fake.calls[1]?.values).toMatchObject({ userId: U, connectionId: C, origin: connection.origin, providerAgentId: connection.providerAgentId });
    expect(fake.remaining()).toBe(0);
  });

  test("an identical provider receipt does not insert a second canonical message", async () => {
    const fake = database([...authority(), { op: "select", table: "bolter_inbox_receipts", rows: [receipt] }]);
    let inserts = 0;
    expect(await acceptBolterInboundWith(fake.db, ctx, inbound, async () => { inserts++; return { jobId: "88888888-8888-4888-8888-888888888888", sessionMessageId: 92, turnId: "duplicate" }; })).toEqual({ status: "duplicate", receipt });
    expect(inserts).toBe(0);
    expect(fake.calls.filter(call => call.op !== "select")).toHaveLength(0);
  });

  test("message-key collision quarantines retained identity and fences its queued reply", async () => {
    for (const change of [{ fingerprint: "c".repeat(64) }, { externalSenderId: "different-speaker" }]) {
      const fake = database([...authority(), { op: "select", table: "bolter_inbox_receipts", rows: [receipt] }, { op: "update", table: "bolter_inbox_receipts", rows: [{ ...receipt, state: "quarantined" }] }, { op: "update", table: "bolter_outbox", rows: [] }]);
      let inserts = 0;
      expect((await acceptBolterInboundWith(fake.db, ctx, { ...inbound, ...change }, async () => { inserts++; return { jobId: "88888888-8888-4888-8888-888888888888", sessionMessageId: 92, turnId: "collision" }; })).status).toBe("quarantined");
      expect(inserts).toBe(0);
      expect(Object.keys(fake.calls[3]?.values ?? {}).sort()).toEqual(["state", "updatedAt"]);
      expect(fake.calls[4]?.values?.['state']).toBeDefined();
      expect(fake.remaining()).toBe(0);
    }
  });

  test("new receipt and canonical source references commit atomically with distinct sender provenance", async () => {
    const pending = { ...receipt, state: "pending", sessionMessageId: null, turnId: null };
    const fake = database([...authority(), { op: "select", table: "bolter_inbox_receipts", rows: [] }, { op: "insert", table: "bolter_inbox_receipts", rows: [pending] }, { op: "update", table: "bolter_inbox_receipts", rows: [receipt] }]);
    expect((await acceptBolterInboundWith(fake.db, ctx, inbound, async (tx, room, receiptId) => { expect(tx as unknown).toBe(fake.tx); expect(room.roomId).toBe(R); expect(receiptId).toBe(I); return { jobId: "88888888-8888-4888-8888-888888888888", sessionMessageId: 91, controlInput: null, turnId: "external-turn" }; })).status).toBe("accepted");
    expect(fake.transactions()).toBe(1);
    expect(fake.calls[3]?.values).toMatchObject({ userId: U, externalSenderId: "outside-speaker", bindingRevision: 2, connectionGeneration: 3 });
    expect(fake.calls[3]?.values).not.toHaveProperty("content");
    expect(fake.remaining()).toBe(0);
  });

  test("failed canonical insertion aborts before accepting the durable receipt", async () => {
    const fake = database([...authority(), { op: "select", table: "bolter_inbox_receipts", rows: [] }, { op: "insert", table: "bolter_inbox_receipts", rows: [{ ...receipt, state: "pending" }] }]);
    await Promise.resolve(expect(acceptBolterInboundWith(fake.db, ctx, inbound, async () => { throw new Error("canonical failure"); })).rejects.toThrow("canonical failure"));
    expect(fake.rolledBack()).toBe(true);
    expect(fake.calls.some(call => call.op === "update")).toBe(false);
  });

  test("archival or lost membership prevents canonical acceptance", async () => {
    const fake = database(authority(), false);
    expect(await acceptBolterInboundWith(fake.db, ctx, inbound, async () => { throw new Error("must not persist"); })).toEqual({ status: "unavailable" });
  });

  test("publication claim CAS binds pending state, owner, generation and revision", async () => {
    const fake = database([...authority(), { op: "update", table: "bolter_outbox", rows: [] }]);
    expect(await claimBolterOutboxWith(fake.db, ctx, I)).toBeNull();
    const claim = fake.calls[2]!;
    const query = new PgDialect().sqlToQuery(claim.predicate!);
    for (const value of [U, B, I, 2, 3, "pending"]) expect(query.params).toContain(value);
    expect(claim.values?.['state']).toBe("publishing");
    expect(claim.values?.['claimToken']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("connection revocation skips terminal bindings while fencing pending and publishing work", async () => {
    const fake = database([{ op: "select", table: "bolter_connections", rows: [connection] }, { op: "update", table: "bolter_connections", rows: [{ ...connection, enabled: false, revokedAt: now, generation: 4, revision: 3 }] }, { op: "select", table: "bolter_room_bindings", rows: [{ id: B }, { id: A }] }, ...fence(), { op: "update", table: "bolter_room_bindings", rows: [] }]);
    expect(await setBolterConnectionStateWith(fake.db, ctx, { connectionId: C, expectedRevision: 2, enabled: false, revoke: true })).toMatchObject({ generation: 4, revision: 3, enabled: false });
    expect(fake.calls.slice(3, 6).map(call => call.values?.['state'])).toEqual(["cancelled", "cancelled", "uncertain"]);
    const predicate = new PgDialect().sqlToQuery(fake.calls[6]!.predicate!);
    expect(predicate.sql).toContain('"state" <>');
    expect(predicate.params).toContain("revoked");
    expect(fake.remaining()).toBe(0);
  });

  test("explicit receiver rotation invalidates old generation and fences in-flight sends", async () => {
    const fake = database([{ op: "select", table: "bolter_connections", rows: [connection] }, { op: "update", table: "bolter_connections", rows: [{ ...connection, desktopSessionId: "new-desktop", pairingGenerationRef: "new-pairing", generation: 4, revision: 3 }] }, { op: "select", table: "bolter_room_bindings", rows: [{ id: B }] }, ...fence()]);
    const rotated = await rotateBolterReceiverWith(fake.db, ctx, { connectionId: C, expectedRevision: 2, desktopSessionId: "new-desktop", pairingGenerationRef: "new-pairing" });
    expect(rotated?.generation).toBe(4);
    expect(bolterReceiverMatches(rotated!, ctx)).toBe(false);
    expect(fake.calls[5]?.values?.['state']).toBe("uncertain");
  });

  test("revoked bindings cannot resume, and recovery only marks publishing uncertain", async () => {
    const fake = database([{ op: "select", table: "bolter_room_bindings", rows: [{ ...binding, state: "revoked" }] }, { op: "select", table: "bolter_connections", rows: [connection] }, { op: "select", table: "bolter_room_bindings", rows: [{ ...binding, state: "revoked" }] }]);
    expect(await updateBolterBindingStateWith(fake.db, ctx, { bindingId: B, expectedRevision: 2, state: "active" })).toBeNull();
    expect(fake.calls.filter(call => call.op === "update")).toHaveLength(0);
    const recovery = database([{ op: "select", table: "bolter_connections", rows: [connection] }, { op: "select", table: "bolter_room_bindings", rows: [{ id: B }] }, { op: "update", table: "bolter_outbox", rows: [] }]);
    await recoverBolterOutboxWith(recovery.db, ctx, C);
    expect(recovery.calls[2]?.values?.['state']).toBe("uncertain");
    expect(new PgDialect().sqlToQuery(recovery.calls[2]!.predicate!).params).toContain("publishing");
  });
});

test("operator identity cannot be replayed as Desktop or through another operator binding", () => {
  const operator = { ...connection, provider: "magent" as const, transportKind: "operator-unix" as const,
    operatorBindingId: I, relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null };
  const receiver = { ...ctx, transportKind: "operator-unix" as const, operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null };
  expect(bolterReceiverMatches(operator, receiver)).toBe(true);
  expect(bolterReceiverMatches(operator, ctx)).toBe(false);
  expect(bolterReceiverMatches(operator, { ...receiver, operatorBindingId: B })).toBe(false);
  expect(bolterReceiverMatches(operator, { ...receiver, connectionGeneration: 4 })).toBe(false);
});

test("lost claim responses can recover only the same exact persisted claim", async () => {
  const fake = database([...authority(), { op: "update", table: "bolter_outbox", rows: [] },
    { op: "select", table: "bolter_outbox", rows: [{ id: I, state: "publishing", claimToken: A }] }]);
  expect(await claimBolterOutboxWith(fake.db, ctx, I, A)).toMatchObject({ id: I, state: "publishing", claimToken: A });
  const retry = new PgDialect().sqlToQuery(fake.calls.at(-1)!.predicate!);
  for (const value of [U, B, I, A, "publishing", 2, 3]) expect(retry.params).toContain(value);
  expect(fake.calls[2]!.values?.["claimToken"]).toBe(A);
  expect(fake.remaining()).toBe(0);
});

test("operator connection insertion carries no forged Desktop credentials and pins its immutable fingerprint", async () => {
  const { createMagentOperatorConnectionWith } = await import("../../src/queries/bolter-bridge");
  const input = { operatorBindingId: I, origin: "http://127.0.0.1:8080", providerAgentId: "external-agent", identityFingerprint: "b".repeat(64) };
  const fake = database([{ op: "insert", table: "bolter_connections", rows: [{ id: I }] }]);
  await createMagentOperatorConnectionWith(fake.db, ctx, input);
  expect(fake.calls[0]!.values).toEqual({ ...input, id: I, userId: U, provider: "magent", transportKind: "operator-unix",
    relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null });
  const changed = database([{ op: "insert", table: "bolter_connections", rows: [] }, { op: "select", table: "bolter_connections",
    rows: [{ ...connection, ...input, id: I, provider: "magent", transportKind: "operator-unix", identityFingerprint: "c".repeat(64) }] }]);
  await Promise.resolve(expect(createMagentOperatorConnectionWith(changed.db, ctx, input)).rejects.toThrow("conflicts"));
});

test("cancelling an operator receipt durably fences its exact job and ambiguous publication", async () => {
  const { cancelMagentReceiptWith } = await import("../../src/queries/bolter-bridge");
  const operator = { ...connection, provider: "magent", transportKind: "operator-unix", operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null };
  const receiver = { ...ctx, transportKind: "operator-unix" as const, operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null };
  const fake = database([{ op: "select", table: "bolter_connections", rows: [operator] },
    { op: "select", table: "bolter_room_bindings", rows: [{ ...binding, provider: "magent" }] },
    { op: "select", table: "bolter_inbox_receipts", rows: [{ ...receipt, jobId: A }] },
    { op: "update", table: "bolter_inbox_receipts", rows: [] }, { op: "update", table: "bolter_outbox", rows: [] }]);
  expect(await cancelMagentReceiptWith(fake.db, receiver, I)).toEqual({ jobId: A });
  expect(fake.calls[3]!.values?.["state"]).toBe("cancelled");
  const state = new PgDialect().sqlToQuery(fake.calls[4]!.values?.["state"] as SQL).sql;
  expect(state).toContain("'publishing' THEN 'uncertain' ELSE 'cancelled'");
  const where = new PgDialect().sqlToQuery(fake.calls[4]!.predicate!).params;
  expect(where).toContain(I);
  expect(where).toContain(U);
  expect(fake.remaining()).toBe(0);
});

test("operator controls persist outside canonical messages and deduplicate the exact receipt", async () => {
  const operator = { ...connection, provider: "magent", transportKind: "operator-unix", operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null };
  const receiver = { ...ctx, transportKind: "operator-unix" as const, operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null };
  const controlInput = { kind: "operator_control_v1" as const, content: "Synthetic operator input",
    origin: { kind: "external_message" as const, version: 1 as const, provider: "magent" as const,
      origin: connection.origin, connectionId: C, bindingId: B, providerAgentId: connection.providerAgentId,
      chatId: binding.chatId, threadRootId: null, messageId: "message", senderId: "outside-speaker",
      senderType: "anima" as const, senderLabel: "Synthetic connector", createdAt: now.toISOString() } };
  const controlReceipt = { ...receipt, sessionMessageId: null, controlInput, jobId: A };
  const admission: Step[] = [{ op: "select", table: "bolter_connections", rows: [operator] },
    { op: "select", table: "bolter_room_bindings", rows: [{ ...binding, provider: "magent" }] },
    { op: "select", table: "external_operator_sessions", rows: [{ sessionId: "generation" }] }];
  const fake = database([...admission, { op: "select", table: "bolter_inbox_receipts", rows: [] },
    { op: "insert", table: "bolter_inbox_receipts", rows: [{ ...receipt, state: "pending" }] },
    { op: "update", table: "bolter_inbox_receipts", rows: [controlReceipt] }]);
  expect(await acceptBolterInboundWith(fake.db, receiver, inbound, async () => ({
    sessionMessageId: null, controlInput, turnId: "external-turn", jobId: A,
  }), "generation")).toEqual({ status: "accepted", receipt: controlReceipt });
  expect(fake.calls.at(-1)?.values).toMatchObject({ sessionMessageId: null, controlInput });
  expect(fake.calls.some(call => call.table === "session_messages")).toBe(false);
  const duplicate = database([...admission, { op: "select", table: "bolter_inbox_receipts", rows: [controlReceipt] }]);
  expect(await acceptBolterInboundWith(duplicate.db, receiver, inbound, async () => { throw new Error("must not duplicate"); }, "generation"))
    .toEqual({ status: "duplicate", receipt: controlReceipt });
  const stale = database(admission);
  expect(await acceptBolterInboundWith(stale.db, receiver, inbound, async () => { throw new Error("must not accept a new context"); }, "other-generation"))
    .toEqual({ status: "unavailable" });
});

test("control recovery verifies durable provenance and refuses legacy transcript receipts", async () => {
  const { loadBolterExecutionWith, completeBolterExecutionWith } = await import("../../src/queries/bolter-bridge");
  const { createHash } = await import("node:crypto");
  const operator = { ...connection, provider: "magent", transportKind: "operator-unix", operatorBindingId: I,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null, homeHandle: null };
  const bound = { ...binding, provider: "magent" };
  const reference = { kind: "external_room_turn_v1" as const, receiptId: I, bindingId: B,
    bindingRevision: 2, connectionGeneration: 3, acceptanceId: N, roomId: R, agentId: A, turnId: "external-turn" };
  const content = "Synthetic control prompt";
  const origin = { kind: "external_message" as const, version: 1 as const, provider: "magent" as const,
    origin: connection.origin, connectionId: C, bindingId: B, providerAgentId: connection.providerAgentId,
    chatId: binding.chatId, threadRootId: null, messageId: receipt.providerMessageId,
    senderId: receipt.externalSenderId, senderType: "anima" as const, senderLabel: "Connector", createdAt: now.toISOString() };
  const digest = createHash("sha256").update(JSON.stringify([origin.provider, origin.origin, origin.providerAgentId,
    origin.chatId, origin.threadRootId, origin.messageId, origin.senderId, origin.senderType, origin.createdAt, content])).digest("hex");
  const controlReceipt = { ...receipt, jobId: A, sessionMessageId: null, fingerprint: digest,
    controlInput: { kind: "operator_control_v1", content, origin } };
  const rows = (inputReceipt: unknown): Step[] => [
    { op: "select", table: "bolter_room_bindings", rows: [bound] },
    { op: "select", table: "bolter_connections", rows: [operator] },
    { op: "select", table: "bolter_room_bindings", rows: [bound] },
    { op: "select", table: "bolter_inbox_receipts", rows: [inputReceipt] },
    { op: "select", table: "work_acceptances", rows: [{ id: N, kind: "foreground", status: "dispatched", jobId: A }] },
    { op: "select", table: "jobs", rows: [{ id: A, status: "running", startedAt: now, completedAt: null }] },
  ];
  const fake = database(rows(controlReceipt));
  expect(await loadBolterExecutionWith(fake.db, ctx, { jobId: A, reference })).toMatchObject({
    sourceMessage: { id: null, content }, session: { id: null, threadId: `room:${R}:operator:${I}` },
  });
  expect(fake.remaining()).toBe(0);
  for (const invalid of [{ ...receipt, jobId: A },
    { ...controlReceipt, controlInput: { ...controlReceipt.controlInput, content: "tampered" } },
    { ...controlReceipt, controlInput: { ...controlReceipt.controlInput, origin: { ...origin, bindingId: N } } },
  ]) {
    const rejected = database(rows(invalid));
    expect(await loadBolterExecutionWith(rejected.db, ctx, { jobId: A, reference })).toBeNull();
    expect(rejected.calls.some(call => call.table === "session_messages")).toBe(false);
  }
  const final = database([...rows(controlReceipt), { op: "update", table: "jobs", rows: [] },
    { op: "insert", table: "bolter_outbox", rows: [{ id: I, state: "pending" }] }]);
  expect(await completeBolterExecutionWith(final.db, ctx, { jobId: A, reference }, async () => ({
    sessionMessageId: null, controlResult: "Synthetic decision", fingerprint: "c".repeat(64),
  }))).toMatchObject({ state: "pending" });
  expect(final.calls.at(-1)?.values).toMatchObject({ sessionMessageId: null, controlResult: "Synthetic decision", sourceInboxId: I });
  expect(final.calls.some(call => call.table === "session_messages")).toBe(false);
});
