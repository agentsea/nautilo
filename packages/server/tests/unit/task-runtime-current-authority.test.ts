import { describe, expect, test } from "bun:test";

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
import type {
  CurrentTaskRuntimeAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  withCurrentAcceptedTaskRuntimeAuthority,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";

import {
  createCurrentProtectedTaskRuntimeAuthorityPort,
  loadCurrentProtectedTaskRuntimeFacts,
  type CurrentProtectedTaskRuntimeFacts,
} from "../../src/routes/task-runtime-current-authority";

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const now = 2_100_000_000_000;
  const domain: DomainForegroundAuthorityEntry = {
    domainId: "domain:task",
    sourceNamespaceId: "namespace:task",
    participantDigest: new Uint8Array(32).fill(1),
    participantCount: 1,
    keyClass: "ai",
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: new Uint8Array(32).fill(2),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(
      crypto,
      [{namespaceId: "namespace:task", bindingDigest: new Uint8Array(32).fill(4)}],
    ),
    activeNamespaceBindingCount: 1,
  };
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "request:task",
    policyRevision: 7,
    sessionId: "episode:task",
    roomId: "room:private",
    subjectHumanId: humanId("human:requestor"),
    committerDeviceId: cryptoDeviceId("device:requestor"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1,
    recipientKeyId: "recipient:task",
    operations: ["decrypt", "encrypt"],
    issuedAt: now,
    deadlineAt: now + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId,
    workId: "run:task",
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 1,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const fingerprint = new Uint8Array(32).fill(9);
  const occurrence: ProtectedTaskOccurrence = {
    task: {
      id: "task:protected",
      ownerId: "user:owner",
      requestorId: "user:requestor",
      agentId: "agent:task",
      callingRoomId: null,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: "namespace:task",
      contentRevision: 1,
      cryptoObjectId: "task-definition:v1:" + "a".repeat(64),
      cryptoAccessRevision: 2,
      cryptoRequiredNamespaceFingerprint: fingerprint,
    },
    run: {
      id: request.workId,
      taskId: "task:protected",
      jobId: null,
      graphThreadId: "thread:task",
      status: "awaiting",
      startedAt: new Date(now - 1_000),
    },
  };
  const facts: CurrentProtectedTaskRuntimeFacts = {
    task: {
      ...occurrence.task,
      status: "running",
      cryptoRequiredNamespaceFingerprint: fingerprint.slice(),
      cryptoMappingState: "verified",
    },
    run: {
      id: occurrence.run.id,
      taskId: occurrence.task.id,
      jobId: "job:task",
      graphThreadId: occurrence.run.graphThreadId,
      status: "running",
      resultRepresentation: "ordinary",
      resultContentNamespaceId: null,
      resultRevision: 0,
      resultCryptoObjectId: null,
      resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: null,
      resultCryptoMappingState: "unmapped",
    },
    requesterPrivateRoom: {
      roomId: request.sourceRoomId,
      namespaceId: occurrence.task.contentNamespaceId,
    },
    nativeExecutionSupported: true,
  };
  const record = {
    snapshot: {
      formatVersion: 3,
      credentialSubject: {kind: "runtime", runtimeKind: "task", runtimeVersion: 1},
      requestId: request.requestId,
      workId: request.workId,
      state: "claimed",
      descriptorDigest: "11".repeat(32),
      recipientGeneration: request.recipientGeneration,
      recipient: {
        recipientKeyId: request.recipientKeyId,
        recipientPublicKey: Buffer.from(request.recipientPublicKey).toString("base64url"),
        expiresAt: request.deadlineAt,
      },
      acceptedResponse: {
        kind: "runtime",
        responseDigest: "22".repeat(32),
        credentialDigest: "22".repeat(32),
        issuingHumanId: plan.subjectHumanId,
        issuingDeviceId: plan.committerDeviceId,
        recipientGeneration: request.recipientGeneration,
        acceptedAt: now,
      },
    },
    descriptorBytes,
    workKind: request.workKind,
    purpose: request.workPurpose,
    expectedPolicyRevision: plan.policyRevision,
    authoritySet: {
      namespaceRequirements: [{ordinal: 0, namespaceId: "namespace:task",
        domainId: domain.domainId, operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 2, expectedPolicyRevision: plan.policyRevision}],
      domainRequirements: [{ordinal: 0, domainId: domain.domainId,
        expectedEpoch: domain.domainKeyGeneration,
        expectedAuthorizationRevision: domain.authorizationRevision}],
    },
    acceptedMaterial: {
      responseBytes: new Uint8Array([1, 2, 3]),
      credentialId: plan.authorizationId,
      issuingDeviceAuthorizationRevision: plan.hostAuthorizationRevision,
      issuerSigningPublicKeyHash: crypto.hash(signing.publicKey),
      authorizationExpiresAt: plan.deadlineAt,
    },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const runningOccurrence: ProtectedTaskRunningOccurrence = {
    task: occurrence.task,
    run: {
      ...occurrence.run,
      jobId: "job:task",
      status: "running",
    },
  };
  const authority: CurrentTaskRuntimeAuthority = {
    device: {
      userId: occurrence.task.requestorId,
      humanActorId: plan.subjectHumanId,
      deviceId: plan.committerDeviceId,
      deviceGeneration: plan.committerDeviceSigningGeneration,
      serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: plan.hostAuthorizationRevision,
      headDigest: new Uint8Array(32),
      signingPublicKey: signing.publicKey,
    },
    plan,
    domains: [domain],
    namespaceRequirements: record.authoritySet.namespaceRequirements,
    policyRevision: plan.policyRevision,
  };
  recipient.privateKey.fill(0);
  return {crypto, signing, now, occurrence, runningOccurrence, facts, record,
    request, authority};
}

describe("current protected Task Runtime authority adapter", () => {
  test("rechecks an accepted awaiting run before claim", async () => {
    const f = await fixture();
    const port = createCurrentProtectedTaskRuntimeAuthorityPort({
      loadCurrentFacts: async () => ({
        ...f.facts,
        task: { ...f.facts.task, status: "pending" },
        run: { ...f.facts.run, status: "awaiting", jobId: null },
      }),
      withAcceptedAuthority: (async (input: Parameters<
        typeof withCurrentAcceptedTaskRuntimeAuthority>[0]) => input.use(
        f.authority,
        {} as never,
        {} as never,
      )) as typeof withCurrentAcceptedTaskRuntimeAuthority,
    });
    const result = await port({
      runner: {} as never,
      restricted: {} as never,
      crypto: f.crypto,
      serverScope: "https://nautilo.example",
      subject: {userId: f.occurrence.task.requestorId,
        humanActorId: f.authority.plan.subjectHumanId,
        deviceId: f.authority.plan.committerDeviceId},
      occurrence: f.occurrence,
      record: {...f.record, snapshot: {...f.record.snapshot,
        state: "grant_ready"}},
      request: f.request,
      now: () => f.now,
      use: () => "awaiting",
    });
    expect(result).toBe("awaiting");
    f.signing.privateKey.fill(0);
  });

  test("rechecks closed current facts under accepted authority and releases locks before use", async () => {
    const f = await fixture();
    const occurrence: ProtectedTaskRunningOccurrence = {
      ...f.runningOccurrence,
      task: { ...f.runningOccurrence.task, callingRoomId: "room:open" },
    };
    let insideAuthority = false;
    let loaded = 0;
    const port = createCurrentProtectedTaskRuntimeAuthorityPort({
      loadCurrentFacts: async () => {
        loaded++;
        return {
          ...f.facts,
          task: { ...f.facts.task, callingRoomId: "room:open" },
        };
      },
      withAcceptedAuthority: (async (input: Parameters<
        typeof withCurrentAcceptedTaskRuntimeAuthority>[0]) => {
        insideAuthority = true;
        try {
          return await input.use(f.authority, {} as never, {} as never);
        } finally {insideAuthority = false;}
      }) as typeof withCurrentAcceptedTaskRuntimeAuthority,
    });
    const result = await port({
      runner: {} as never,
      restricted: {} as never,
      crypto: f.crypto,
      serverScope: "https://nautilo.example",
      subject: {userId: f.occurrence.task.requestorId,
        humanActorId: f.authority.plan.subjectHumanId,
        deviceId: f.authority.plan.committerDeviceId},
      occurrence,
      record: f.record,
      request: f.request,
      now: () => f.now,
      use: current => {
        expect(insideAuthority).toBe(false);
        expect(current.foreground.authorizationId).toBe(f.request.requestId);
        expect(current.foreground.roomId).toBe(f.request.sourceRoomId);
        expect(current.namespaceRequirements).toEqual(
          f.record.authoritySet.namespaceRequirements,
        );
        expect(current.nativeExecutionSupported).toBe(true);
        return "current";
      },
    });
    expect(result).toBe("current");
    expect(loaded).toBe(1);
    f.signing.privateKey.fill(0);
  });

  test("accepts current running cron authority with a pending parent Task", async () => {
    const f = await fixture();
    const occurrence: ProtectedTaskRunningOccurrence = {
      ...f.runningOccurrence,
      task: { ...f.runningOccurrence.task, scheduleKind: "cron" },
    };
    const port = createCurrentProtectedTaskRuntimeAuthorityPort({
      loadCurrentFacts: async () => ({
        ...f.facts,
        task: { ...f.facts.task, scheduleKind: "cron", status: "pending" },
      }),
      withAcceptedAuthority: (async (input: Parameters<
        typeof withCurrentAcceptedTaskRuntimeAuthority>[0]) => input.use(
        f.authority,
        {} as never,
        {} as never,
      )) as typeof withCurrentAcceptedTaskRuntimeAuthority,
    });
    const result = await port({
      runner: {} as never,
      restricted: {} as never,
      crypto: f.crypto,
      serverScope: "https://nautilo.example",
      subject: {userId: occurrence.task.requestorId,
        humanActorId: f.authority.plan.subjectHumanId,
        deviceId: f.authority.plan.committerDeviceId},
      occurrence,
      record: f.record,
      request: f.request,
      now: () => f.now,
      use: () => "cron",
    });
    expect(result).toBe("cron");
    f.signing.privateKey.fill(0);
  });

  test("fails closed on stale Agent, mapped result, or substituted request", async () => {
    for (const change of ["agent", "result", "request"] as const) {
      const f = await fixture();
      const facts: CurrentProtectedTaskRuntimeFacts = change === "agent"
        ? {...f.facts, task: {...f.facts.task, agentId: "agent:other"}}
        : change === "result"
          ? {...f.facts, run: {...f.facts.run, resultRevision: 1}}
          : f.facts;
      let used = false;
      const port = createCurrentProtectedTaskRuntimeAuthorityPort({
        loadCurrentFacts: async () => facts,
        withAcceptedAuthority: (async (input: Parameters<
          typeof withCurrentAcceptedTaskRuntimeAuthority>[0]) => input.use(
          f.authority,
          {} as never,
          {} as never,
        )) as typeof withCurrentAcceptedTaskRuntimeAuthority,
      });
      const request = change === "request"
        ? {...f.request, sourceRoomId: "room:substituted"}
        : f.request;
      const result = await port({
        runner: {} as never,
        restricted: {} as never,
        crypto: f.crypto,
        serverScope: "https://nautilo.example",
        subject: {userId: f.occurrence.task.requestorId,
          humanActorId: f.authority.plan.subjectHumanId,
          deviceId: f.authority.plan.committerDeviceId},
        occurrence: f.runningOccurrence,
        record: f.record,
        request,
        now: () => f.now,
        use: () => {used = true; return "unsafe";},
      }).catch(() => null);
      expect(result).toBeNull();
      expect(used).toBe(false);
      f.signing.privateKey.fill(0);
    }
  });

  test("projects only content-free native route admission from the locked Task", async () => {
    const f = await fixture();
    const load = async (nativeExecutionSupported: boolean) => {
      const statements: Readonly<{sql: string; params: readonly unknown[]}>[] = [];
      const rows: unknown[][] = [
        [{
          id: f.facts.task.id,
          owner_id: f.facts.task.ownerId,
          requestor_id: f.facts.task.requestorId,
          agent_id: f.facts.task.agentId,
          calling_room_id: f.facts.task.callingRoomId,
          status: f.facts.task.status,
          schedule_kind: f.facts.task.scheduleKind,
          content_representation: f.facts.task.contentRepresentation,
          content_namespace_id: f.facts.task.contentNamespaceId,
          content_revision: f.facts.task.contentRevision,
          crypto_object_id: f.facts.task.cryptoObjectId,
          crypto_access_revision: f.facts.task.cryptoAccessRevision,
          crypto_required_namespace_fingerprint:
            f.facts.task.cryptoRequiredNamespaceFingerprint,
          crypto_mapping_state: f.facts.task.cryptoMappingState,
          native_execution_supported: nativeExecutionSupported,
        }],
        [{
          id: f.facts.run.id,
          task_id: f.facts.run.taskId,
          job_id: f.facts.run.jobId,
          graph_thread_id: f.facts.run.graphThreadId,
          status: f.facts.run.status,
          result_representation: f.facts.run.resultRepresentation,
          result_content_namespace_id: f.facts.run.resultContentNamespaceId,
          result_revision: f.facts.run.resultRevision,
          result_crypto_object_id: f.facts.run.resultCryptoObjectId,
          result_crypto_access_revision: f.facts.run.resultCryptoAccessRevision,
          result_crypto_required_namespace_fingerprint:
            f.facts.run.resultCryptoRequiredNamespaceFingerprint,
          result_crypto_mapping_state: f.facts.run.resultCryptoMappingState,
        }],
        [{ id: f.authority.plan.subjectHumanId }],
        [{
          id: f.request.sourceRoomId,
          namespace_id: f.occurrence.task.contentNamespaceId,
          human_actor_ids: [f.authority.plan.subjectHumanId],
        }],
        [
          { id: f.authority.plan.subjectHumanId, kind: "user", agent_id: null },
          { id: "actor:agent", kind: "agent", agent_id: f.occurrence.task.agentId },
        ],
      ];
      const product = {
        query: async (sql: string, params: readonly unknown[]) => {
          statements.push({sql, params});
          return rows.shift() ?? [];
        },
      } as never;
      const facts = await loadCurrentProtectedTaskRuntimeFacts({
        product,
        occurrence: f.runningOccurrence,
      });
      return {facts, statement: statements[0]!};
    };

    const admitted = await load(true);
    expect(admitted.facts?.nativeExecutionSupported).toBe(true);
    expect(Object.hasOwn(admitted.facts?.task ?? {}, "metadata")).toBe(false);
    expect(Object.hasOwn(admitted.facts?.task ?? {}, "preset")).toBe(false);
    expect(admitted.statement.sql).toContain(
      `case\n      when jsonb_typeof("metadata") = 'object' then coalesce(`,
    );
    expect(admitted.statement.sql).toContain(
      `"metadata" - 'preparation' - 'lastInterruption'`,
    );
    expect(admitted.statement.sql).toContain(
      `as "native_execution_supported"`,
    );
    expect(admitted.statement.sql).not.toContain(`, "preset",`);
    expect(admitted.statement.sql).not.toContain(`, "metadata",`);
    expect(admitted.statement.params.slice(0, 5)).toEqual([
      "task",
      "in_scope",
      "in_private_namespace",
      "in_background",
      "schedule",
    ]);

    expect((await load(false)).facts?.nativeExecutionSupported).toBe(false);
    f.signing.privateKey.fill(0);
  });
});
