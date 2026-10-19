import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import type { ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/background";
import { agentRuntimeObjectSignerKeyIdV1,
  parseDomainForegroundAuthorizationPlanV2 } from
  "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { CurrentTaskRuntimeAuthority } from "@nautilo/lattice-bridge/server";
import {
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import {
  createProtectedTaskCancellationClaim,
  type ProtectedTaskCancellationClaimDependencies,
} from "../../src/routes/protected-task-cancellation-claim";
import type { ProtectedTaskCancellationAuthorityPort } from
  "../../src/routes/protected-task-cancellation-authority";
import { createProtectedTaskCancellationPlan } from
  "../../src/routes/protected-task-cancellation-plan";

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
const CLAIM = "a0000000-0000-4000-8000-00000000000a";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function domain(): DomainForegroundAuthorityEntry {
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
  });
}

function intent(): ProtectedTaskCancellationOutputIntent {
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
      kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 2,
    }),
    policyRevision: 7,
    taskStatus: "cancelled",
    runStatus: "cancelled",
    terminalAt: new Date(NOW - 1_000),
  };
}

function fixture(options: Readonly<{
  clock?: () => number;
  denyDevice?: boolean;
  failCasState?: "grant_ready" | "claimed" | "running";
  publicationError?: Error;
  registryUnavailable?: boolean;
  mutateClaimBeforePublication?: boolean;
}> = {}) {
  const crypto = new LatticeCrypto();
  const plan = createProtectedTaskCancellationPlan({
    intent: intent(),
    namespaceAuthority: {
      sourceRoomId: ROOM,
      sourceNamespaceId: NAMESPACE,
      facts: [{ namespaceId: NAMESPACE, domainId: DOMAIN,
        expectedAccessRevision: 3, expectedPolicyRevision: 7,
        expectedDomainEpoch: 5, expectedAuthorizationRevision: 11 }],
    },
    crypto,
    now: NOW,
    recipientTtlMs: 60_000,
  });
  const recipientPublicKey = new Uint8Array(65).fill(4);
  const currentDomain = domain();
  const signer = crypto.generateSigningKeyPair();
  const request = plan.buildRequest({
    record: plan.initialRecord,
    attempt: {
      requestId: plan.initialRecord.snapshot.requestId,
      workId: RUN,
      recipientGeneration: 0,
      recipientKeyId: `task-cancellation-runtime:${RUN}:0`,
      recipientPublicKey,
      expiresAt: NOW + 60_000,
      signer: { agentId: AGENT, runtimeGeneration: 0,
        signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
        signerPublicKey: signer.publicKey },
    },
    binding: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE },
    authority: {
      device: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE,
        deviceGeneration: 2, securityRevision: 3,
        signingPublicKey: bytes(12),
        serverInstanceId: "b0000000-0000-4000-8000-00000000000b",
        lineageGeneration: 1, epoch: 1, headDigest: bytes(13) } as never,
      sourceRoomId: ROOM,
      policyRevision: 7,
      namespaceRequirements: plan.initialRecord.authoritySet.namespaceRequirements,
      domains: [currentDomain],
    },
  });
  signer.privateKey.fill(0);
  signer.publicKey.fill(0);
  const baseRequest = request.baseRequest;
  const foreground = parseDomainForegroundAuthorizationPlanV2(
    baseRequest.authorizationPlanBytes,
  );
  if (foreground === null) throw new Error("fixture foreground plan is invalid");
  const authorizationBytes = bytes(7);
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes, certificateBytes: bytes(6),
  });
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const selected: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.initialRecord,
    snapshot: {
      ...plan.initialRecord.snapshot,
      state: "grant_ready",
      requestRevision: 2,
      updatedAt: NOW,
      descriptorDigest: createHash("sha256").update(descriptorBytes).digest("hex"),
      recipient: {
        recipientKeyId: baseRequest.recipientKeyId,
        recipientPublicKey: Buffer.from(recipientPublicKey).toString("base64url"),
        expiresAt: baseRequest.deadlineAt,
      },
      acceptedResponse: {
        kind: "runtime",
        responseDigest: createHash("sha256").update(responseBytes).digest("hex"),
        credentialDigest: "33".repeat(32),
        issuingHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        recipientGeneration: 0,
        acceptedAt: NOW,
      },
    },
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: baseRequest.requestId,
      issuingDeviceAuthorizationRevision: authorizationRevision(3),
      issuerSigningPublicKeyHash: bytes(8),
      authorizationExpiresAt: NOW + 60_000,
    },
  };
  const currentAuthority: CurrentTaskRuntimeAuthority = {
    device: {
      userId: REQUESTER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
      deviceGeneration: 2,
      serverInstanceId: "b0000000-0000-4000-8000-00000000000b",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: 3,
      headDigest: bytes(9),
      signingPublicKey: bytes(10),
    },
    plan: foreground,
    domains: [currentDomain],
    namespaceRequirements: selected.authoritySet.namespaceRequirements,
    policyRevision: 7,
  };
  const events: string[] = [];
  const state: { record: BackgroundAuthorizationRecord; inAuthority: boolean;
    accepted: Uint8Array | null; publicSigning: Uint8Array | null;
    publicParticipant: Uint8Array | null } = {
    record: selected,
    inAuthority: false,
    accepted: null,
    publicSigning: null,
    publicParticipant: null,
  };
  const repository = {
    get: async (requestId: string) => {
      expect(requestId).toBe(selected.snapshot.requestId);
      return state.record;
    },
    compareAndSwap: async (input: Readonly<{
      expectedRequestRevision: number;
      next: BackgroundAuthorizationRecord;
    }>) => {
      events.push(`cas:${input.next.snapshot.state}`);
      if (options.failCasState === input.next.snapshot.state
        || state.record.snapshot.requestRevision !== input.expectedRequestRevision) {
        return { status: "stale" as const, current: state.record };
      }
      state.record = input.next;
      return { status: "updated" as const, record: input.next };
    },
  };
  const authority: ProtectedTaskCancellationAuthorityPort = {
    withDiscovery: async () => { throw new Error("unexpected discovery"); },
    withBound: async () => { throw new Error("unexpected bound authority"); },
    withAccepted: async operation => {
      events.push("authority:enter");
      state.accepted = operation.accepted.authorizationBytes;
      if (options.denyDevice) {
        events.push("authority:deny");
        return null;
      }
      expect(operation.subject).toEqual({
        userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE,
      });
      state.inAuthority = true;
      try {
        const value = await operation.use(
          currentAuthority,
          {} as never,
          {} as never,
          {} as never,
        );
        await operation.validateBeforeCommit();
        return value;
      } finally {
        state.inAuthority = false;
        events.push("authority:exit");
      }
    },
  };
  let publicationCalls = 0;
  let registryCalls = 0;
  let deletes = 0;
  const dependencies: ProtectedTaskCancellationClaimDependencies = {
    authority,
    repository: async () => repository,
    now: options.clock ?? (() => NOW + 1),
    claimId: () => CLAIM,
    publish: async publication => {
      events.push("publish");
      expect(state.inAuthority).toBe(false);
      publicationCalls += 1;
      expect(publication.plan).toBe(plan);
      expect(publication.record.snapshot.state).toBe("running");
      expect(publication.record.snapshot.claimId).toBe(CLAIM);
      if (options.mutateClaimBeforePublication) {
        state.record = {
          ...state.record,
          snapshot: {
            ...state.record.snapshot,
            recipientGeneration: state.record.snapshot.recipientGeneration + 1,
            requestRevision: state.record.snapshot.requestRevision + 1,
          },
        };
      }
      await publication.assertCurrentClaim();
      if (options.publicationError !== undefined) throw options.publicationError;
    },
    recipients: {
      withOpenedCancellationResultGrant: async operation => {
        events.push("registry");
        expect(state.inAuthority).toBe(false);
        registryCalls += 1;
        expect(operation.claimId).toBe(CLAIM);
        expect(operation.result).toMatchObject({
          taskId: TASK,
          taskRunId: RUN,
          contentRevision: 2,
          objectId: plan.intent.resultObjectId,
          signerAgentId: AGENT,
          namespace: { namespaceId: NAMESPACE, domainId: DOMAIN,
            operations: ["encrypt"], expectedAccessRevision: 3,
            expectedPolicyRevision: 7 },
        });
        expect(operation.certifiedSigning?.expectedPublication).toMatchObject({
          kind: "task.cancel_result", taskId: TASK, taskRunId: RUN,
          contentRevision: 2,
        });
        expect(operation.certifiedSigning?.expectedPublication.workIdentityHash)
          .toEqual(plan.initialRecord.workIdentityHash);
        state.publicSigning = operation.current.committerDeviceSigningPublicKey;
        state.publicParticipant = operation.current.domains[0]!.participantDigest;
        if (options.registryUnavailable) {
          return { status: "unavailable" as const, reason: "recipient_unavailable" };
        }
        const value = await operation.operation(
          [],
          new AbortController().signal,
          {} as never,
        );
        return { status: "opened" as const, value };
      },
      delete: (requestId, generation) => {
        events.push("delete");
        expect(requestId).toBe(selected.snapshot.requestId);
        expect(generation).toBe(0);
        deletes += 1;
        return true;
      },
    },
  };
  const claim = createProtectedTaskCancellationClaim(dependencies);
  return { claim, plan, selected, state, events, currentAuthority,
    publicationCalls: () => publicationCalls,
    registryCalls: () => registryCalls,
    deletes: () => deletes };
}

