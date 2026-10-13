import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { DirectDatabase } from "@nautilo/db";
import { InMemoryBackgroundAuthorizationRepository, attachBackgroundAuthorizationRecipient, taskRuntimeStableIdempotencyKey,
  type ProtectedTaskOccurrence, type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { refreshHumanMappedTaskContentAccessHead } from "@nautilo/lattice-bridge/server";
import { setup, replanFixture } from "../../../lattice-bridge/tests/fixtures/human-task-mapped-content";
import { createProtectedTaskRuntimeMappedHeadReplan } from "../../src/routes/protected-task-runtime-mapped-head-replan";

async function fixture(options: Readonly<{
  authorityRefresh?: boolean;
  invalidPredecessor?: boolean;
}> = {}) {
  const f = await setup();
  const plans: ReturnType<typeof replanFixture>[] = [];
  await rejects(refreshHumanMappedTaskContentAccessHead({ ...f.input, withMappedHead: async held => {
    plans.push(replanFixture(held)); throw new Error("blueprint rollback");
  } }), /blueprint rollback/);
  const plan = plans[0]!;
  if (options.authorityRefresh) {
    expect(await refreshHumanMappedTaskContentAccessHead(f.input)).toBe("applied");
  }
  f.events.length = 0;
  const stable = plan.stableIdentity;
  const occurrence: ProtectedTaskOccurrence = { task: { id: stable.taskId, ownerId: stable.ownerId,
    requestorId: stable.requestorId, agentId: stable.agentId, callingRoomId: stable.callingRoomId,
    scheduleKind: stable.scheduleKind, contentRepresentation: stable.contentRepresentation,
    contentNamespaceId: stable.contentNamespaceId, contentRevision: stable.contentRevision,
    cryptoObjectId: stable.contentObjectId, cryptoAccessRevision: f.access(),
    cryptoRequiredNamespaceFingerprint: Uint8Array.from(plan.lifecycle.requiredNamespaceFingerprint) },
  run: { id: stable.taskRunId, taskId: stable.taskId, jobId: null, graphThreadId: stable.graphThreadId,
    status: "awaiting", startedAt: new Date(stable.startedAt) } };
  const snapshot = attachBackgroundAuthorizationRecipient(plan.expected.snapshot, {
    recipientGeneration: 0, recipientKeyId: "old-recipient", recipientPublicKey: Buffer.from(new Uint8Array(65).fill(4)).toString("base64url"),
    descriptorDigest: Buffer.from(f.crypto.crypto.hash(new Uint8Array([7]))).toString("hex"), expiresAt: 200, now: 100,
  });
  if (snapshot.formatVersion !== 3 || snapshot.credentialSubject.kind !== "runtime"
    || snapshot.credentialSubject.runtimeKind !== "task") throw new Error("Task runtime snapshot required");
  const authorityRefreshRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.replacement,
    expectedPolicyRevision: 3,
    authoritySet: {
      ...plan.replacement.authoritySet,
      namespaceRequirements: plan.replacement.authoritySet.namespaceRequirements.map(requirement => ({
        ...requirement,
        expectedPolicyRevision: 3,
      })),
    },
  };
  const initial = options.authorityRefresh ? authorityRefreshRecord : options.invalidPredecessor
    ? { ...plan.expected, idempotencyKey: taskRuntimeStableIdempotencyKey({
      ...stable,
      contentAccessRevision: 0,
      targetRoomId: "10000000-0000-4000-8000-000000000099",
    }) }
    : plan.expected;
  const record: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...initial, snapshot: { ...snapshot, credentialSubject: snapshot.credentialSubject }, descriptorBytes: new Uint8Array([7]) };
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(record);
  const events: string[] = [];
  let readCurrentLineage = false;
  let phase = 0;
  let rejectSecondCommit = false;
  const run = createProtectedTaskRuntimeMappedHeadReplan({ db: {} as DirectDatabase, crypto: f.crypto.crypto,
    serverScope: f.input.serverScope, now: f.input.now,
    recipients: { delete: (requestId, generation) => { events.push(`delete:${requestId}:${generation}`); return true; } },
  }, { readLineage: async () => readCurrentLineage ? plan.lineage : null, readPolicy: async () => ({ mode: "encrypted_only", revision: 4 }),
    privateRoom: async () => ({ roomId: f.input.sourceRoomId, namespaceId: stable.contentNamespaceId }),
    productContext: async () => ({ handle: f.product, canonicalRunner: f.input.runner }),
    repository: held => { held.context.assertCurrent(); return repository; },
    repair: async input => {
      phase += 1; events.push(`enter:${phase}`);
      if (phase === 2 && rejectSecondCommit) f.failCommit();
      const result = await refreshHumanMappedTaskContentAccessHead(input);
      events.push(`commit:${phase}`); return result;
    },
  });
  const operation = { occurrence, record, restricted: f.input.restricted,
    admission: { ...f.input.subject.admission, userId: f.input.subject.userId, humanActorId: f.input.subject.humanActorId },
    resolvePlan: async () => {
      expect(events.at(-1)).toBe("commit:1");
      expect(f.access()).toBe(1); events.push("plan");
      return { occurrence: { ...occurrence, task: { ...occurrence.task, cryptoAccessRevision: 1 } },
        stableIdentity: stable, initialRecord: plan.replacement };
    },
  };
  return { f, run, operation, repository, events, currentLineage: () => { readCurrentLineage = true; }, fail: () => { rejectSecondCommit = true; }, plan };
}

