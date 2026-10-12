import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { DirectDatabase, ProtectedTaskCancellationOutputIntent,
  ProtectedTaskCancellationOutputSettlementProof } from "@nautilo/db";
import { fingerprintTaskContentAuthorityV1, deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  InMemoryBackgroundAuthorizationRepository, attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest, createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady, markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { createProtectedTaskCancellationSettlement, type VerifyStagedCancellationSettlement } from "../../src/routes/protected-task-cancellation-settlement";
import { protectedTaskCancellationIdempotencyKey } from "../../src/routes/protected-task-cancellation-plan";
const START = 1_700_100_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const NAMESPACE = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
const REQUEST = `task-run-cancellation-result-authorization:${RUN}`;
const database = Object.freeze({}) as unknown as DirectDatabase;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: REQUEST,
    workId: RUN,
    namespaceId: NAMESPACE,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "published-result-device",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "published-result-claim",
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(claimed, START + 4),
    workIdentityHash: new Uint8Array(32).fill(9),
    idempotencyKey: protectedTaskCancellationIdempotencyKey(intent),
    workKind: "task.cancel_result",
    purpose: "task.cancel_result",
    domainId: "published-result-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: "published-result-credential",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: "published-result-domain",
        operations: ["encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "published-result-domain",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

const intent: ProtectedTaskCancellationOutputIntent = {
  taskId: TASK, taskRunId: RUN, requesterUserId: "requester", agentId: "agent",
  contentNamespaceId: NAMESPACE, representation: "protected", resultRevision: 2,
  resultOperationId: `task-run-cancelled-result:${RUN}`,
  resultObjectId: deriveTaskContentCryptoObjectIdV1({
    kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 2,
  }),
  policyRevision: 5, taskStatus: "cancelled", runStatus: "cancelled",
  terminalAt: new Date(START - 1),
};
const fingerprint = fingerprintTaskContentAuthorityV1({
  authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
  requesterHumanId: HUMAN, namespaceId: NAMESPACE, domainId: "published-result-domain",
  expectedAccessRevision: 4, expectedPolicyRevision: 5,
});
const proof: ProtectedTaskCancellationOutputSettlementProof = {
  intent, requesterHumanId: HUMAN, authorityFingerprint: fingerprint,
  currentPolicyRevision: 5,
  cryptoAccessRevision: 0, requiredNamespaceFingerprint: new Uint8Array(32).fill(5),
};
async function fixture(options: {
  row?: BackgroundAuthorizationTaskRuntimeRecordV3;
  pruned?: boolean;
  mappedProof?: ProtectedTaskCancellationOutputSettlementProof;
  lostCasResponse?: boolean;
  rejectProof?: boolean;
  rejectProductCommit?: boolean;
  currentPolicyRevision?: number;
} = {}) {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  if (!options.pruned) await repository.create(options.row ?? runningRecord());
  let held = false;
  let cas = 0;
  const deleted: string[] = [];
  const cleanup: (() => void)[] = [];
  const settle: NonNullable<Parameters<typeof createProtectedTaskCancellationSettlement>[0]["settle"]> =
    async (_db, coordinates, complete) => {
      expect(coordinates).toEqual({
        taskId: TASK,
        taskRunId: RUN,
        ...(options.currentPolicyRevision === undefined
          ? {} : { currentPolicyRevision: options.currentPolicyRevision }),
      });
      if (options.rejectProof) return { status: "rejected", reason: "conflict" };
      held = true;
      try {
        if (!await complete(options.mappedProof ?? proof)) return { status: "rejected", reason: "not_ready" };
        if (options.rejectProductCommit) return { status: "rejected", reason: "conflict" };
        return { status: "completed", binding: {} } as Awaited<ReturnType<typeof settle>>;
      } finally { held = false; }
    };
  const recover = createProtectedTaskCancellationSettlement({
    deferRecipientCleanup: release => { cleanup.push(release); },
    db: database, now: () => START + 120_000, settle,
    repository: { get: id => repository.get(id), compareAndSwap: async input => {
      expect(held).toBe(true);
      cas += 1;
      const result = await repository.compareAndSwap(input);
      if (options.lostCasResponse) throw new Error("response lost after commit");
      return result;
    } },
    recipients: { delete: (id, generation) => {
      expect(held).toBe(false);
      deleted.push(`${id}:${generation}`);
      return true;
    } },
  });
  return { recover: async (verifyStaged?: VerifyStagedCancellationSettlement) => {
    const result = await recover({
    taskId: TASK,
    taskRunId: RUN,
    ...(options.currentPolicyRevision === undefined
      ? {} : { currentPolicyRevision: options.currentPolicyRevision }),
  }, verifyStaged);
    if (result) for (const release of cleanup.splice(0)) release();
    return result;
  },
    repository, deleted, cas: () => cas, held: () => held };
}

test.each([false, true])("mapped cancellation settles an expired claim, including lost CAS response (%s)", async lostCasResponse => {
  const state = await fixture({ lostCasResponse });
  expect(await state.recover()).toBe(true);
  expect(await state.repository.get(REQUEST)).toMatchObject({
    snapshot: { state: "completed" }, finishedAt: START + 120_000,
  });
  expect(state.cas()).toBe(1);
  expect(state.deleted).toEqual([`${REQUEST}:0`]);
  expect(await state.recover()).toBe(true);
  expect(state.cas()).toBe(1);
});

test("same-policy settlement does not require or consult staged recovery proof", async () => {
  const state = await fixture();
  let calls = 0;
  expect(await state.recover(async () => {
    calls += 1;
    return null;
  })).toBe(true);
  expect(calls).toBe(0);
  expect(state.cas()).toBe(1);
});

test("newer compatible policy settles a surviving old-policy request only with exact staged proof", async () => {
  const currentProof: ProtectedTaskCancellationOutputSettlementProof = {
    ...proof,
    currentPolicyRevision: 6,
  };
  const state = await fixture({
    mappedProof: currentProof,
    currentPolicyRevision: 6,
  });
  let calls = 0;
  expect(await state.recover(async received => {
    calls += 1;
    expect(received).toEqual(currentProof);
    return { requestId: REQUEST, recipientGeneration: 0 };
  })).toBe(true);
  expect(calls).toBe(1);
  expect(state.cas()).toBe(1);
  expect(state.deleted).toEqual([`${REQUEST}:0`]);
});

test("newer compatible policy cannot settle a surviving request without staged proof", async () => {
  const state = await fixture({
    mappedProof: { ...proof, currentPolicyRevision: 6 },
    currentPolicyRevision: 6,
  });
  expect(await state.recover()).toBe(false);
  expect(state.cas()).toBe(0);
  expect(state.deleted).toEqual([]);
});

test("newer compatible policy rejects a staged proof for another recipient generation", async () => {
  const state = await fixture({
    mappedProof: { ...proof, currentPolicyRevision: 6 },
    currentPolicyRevision: 6,
  });
  expect(await state.recover(async () => ({
    requestId: REQUEST,
    recipientGeneration: 1,
  }))).toBe(false);
  expect(state.cas()).toBe(0);
  expect(state.deleted).toEqual([]);
});

test("newer compatible policy does not let staged proof bless a foreign surviving request", async () => {
  const row = runningRecord();
  const state = await fixture({
    row: { ...row, workKind: "task.execute", purpose: "task.execute" },
    mappedProof: { ...proof, currentPolicyRevision: 6 },
    currentPolicyRevision: 6,
  });
  expect(await state.recover(async () => ({
    requestId: REQUEST,
    recipientGeneration: 0,
  }))).toBe(false);
  expect(state.cas()).toBe(0);
  expect(state.deleted).toEqual([]);
});

test.each(["identity", "human", "fingerprint", "policy", "namespace", "execution"] as const)(
  "mapped cancellation rejects mismatched %s proof without settling authority", async mismatch => {
    const row = runningRecord();
    const changedProof = { ...proof, intent: { ...intent } };
    if (mismatch === "identity") changedProof.intent.agentId = "another-agent";
    if (mismatch === "human") changedProof.requesterHumanId = "another-human";
    if (mismatch === "fingerprint") changedProof.authorityFingerprint = new Uint8Array(32);
    if (mismatch === "policy") changedProof.intent.policyRevision += 1;
    if (mismatch === "namespace") changedProof.intent.contentNamespaceId = "another-namespace";
    const state = await fixture({ mappedProof: changedProof,
      row: mismatch === "execution" ? { ...row, workKind: "task.execute", purpose: "task.execute" } : row });
    expect(await state.recover()).toBe(false);
    expect(state.cas()).toBe(0);
    expect(state.deleted).toEqual([]);
  },
);

test("unmapped/rejected product proof cannot complete or delete custody", async () => {
  const state = await fixture({ rejectProof: true });
  expect(await state.recover()).toBe(false);
  expect(state.cas()).toBe(0);
  expect(state.deleted).toEqual([]);
});

test("a lost product commit retains custody and can retry the completed authorization", async () => {
  const state = await fixture({ rejectProductCommit: true });
  expect(await state.recover()).toBe(false);
  expect(state.cas()).toBe(1);
  expect(state.deleted).toEqual([]);
  expect(await state.recover()).toBe(false);
  expect(state.cas()).toBe(1);
});

test("pruned cancellation request settles from exact staged proof under product locks", async () => {
  const state = await fixture({ pruned: true });
  expect(await state.recover(async current => {
    expect(state.held()).toBe(true);
    expect(current).toEqual(proof);
    return { requestId: REQUEST, recipientGeneration: 4 };
  })).toBe(true);
  expect(state.cas()).toBe(0);
  expect(state.deleted).toEqual([`${REQUEST}:4`]);
});

test("staged fallback never bypasses a conflicting surviving request", async () => {
  const row = runningRecord();
  const state = await fixture({ row: { ...row, workKind: "task.execute", purpose: "task.execute" } });
  let calls = 0;
  expect(await state.recover(async () => { calls++; return { requestId: REQUEST, recipientGeneration: 0 }; })).toBe(false);
  expect(calls).toBe(0);
  expect(state.deleted).toEqual([]);
});

test.each(["absent", "mismatch", "generation", "failed-commit"] as const)(
  "pruned request cannot release custody for %s staged proof", async kind => {
    const state = await fixture({ pruned: true, rejectProductCommit: kind === "failed-commit" });
    expect(await state.recover(async () => kind === "absent" ? null : {
      requestId: kind === "mismatch" ? "other-request" : REQUEST,
      recipientGeneration: kind === "generation" ? -1 : 2,
    })).toBe(false);
    expect(state.deleted).toEqual([]);
    expect(state.cas()).toBe(0);
  });
