import { afterEach, describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { rooms, roomMembers, groupMembers, memories, memoryNamespaces, memoryScopes, agentScopes, type SQL } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { memoryReviewFingerprint } from "../../src/memory/memory-review-staging";
import { installAuthoredMemorySemanticChangeSink, _resetAuthoredMemorySemanticChangeSinkForTests } from "../../src/store/authored-memory-semantic-change";
import { setMemoryAuditSink } from "../../src/store/memory-write-access";
import { MemoryMutationAuthorityError, revalidateMemoryMutationAuthority, revalidateHumanMemoryMutationAuthority } from "../../src/store/memory-mutation-authority";

const writes: { name: string; tx: unknown }[] = [];
const propagatedEmbeddings: unknown[] = [];
mock.module("../../src/store/memory-store", () => ({
  findMemorySaveTarget: async () => null, getMemoryById: async () => null, searchMemory: async () => [],
  saveMemoryWithDb: async (tx: unknown, _opts: unknown, prepared: { id: string; embedding: unknown }) => { writes.push({ name: "save", tx }); propagatedEmbeddings.push(prepared.embedding); return { id: prepared.id, action: "created" }; },
  replaceMemoryWithDb: async (tx: unknown, _id: unknown, _content: unknown, _mutable: unknown, embedding: unknown) => { writes.push({ name: "replace", tx }); propagatedEmbeddings.push(embedding); return true; },
  demoteMemoryWithDb: async (tx: unknown) => { writes.push({ name: "demote", tx }); return true; },
  promoteMemoryWithDb: async (tx: unknown) => { writes.push({ name: "promote", tx }); return true; },
}));
mock.module("../../src/store/scope-memory-store", () => ({
  findScopeMemorySaveTarget: async () => null, getScopeMemoryById: async () => null, searchScopeMemory: async () => [],
  saveScopeMemoryWithDb: async (tx: unknown, _opts: unknown, prepared: { id: string; embedding: unknown }) => { writes.push({ name: "scope-save", tx }); propagatedEmbeddings.push(prepared.embedding); return { id: prepared.id, action: "created" }; },
  replaceScopeMemoryWithDb: async (tx: unknown, _opts: unknown, embedding: unknown) => { writes.push({ name: "scope-replace", tx }); propagatedEmbeddings.push(embedding); },
  demoteScopeMemoryWithDb: async (tx: unknown) => { writes.push({ name: "scope-demote", tx }); },
  promoteScopeMemoryWithDb: async (tx: unknown) => { writes.push({ name: "scope-promote", tx }); },
}));
const { publishPreparedMemoryReview, deliverMemoryReviewEffect } = await import("../../src/memory/memory-review-publication");
import type { PreparedMemoryReview, MemoryReviewTransaction, MemoryReviewEffect } from "../../src/memory/memory-review-publication";

const envelope: MemoryAccessEnvelope = { ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room", readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"], toolPolicy: {} };
const original = { id: "existing", type: "fact", content: "Private Memory content", importance: 0.6, tier: 1, createdAt: new Date(0), updatedAt: new Date(0), demotedAt: null, demotedFrom: null, namespaceIds: ["namespace"] };
const embedding = { vector: [1, 0], provider: "openai" as const, canonicalModel: "model-a", dimensions: 2, contractVersion: 1 as const };
function proposal(): PreparedMemoryReview {
  return { envelope, speakerUserId: "human", snapshots: [{ memoryId: original.id, fingerprint: memoryReviewFingerprint(original) }],
    operations: [{ operationId: "work:mutation:0", action: "replace", memoryId: original.id, expectedDedupId: null, type: "fact", content: "New private content", embedding }],
  };
}
function transaction(options: { noSpeaker?: boolean; noAgent?: boolean; noCapability?: boolean; readOnly?: boolean; archived?: boolean; namespaceChanged?: boolean; sourceChanged?: boolean; scopeClosed?: boolean; seeded?: boolean } = {}) {
  const events: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (query: SQL) => {
      const sql = dialect.sqlToQuery(query).sql;
      events.push(sql);
      return [];
    },
    select: () => ({ from: (table: unknown) => {
      const rows = table === rooms ? [{ id: "room", archivedAt: options.archived ? new Date() : null, namespaceId: options.namespaceChanged ? "changed" : "namespace", humanActorIds: ["actor"] }]
        : table === roomMembers ? [
          ...(!options.noSpeaker ? [{ actorId: "actor", ownerId: "human", kind: "user", agentId: null }] : []),
          ...(!options.noAgent ? [{ actorId: "agent-actor", ownerId: "human", kind: "agent", agentId: "agent" }] : []),
        ]
        : table === groupMembers ? options.noCapability ? [] : [{ slug: "read_memories" }, ...(!options.readOnly ? [{ slug: "manage_memories" }] : [])]
        : table === memories ? [{ ...original, content: options.sourceChanged ? "Changed since review" : original.content }]
        : table === memoryNamespaces ? [{ memoryId: "existing", namespaceId: "namespace" }]
        : table === memoryScopes ? [{ memoryId: "existing", scopeId: "scope", origin: options.seeded ? "seed" : "scope" }]
        : table === agentScopes ? [{ id: "scope", parentAgentId: "agent", speakerUserId: "human", lifecycleState: options.scopeClosed ? "closing" : "open" }]
        : [{ publicRoomId: null }];
      const query = { where: () => query, orderBy: () => query, leftJoin: () => query, innerJoin: () => query,
        for: (mode: string) => { events.push(`lock:${mode}`); return Promise.resolve(rows); },
        then: <TResult1 = typeof rows, TResult2 = never>(resolve?: ((value: typeof rows) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    } }),
  };
  return { tx: tx as unknown as MemoryReviewTransaction, events };
}
afterEach(() => { writes.length = 0; propagatedEmbeddings.length = 0; setMemoryAuditSink(null); _resetAuthoredMemorySemanticChangeSinkForTests(); });
describe("Memory transaction publication", () => {
  test("Human library authority does not borrow Agent membership, but retains Human and product gates", async () => {
    await revalidateHumanMemoryMutationAuthority(transaction({ noAgent: true }).tx, {
      envelope, speakerUserId: "human", mutation: true,
    });
    expect(await revalidateMemoryMutationAuthority(transaction({ noAgent: true }).tx, {
      envelope, speakerUserId: "human", mutation: true,
    }).catch((error: unknown) => error)).toBeInstanceOf(MemoryMutationAuthorityError);
    for (const options of [{ noSpeaker: true }, { noCapability: true },
      { archived: true }, { namespaceChanged: true }, { readOnly: true }]) {
      expect(await revalidateHumanMemoryMutationAuthority(transaction(options).tx, {
        envelope, speakerUserId: "human", mutation: true,
      }).catch((error: unknown) => error)).toBeInstanceOf(MemoryMutationAuthorityError);
    }
    const { tx, events } = transaction();
    expect(await revalidateHumanMemoryMutationAuthority(tx, {
      envelope: { memoryMode: "scope", ownerId: "human", actorId: "actor",
        agentId: "agent", roomId: "room", scopeId: "scope", toolPolicy: {} },
      speakerUserId: "human", mutation: true,
    }).catch((error: unknown) => error)).toBeInstanceOf(MemoryMutationAuthorityError);
    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });
  test("shared foreground authority requires management only for mutations", async () => {
    const { tx } = transaction({ readOnly: true });
    await revalidateMemoryMutationAuthority(tx, { envelope, speakerUserId: "human", mutation: false });
    const error = await revalidateMemoryMutationAuthority(tx, {
      envelope, speakerUserId: "human", mutation: true,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MemoryMutationAuthorityError);
    expect(writes).toEqual([]);
  });
  test("shared foreground authority rejects substituted subjects before locking and stale mutable or writable sets", async () => {
    const { tx, events } = transaction();
    expect(await revalidateMemoryMutationAuthority(tx, {
      envelope, speakerUserId: "other-human", mutation: true,
    }).catch((value: unknown) => value)).toBeInstanceOf(MemoryMutationAuthorityError);
    expect(events).toEqual([]);
    for (const changed of [
      { ...envelope, mutableNamespaces: ["other-namespace"] },
      { ...envelope, writableNamespaces: ["other-namespace"] },
    ]) {
      expect(await revalidateMemoryMutationAuthority(transaction().tx, {
        envelope: changed, speakerUserId: "human", mutation: true,
      }).catch((value: unknown) => value)).toMatchObject({ reason: "source_changed" });
    }
    expect(writes).toEqual([]);
  });
  test("rejects revoked speaker, Agent, capability, archived Room, changed Namespace or source before canonical mutation", async () => {
    for (const options of [{ noSpeaker: true }, { noAgent: true }, { noCapability: true }, { archived: true }, { namespaceChanged: true }, { sourceChanged: true }]) {
      const { tx } = transaction(options);
      const error = await publishPreparedMemoryReview(tx, proposal()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(writes).toEqual([]);
    }
  });
  test("runs canonical mutation in caller transaction and returns content-free replay effects", async () => {
    const { tx, events } = transaction();
    const result = await publishPreparedMemoryReview(tx, proposal());
    expect(writes).toEqual([{ name: "replace", tx }]);
    expect(propagatedEmbeddings).toEqual([embedding]);
    expect(result.counts).toEqual({ created: 0, replaced: 1, promoted: 0, demoted: 0 });
    expect(result.effects[0]).toMatchObject({ operationId: "work:mutation:0", memoryId: "existing", changeKind: "replace" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(events).toContain("lock:update");
  });
  test("passes exact embedding provenance through a canonical save", async () => {
    const pending = proposal();
    pending.snapshots = [];
    pending.operations = [{
      operationId: "work:mutation:0", action: "save", memoryId: "new-memory",
      expectedDedupId: null, type: "fact", content: "New private content", embedding,
    }];
    const { tx } = transaction();
    await publishPreparedMemoryReview(tx, pending);
    expect(writes).toEqual([{ name: "save", tx }]);
    expect(propagatedEmbeddings).toEqual([embedding]);
  });
  test("preserves scope ownership/lifecycle and refuses seed mutation", async () => {
    const pending = proposal();
    pending.envelope = { memoryMode: "scope", ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room", scopeId: "scope", toolPolicy: {} };
    pending.snapshots = [{ memoryId: "existing", fingerprint: memoryReviewFingerprint({ ...original, namespaceIds: [] }) }];
    for (const options of [{ scopeClosed: true }, { seeded: true }]) {
      expect(await publishPreparedMemoryReview(transaction(options).tx, pending).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(writes).toEqual([]);
    }
    const { tx } = transaction();
    await publishPreparedMemoryReview(tx, pending);
    expect(writes).toEqual([{ name: "scope-replace", tx }]);
    expect(propagatedEmbeddings).toEqual([embedding]);
  });
  test("post-commit delivery failures stay observable and use stable identities on retry", async () => {
    const effect: MemoryReviewEffect = { operationId: "work:mutation:0", memoryId: "existing", action: "replaced", changeKind: "replace",
      audit: { kind: "memory.edit", memoryId: "existing", action: "replace", outcome: "success", actorId: "human", ip: "" },
    };
    expect(await deliverMemoryReviewEffect(effect).catch((error: unknown) => error)).toBeInstanceOf(Error);
    const received: string[] = [];
    installAuthoredMemorySemanticChangeSink(async (change) => { received.push(change.changeRef); });
    let failAudit = true;
    const audits: string[] = [];
    setMemoryAuditSink((audit) => { if (failAudit) throw new Error("disk unavailable"); audits.push(audit.operationId!); });
    expect(await deliverMemoryReviewEffect(effect).catch((error: unknown) => error)).toBeInstanceOf(Error);
    failAudit = false;
    await deliverMemoryReviewEffect(effect);
    expect(received).toEqual(["memory-change:stable:work:mutation:0", "memory-change:stable:work:mutation:0"]);
    expect(audits).toEqual(["work:mutation:0"]);
  });
});