test("claims, starts, publishes after lock release, then completes and releases custody", async () => {
  const value = fixture();
  const completed = await value.claim({
    plan: value.plan,
    record: value.selected,
    restricted: {} as never,
    signal: new AbortController().signal,
  });
  expect(completed?.snapshot.state).toBe("completed");
  expect(completed?.finishedAt).toBe(NOW + 1);
  expect(value.events).toEqual([
    "authority:enter",
    "cas:claimed",
    "cas:running",
    "authority:exit",
    "registry",
    "publish",
    "cas:completed",
    "delete",
  ]);
  expect(value.publicationCalls()).toBe(1);
  expect(value.registryCalls()).toBe(1);
  expect(value.deletes()).toBe(1);
  expect(value.selected.snapshot.state).toBe("grant_ready");
  expect(value.state.accepted).not.toBeNull();
  expect(value.state.accepted?.every(byte => byte === 0)).toBe(true);
  expect(value.state.publicSigning?.every(byte => byte === 0)).toBe(true);
  expect(value.state.publicParticipant?.every(byte => byte === 0)).toBe(true);
  expect(value.currentAuthority.device.signingPublicKey.every(byte => byte === 10)).toBe(true);
});

test("rejects a stale selected record, expired lease, and denied device before claim", async () => {
  const stale = fixture();
  stale.state.record = {
    ...stale.selected,
    snapshot: { ...stale.selected.snapshot, requestRevision: 3 },
  };
  expect(await stale.claim({ plan: stale.plan, record: stale.selected,
    restricted: {} as never, signal: new AbortController().signal })).toBeNull();
  expect(stale.events).toEqual(["authority:enter", "authority:exit"]);
  expect(stale.registryCalls()).toBe(0);

  const expired = fixture({ clock: () => NOW + 60_000 });
  expect(await expired.claim({ plan: expired.plan, record: expired.selected,
    restricted: {} as never, signal: new AbortController().signal })).toBeNull();
  expect(expired.events).toEqual(["authority:enter", "authority:exit"]);

  const denied = fixture({ denyDevice: true });
  expect(await denied.claim({ plan: denied.plan, record: denied.selected,
    restricted: {} as never, signal: new AbortController().signal })).toBeNull();
  expect(denied.events).toEqual(["authority:enter", "authority:deny"]);
});

