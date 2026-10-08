import { expect, test } from "bun:test";

import type { ParkedProtectedTaskAdditionalAuthority } from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  domainForegroundNamespaceBindingSetDigest,
  humanId,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type { ParkedTaskRuntimeCurrentRoutingFacts } from
  "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ParkedTaskRuntimeExecutionStartInput,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import type { ParkedProtectedTaskRuntimeMemoryPlan } from
  "../../src/routes/protected-task-runtime-parked-memory-plan";
import type { ParkedTaskRuntimeAuthorizationPlan } from
  "../../src/routes/protected-task-runtime-parked-plan";
import {
  createProtectedTaskRuntimeParkedContinuation,
} from "../../src/routes/protected-task-runtime-parked-continuation";

const NOW = 1_900_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const PRIOR_JOB = "60000000-0000-4000-8000-000000000006";
const NEW_JOB = "61000000-0000-4000-8000-000000000006";
const CONTENT = "70000000-0000-4000-8000-000000000007";
const SOURCE = "80000000-0000-4000-8000-000000000008";
const TARGET = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const REQUEST = "task-run-authorization:v2:parked-continuation";
const INPUT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT = `task-run-result:v1:${"b".repeat(64)}`;
const FINGERPRINT = Buffer.alloc(32, 5).toString("base64url");

