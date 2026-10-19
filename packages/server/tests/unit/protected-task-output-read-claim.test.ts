import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { protectedTaskRunWakeJobId, protectedTaskRunResultObjectId } from "@nautilo/db";
import { LatticeCrypto, type DomainForegroundAuthorityEntry } from "@nautilo/lattice-crypto";
import { encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2 } from "@nautilo/lattice-crypto/background";
import { agentRuntimeObjectSignerKeyIdV1,
  parseDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import { InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { createProtectedTaskOutputReadClaim,
  type ProtectedTaskOutputReadClaimDependencies } from "../../src/routes/protected-task-output-read-claim";
import { createProtectedTaskOutputReadPlan } from "../../src/routes/protected-task-output-read-plan";
import type { ProtectedTaskOutputReadIntent } from "../../src/routes/protected-task-output-read-product";
import type { ProtectedTaskOutputReadCurrentAuthority } from "../../src/routes/protected-task-output-read-authority";

const NOW = 1_800_500_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const USER = "30000000-0000-4000-8000-000000000003";
const HUMAN = "40000000-0000-4000-8000-000000000004";
const AGENT = "50000000-0000-4000-8000-000000000005";
const ROOM = "60000000-0000-4000-8000-000000000006";
const SESSION = "70000000-0000-4000-8000-000000000007";
const PRIVATE = "80000000-0000-4000-8000-000000000008";
const DESTINATION = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const DEVICE = "b0000000-0000-4000-8000-00000000000b";
const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(wake = false, sameNamespace = false, additional = false) {
  const workKind = wake ? "task.delivery_wake" as const : "task.deliver_result" as const;
  const bindingId = `task-run-output:${RUN}`;
  const operationId = `task-run-delivery-${wake ? "wake" : "message"}:${RUN}`;
  const resultObjectId = protectedTaskRunResultObjectId(TASK, RUN);
  const intent: ProtectedTaskOutputReadIntent = {
    requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
    contentNamespaceId: PRIVATE, representation: "protected", expectedPolicyRevision: 7,
    acceptedPolicyRevision: 6, initialState: wake ? "wake_queued" : "raw_unpublished",
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId: resultObjectId, cryptoAccessRevision: 0, genesisManifestHash: bytes(1), signerAgentId: AGENT },
    invocation: wake ? { kind: "wake", bindingId, operationId, roomId: ROOM, sessionId: SESSION,
      jobId: protectedTaskRunWakeJobId(RUN), reference: { kind: "protected_task_delivery_v1",
        taskId: TASK, taskRunId: RUN, bindingId, resultObjectId, wakeOperationId: operationId } }
      : { kind: "raw", bindingId, operationId, roomId: ROOM, sessionId: SESSION },
  };
  const resultFact = { namespaceId: PRIVATE, domainId: DOMAIN, expectedAccessRevision: 2,
    expectedPolicyRevision: 7, expectedDomainEpoch: 3, expectedAuthorizationRevision: 4 };
  const foregroundFact = { ...resultFact, namespaceId: sameNamespace ? PRIVATE : DESTINATION };
  const mutationFact = { ...resultFact, namespaceId: "a0000000-0000-4000-8000-00000000000b" };
  const mutation = { roomId: "60000000-0000-4000-8000-000000000007",
    namespaceId: mutationFact.namespaceId, semanticDigest: "ab".repeat(32) };
  const namespaceAuthority = { sourceRoomId: ROOM, sourceNamespaceId: PRIVATE,
    facts: [...(sameNamespace ? [resultFact] : [resultFact, foregroundFact]), ...(additional ? [mutationFact] : [])],
    ...(additional ? { additionalMutationFact: { destination: mutation, namespace: mutationFact } } : {}),
    resultFact, foregroundFacts: [foregroundFact] };
  const crypto = new LatticeCrypto();
  const plan = createProtectedTaskOutputReadPlan({ intent, authority: namespaceAuthority,
    crypto, now: NOW, recipientTtlMs: 60_000 });
  const domain = { domainId: DOMAIN, sourceNamespaceId: PRIVATE,
    participantDigest: bytes(2), participantCount: 1, keyClass: "ai", domainKeyGeneration: 3,
    authorizationRevision: 4, headDigest: bytes(3), activeNamespaceBindingSetDigest: bytes(4),
    activeNamespaceBindingCount: sameNamespace ? 1 : 2 } as DomainForegroundAuthorityEntry;
  const device = { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 1,
    signingPublicKey: bytes(5), serverInstanceId: "test-server", lineageGeneration: 1,
    epoch: 1, securityRevision: 1, headDigest: bytes(6) };
  const namespaces = plan.initialRecord.authoritySet.namespaceRequirements;
  const publicKey = new Uint8Array(65).fill(7);
  const signer = crypto.generateSigningKeyPair();
  const request = plan.buildRequest({ record: plan.initialRecord,
    binding: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
    authority: { sourceRoomId: ROOM, policyRevision: 7, device,
      namespaceRequirements: namespaces, domains: [domain] },
    attempt: { ...plan.recipientAttempt({ record: plan.initialRecord, now: NOW }),
      requestId: plan.initialRecord.snapshot.requestId, workId: plan.initialRecord.snapshot.workId,
      recipientGeneration: 0, recipientPublicKey: publicKey,
      signer: { agentId: AGENT, runtimeGeneration: 0,
        signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
        signerPublicKey: signer.publicKey } } });
  signer.privateKey.fill(0);
  signer.publicKey.fill(0);
  const baseRequest = request.baseRequest;
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes: bytes(8), certificateBytes: bytes(9),
  });
  const record: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...plan.initialRecord, descriptorBytes,
    snapshot: { ...plan.initialRecord.snapshot, state: "grant_ready", requestRevision: 2,
      descriptorDigest: hash(descriptorBytes), recipient: { recipientKeyId: baseRequest.recipientKeyId,
        recipientPublicKey: Buffer.from(publicKey).toString("base64url"), expiresAt: baseRequest.deadlineAt },
      acceptedResponse: { kind: "runtime", responseDigest: hash(responseBytes), credentialDigest: "aa".repeat(32),
        issuingHumanId: HUMAN, issuingDeviceId: DEVICE, recipientGeneration: 0, acceptedAt: NOW } },
    acceptedMaterial: { responseBytes, credentialId: baseRequest.requestId,
      issuingDeviceAuthorizationRevision: 1, issuerSigningPublicKeyHash: bytes(9), authorizationExpiresAt: NOW + 60_000 },
  };
  const projectedResult = { ...namespaces[0]!, operations: ["decrypt"] as const };
  const projectedForeground = namespaces.filter(n => plan.foregroundNamespaceIds.includes(n.namespaceId))
    .map(n => ({ ...n, operations: wake ? ["decrypt", "encrypt"] as const : ["encrypt"] as const }));
  const current: ProtectedTaskOutputReadCurrentAuthority = {
    device, plan: parseDomainForegroundAuthorizationPlanV2(baseRequest.authorizationPlanBytes)!,
    domains: [domain], namespaceRequirements: namespaces, policyRevision: 7, namespaceAuthority,
    resultNamespaceRequirement: projectedResult, foregroundNamespaceRequirements: projectedForeground,
    occurrence: { requesterHumanId: HUMAN, result: { ...intent.result, namespace: {
      namespaceId: PRIVATE, domainId: DOMAIN, operations: ["decrypt"], expectedAccessRevision: 2,
      expectedPolicyRevision: 7 } }, invocation: intent.invocation },
  };
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(record);
  const events: string[] = [];
  let held = false;
  let opened = 0;
  let published = 0;
  let unavailable = false;
  let failPublication = false;
  let expire = false;
  let signingCopy: Uint8Array | undefined;
  const dependencies: ProtectedTaskOutputReadClaimDependencies = {
    workKind, now: () => expire ? NOW + 60_000 : NOW + 1, claimId: () => "read-claim",
    repository: async () => repository,
    authority: {
      withPlanning: async () => { throw new Error("unexpected planning"); },
      withDiscovery: async () => { throw new Error("unexpected discovery"); },
      withBound: async () => { throw new Error("unexpected bound"); },
      withAccepted: async operation => {
        held = true; events.push("held");
        try {
          const value = await operation.use(current, {} as never, {} as never, {} as never);
          await operation.validateBeforeCommit();
          return value;
        } finally { held = false; events.push("commit"); }
      },
    },
    recipients: {
      delete: () => { events.push("delete"); return true; },
      withOpenedRunResultReadGrant: async operation => {
        expect(held).toBe(false); opened += 1; events.push("open");
        signingCopy = operation.current.committerDeviceSigningPublicKey;
        expect(operation.workId).toBe(wake ? protectedTaskRunWakeJobId(RUN) : RUN);
        expect(operation.workKind).toBe(workKind);
        expect(operation.certifiedSigning?.expectedPublication).toMatchObject(
          wake
            ? { kind: "task.delivery_wake", taskId: TASK, taskRunId: RUN,
                contentRevision: 1, jobId: protectedTaskRunWakeJobId(RUN) }
            : { kind: "task.deliver_result", taskId: TASK, taskRunId: RUN,
                contentRevision: 1 },
        );
        expect(operation.result.namespace.operations).toEqual(["decrypt"]);
        expect(operation.currentNamespaceRequirements).toEqual(namespaces);
        expect(operation.currentForegroundNamespaceRequirements).toEqual(projectedForeground);
        expect(operation.currentAdditionalMutationDestination).toEqual(additional
          ? { roomId: mutation.roomId, semanticDigest: mutation.semanticDigest,
            namespace: namespaces.find(n => n.namespaceId === mutation.namespaceId)! } : undefined);
        expect(operation.currentForegroundNamespaceRequirements.map(n => n.namespaceId))
          .toEqual([sameNamespace ? PRIVATE : DESTINATION]);
        if (unavailable) return { status: "unavailable", reason: "recipient_unavailable" };
        const value = await operation.operation({ resultDomains: [{ ...domain, domainKey: bytes(10) }],
          foregroundDomains: [{ ...domain, domainKey: bytes(10) }],
          foregroundNamespaceRequirements: operation.currentForegroundNamespaceRequirements },
        new AbortController().signal, {} as never);
        return { status: "opened", value };
      },
    },
    publish: async value => {
      expect(held).toBe(false); events.push("publish"); published += 1;
      expect(value.record.snapshot.state).toBe("running");
      await value.assertCurrentClaim();
      if (failPublication) throw new Error("publication failed");
    },
  };
  const claim = (overrides: Partial<ProtectedTaskOutputReadClaimDependencies> = {}) =>
    createProtectedTaskOutputReadClaim({ ...dependencies, ...overrides });
  const input = { plan, record, restricted: {} as never, signal: new AbortController().signal };
  return { claim, input, current, repository, dependencies, events,
    opened: () => opened, published: () => published, signingCopy: () => signingCopy,
    unavailable: () => { unavailable = true; }, fail: () => { failPublication = true; }, expire: () => { expire = true; } };
}

