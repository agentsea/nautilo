import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getBolterReceiptMessageIdsWith, getBolterOutboxMessageIdsWith, parseExternalRoomJobReference,
  loadBolterExecutionWith, startBolterExecutionWith, settleBolterExecutionWith, completeBolterExecutionWith,
  linkBolterExecutionAcceptanceWith, loadBolterPublicationContentWith, type BolterBridgeDatabase, type BolterExecutionInput,
} from "../../src/queries/bolter-bridge";
import { finalizeBolterExecutionMigration, BOLTER_EXECUTION_MARKER } from "../../scripts/finalize-bolter-execution";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-7111-8111-111111111111`;
const owner = uuid(1), bindingId = uuid(2), roomId = uuid(3), agentId = uuid(4), receiptId = uuid(5), acceptanceId = uuid(6), jobId = uuid(7), connectionId = uuid(8);
const now = new Date("2026-01-01T00:00:00Z");
const input: BolterExecutionInput = { jobId, reference: { kind: "external_room_turn_v1", receiptId, bindingId,
  bindingRevision: 0, connectionGeneration: 1, acceptanceId, roomId, agentId, turnId: "fixture-turn" } };
const binding = { id: bindingId, userId: owner, roomId, agentId, namespaceId: uuid(9), connectionId,
  origin: "https://bolter.chat", providerAgentId: "fixture-agent", chatId: "fixture-chat", threadId: "", state: "active", revision: 0, modelSponsorshipAcceptedAt: now };
const connection = { id: connectionId, userId: owner, enabled: true, revokedAt: null, generation: 1,
  origin: binding.origin, providerAgentId: binding.providerAgentId,
  relayId: "fixture-relay", desktopSessionId: "fixture-desktop", pairingGenerationRef: "fixture-pair" };
const origin = { kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
  connectionId, bindingId, providerAgentId: binding.providerAgentId, chatId: binding.chatId,
  threadRootId: null, messageId: "fixture-message", senderId: "fixture-sender", senderType: "user",
  senderLabel: "Fixture sender", createdAt: "2026-01-01T00:00:00Z" } as const;
const content = "Synthetic source";
const fingerprint = createHash("sha256").update(JSON.stringify([origin.provider, origin.origin, origin.providerAgentId,
  origin.chatId, origin.threadRootId, origin.messageId, origin.senderId, origin.senderType, origin.createdAt, content])).digest("hex");
const receipt = { id: receiptId, userId: owner, bindingId, bindingRevision: 0, connectionGeneration: 1,
  sessionMessageId: 17, controlInput: null, turnId: input.reference.turnId, jobId, state: "accepted", fingerprint,
  providerMessageId: origin.messageId, externalSenderId: origin.senderId };
const job = { id: jobId, ownerId: owner, requestorId: owner, input: input.reference, status: "queued", startedAt: null, completedAt: null };
const acceptance = { id: acceptanceId, kind: "foreground", status: "dispatched", jobId, dispatchedAt: now, cancelledAt: null };
type Step = { table: string; rows: unknown[]; op?: "select" | "update" | "insert" };
function db(steps: Step[], mode = "plaintext_only") {
  const calls: { table: string; op: string; values?: unknown; predicate?: SQL | undefined }[] = [];
  let rolledBack = false;
  const build = (op: "select" | "update" | "insert", table?: unknown) => {
    const call = { op, table: table ? getTableName(table as never) : "", values: undefined as unknown, predicate: undefined as SQL | undefined };
    const read = () => {
      if (call.table === "encryption_transition_policy") return [{ mode, shadowBehavior: "fallback", revision: 0 }];
      calls.push(call); const step = steps.shift();
      expect(step?.table).toBe(call.table); expect(step?.op ?? "select").toBe(op); return step?.rows ?? [];
    };
    const chain = { from(t: unknown) { call.table = getTableName(t as never); return chain; },
      innerJoin() { return chain; }, leftJoin() { return chain; }, groupBy() { return chain; }, where(v: SQL) { call.predicate = v; return chain; }, orderBy() { return chain; },
      values(v: unknown) { call.values = v; return chain; }, set(v: unknown) { call.values = v; return chain; },
      for() { return Promise.resolve(read()); }, limit() { return Promise.resolve(read()); }, returning() { return Promise.resolve(read()); },
      then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(read()).then(resolve); } };
    return chain;
  };
  const tx = { select: () => build("select"), update: (t: unknown) => build("update", t), insert: (t: unknown) => build("insert", t),
    execute: async () => [{ allowed: true }] };
  const database = { async transaction<T>(run: (transaction: typeof tx) => Promise<T>) { try { return await run(tx); } catch (error) { rolledBack = true; throw error; } } } as unknown as BolterBridgeDatabase;
  return { database, tx, calls, rolledBack: () => rolledBack, remaining: () => steps.length };
}
const lock = (status = "queued", acceptanceStatus = "dispatched"): Step[] => [
  { table: "bolter_room_bindings", rows: [binding] }, { table: "bolter_connections", rows: [connection] },
  { table: "bolter_room_bindings", rows: [binding] }, { table: "bolter_inbox_receipts", rows: [receipt] },
  { table: "work_acceptances", rows: [{ ...acceptance, status: acceptanceStatus, jobId: acceptanceStatus === "accepted" ? null : jobId }] },
  { table: "jobs", rows: [{ ...job, status, startedAt: status === "queued" ? null : now, completedAt: ["completed", "failed"].includes(status) ? now : null }] },
];
const hydrate = (body = content): Step[] => [{ table: "session_messages", rows: [{ sourceMessage: { id: 17, content: body, externalAuthorship: true }, session: { id: uuid(10) } }] },
  { table: "bolter_inbox_receipts", rows: [{ receipt, binding, ownerId: owner, roomId, agentId, role: "user", humanTurnId: input.reference.turnId,
    metadata: { externalOrigin: origin, externalReceiptId: receiptId } }] }];

const publicationContext = { userId: owner, connectionId, connectionGeneration: 1,
  relayId: connection.relayId, desktopSessionId: connection.desktopSessionId,
  pairingGenerationRef: connection.pairingGenerationRef, bindingId, bindingRevision: 0 };
const publicationClaim = { outboxId: uuid(11), claimToken: uuid(12) };
const finalContent = "Synthetic final response";
const finalFingerprint = createHash("sha256").update(JSON.stringify(["external-room-final-v1", receiptId, jobId, finalContent])).digest("hex");
const outbox = { id: publicationClaim.outboxId, sourceInboxId: receiptId, explicitShareId: null, sessionMessageId: 18, controlResult: null, fingerprint: finalFingerprint };
const publicationSteps = (): Step[] => [
  { table: "bolter_connections", rows: [connection] }, { table: "bolter_room_bindings", rows: [binding] },
  { table: "bolter_outbox", rows: [outbox] }, { table: "bolter_inbox_receipts", rows: [{ jobId, input: input.reference }] },
  ...lock("completed"), ...hydrate(), { table: "bolter_outbox", rows: [outbox] },
  { table: "session_messages", rows: [{ content: finalContent, fingerprint: finalFingerprint }] },
];

describe("Bolter exact durable execution", () => {
  test("publication reads only a completed canonical reply at its exact destination", async () => {
    const f = db(publicationSteps());
    expect(await loadBolterPublicationContentWith(f.database, publicationContext, publicationClaim)).toEqual({
      origin: binding.origin, providerAgentId: binding.providerAgentId, chatId: binding.chatId, threadRootId: null, content: finalContent,
    });
    expect(f.remaining()).toBe(0);
    const claimQuery = new PgDialect().sqlToQuery(f.calls[2]!.predicate!);
    for (const value of [owner, bindingId, publicationClaim.outboxId, publicationClaim.claimToken, "publishing", 0, 1]) expect(claimQuery.params).toContain(value);
    const finalQuery = new PgDialect().sqlToQuery(f.calls.at(-1)!.predicate!);
    for (const field of ["session_id", "role", "transcript_origin", "human_turn_id", "tool_calls", "tool_name", "reply_to_message_id", "metadata"]) expect(finalQuery.sql).toContain(field);
    expect(finalQuery.params).toContain(JSON.stringify({ kind: "bolter_final_reply_v1", receiptId, jobId, turnId: input.reference.turnId, acceptanceId }));
    expect(finalQuery.params).toContain(uuid(10));
    expect(finalQuery.params).toContain(17); expect(finalQuery.params).toContain(18);
  });
  test("publication never reads final text for wrong mode, owner, generation, sponsorship or claim", async () => {
    const encrypted = db([], "full_encryption");
    await Promise.resolve(expect(loadBolterPublicationContentWith(encrypted.database, publicationContext, publicationClaim)).rejects.toThrow());
    expect(encrypted.calls).toHaveLength(0);
    for (const patch of [{ userId: uuid(99) }, { connectionGeneration: 2 }, { desktopSessionId: "other" }]) {
      const f = db(publicationSteps());
      expect(await loadBolterPublicationContentWith(f.database, { ...publicationContext, ...patch }, publicationClaim)).toBeNull();
      expect(f.calls).toHaveLength(1);
    }
    for (const missing of ["consent", "claim", "explicit-share"]) {
      const steps = publicationSteps();
      if (missing === "consent") steps[1]!.rows = [{ ...binding, modelSponsorshipAcceptedAt: null }];
      if (missing === "claim") steps[2]!.rows = [];
      if (missing === "explicit-share") steps[2]!.rows = [{ ...outbox, explicitShareId: uuid(99) }];
      const f = db(steps);
      expect(await loadBolterPublicationContentWith(f.database, publicationContext, publicationClaim)).toBeNull();
      expect(f.calls.some(call => call.table === "session_messages")).toBe(false);
    }
  });
  test("unfinished work, altered source and altered final bytes cannot be published", async () => {
    for (const change of ["job", "acceptance", "source", "body", "fingerprint", "withdrawn-claim"]) {
      const steps = publicationSteps();
      if (change === "job") steps[9]!.rows = [{ ...job, status: "running", startedAt: now, completedAt: null }];
      if (change === "acceptance") steps[8]!.rows = [{ ...acceptance, cancelledAt: now }];
      if (change === "source") steps[10]!.rows = [{ sourceMessage: { id: 17, content: "Altered source", externalAuthorship: true }, session: { id: uuid(10) } }];
      if (change === "body") steps[13]!.rows = [{ content: "Altered final", fingerprint: finalFingerprint }];
      if (change === "fingerprint") steps[13]!.rows = [{ content: finalContent, fingerprint: "0".repeat(64) }];
      if (change === "withdrawn-claim") steps[12]!.rows = [];
      const f = db(steps);
      expect(await loadBolterPublicationContentWith(f.database, publicationContext, publicationClaim)).toBeNull();
      if (["job", "acceptance"].includes(change)) expect(f.calls.some(call => call.table === "session_messages")).toBe(false);
    }
  });
  test("reference rejects prompt payload and unknown coordinates while accepting UUIDv7", () => {
    expect(parseExternalRoomJobReference(input.reference)).toEqual(input.reference);
    for (const bad of [{ ...input.reference, message: "Duplicate prompt" }, { ...input.reference, connectionGeneration: 0 },
      { ...input.reference, bindingRevision: 0.5 }, { ...input.reference, receiptId: "short" }, { ...input.reference, turnId: "\n" }]) expect(parseExternalRoomJobReference(bad)).toBeNull();
  });
  test("receipt and outbox guards read only structural projection without state filters", async () => {
    const fixture = db([{ table: "bolter_inbox_receipts", rows: [{ sessionMessageId: 17 }] }, { table: "bolter_outbox", rows: [{ sessionMessageId: 18 }] }]);
    expect([...await getBolterReceiptMessageIdsWith(fixture.tx as never, { userId: owner }, [17])]).toEqual([17]);
    expect([...await getBolterOutboxMessageIdsWith(fixture.tx as never, { userId: owner }, [18])]).toEqual([18]);
    for (const call of fixture.calls) {
      const query = new PgDialect().sqlToQuery(call.predicate!); expect(query.params).toContain(owner);
      expect(query.sql).not.toContain('"state"'); expect(query.sql).not.toContain('"metadata"');
    }
  });
  test("hydration requires receipt provenance and immutable provider content fingerprint", async () => {
    const good = db([...lock(), ...hydrate()]);
    expect((await loadBolterExecutionWith(good.database, { userId: owner }, input))?.origin).toEqual(origin);
    const tampered = db([...lock(), ...hydrate("Edited source")]);
    expect(await loadBolterExecutionWith(tampered.database, { userId: owner }, input)).toBeNull();
    const encrypted = db([], "shadow_encryption");
    await Promise.resolve(expect(loadBolterExecutionWith(encrypted.database, { userId: owner }, input)).rejects.toThrow("unavailable"));
    expect(encrypted.calls).toHaveLength(0);
  });
  test("start CAS compares exact queued identity and requires acceptance dispatch", async () => {
    const fixture = db([...lock(), { table: "jobs", op: "update", rows: [{ id: jobId }] }]);
    expect(await startBolterExecutionWith(fixture.database, { userId: owner }, { ...input, executionClaim: { roomId, jobId, token: uuid(10) } })).toBe("started");
    const update = fixture.calls.at(-1)!; const query = new PgDialect().sqlToQuery(update.predicate!);
    expect(query.params).toContain(jobId); expect(query.params).toContain(owner); expect(query.params).toContain("queued");
    expect(query.sql).toContain('"started_at" is null'); expect(query.sql).toContain('"completed_at" is null');
    const unlinked = db(lock("queued", "accepted"));
    expect(await startBolterExecutionWith(unlinked.database, { userId: owner }, input)).toBe("rejected");
    expect(unlinked.calls.every(call => call.op === "select")).toBe(true);
  });
  test("queued recovery can link once or adopt the same already dispatched acceptance", async () => {
    const first = db([...lock("queued", "accepted"), { table: "work_acceptances", op: "update", rows: [] }]);
    expect(await linkBolterExecutionAcceptanceWith(first.database, { userId: owner }, input)).toBe("linked");
    const second = db(lock());
    expect(await linkBolterExecutionAcceptanceWith(second.database, { userId: owner }, input)).toBe("linked");
    expect(second.calls.every(call => call.op === "select")).toBe(true);
  });
  test("start loser cannot terminalize winner and completion status cannot bypass publication", async () => {
    const loser = db(lock("running"));
    expect(await settleBolterExecutionWith(loser.database, { userId: owner }, { ...input, status: "failed", expectedPredecessor: "queued" })).toEqual({ kind: "rejected" });
    const noPredecessor = db(lock("running"));
    expect(await settleBolterExecutionWith(noPredecessor.database, { userId: owner }, { ...input, status: "failed" })).toEqual({ kind: "rejected" });
    const bypass = db(lock("running"));
    expect(await settleBolterExecutionWith(bypass.database, { userId: owner }, { ...input, status: "completed", expectedPredecessor: "running" })).toEqual({ kind: "rejected" });
    expect(loser.calls.every(call => call.op === "select")).toBe(true);
  });
  test("failed final callback aborts before Job completion and outbox insertion", async () => {
    const fixture = db([...lock("running"), ...hydrate()]);
    await Promise.resolve(expect(completeBolterExecutionWith(fixture.database, { userId: owner }, input, async () => { throw new Error("Synthetic canonical failure"); })).rejects.toThrow("Synthetic canonical failure"));
    expect(fixture.rolledBack()).toBe(true); expect(fixture.calls.every(call => call.op === "select")).toBe(true);
    expect(fixture.remaining()).toBe(0);
  });
  test("missing provenance observes exact terminal failure only without recovering execution authority", async () => {
    for (const status of ["cancelled", "failed", "timed_out"]) {
      const f = db([{ table: "bolter_room_bindings", rows: [] }, { table: "jobs", rows: [{ status }] }]);
      expect(await settleBolterExecutionWith(f.database, { userId: owner }, { ...input, status: "failed", expectedPredecessor: "running" }))
        .toEqual({ kind: "existing_terminal", status });
      expect(f.calls.every(call => call.op === "select")).toBe(true);
      const query = new PgDialect().sqlToQuery(f.calls[1]!.predicate!);
      expect(query.params).toContain(owner); expect(query.params).toContain(`room:${roomId}`);
      expect(query.sql).toContain('"jobs"."completed_at" is not null');
      expect(query.params).not.toContain("completed");
    }
    const missing = db([{ table: "bolter_room_bindings", rows: [] }, { table: "jobs", rows: [] }]);
    expect(await settleBolterExecutionWith(missing.database, { userId: owner }, { ...input, status: "completed" })).toEqual({ kind: "rejected" });
  });
  test("generated finalization is deterministic and adds sponsorship, exact work and reply authority", () => {
    const prefix = 'ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;';
    const result = finalizeBolterExecutionMigration(prefix);
    expect(result.startsWith(prefix)).toBe(true); expect(result).toContain(BOLTER_EXECUTION_MARKER);
    expect(finalizeBolterExecutionMigration(result)).toBe(result);
    for (const condition of ["j.input IS DISTINCT FROM jsonb_build_object", "a.status <> 'dispatched'", "m.human_turn_id IS NULL",
      "m.reply_to_message_id = i.session_message_id", "m.fingerprint = NEW.fingerprint", "btrim(m.content) <> ''", "NEW.explicit_share_id IS NOT NULL"]) expect(result).toContain(condition);
    expect(result).not.toContain("SECURITY DEFINER"); expect(result).not.toContain("GRANT ALL");
  });
});

test("explicit file publication requires fingerprinted metadata and retained blobs in the exact Room namespace", async () => {
  const { bolterReviewedTextFingerprint } = await import("../../src/queries/bolter-bridge");
  const file = { id: uuid(44), filename: "brief.txt", mimeType: "text/plain", sizeBytes: 5, sha256: "a".repeat(64) };
  const requestId = uuid(45), shareId = uuid(46), content = "Synthetic shared file";
  const fingerprint = bolterReviewedTextFingerprint(bindingId, requestId, content, [file]);
  const shared = { ...outbox, sourceInboxId: null, explicitShareId: shareId, fingerprint };
  const share = { id: shareId, requestId, sessionMessageId: outbox.sessionMessageId, fingerprint };
  function steps(missing = false, altered = false): Step[] {
    return [
      { table: "bolter_connections", rows: [connection] }, { table: "bolter_room_bindings", rows: [binding] },
      { table: "bolter_outbox", rows: [shared] }, { table: "bolter_explicit_shares", rows: [share] },
      { table: "bolter_outbox", rows: [shared] }, { table: "session_messages", rows: [{ content, fingerprint,
        metadata: { bolterAttachments: [{ ...file, filename: altered ? "different.txt" : file.filename }] } }] },
      { table: "message_attachments", rows: missing ? [] : [{ ...file, storageUri: "file:///path/to/synthetic/blob" }] },
    ];
  }
  const f = db(steps());
  const result = await loadBolterPublicationContentWith(f.database, publicationContext, publicationClaim);
  expect(result?.files).toEqual([{ ...file, storageUri: "file:///path/to/synthetic/blob" }]);
  const predicate = new PgDialect().sqlToQuery(f.calls.at(-1)!.predicate!);
  expect(predicate.params).toContain(binding.namespaceId);
  expect(predicate.params).toContain("retained");
  expect(predicate.params).toContain(fingerprint);
  expect(await loadBolterPublicationContentWith(db(steps(true)).database, publicationContext, publicationClaim)).toBeNull();
  const altered = db(steps(false, true));
  expect(await loadBolterPublicationContentWith(altered.database, publicationContext, publicationClaim)).toBeNull();
  expect(altered.calls.some(call => call.table === "message_attachments")).toBe(false);
});

test("automatic delivery reads use exact IDs and aggregate only unresolved states", async () => {
  const { getBolterDeliveryCountsWith, listBolterDeliverySummariesWith } = await import("../../src/queries/bolter-bridge");
  const counts = db([{ table: "bolter_outbox", rows: [{ state: "pending", quantity: 2 }, { state: "publishing", quantity: 1 }, { state: "uncertain", quantity: 4 }] }]);
  expect(await getBolterDeliveryCountsWith(counts.database, { userId: owner }, bindingId)).toEqual({ pending: 3, uncertain: 4 });
  const countQuery = new PgDialect().sqlToQuery(counts.calls[0]!.predicate!);
  for (const param of [owner, bindingId, "pending", "publishing", "uncertain"]) expect(countQuery.params).toContain(param);
  for (const selection of [{ outboxId: publicationClaim.outboxId }, { requestId: uuid(50) }]) {
    const exact = db([{ table: "bolter_outbox", rows: [] }]);
    await listBolterDeliverySummariesWith(exact.database, { userId: owner }, bindingId, selection);
    const predicate = new PgDialect().sqlToQuery(exact.calls[0]!.predicate!);
    for (const param of [owner, bindingId, Object.values(selection)[0]]) expect(predicate.params).toContain(param);
  }
});