async function descriptor() {
  const crypto = new LatticeCrypto();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domain: DomainForegroundAuthorityEntry = {
    domainId: DOMAIN, sourceNamespaceId: CONTENT,
    participantDigest: new Uint8Array(32).fill(1), participantCount: 1,
    keyClass: "ai", domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: new Uint8Array(32).fill(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto,
      [{ namespaceId: CONTENT, bindingDigest: new Uint8Array(32).fill(3) }],
    ),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: REQUEST, policyRevision: 7, sessionId: "episode:parked",
    roomId: SOURCE, subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId("device:parked"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(4),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1, recipientKeyId: "recipient:parked",
    operations: ["decrypt", "encrypt"], issuedAt: NOW,
    deadlineAt: NOW + 60_000, maximumSecretBytes: 4_096, domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: REQUEST, workId: RUN, workKind: "task.execute",
    workPurpose: "task.execute", recipientGeneration: 1,
    episodeId: plan.sessionId, sourceRoomId: SOURCE,
    recipientKeyId: plan.recipientKeyId, recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  recipient.privateKey.fill(0);
  return encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
}

async function fixture() {
  const occurrence: ProtectedTaskOccurrence = {
    task: { id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
      callingRoomId: SOURCE, scheduleKind: "now",
      contentRepresentation: "dual", contentNamespaceId: CONTENT,
      contentRevision: 1, cryptoObjectId: INPUT, cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(4) },
    run: { id: RUN, taskId: TASK, jobId: PRIOR_JOB,
      graphThreadId: "task-thread", status: "awaiting",
      startedAt: new Date(NOW - 1_000) },
  };
  const expected = {
    occurrence,
    priorJob: { id: PRIOR_JOB, generation: 3, interrupts: [{ id: "interrupt:1" }],
      parkedAt: new Date(NOW - 500), reference: { resultObjectId: RESULT } },
    proof: {
      continuation: { interruptId: "interrupt:1", operationId: "operation:1",
        requestDigest: new Uint8Array(32).fill(1),
        requiredAuthorityDigest: new Uint8Array(32).fill(2),
        stableRoutingDigest: new Uint8Array(32).fill(3),
        semanticAuthorityRequirements: [] },
      segment: { expectedCheckpointCount: 2,
        checkpointDigest: new Uint8Array(32).fill(6),
        expectedCheckpointBlobCount: 3,
        checkpointBlobDigest: new Uint8Array(32).fill(7),
        expectedPendingWriteCount: 1,
        pendingWriteDigest: new Uint8Array(32).fill(8) },
    },
    authorizationRequestId: REQUEST,
    continuationFingerprint: FINGERPRINT,
    nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
  const memory: ParkedProtectedTaskRuntimeMemoryPlan = {
    routing: { taskId: TASK, taskRunId: RUN, requesterUserId: USER,
      requesterHumanId: HUMAN, agentId: AGENT, sourceRoomId: SOURCE,
      sourceNamespaceId: CONTENT, targetRoomId: TARGET, targetUserIds: [USER],
      memoryMode: "namespace", scopeId: null, targetChat: "new_in_namespace",
      wideBringBack: false, widePrivateNamespaceId: null,
      outputRoomId: SOURCE, outputNamespaceId: CONTENT },
    resolution: { mode: "namespace", authorityStatus: "exact",
      provenance: "target_users_namespace", envelope: { memoryMode: "namespace",
        ownerId: USER, actorId: HUMAN, agentId: AGENT, roomId: TARGET,
        readableNamespaces: [CONTENT], mutableNamespaces: [CONTENT],
        writableNamespaces: [CONTENT], toolPolicy: {} } },
  };
  const resolved = Object.freeze({ expected,
    output: { taskRunId: RUN, resultObjectId: RESULT,
      destinationRoomId: SOURCE, destinationNamespaceId: CONTENT },
    policy: { mode: "shadow_encryption" as const,
      shadowBehavior: "strict" as const, revision: 7 },
    memory,
    inventory: Object.freeze({ namespaceIds: Object.freeze([CONTENT]),
      operations: () => Object.freeze(["decrypt" as const, "encrypt" as const]) }),
    validateCurrentRouting: (_facts: ParkedTaskRuntimeCurrentRoutingFacts) => true,
  }) as unknown as ParkedTaskRuntimeAuthorizationPlan;
  const initialRecord = {
    snapshot: { formatVersion: 3, requestId: REQUEST, workId: RUN,
      state: "awaiting_recipient", requestRevision: 0 },
    idempotencyKey: "task-runtime-stable-v1:fixture",
    descriptorBytes: null,
    authoritySet: { namespaceRequirements: [], domainRequirements: [] },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const canonical = { stableIdentity: { taskId: TASK, taskRunId: RUN,
      executionSegment: 2, resumeContinuationFingerprint: FINGERPRINT },
    initialRecord, authority: { policyRevision: 7 }, scopeWorkIdentity: "scope" } as never;
  const selected = { ...initialRecord,
    snapshot: { ...initialRecord.snapshot, state: "grant_ready" as const,
      requestRevision: 2 },
    descriptorBytes: await descriptor(),
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const events: string[] = [];
  let ownerHeld = false;
  let poolOpen = false;
  const authority = {
    withPlan: async <Value>(operation: unknown,
      use: (held: never) => Promise<Value>): Promise<Value> => {
      events.push("owner");
      ownerHeld = true;
      try {
        expect(operation).toBeDefined();
        return await use({ resolved, canonical, persistJob: async () => {
          expect(ownerHeld).toBe(true);
          events.push("persist-held");
          return NEW_JOB;
        } } as never);
      } finally {
        ownerHeld = false;
        events.push("owner-close");
      }
    },
    claim: async () => null,
  };
  const repository = { get: async () => selected };
  const composition = createProtectedTaskRuntimeParkedContinuation({
    db: {} as never, restricted: {} as never, crypto: new LatticeCrypto(),
    serverScope: "https://server.example", resolver: {} as never,
    recipients: {} as never, repository: repository as never,
    withCurrentAuthority: async () => null,
    prepareExecution: async value => {
      expect(value.additionalAuthorityResume).toEqual({
        interruptId: "interrupt:1", authorizationRequestId: REQUEST,
        effectDisposition: "not_started_v1", operationId: "operation:1",
        requestDigest: new Uint8Array(32).fill(1),
        requiredAuthorityDigest: new Uint8Array(32).fill(2),
      });
      return ({
      executor: async function* () { yield* []; },
      openTransientInput: async () => ({ message: "opened" }),
    }); },
    publishResult: async () => {},
    createDedicatedPool: (() => {
      throw new Error("unused pool factory");
    }) as never,
    recoverUnstarted: async () => true,
    recoverClaim: async () => { events.push("recover-claim"); return true; },
    now: () => NOW,
  }, {
    resolvePlan: async () => resolved,
    authority: authority as never,
    readManifest: async () => {
      expect(ownerHeld).toBe(true);
      events.push("pool");
      poolOpen = true;
      try {
        return { contract: "encrypted_langgraph_v1" as const,
          expectedCheckpointCount: 2,
          checkpointOrderedDigest: new Uint8Array(32).fill(6),
          expectedBlobCount: 3,
          blobOrderedDigest: new Uint8Array(32).fill(7),
          expectedPendingWriteCount: 1,
          pendingWriteOrderedDigest: new Uint8Array(32).fill(8) };
      } finally {
        poolOpen = false;
        events.push("pool-close");
      }
    },
    start: async (_db, value) => {
      expect(ownerHeld).toBe(false);
      expect(poolOpen).toBe(false);
      events.push("db-start");
      expect(value.taskRunId).toBe(RUN);
      expect(value.priorJobId).toBe(PRIOR_JOB);
      expect(value.jobId).toBe(NEW_JOB);
      expect(value.jobReference.resumeContinuationFingerprint).toBe(FINGERPRINT);
      return { status: "started" as const };
    },
  });
  return { occurrence, selected, resolved, composition, events,
    setMissing: () => { repository.get = async () => null as never; } };
}

test("returns no plan and creates no Job when the prepared grant is missing", async () => {
  const f = await fixture();
  f.setMissing();
  expect(await f.composition.plan(f.occurrence)).toBeNull();
  expect(f.events).toEqual([]);
  expect(typeof f.composition.prepareOrClaimExact).toBe("function");
});

test("closes the held owner and fresh manifest pool before starting a new Job", async () => {
  const f = await fixture();
  const plan = await f.composition.plan(f.occurrence);
  if (plan === null) throw new Error("parked continuation plan missing");
  const claimed = { ...f.selected, snapshot: { ...f.selected.snapshot,
    state: "claimed" as const, claimId: "claim:parked" } };
  const reference = plan.reference;
  expect(reference.taskRunId).toBe(RUN);
  expect(reference.executionSegment).toBe(2);
  expect(reference.resumeContinuationFingerprint).toBe(FINGERPRINT);
  expect(await plan.start({ occurrence: f.occurrence, claimed,
    claimId: "claim:parked", jobId: NEW_JOB, reference } as
    ParkedTaskRuntimeExecutionStartInput)).toEqual({ status: "started" });
  expect(f.events).toEqual([
    "owner", "owner-close", "owner", "pool", "pool-close", "owner-close",
    "db-start",
  ]);
});

test.each([
  { resumeContinuationFingerprint: Buffer.alloc(32, 9).toString("base64url") },
  { policyRevision: 8 },
  { executionSegment: 3 },
  { authorizationRequestId: "different-request" },
  { inputObjectId: `task-definition:v1:${"c".repeat(64)}` },
])("rejects substituted continuation reference fields before manifest or DB start", async patch => {
  const f = await fixture();
  const plan = await f.composition.plan(f.occurrence);
  if (plan === null) throw new Error("parked continuation plan missing");
  const claimed = { ...f.selected, snapshot: { ...f.selected.snapshot,
    state: "claimed" as const, claimId: "claim:parked" } };
  expect(await plan.start({ occurrence: f.occurrence, claimed,
    claimId: "claim:parked", jobId: NEW_JOB, reference: { ...plan.reference, ...patch } } as
    ParkedTaskRuntimeExecutionStartInput)).toEqual({ status: "stale" });
  expect(f.events).toEqual(["owner", "owner-close"]);
});


test("persists under the exact claimed owner and recovers without a Job id", async () => {
  const f = await fixture();
  const plan = await f.composition.plan(f.occurrence);
  if (plan === null) throw new Error("parked continuation plan missing");
  const claimed = { ...f.selected, snapshot: { ...f.selected.snapshot,
    state: "claimed" as const, claimId: "claim:parked" } };
  const value = { occurrence: f.occurrence, claimed,
    claimId: "claim:parked", reference: plan.reference };
  expect(await plan.persistJob({ ...value, payload: {} as never })).toBe(NEW_JOB);
  expect(f.events).toEqual([
    "owner", "owner-close", "owner", "persist-held", "owner-close",
  ]);
  expect(await plan.recoverBeforeExecution(value)).toBe(true);
  expect(f.events.at(-1)).toBe("recover-claim");
  const failure = await plan.persistJob({ ...value, claimId: "substituted", payload: {} as never })
    .then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("stale");
});
