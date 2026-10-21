import { expect, test } from "bun:test";
import { LatticeCrypto, type DomainForegroundAuthorityEntry } from "@nautilo/lattice-crypto";
import { agentRuntimeObjectSignerKeyIdV1, parseDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import type { TaskOutputNamespaceAuthority } from "@nautilo/lattice-bridge/server";
import { buildUnclaimedTaskOutputReadAuthorityReplacement, sameTaskRuntimeAuthorityPlan, type TaskRuntimeRecipientCurrentAuthority } from "@nautilo/runtime";
import { createProtectedTaskOutputReadPlan } from "../../src/routes/protected-task-output-read-plan";
import type { ProtectedTaskOutputReadIntent } from "../../src/routes/protected-task-output-read-product";
const NOW = 1_800_500_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const USER = "30000000-0000-4000-8000-000000000001";
const HUMAN = "40000000-0000-4000-8000-000000000001";
const AGENT = "50000000-0000-4000-8000-000000000001";
const ROOM = "60000000-0000-4000-8000-000000000001";
const SESSION = "70000000-0000-4000-8000-000000000001";
const PRIVATE = "80000000-0000-4000-8000-000000000001";
const DESTINATION = "90000000-0000-4000-8000-000000000001";
const DOMAIN = "a0000000-0000-4000-8000-000000000001";
const JOB = "b0000000-0000-4000-8000-000000000001";
const DEVICE = "c0000000-0000-4000-8000-000000000001";
function fixture(wake = false, sameNamespace = false) {
  const resultObjectId = `task-run-result:v1:${"a".repeat(64)}`;
  const bindingId = `task-run-output:${RUN}`;
  const operationId = `task-run-delivery-${wake ? "wake" : "message"}:${RUN}`;
  const intent: ProtectedTaskOutputReadIntent = {
    requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
    contentNamespaceId: PRIVATE, representation: "protected", expectedPolicyRevision: 7, acceptedPolicyRevision: 6,
    initialState: wake ? "wake_queued" : "raw_unpublished",
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId: resultObjectId, cryptoAccessRevision: 0, genesisManifestHash: new Uint8Array(32).fill(1), signerAgentId: AGENT },
    invocation: wake ? { kind: "wake", bindingId, operationId, roomId: ROOM, sessionId: SESSION,
      jobId: JOB, reference: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN,
        bindingId, resultObjectId, wakeOperationId: operationId } }
      : { kind: "raw", bindingId, operationId, roomId: ROOM, sessionId: SESSION },
  };
  const resultFact = { namespaceId: PRIVATE, domainId: DOMAIN, expectedAccessRevision: 2,
    expectedPolicyRevision: 7, expectedDomainEpoch: 3, expectedAuthorizationRevision: 4 };
  const foregroundFact = sameNamespace ? resultFact : { ...resultFact, namespaceId: DESTINATION };
  const authority: TaskOutputNamespaceAuthority = { sourceRoomId: ROOM, sourceNamespaceId: PRIVATE,
    facts: sameNamespace ? [resultFact] : [resultFact, foregroundFact], resultFact, foregroundFacts: [foregroundFact] };
  const crypto = new LatticeCrypto();
  const build = () => createProtectedTaskOutputReadPlan({ intent, authority, crypto, now: NOW, recipientTtlMs: 60_000 });
  return { intent, authority, crypto, build };
}
for (const wake of [false, true]) {
  for (const sameNamespace of [false, true]) {
    test(`plans ${wake ? "wake" : "raw"} with same Namespace=${sameNamespace} and one shared Domain`, () => {
      const { build, crypto } = fixture(wake, sameNamespace); const plan = build();
      const namespaces = plan.initialRecord.authoritySet.namespaceRequirements;
      expect(plan.initialRecord.authoritySet.domainRequirements).toHaveLength(1);
      expect(namespaces).toHaveLength(sameNamespace ? 1 : 2);
      expect(namespaces[0]?.operations).toEqual(sameNamespace ? ["decrypt", "encrypt"] : ["decrypt"]);
      if (!sameNamespace) expect(namespaces[1]?.operations).toEqual(wake ? ["decrypt", "encrypt"] : ["encrypt"]);
      const record = plan.initialRecord;
      const attemptConfig = plan.recipientAttempt({ record, now: NOW });
      const pair = crypto.generateEncryptionKeyPair();
      const domain = { domainId: DOMAIN, sourceNamespaceId: PRIVATE,
        participantDigest: new Uint8Array(32).fill(2), participantCount: 1, keyClass: "ai",
        domainKeyGeneration: 3, authorizationRevision: 4, headDigest: new Uint8Array(32).fill(3),
        activeNamespaceBindingSetDigest: new Uint8Array(32).fill(4), activeNamespaceBindingCount: 2 } as DomainForegroundAuthorityEntry;
      const current: TaskRuntimeRecipientCurrentAuthority = { sourceRoomId: ROOM, policyRevision: 7,
        device: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 1,
          signingPublicKey: new Uint8Array(65).fill(5), serverInstanceId: "test-server", lineageGeneration: 1,
          epoch: 1, securityRevision: 1, headDigest: new Uint8Array(32).fill(6) },
        namespaceRequirements: namespaces, domains: [domain] };
      return Promise.resolve(pair).then(keys => {
        try {
          const request = plan.buildRequest({ record, binding: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
            authority: current, attempt: { ...attemptConfig, requestId: record.snapshot.requestId,
              workId: record.snapshot.workId, recipientGeneration: record.snapshot.recipientGeneration,
              recipientPublicKey: keys.publicKey, signer: Object.freeze({ agentId: AGENT,
                runtimeGeneration: 0 as const, signerPublicKey: new Uint8Array(32).fill(9),
                signerKeyId: agentRuntimeObjectSignerKeyIdV1(new LatticeCrypto(), new Uint8Array(32).fill(9)) }) } });
          expect(request.formatVersion).toBe(3);
          const grant = parseDomainForegroundAuthorizationPlanV2(request.baseRequest.authorizationPlanBytes);
          expect(grant?.sessionId).toBe(SESSION); expect(grant?.roomId).toBe(ROOM);
          expect(grant?.operations).toEqual(["decrypt", "encrypt"]);
          expect(request.work.kind).toBe(wake ? "task.delivery_wake" : "task.deliver_result");
          expect(request.baseRequest.workId).toBe(wake ? JOB : RUN);
        } finally { keys.privateKey.fill(0); keys.publicKey.fill(0); }
      });
    });
  }
}
test("policy renewal changes grant facts while retaining immutable result/invocation identity", () => {
  const value = fixture(); const first = value.build();
  const later = createProtectedTaskOutputReadPlan({ ...value, intent: { ...value.intent, expectedPolicyRevision: 8 },
    authority: { ...value.authority, facts: value.authority.facts.map(f => ({ ...f, expectedPolicyRevision: 8 })),
      resultFact: { ...value.authority.resultFact, expectedPolicyRevision: 8 },
      foregroundFacts: value.authority.foregroundFacts.map(f => ({ ...f, expectedPolicyRevision: 8 })) },
    now: NOW + 1, recipientTtlMs: 60_000 });
  expect(later.initialRecord.idempotencyKey).toBe(first.initialRecord.idempotencyKey);
  expect(later.initialRecord.workIdentityHash).not.toEqual(first.initialRecord.workIdentityHash);
});
test("Domain facts match the canonical PostgreSQL reconstruction without false replacement", () => {
  const plan = fixture().build();
  const record = plan.initialRecord;
  const roundTrip = { ...record, authoritySet: { ...record.authoritySet,
    domainRequirements: record.authoritySet.domainRequirements.map(d => ({ ordinal: d.ordinal,
      domainId: d.domainId, expectedEpoch: d.expectedEpoch,
      expectedAuthorizationRevision: d.expectedAuthorizationRevision })) } };
  expect(sameTaskRuntimeAuthorityPlan(roundTrip, record)).toBe(true);
});
test("foreign planning and Domain generation disagreement reject before recipient creation", () => {
  const value = fixture();
  expect(() => createProtectedTaskOutputReadPlan({ ...value, authority: { ...value.authority, sourceRoomId: TASK },
    now: NOW, recipientTtlMs: 60_000 })).toThrow();
  const facts = value.authority.facts.map((f, i) => ({ ...f, expectedDomainEpoch: i + 3 }));
  expect(() => createProtectedTaskOutputReadPlan({ ...value, authority: { ...value.authority, facts,
    resultFact: facts[0]!, foregroundFacts: [facts[1]!] }, now: NOW, recipientTtlMs: 60_000 })).toThrow();
});