for (const wake of [false, true]) for (const sameNamespace of [false, true]) {
  test(`claims ${wake ? "wake Job" : "raw Run"} with independent foreground; same Namespace=${sameNamespace}`, async () => {
    const f = await fixture(wake, sameNamespace);
    const completed = await f.claim()(f.input);
    expect(completed?.snapshot.state).toBe("completed");
    expect(f.events).toEqual(["held", "commit", "open", "publish", "delete"]);
    expect(f.signingCopy()?.every(byte => byte === 0)).toBe(true);
    expect(f.current.device.signingPublicKey.every(byte => byte === 5)).toBe(true);
  });
}

test("closed purpose, foreground, source and held occurrence substitutions do not claim", async () => {
  const wrongKind = await fixture();
  expect(await wrongKind.claim({ workKind: "task.delivery_wake" })(wrongKind.input)).toBeNull();
  expect(wrongKind.events).toEqual([]);
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.current.occurrence.result.genesisManifestHash[0] = 99; },
    (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.current, { foregroundNamespaceRequirements: [] }); },
    (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.current, {
      domains: f.current.domains.map(d => ({ ...d, domainKeyGeneration: d.domainKeyGeneration + 1 })),
    }); },
    (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.current, { plan: { ...f.current.plan, sessionId: TASK } }); },
  ]) {
    const f = await fixture(); mutate(f);
    expect(await f.claim()(f.input)).toBeNull();
    expect(f.opened()).toBe(0);
    expect((await f.repository.get(f.input.record.snapshot.requestId))?.snapshot.state).toBe("grant_ready");
  }
  const f = await fixture();
  expect(await f.claim()({ ...f.input, plan: { ...f.input.plan, foregroundNamespaceIds: [PRIVATE] } })).toBeNull();
  expect(await f.claim()({ ...f.input, plan: { ...f.input.plan, sourceRoomId: TASK } })).toBeNull();
  expect(f.opened()).toBe(0);
});

