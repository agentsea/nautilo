import { expect, test } from "bun:test";

import type { ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import { agentRuntimeObjectSignerKeyIdV1, parseDomainForegroundAuthorizationPlanV2 } from
  "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { InitialTaskRuntimeNamespaceAuthority } from
  "@nautilo/lattice-bridge/server";
import {
  createProtectedTaskCancellationPlan,
  protectedTaskCancellationRequestId,
} from "../../src/routes/protected-task-cancellation-plan";

const NOW = 1_800_500_000_000;
const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const ROOM = "60000000-0000-4000-8000-000000000006";
const DEVICE = "70000000-0000-4000-8000-000000000007";
const NAMESPACE = "80000000-0000-4000-8000-000000000008";
const DOMAIN = "90000000-0000-4000-8000-000000000009";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function cancellationIntent(
  patch: Partial<ProtectedTaskCancellationOutputIntent> = {},
): ProtectedTaskCancellationOutputIntent {
  return {
    taskId: TASK,
    taskRunId: RUN,
    requesterUserId: REQUESTER,
    agentId: AGENT,
    contentNamespaceId: NAMESPACE,
    representation: "protected",
    resultRevision: 2,
    resultOperationId: `task-run-cancelled-result:${RUN}`,
    resultObjectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 2,
    }),
    policyRevision: 7,
    taskStatus: "cancelled",
    runStatus: "cancelled",
    terminalAt: new Date(NOW - 1_000),
    ...patch,
  };
}

function namespaceAuthority(): {
  sourceRoomId: string;
  sourceNamespaceId: string;
  facts: Array<{
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    expectedDomainEpoch: number;
    expectedAuthorizationRevision: number;
  }>;
} {
  return {
    sourceRoomId: ROOM,
    sourceNamespaceId: NAMESPACE,
    facts: [{
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      expectedAccessRevision: 3,
      expectedPolicyRevision: 7,
      expectedDomainEpoch: 5,
      expectedAuthorizationRevision: 11,
    }],
  };
}

function currentDomain(
  patch: Partial<DomainForegroundAuthorityEntry> = {},
): DomainForegroundAuthorityEntry {
  return Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 5,
    authorizationRevision: authorizationRevision(11),
    headDigest: bytes(2),
    activeNamespaceBindingSetDigest: bytes(3),
    activeNamespaceBindingCount: 1,
    ...patch,
  });
}

function buildRequest(
  plan: ReturnType<typeof createProtectedTaskCancellationPlan>,
  authorityPatch: Readonly<Record<string, unknown>> = {},
) {
  const crypto = new LatticeCrypto();
  const signerPublicKey = new Uint8Array(32).fill(9);
  const recipient = plan.recipientAttempt({ record: plan.initialRecord, now: NOW });
  const attempt = Object.freeze({
    requestId: plan.initialRecord.snapshot.requestId,
    workId: RUN,
    recipientGeneration: plan.initialRecord.snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(4),
    expiresAt: recipient.expiresAt,
    signer: Object.freeze({ agentId: AGENT, runtimeGeneration: 0 as const,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signerPublicKey), signerPublicKey }),
  });
  return {
    recipient,
    request: plan.buildRequest({
      record: plan.initialRecord,
      attempt,
      binding: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE },
      authority: {
        device: {
          userId: REQUESTER,
          humanActorId: HUMAN,
          deviceId: DEVICE,
          deviceGeneration: 2,
          signingPublicKey: new Uint8Array(65).fill(5),
          serverInstanceId: "test-server",
          lineageGeneration: 1,
          epoch: 2,
          securityRevision: 3,
          headDigest: bytes(6),
        } as never,
        sourceRoomId: ROOM,
        policyRevision: 7,
        namespaceRequirements:
          plan.initialRecord.authoritySet.namespaceRequirements,
        domains: Object.freeze([currentDomain()]),
        ...authorityPatch,
      },
    }),
  };
}

