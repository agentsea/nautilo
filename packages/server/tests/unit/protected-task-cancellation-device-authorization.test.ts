import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  LatticeCrypto, TaskRuntimeRecipientRegistry, authorizationRevision,
  domainForegroundNamespaceBindingSetDigest,
} from "@nautilo/lattice-crypto";
import { decodeTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier } from
  "@nautilo/lattice-crypto/background";
import { destroyDomainForegroundAuthorizationPlanV2, parseDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import type { ProtectedTaskCancellationAuthorityPort } from "../../src/routes/protected-task-cancellation-authority";
import { createProtectedTaskCancellationPlan } from "../../src/routes/protected-task-cancellation-plan";
import { createProtectedTaskCancellationDeviceAuthorization } from "../../src/routes/protected-task-cancellation-device-authorization";

const NOW = 1_800_500_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const ROOM = "70000000-0000-4000-8000-000000000007";
const NS = "80000000-0000-4000-8000-000000000008";
const DEVICE = "90000000-0000-4000-8000-000000000009";
const SERVER = "a0000000-0000-4000-8000-00000000000a";
const DOMAIN = "task-runtime-domain";
const bytes = (value: number) => new Uint8Array(32).fill(value);

async function fixture() {
  let clock = NOW + 1;
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipients = new TaskRuntimeRecipientRegistry(crypto, { now: () => clock });
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const intent: ProtectedTaskCancellationOutputIntent = {
    taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: AGENT,
    contentNamespaceId: NS, representation: "protected", resultRevision: 2,
    resultOperationId: `task-run-cancelled-result:${RUN}`,
    resultObjectId: deriveTaskContentCryptoObjectIdV1({ kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 2 }),
    policyRevision: 7, taskStatus: "cancelled", runStatus: "cancelled", terminalAt: new Date(NOW),
  };
  const plan = createProtectedTaskCancellationPlan({ intent, crypto, now: NOW, recipientTtlMs: 60_000,
    namespaceAuthority: { sourceRoomId: ROOM, sourceNamespaceId: NS,
      facts: [{ namespaceId: NS, domainId: DOMAIN, expectedAccessRevision: 3,
        expectedPolicyRevision: 7, expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 }] } });
  await repository.create(plan.initialRecord);
  const device = { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 2,
    serverInstanceId: SERVER, lineageGeneration: 1, epoch: 1, securityRevision: 4,
    headDigest: bytes(6), signingPublicKey: signing.publicKey.slice() };
  signing.privateKey.fill(0);
  const domain = { domainId: DOMAIN, sourceNamespaceId: NS, participantDigest: bytes(3),
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3), headDigest: bytes(4),
    activeNamespaceBindingSetDigest: domainForegroundNamespaceBindingSetDigest(crypto,
      [{ namespaceId: NS, bindingDigest: bytes(5) }]), activeNamespaceBindingCount: 1 };
  const restricted = {} as PostgresJsBridgeConnection;
  const current = { device, domains: [domain], namespaceRequirements: plan.initialRecord.authoritySet.namespaceRequirements,
    policyRevision: 7, sourceRoomId: ROOM, sourceNamespaceId: NS, restricted };
  const state = { rollback: false, deny: false, expireAfterUse: false, casConflict: false,
    substitute: false, changePlan: false, discoveryCalls: 0, boundCalls: 0 };
  const authority: ProtectedTaskCancellationAuthorityPort = {
    withDiscovery: async input => {
      state.discoveryCalls++;
      if (state.deny) return null;
      const result = await input.use(current, restricted, {} as never);
      if (state.expireAfterUse) clock += 60_000;
      await input.validateBeforeCommit?.();
      if (state.rollback) throw new Error("Product commit failed");
      return result;
    },
    withBound: async input => {
      state.boundCalls++;
      const foreground = parseDomainForegroundAuthorizationPlanV2(input.request.authorizationPlanBytes)!;
      try { return await input.use({ ...current, plan: foreground }, restricted, restricted); }
      finally { destroyDomainForegroundAuthorizationPlanV2(foreground); }
    },
    withAccepted: async () => { throw new Error("Unexpected claim"); },
  };
  const hooks = createProtectedTaskCancellationDeviceAuthorization({ recipients, authority,
    resolvePlan: async () => state.changePlan ? { ...plan,
      initialRecord: { ...plan.initialRecord, workIdentityHash: bytes(19) } } : plan,
    repository: async connection => {
      expect(connection).toBe(restricted);
      return { get: id => repository.get(id), compareAndSwap: async input => {
        if (state.casConflict) return { status: "conflict", record: await repository.get(input.next.snapshot.requestId) } as never;
        const result = await repository.compareAndSwap(input);
        if (state.substitute && result.status === "updated") return { ...result,
          record: { ...result.record, descriptorBytes: new Uint8Array([0]) } };
        return result;
      } };
    }, now: () => clock });
  const operation = { subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE,
    admission: { ...device, headDigest: device.headDigest.slice(), expiresAt: NOW + 60_000 } },
    admission: { ...device, expiresAt: NOW + 60_000 }, device, restricted, record: plan.initialRecord };
  const hasAttempt = () => recipients.hasAttempt({ requestId: plan.initialRecord.snapshot.requestId,
    workId: RUN, recipientGeneration: plan.initialRecord.snapshot.recipientGeneration,
    recipientKeyId: plan.recipientAttempt({ record: plan.initialRecord, now: NOW + 1 }).recipientKeyId });
  return { hooks, operation, repository, recipients, state, hasAttempt,
    setClock: (value: number) => { clock = value; } };
}