test("unavailable grant and publication failure cannot complete", async () => {
  for (const fail of ["unavailable", "fail"] as const) {
    const f = await fixture(); f[fail]();
    expect(await f.claim()(f.input).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect((await f.repository.get(f.input.record.snapshot.requestId))?.snapshot.state).toBe("running");
    expect(f.events).not.toContain("delete");
  }
  const expired = await fixture(); expired.expire();
  expect(await expired.claim()(expired.input)).toBeNull();
  expect(expired.opened()).toBe(0);
});

test("stale selected revision cannot claim or open", async () => {
  const f = await fixture();
  const selected = { ...f.input.record, snapshot: { ...f.input.record.snapshot, requestRevision: 3 } };
  expect(await f.claim()({ ...f.input, record: selected })).toBeNull();
  expect(f.opened()).toBe(0);
});


test("wake Work identity is the canonical Job and encrypt-only private authority is refused", async () => {
  const wake = await fixture(true);
  expect(await wake.claim()({ ...wake.input, plan: { ...wake.input.plan,
    intent: { ...wake.input.plan.intent, invocation: { ...wake.input.plan.intent.invocation,
      kind: "wake", jobId: RUN, reference: {
        kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN,
        bindingId: `task-run-output:${RUN}`, resultObjectId: wake.input.plan.intent.result.objectId,
        wakeOperationId: `task-run-delivery-wake:${RUN}`,
      } } },
  } })).toBeNull();
  expect(wake.events).toEqual([]);
  const raw = await fixture(false, true);
  const authoritySet = { ...raw.input.record.authoritySet,
    namespaceRequirements: raw.input.record.authoritySet.namespaceRequirements.map(n => ({
      ...n, operations: ["encrypt"] as const,
    })),
  };
  expect(await raw.claim()({ ...raw.input,
    record: { ...raw.input.record, authoritySet },
    plan: { ...raw.input.plan, initialRecord: { ...raw.input.plan.initialRecord, authoritySet } },
  })).toBeNull();
  expect(raw.events).toEqual([]);
});

test("snapshotting protects the closed source from caller mutation during admission", async () => {
  const f = await fixture();
  const authority = { ...f.dependencies.authority,
    withAccepted: ((operation) => {
      f.input.plan.intent.result.genesisManifestHash.fill(0);
      return f.dependencies.authority.withAccepted(operation);
    }) as typeof f.dependencies.authority.withAccepted,
  };
  expect((await f.claim({ authority })(f.input))?.snapshot.state).toBe("completed");
  expect(f.published()).toBe(1);
});

test("wake claim forwards only the independently held encrypt-only mutation partition", async () => {
  const f = await fixture(true, false, true);
  expect((await f.claim()(f.input))?.snapshot.state).toBe("completed");
  expect(f.opened()).toBe(1);
  expect(f.published()).toBe(1);
  const changed = await fixture(true, false, true);
  const destination = changed.input.plan.additionalMutationDestination!;
  expect(await changed.claim()({ ...changed.input, plan: { ...changed.input.plan,
    additionalMutationDestination: { ...destination, semanticDigest: "cd".repeat(32) } } })).toBeNull();
  expect(changed.opened()).toBe(0);
});

test("forged park outcome never skips claim completion checks or rotates authorization", async () => {
  for (const wake of [false, true]) {
    const f = await fixture(wake);
    let finished = 0;
    const claim = f.claim({ publish: async () => ({ status: "parked", receipt: {} as never }),
      finishParkedWake: async () => { finished++; return null; } });
    expect(await claim(f.input).catch((error: unknown) => error)).toBeInstanceOf(TypeError);
    expect(finished).toBe(0);
    expect((await f.repository.get(f.input.record.snapshot.requestId))?.snapshot.state).toBe("running");
    expect(f.events).not.toContain("delete");
  }
});