test("builds a fresh cancellation request with encrypt-only authority", () => {
  const plan = createProtectedTaskCancellationPlan({
    intent: cancellationIntent(),
    namespaceAuthority: namespaceAuthority(),
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });

  expect(plan.initialRecord).toMatchObject({
    workKind: "task.cancel_result",
    purpose: "task.cancel_result",
    expectedPolicyRevision: 7,
    domainId: DOMAIN,
  });
  expect(plan.initialRecord.snapshot).toMatchObject({
    requestId: protectedTaskCancellationRequestId(RUN),
    workId: RUN,
    namespaceId: NAMESPACE,
    recipientGeneration: 0,
  });
  expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([{
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: ["encrypt"],
    expectedAccessRevision: 3,
    expectedPolicyRevision: 7,
  }]);
  expect(plan.initialRecord.idempotencyKey).toMatch(/^task-cancellation:/u);

  const { recipient, request } = buildRequest(plan);
  expect(recipient.recipientKeyId).toBe(`task-cancellation-runtime:${RUN}:0`);
  expect(request.formatVersion).toBe(3);
  const authorization = parseDomainForegroundAuthorizationPlanV2(
    request.baseRequest.authorizationPlanBytes,
  );
  expect(authorization).toMatchObject({
    authorizationId: protectedTaskCancellationRequestId(RUN),
    sessionId: `task-run:${RUN}`,
    roomId: ROOM,
    recipientKeyId: recipient.recipientKeyId,
    operations: ["encrypt"],
    domainCount: 1,
  });
  expect(request.baseRequest).toMatchObject({
    requestId: protectedTaskCancellationRequestId(RUN),
    workId: RUN,
    workKind: "task.cancel_result",
    workPurpose: "task.cancel_result",
  });
  expect(request.work).toMatchObject({ kind: "task.cancel_result", taskId: TASK,
    taskRunId: RUN, contentRevision: 2 });
});

test("rejects every changed stopped-result coordinate", () => {
  const exact = cancellationIntent();
  const changed: ProtectedTaskCancellationOutputIntent[] = [
    { ...exact, taskStatus: "running" as never },
    { ...exact, runStatus: "completed" as never },
    { ...exact, resultRevision: 1 as never },
    { ...exact, resultOperationId: `task-run-cancelled-result:other` },
    { ...exact, resultObjectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 1,
    }) },
    { ...exact, terminalAt: new Date(NOW + 1) },
  ];
  for (const intent of changed) {
    expect(() => createProtectedTaskCancellationPlan({
      intent,
      namespaceAuthority: namespaceAuthority(),
      crypto: new LatticeCrypto(),
      now: NOW,
      recipientTtlMs: 60_000,
    })).toThrow("stopped intent");
  }
});

test("rejects mismatched policy, namespace, and live Domain authority", () => {
  const exact = cancellationIntent();
  for (const authority of [
    { ...namespaceAuthority(), sourceNamespaceId: "other" },
    { ...namespaceAuthority(), facts: [{
      ...namespaceAuthority().facts[0]!, namespaceId: "other",
    }] },
    { ...namespaceAuthority(), facts: [{
      ...namespaceAuthority().facts[0]!, expectedPolicyRevision: 8,
    }] },
  ] satisfies InitialTaskRuntimeNamespaceAuthority[]) {
    expect(() => createProtectedTaskCancellationPlan({
      intent: exact,
      namespaceAuthority: authority,
      crypto: new LatticeCrypto(),
      now: NOW,
      recipientTtlMs: 60_000,
    })).toThrow("stopped intent");
  }

  const plan = createProtectedTaskCancellationPlan({
    intent: exact,
    namespaceAuthority: namespaceAuthority(),
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });
  for (const patch of [
    { policyRevision: 8 },
    { namespaceRequirements: [{
      ...plan.initialRecord.authoritySet.namespaceRequirements[0]!,
      namespaceId: "other",
    }] },
    { domains: [currentDomain({ domainId: "other" })] },
  ]) {
    expect(() => buildRequest(plan, patch)).toThrow("request authority is not exact");
  }
});

test("copies stopped intent and authority inputs before exposing request builders", () => {
  const terminalAt = new Date(NOW - 1_000);
  const intent = cancellationIntent({ terminalAt });
  const authority = namespaceAuthority();
  const plan = createProtectedTaskCancellationPlan({
    intent,
    namespaceAuthority: authority,
    crypto: new LatticeCrypto(),
    now: NOW,
    recipientTtlMs: 60_000,
  });

  terminalAt.setTime(NOW + 10_000);
  authority.sourceRoomId = "other";
  authority.sourceNamespaceId = "other";
  authority.facts[0]!.namespaceId = "other";
  authority.facts[0]!.domainId = "other";
  authority.facts[0]!.expectedAccessRevision = 99;

  expect(plan.intent.terminalAt.getTime()).toBe(NOW - 1_000);
  expect(plan.sourceRoomId).toBe(ROOM);
  expect(plan.initialRecord.authoritySet.namespaceRequirements).toEqual([{
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: ["encrypt"],
    expectedAccessRevision: 3,
    expectedPolicyRevision: 7,
  }]);
  expect(() => buildRequest(plan)).not.toThrow();
});