test("a clock before signed issuance waits without consuming custody, then retries with the current clock", async () => {
  let currentTime = NOW - 1;
  const value = fixture({ clock: () => currentTime });
  const input = { plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal };
  expect(await value.claim(input)).toBeNull();
  expect(value.events).toEqual(["authority:enter", "authority:exit"]);
  expect(value.state.record.snapshot.state).toBe("grant_ready");
  expect(value.registryCalls()).toBe(0);
  expect(value.publicationCalls()).toBe(0);
  expect(value.deletes()).toBe(0);

  currentTime = NOW + 1;
  expect((await value.claim(input))?.snapshot.state).toBe("completed");
  expect(value.registryCalls()).toBe(1);
  expect(value.publicationCalls()).toBe(1);
  expect(value.deletes()).toBe(1);
});

test("a claim race does not open or publish", async () => {
  const value = fixture({ failCasState: "claimed" });
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })).toBeNull();
  expect(value.events).toEqual([
    "authority:enter", "cas:claimed", "authority:exit",
  ]);
  expect(value.registryCalls()).toBe(0);
  expect(value.publicationCalls()).toBe(0);
});

test("a start race leaves the durable claim for recovery and never opens", async () => {
  const value = fixture({ failCasState: "running" });
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })
    .catch((error: unknown) => error)).toMatchObject({
    message: "Cancellation result start could not be recorded",
  });
  expect(value.state.record.snapshot.state).toBe("claimed");
  expect(value.registryCalls()).toBe(0);
  expect(value.deletes()).toBe(0);
});