test("binds a real cancellation recipient and admits only its encrypt-only request", async () => {
  const value = await fixture();
  const attached = await value.hooks.bindTaskRecipient(value.operation);
  expect(attached).not.toBeNull();
  expect(attached!.record.snapshot.state).toBe("awaiting_device");
  expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(
    attached!.requestBytes,
  )).toBe(false);
  expect(isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(
    attached!.requestBytes,
  )).toBe(true);
  const certified = decodeTaskRuntimeBackgroundAuthorizationRequestV3(
    new LatticeCrypto(),
    attached!.requestBytes,
  );
  expect(certified?.work).toMatchObject({
    kind: "task.cancel_result", taskId: TASK, taskRunId: RUN,
    contentRevision: 2,
  });
  expect(certified?.signer).toMatchObject({ agentId: AGENT, runtimeGeneration: 0 });
  if (certified !== null) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV3(certified);
  }
  expect(value.hasAttempt()).toBe(true);
  expect(value.hooks.isTaskRecipientActive(attached!.record)).toBe(true);
  const result = await value.hooks.withTaskAuthority({ ...value.operation, record: attached!.record,
    use: async (request, plan) => {
      expect(request.workKind).toBe("task.cancel_result");
      expect(request.workPurpose).toBe("task.cancel_result");
      expect(plan.operations).toEqual(["encrypt"]);
      expect(plan.domains).toHaveLength(1);
      return "accepted";
    } });
  expect(result).toBe("accepted");
  value.recipients.delete(attached!.record.snapshot.requestId, attached!.record.snapshot.recipientGeneration);
  expect(await value.hooks.withTaskAuthority({ ...value.operation, record: attached!.record,
    use: async () => { throw new Error("Missing custody"); } })).toBeNull();
});

for (const scenario of ["rollback", "expireAfterUse", "substitute"] as const) {
  test(`destroys locally created custody after ${scenario}`, async () => {
    const value = await fixture();
    value.state[scenario] = true;
    const result = await value.hooks.bindTaskRecipient(value.operation).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(value.hasAttempt()).toBe(false);
  });
}

for (const scenario of ["deny", "casConflict", "changePlan"] as const) {
  test(`does not retain custody after ${scenario}`, async () => {
    const value = await fixture(); value.state[scenario] = true;
    expect(await value.hooks.bindTaskRecipient(value.operation)).toBeNull();
    expect(value.hasAttempt()).toBe(false);
  });
}

test("expired admission cannot create a recipient and expiry after bound use aborts", async () => {
  const value = await fixture();
  value.setClock(NOW + 60_000);
  expect(await value.hooks.bindTaskRecipient(value.operation)).toBeNull();
  expect(value.state.discoveryCalls).toBe(0);
  value.setClock(NOW + 1);
  const attached = (await value.hooks.bindTaskRecipient(value.operation))!;
  const result = await value.hooks.withTaskAuthority({ ...value.operation, record: attached.record,
    use: async () => { value.setClock(NOW + 60_000); return "unsafe"; } }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
});

test("bound descriptor substitution is rejected before current authority", async () => {
  const value = await fixture();
  const attached = (await value.hooks.bindTaskRecipient(value.operation))!;
  const descriptor = attached.record.descriptorBytes!.slice();
  descriptor[descriptor.length - 1] = descriptor[descriptor.length - 1]! ^ 1;
  const record = { ...attached.record, descriptorBytes: descriptor } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const result = await value.hooks.withTaskAuthority({ ...value.operation, record,
    use: async () => { throw new Error("Must not admit substitution"); } }).catch((error: unknown) => error);
  expect(result === null || result instanceof Error).toBe(true);
  expect(value.state.boundCalls).toBe(0);
});