test("wake plans keep a sealed additional destination encrypt-only and outside foreground", () => {
  const value = fixture(true);
  const namespace = { ...value.authority.resultFact,
    namespaceId: "a0000000-0000-4000-8000-000000000002" };
  const destination = { roomId: "60000000-0000-4000-8000-000000000002",
    namespaceId: namespace.namespaceId, semanticDigest: "ab".repeat(32) };
  const authority = { ...value.authority, facts: [...value.authority.facts, namespace],
    additionalMutationFact: { destination, namespace } };
  const build = (next: TaskOutputNamespaceAuthority = authority) => createProtectedTaskOutputReadPlan({ ...value,
    authority: next, now: NOW, recipientTtlMs: 60_000 });
  const plan = build();
  expect(plan.foregroundNamespaceIds).toEqual([DESTINATION]);
  expect(plan.additionalMutationDestination).toEqual(destination);
  expect(plan.initialRecord.authoritySet.namespaceRequirements.map(row => row.operations))
    .toEqual([["decrypt"], ["decrypt", "encrypt"], ["encrypt"]]);
  expect(plan.initialRecord.authoritySet.domainRequirements).toHaveLength(1);
  expect(build({ ...authority, additionalMutationFact: { ...authority.additionalMutationFact,
    destination: { ...destination, semanticDigest: "cd".repeat(32) } } })
    .initialRecord.workIdentityHash).not.toEqual(plan.initialRecord.workIdentityHash);
  expect(plan.initialRecord.idempotencyKey).toBe(value.build().initialRecord.idempotencyKey);
  expect(() => build({ ...authority, facts: value.authority.facts })).toThrow();
  expect(() => build({ ...authority, additionalMutationFact: { destination: {
    ...destination, namespaceId: PRIVATE }, namespace: value.authority.resultFact } })).toThrow();
  expect(() => createProtectedTaskOutputReadPlan({ ...value, intent: fixture().intent,
    authority, now: NOW, recipientTtlMs: 60_000 })).toThrow();
});


test.each([false, true])("mapped result head changes only fresh authority, wake=%s", wake => {
  const value = fixture(wake);
  const first = value.build();
  const next = createProtectedTaskOutputReadPlan({ ...value,
    intent: { ...value.intent, result: { ...value.intent.result, cryptoAccessRevision: 1 } },
    now: NOW + 1, recipientTtlMs: 60_000 });
  expect(next.initialRecord.idempotencyKey).toBe(first.initialRecord.idempotencyKey);
  expect(next.initialRecord.workIdentityHash).not.toEqual(first.initialRecord.workIdentityHash);
  const replacement = buildUnclaimedTaskOutputReadAuthorityReplacement({
    expected: first.initialRecord, replacement: next.initialRecord, now: NOW + 1 });
  expect(replacement.snapshot.recipientGeneration).toBe(first.initialRecord.snapshot.recipientGeneration + 1);
  expect(replacement.workIdentityHash).toEqual(next.initialRecord.workIdentityHash);
});