test("publication failure leaves running state and cannot reclaim the same grant", async () => {
  const value = fixture({ publicationError: new Error("publication failed") });
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })
    .catch((error: unknown) => error)).toEqual(new Error("publication failed"));
  expect(value.state.record.snapshot.state).toBe("running");
  expect(value.publicationCalls()).toBe(1);
  expect(value.deletes()).toBe(0);
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })).toBeNull();
  expect(value.publicationCalls()).toBe(1);
});

test("an unavailable opened grant leaves running state for recovery", async () => {
  const value = fixture({ registryUnavailable: true });
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })
    .catch((error: unknown) => error)).toMatchObject({
    message: "Task publication authorization could not be opened",
  });
  expect(value.state.record.snapshot.state).toBe("running");
  expect(value.publicationCalls()).toBe(0);
  expect(value.deletes()).toBe(0);
});

test("the publication fence rejects a changed claim revision or generation", async () => {
  const value = fixture({ mutateClaimBeforePublication: true });
  expect(await value.claim({ plan: value.plan, record: value.selected,
    restricted: {} as never, signal: new AbortController().signal })
    .catch((error: unknown) => error)).toMatchObject({
    message: "Cancellation result claim is no longer current",
  });
  expect(value.state.record.snapshot.state).toBe("running");
  expect(value.publicationCalls()).toBe(1);
  expect(value.deletes()).toBe(0);
});


test("fixed cancellation claims still reject a merged decrypt-and-encrypt authority", async () => {
  const value = fixture();
  const expanded = {
    ...value.selected,
    authoritySet: { ...value.selected.authoritySet,
      namespaceRequirements: value.selected.authoritySet.namespaceRequirements.map(n => ({
        ...n, operations: ["decrypt", "encrypt"] as const,
      })),
    },
  };
  expect(await value.claim({
    plan: { ...value.plan, initialRecord: { ...value.plan.initialRecord, authoritySet: expanded.authoritySet } },
    record: expanded, restricted: {} as never, signal: new AbortController().signal,
  }).catch((error: unknown) => error)).toBeInstanceOf(TypeError);
  expect(value.events).toEqual([]);
  expect(value.registryCalls()).toBe(0);
});