test("repair commits before planning, fresh live CAS commits before old custody is deleted", async () => {
  const f = await fixture();
  try {
    expect(await f.run(f.operation)).toBe("retry");
    expect(f.events.slice(0, 5)).toEqual(["enter:1", "commit:1", "plan", "enter:2", "commit:2"]);
    expect(f.events[5]).toContain("delete:");
    const record = await f.repository.get(f.operation.record.snapshot.requestId);
    expect(record?.idempotencyKey).toBe(f.plan.replacement.idempotencyKey);
    expect(record?.snapshot.recipientGeneration).toBe(1);
  } finally { f.f.cleanup(); }
});

test("same-head policy refresh uses ordinary authority replacement", async () => {
  const f = await fixture({ authorityRefresh: true });
  try {
    expect(f.plan.stableIdentity.contentAccessRevision).toBe(1);
    expect(await f.run(f.operation)).toBe("retry");
    const record = await f.repository.get(f.operation.record.snapshot.requestId);
    expect(record?.idempotencyKey).toBe(f.plan.replacement.idempotencyKey);
    expect(record?.expectedPolicyRevision).toBe(4);
    expect(record?.snapshot.requestRevision).toBe(
      f.operation.record.snapshot.requestRevision + 1,
    );
  } finally { f.f.cleanup(); }
});

test("changed stable key without a unique access-head predecessor remains rejected", async () => {
  const f = await fixture({ invalidPredecessor: true });
  try {
    await rejects(f.run(f.operation), /no unique immutable predecessor/);
  } finally { f.f.cleanup(); }
});

test("second product commit loss leaves custody intact despite durable crypto generation change", async () => {
  const f = await fixture();
  try {
    f.fail(); await rejects(f.run(f.operation), /commit rejected/);
    expect(f.events.some(event => event.startsWith("delete:"))).toBe(false);
    expect((await f.repository.get(f.operation.record.snapshot.requestId))?.idempotencyKey).toBe(f.plan.replacement.idempotencyKey);
  } finally { f.f.cleanup(); }
});

test("exact current retry after a prior cross-role CAS is a no-op, and cleans only the retired generation", async () => {
  const f = await fixture();
  try {
    // Model the durable restricted commit from a previous failed outer product transaction.
    await refreshHumanMappedTaskContentAccessHead({ ...f.f.input, withMappedHead: async held => {
      await f.repository.replaceUnclaimedTaskMappedHeadAuthority({ ...replanFixture(held), expected: f.operation.record });
    } });
    const revision = (await f.repository.get(f.operation.record.snapshot.requestId))!.snapshot.requestRevision;
    expect(await f.run(f.operation)).toBe("retry");
    expect((await f.repository.get(f.operation.record.snapshot.requestId))!.snapshot.requestRevision).toBe(revision);
    expect(f.events.filter(event => event.startsWith("delete:"))).toHaveLength(1);
  } finally { f.f.cleanup(); }
});

test("fresh plan source substitution and revoked current authority cannot rotate or delete", async () => {
  for (const mode of ["source", "revoked"] as const) {
    const f = await fixture();
    try {
      if (mode === "revoked") {
        f.f.revoke(); expect(await f.run(f.operation)).toBe("unavailable");
      } else {
        await rejects(f.run({ ...f.operation, resolvePlan: async () => ({ occurrence: f.operation.occurrence,
          initialRecord: f.plan.replacement, stableIdentity: { ...f.plan.stableIdentity, targetRoomId: "substituted" } }) }));
      }
      expect((await f.repository.get(f.operation.record.snapshot.requestId))!.snapshot.recipientGeneration).toBe(0);
      expect(f.events.some(event => event.startsWith("delete:"))).toBe(false);
    } finally { f.f.cleanup(); }
  }
});


test("exact signed current head and fresh plan bypass owned repair for a distinct owner", async () => {
  const f = await fixture();
  try {
    f.currentLineage();
    const occurrence = { ...f.operation.occurrence, task: { ...f.operation.occurrence.task,
      ownerId: "independent-owner", cryptoAccessRevision: 1 } };
    const stableIdentity = { ...f.plan.stableIdentity, ownerId: occurrence.task.ownerId };
    const plan = { occurrence, stableIdentity, initialRecord: { ...f.plan.replacement,
      idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity) } };
    expect(await f.run({ ...f.operation, occurrence, record: plan.initialRecord,
      resolvePlan: async () => plan })).toBe("unchanged");
    expect(f.events).toEqual([]);
    expect(f.f.access()).toBe(0);
    expect(await f.run({ ...f.operation, occurrence, record: f.plan.expected,
      resolvePlan: async () => plan })).toBe("unavailable");
    expect(f.events).toEqual([]);
  } finally { f.f.cleanup(); }
});
