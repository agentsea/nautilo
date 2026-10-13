import {
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeForegroundEvidenceV1,
} from "../../src/background/task-runtime-wake-foreground-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceV1,
} from "../../src/background/task-runtime-run-result-read-evidence-v1.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  domainForegroundNamespaceBindingSetDigestV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import {
  assertAuthenticTaskRuntimeCancellationResultEvidenceV1,
  assertAuthenticTaskRuntimeTerminalMessageEvidenceV1,
  TaskRuntimeRecipientRegistryV1,
  type TaskRuntimeCancellationResultEvidenceV1,
  type TaskRuntimeTerminalMessageEvidenceV1,
} from
  "../../src/background/task-runtime-recipient-registry-v1.ts";
import type { TaskRuntimeRecipientDeadlineSchedulerV1 } from
  "../../src/background/task-runtime-recipient-registry-v1.ts";
import {
  PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1,
} from "../../src/background/one-run-processor-transform-v1.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const NOW = 1_800_400_000_000;
const REQUEST = "task-runtime-request";
const WORK = "10000000-0000-4000-8000-000000000001";
const KEY = "task-runtime-key";
const ROOM = "70000000-0000-4000-8000-000000000001";
const SESSION = "80000000-0000-4000-8000-000000000001";
const TERMINAL_REQUEST = `task-run-delivery-message-authorization:${WORK}`;
const RESULT = Object.freeze({
  taskId: "10000000-0000-4000-8000-000000000002",
  taskRunId: WORK,
  contentRevision: 1 as const,
  objectId: `task-run-result:v1:${"a".repeat(64)}`,
  signerAgentId: "10000000-0000-4000-8000-000000000003",
  namespace: Object.freeze({
    namespaceId: "task-runtime-namespace",
    domainId: "task-runtime-domain",
    operations: Object.freeze(["encrypt"] as const),
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
  }),
});
const CANCEL_RESULT = Object.freeze({
  taskId: RESULT.taskId,
  taskRunId: WORK,
  contentRevision: 2 as const,
  objectId: `task-run-result:v1:${bytesToHex(sha256(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${RESULT.taskId}\n${WORK}\n2`,
  )))}`,
  signerAgentId: RESULT.signerAgentId,
  namespace: Object.freeze({
    ...RESULT.namespace,
    operations: Object.freeze(["encrypt"] as const),
  }),
});
const CURRENT_NAMESPACES = Object.freeze([Object.freeze({
  ordinal: 0,
  namespaceId: RESULT.namespace.namespaceId,
  domainId: RESULT.namespace.domainId,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
  expectedAccessRevision: RESULT.namespace.expectedAccessRevision,
  expectedPolicyRevision: RESULT.namespace.expectedPolicyRevision,
})]);
const CANCELLATION_NAMESPACES = Object.freeze([Object.freeze({
  ...CURRENT_NAMESPACES[0]!,
  operations: Object.freeze(["encrypt"] as const),
})]);
const terminalObjectDigest = sha256(new TextEncoder().encode(
  `nautilo/conversation-message-crypto-object/v2\n${SESSION.length}\n${SESSION}\n1\n0`,
));
const TERMINAL_MESSAGE = Object.freeze({
  taskId: RESULT.taskId,
  taskRunId: WORK,
  bindingId: `task-run-output:${WORK}`,
  messageOperationId: `task-run-delivery-message:${WORK}`,
  sessionId: SESSION,
  messageId: 1,
  revision: 0,
  objectId: `message:v2:${bytesToHex(terminalObjectDigest)}`,
  roomId: ROOM,
  namespaceId: RESULT.namespace.namespaceId,
  domainId: RESULT.namespace.domainId,
  mode: "encrypted_only" as const,
  acceptedPolicyRevision: 6,
  publicationPolicyRevision: 7,
  signerAgentId: RESULT.signerAgentId,
  payloadDigest: new Uint8Array(32).fill(0x55),
});
terminalObjectDigest.fill(0);

const resultAuthority = () => ({
  result: RESULT,
  currentNamespaceRequirements: CURRENT_NAMESPACES,
});

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture(
  scheduler?: TaskRuntimeRecipientDeadlineSchedulerV1,
  cancellation = false,
  requestId = REQUEST,
  options: { workId?: string; separateForeground?: boolean; authorizationExpiresAt?: number } = {},
) {
  let now = NOW;
  const crypto = new LatticeCrypto(seededRng(401_001), { now: () => now });
  const registry = new TaskRuntimeRecipientRegistryV1(crypto, {
    now: () => now,
    ...(scheduler === undefined ? {} : { scheduler }),
  });
  const generatedRecipientPairs: Array<Awaited<
    ReturnType<LatticeCrypto["generateEncryptionKeyPair"]>
  >> = [];
  const generateEncryptionKeyPair =
    crypto.generateEncryptionKeyPair.bind(crypto);
  const generator = spyOn(crypto, "generateEncryptionKeyPair")
    .mockImplementation(async () => {
      const pair = await generateEncryptionKeyPair();
      generatedRecipientPairs.push(pair);
      return pair;
    });
  const attempt = await registry.createAttempt({
    requestId,
    workId: options.workId ?? WORK,
    recipientGeneration: 0,
    recipientKeyId: KEY,
    expiresAt: NOW + 60_000,
  }).finally(() => generator.mockRestore());
  if (attempt.status !== "created") throw new Error("recipient unavailable");
  const generatedRecipientPair = generatedRecipientPairs[0];
  if (generatedRecipientPair === undefined) {
    throw new Error("recipient keypair was not generated");
  }
  const signer = crypto.generateSigningKeyPair();
  const domain = Object.freeze({
    domainId: "task-runtime-domain",
    sourceNamespaceId: "task-runtime-namespace",
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(4),
    activeNamespaceBindingSetDigest:
      domainForegroundNamespaceBindingSetDigestV2(crypto, [{
        namespaceId: "task-runtime-namespace",
        bindingDigest: bytes(5),
      }]),
    activeNamespaceBindingCount: 1,
  });
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: requestId,
    policyRevision: 7,
    sessionId: "task-runtime-episode",
    roomId: ROOM,
    subjectHumanId: humanId("task-runtime-human"),
    committerDeviceId: cryptoDeviceId("task-runtime-device"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: KEY,
    operations: cancellation
      ? ["encrypt"]
      : ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: options.authorizationExpiresAt ?? NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domain, ...(options.separateForeground ? [{ ...domain,
      domainId: "foreground-domain", sourceNamespaceId: "foreground-namespace" }] : [])].sort((a, b) => a.domainId.localeCompare(b.domainId)),
  });
  const secrets: readonly DomainForegroundSecretEntryV2[] = plan.domains.map(entry => ({
    ...entry, domainKey: bytes(9),
  }));
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: secrets,
    committerDeviceSigningPrivateKey: signer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const current: DomainForegroundAuthorizationPublicCurrentAuthorityV2 = {
    authorizationId: plan.authorizationId,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    subjectHumanId: plan.subjectHumanId,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningGeneration: plan.committerDeviceSigningGeneration,
    committerDeviceSigningPublicKey: signer.publicKey,
    committerDeviceActive: true,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    recipientKind: plan.recipientKind,
    recipientPrincipalId: plan.recipientPrincipalId,
    recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
    recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
    recipientKeyId: plan.recipientKeyId,
    recipientAuthorized: true,
    domains: plan.domains,
  };
  return {
    crypto,
    registry,
    attempt: attempt.attempt,
    generatedRecipientPrivateKey: generatedRecipientPair.privateKey,
    generatedRecipientPublicKey: generatedRecipientPair.publicKey,
    authorizationBytes,
    current,
    requestId,
    setNow: (value: number) => { now = value; },
  };
}

describe("Task Runtime recipient registry", () => {
  test("opens one exact encrypt-only terminal Message grant with callback-scoped evidence", async () => {
    const value = await fixture(undefined, true, TERMINAL_REQUEST);
    let retained: TaskRuntimeTerminalMessageEvidenceV1 | null = null;
    let openedDomainKey: Uint8Array | null = null;
    const opened = await value.registry.withOpenedTerminalMessageGrant({
      requestId: TERMINAL_REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-terminal-message-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      currentNamespaceRequirements: CANCELLATION_NAMESPACES,
      message: TERMINAL_MESSAGE,
      operation: (domains, _signal, evidence) => {
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
          evidence,
        )).not.toThrow();
        expect(evidence).toMatchObject({
          purpose: "task.runtime.terminal_message",
          workKind: "task.deliver_message",
          requestId: TERMINAL_REQUEST,
          workId: WORK,
          operations: ["encrypt"],
          message: TERMINAL_MESSAGE,
          namespaceRequirements: CANCELLATION_NAMESPACES,
        });
        expect(evidence.domainRequirements).toHaveLength(1);
        openedDomainKey = domains[0]!.domainKey;
        retained = evidence;
        return "terminal-message";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "terminal-message" });
    expect(value.registry.size).toBe(0);
    expect(value.generatedRecipientPrivateKey.every(byte => byte === 0))
      .toBe(true);
    expect(openedDomainKey).not.toBeNull();
    expect(openedDomainKey!.every(byte => byte === 0)).toBe(true);
    if (retained === null) throw new Error("terminal Message evidence was absent");
    expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(retained!))
      .toThrow("not active");
  });

  test("rejects terminal Message substitutions and permanently invalidates tampered evidence", async () => {
    const substitutions = [
      { ...TERMINAL_MESSAGE, roomId: "70000000-0000-4000-8000-000000000002" },
      { ...TERMINAL_MESSAGE, messageOperationId: `other:${WORK}` },
      { ...TERMINAL_MESSAGE, publicationPolicyRevision: 8 },
      { ...TERMINAL_MESSAGE, objectId: `message:v2:${"b".repeat(64)}` },
    ] as const;
    for (const message of substitutions) {
      const value = await fixture(undefined, true, TERMINAL_REQUEST);
      let invoked = false;
      let result: unknown;
      try {
        result = await value.registry.withOpenedTerminalMessageGrant({
          requestId: TERMINAL_REQUEST,
          workId: WORK,
          recipientGeneration: 0,
          recipientKeyId: KEY,
          claimId: "task-runtime-terminal-message-claim",
          claimExpiresAt: NOW + 30_000,
          authorizationBytes: value.authorizationBytes,
          current: value.current,
          currentNamespaceRequirements: CANCELLATION_NAMESPACES,
          message,
          operation: () => { invoked = true; },
        });
      } catch (error: unknown) {
        result = error;
      }
      expect(invoked).toBe(false);
      expect(result instanceof Error || typeof result === "object"
        && result !== null && "status" in result
        && result.status === "unavailable").toBe(true);
      value.registry.close();
    }

    const value = await fixture(undefined, true, TERMINAL_REQUEST);
    const opened = await value.registry.withOpenedTerminalMessageGrant({
      requestId: TERMINAL_REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-terminal-message-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      currentNamespaceRequirements: CANCELLATION_NAMESPACES,
      message: TERMINAL_MESSAGE,
      operation: (_domains, _signal, evidence) => {
        const original = evidence.message.payloadDigest[0]!;
        evidence.message.payloadDigest[0] = original ^ 1;
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence))
          .toThrow("not active");
        evidence.message.payloadDigest[0] = original;
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence))
          .toThrow("not active");
        return "tampered";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "tampered" });
  });

  test("opens one exact encrypt-only cancellation result grant with scoped evidence", async () => {
    const value = await fixture(undefined, true);
    let retained: TaskRuntimeCancellationResultEvidenceV1 | null = null;
    let openedDomainKey: Uint8Array | null = null;
    const opened = await value.registry.withOpenedCancellationResultGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-cancellation-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      currentNamespaceRequirements: CANCELLATION_NAMESPACES,
      result: CANCEL_RESULT,
      operation: (domains, _signal, evidence) => {
        expect(() => assertAuthenticTaskRuntimeCancellationResultEvidenceV1(
          evidence,
        )).not.toThrow();
        expect(evidence).toMatchObject({
          purpose: "task.runtime.cancellation_result",
          requestId: REQUEST,
          workId: WORK,
          claimId: "task-runtime-cancellation-claim",
          operations: ["encrypt"],
          result: CANCEL_RESULT,
          namespaceRequirements: CANCELLATION_NAMESPACES,
        });
        expect(evidence.domainRequirements).toHaveLength(1);
        expect(evidence.domainRequirements[0]?.domainId)
          .toBe(CANCEL_RESULT.namespace.domainId);
        openedDomainKey = domains[0]!.domainKey;
        retained = evidence;
        return "cancelled-result";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "cancelled-result" });
    expect(value.registry.size).toBe(0);
    expect(value.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);
    expect(openedDomainKey).not.toBeNull();
    expect(openedDomainKey!.every((byte) => byte === 0)).toBe(true);
    if (retained === null) throw new Error("cancellation evidence was absent");
    expect(() => assertAuthenticTaskRuntimeCancellationResultEvidenceV1(
      retained!,
    )).toThrow("not active");
  });

  test("keeps execution and cancellation grant operations disjoint", async () => {
    const cancellation = await fixture(undefined, true);
    expect(await cancellation.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: cancellation.authorizationBytes,
      current: cancellation.current,
      ...resultAuthority(),
      operation: () => {
        throw new Error("encrypt-only grant reached execution");
      },
    })).toEqual({ status: "unavailable", reason: "authority_stale" });
    cancellation.registry.close();

    const execution = await fixture();
    expect(await execution.registry.withOpenedCancellationResultGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-cancellation-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: execution.authorizationBytes,
      current: execution.current,
      currentNamespaceRequirements: CANCELLATION_NAMESPACES,
      result: CANCEL_RESULT,
      operation: () => {
        throw new Error("execution grant reached cancellation publication");
      },
    })).toEqual({ status: "unavailable", reason: "authority_stale" });
    execution.registry.close();
  });

  test("rejects substituted cancellation result coordinates and authority", async () => {
    type Result = Parameters<
      TaskRuntimeRecipientRegistryV1["withOpenedCancellationResultGrant"]
    >[0]["result"];
    type Namespaces = Parameters<
      TaskRuntimeRecipientRegistryV1["withOpenedCancellationResultGrant"]
    >[0]["currentNamespaceRequirements"];
    const requirement = CANCELLATION_NAMESPACES[0]!;
    const cases: readonly Readonly<{
      name: string;
      result?: Result;
      namespaces?: Namespaces;
      current?(value: Awaited<ReturnType<typeof fixture>>):
        DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    }>[] = [
      {
        name: "Task",
        result: {
          ...CANCEL_RESULT,
          taskId: "20000000-0000-4000-8000-000000000002",
        },
      },
      {
        name: "Task Run",
        result: {
          ...CANCEL_RESULT,
          taskRunId: "20000000-0000-4000-8000-000000000001",
        },
      },
      {
        name: "revision",
        result: {
          ...CANCEL_RESULT,
          contentRevision: 1,
        } as unknown as Result,
      },
      {
        name: "object",
        result: { ...CANCEL_RESULT, objectId: `task-run-result:v1:${"b".repeat(64)}` },
      },
      { name: "missing Namespace", namespaces: [] },
      { name: "duplicate Namespace", namespaces: [requirement, requirement] },
      {
        name: "Namespace operations",
        namespaces: [{ ...requirement, operations: ["decrypt", "encrypt"] }],
      },
      {
        name: "Namespace access revision",
        namespaces: [{ ...requirement, expectedAccessRevision: 5 }],
      },
      {
        name: "policy revision",
        current: (value) => ({ ...value.current, policyRevision: 8 }),
      },
      {
        name: "extra Domain",
        current: (value) => ({
          ...value.current,
          domains: [value.current.domains[0]!, value.current.domains[0]!],
        }),
      },
      {
        name: "Domain source Namespace",
        current: (value) => ({
          ...value.current,
          domains: [{
            ...value.current.domains[0]!,
            sourceNamespaceId: "other-task-runtime-namespace",
          }],
        }),
      },
    ];
    for (const item of cases) {
      const value = await fixture(undefined, true);
      let invoked = false;
      const opened = await value.registry.withOpenedCancellationResultGrant({
        requestId: REQUEST,
        workId: WORK,
        recipientGeneration: 0,
        recipientKeyId: KEY,
        claimId: "task-runtime-cancellation-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes: value.authorizationBytes,
        current: item.current?.(value) ?? value.current,
        currentNamespaceRequirements:
          item.namespaces ?? CANCELLATION_NAMESPACES,
        result: item.result ?? CANCEL_RESULT,
        operation: () => {
          invoked = true;
        },
      });
      expect(opened).toEqual({ status: "unavailable", reason: "authority_stale" });
      expect(invoked).toBe(false);
      value.registry.close();
    }
  });

  test("permanently rejects mutated cancellation result evidence", async () => {
    const value = await fixture(undefined, true);
    const opened = await value.registry.withOpenedCancellationResultGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-cancellation-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      currentNamespaceRequirements: CANCELLATION_NAMESPACES,
      result: CANCEL_RESULT,
      operation: (_domains, _signal, evidence) => {
        const original = evidence.authorizationDigest[0]!;
        evidence.authorizationDigest[0] = original ^ 1;
        expect(() => assertAuthenticTaskRuntimeCancellationResultEvidenceV1(
          evidence,
        )).toThrow("not active");
        evidence.authorizationDigest[0] = original;
        expect(() => assertAuthenticTaskRuntimeCancellationResultEvidenceV1(
          evidence,
        )).toThrow("not active");
        return "mutated";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "mutated" });
  });

  test("mints exact execution evidence only for the opened callback", async () => {
    const value = await fixture();
    const expectedAuthorizationDigest = new LatticeCrypto(
      seededRng(401_002),
    ).hash(value.authorizationBytes);
    let retained: TaskRuntimeExecutionEvidenceV1 | null = null;
    const opened = await value.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      ...resultAuthority(),
      operation: async (_domains, _signal, evidence) => {
        await Promise.resolve();
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
          .not.toThrow();
        expect(evidence).toMatchObject({
          purpose: "task.runtime.execution",
          requestId: REQUEST,
          workId: WORK,
          claimId: "task-runtime-claim",
          claimExpiresAt: NOW + 30_000,
          recipientExpiresAt: NOW + 60_000,
          expiresAt: NOW + 30_000,
          recipientGeneration: 0,
          recipientKeyId: KEY,
          policyRevision: 7,
          episodeId: "task-runtime-episode",
          sourceRoomId: ROOM,
          hostAuthorizationRevision: 6,
          recipientAuthorizationRevision: 0,
          operations: ["decrypt", "encrypt"],
          result: RESULT,
        });
        expect(evidence.authorizationDigest)
          .toEqual(expectedAuthorizationDigest);
        expect(evidence.domainRequirements).toEqual([value.current.domains[0]!]);
        expect(evidence.namespaceRequirements).toEqual(CURRENT_NAMESPACES);

        const clone = {
          ...evidence,
          authorizationDigest: evidence.authorizationDigest.slice(),
          domainRequirements: evidence.domainRequirements.map((entry) => ({
            ...entry,
            participantDigest: entry.participantDigest.slice(),
            headDigest: entry.headDigest.slice(),
            activeNamespaceBindingSetDigest:
              entry.activeNamespaceBindingSetDigest.slice(),
          })),
        } as TaskRuntimeExecutionEvidenceV1;
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(clone))
          .toThrow("not active");

        retained = evidence;
        return "executed";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "executed" });
    if (retained === null) throw new Error("execution evidence was not observed");
    expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(retained!))
      .toThrow("not active");
    expectedAuthorizationDigest.fill(0);
  });

  test("rejects result authority not proven by the current Namespace and Domain", async () => {
    for (const changed of [
      "run",
      "access",
      "policy",
      "domain",
      "missing_domain",
    ] as const) {
      const value = await fixture();
      const authority = resultAuthority();
      const result = changed === "run"
        ? Object.freeze({ ...RESULT, taskRunId: "other-task-run" })
        : changed === "policy"
          ? Object.freeze({
            ...RESULT,
            namespace: Object.freeze({
              ...RESULT.namespace,
              expectedPolicyRevision: 8,
            }),
          })
          : changed === "domain"
            ? Object.freeze({
              ...RESULT,
              namespace: Object.freeze({
                ...RESULT.namespace,
                domainId: "other-task-runtime-domain",
              }),
            })
            : authority.result;
      const currentNamespaceRequirements = changed === "access"
        ? Object.freeze([Object.freeze({
          ...CURRENT_NAMESPACES[0]!,
          expectedAccessRevision: 5,
        })])
        : authority.currentNamespaceRequirements;
      const current = changed === "missing_domain"
        ? { ...value.current, domains: Object.freeze([]) }
        : value.current;
      let invoked = false;

      expect(await value.registry.withOpenedGrant({
        requestId: REQUEST,
        workId: WORK,
        recipientGeneration: 0,
        recipientKeyId: KEY,
        claimId: "task-runtime-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes: value.authorizationBytes,
        current,
        result,
        currentNamespaceRequirements,
        operation: () => {
          invoked = true;
        },
      })).toEqual({ status: "unavailable", reason: "authority_stale" });
      expect(invoked).toBe(false);
      value.registry.close();
    }
  });

  test("permanently rejects mutated execution evidence", async () => {
    for (const changed of ["authorization", "authority"] as const) {
      const value = await fixture();
      const opened = await value.registry.withOpenedGrant({
        requestId: REQUEST,
        workId: WORK,
        recipientGeneration: 0,
        recipientKeyId: KEY,
        claimId: "task-runtime-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes: value.authorizationBytes,
        current: value.current,
        ...resultAuthority(),
        operation: (_domains, _signal, evidence) => {
          const changedBytes = changed === "authorization"
            ? evidence.authorizationDigest
            : evidence.domainRequirements[0]?.participantDigest;
          const original = changedBytes?.[0];
          if (changedBytes === undefined || original === undefined) {
            throw new Error("execution evidence bytes are empty");
          }
          changedBytes[0] = original ^ 1;
          expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
            .toThrow("not active");
          changedBytes[0] = original;
          expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
            .toThrow("not active");
          return changed;
        },
      });
      expect(opened).toEqual({ status: "opened", value: changed });
    }
  });

  test("opens one exact grant once and keeps Domain keys inside the callback", async () => {
    const value = await fixture();
    const publicAttempt = value.attempt.recipientPublicKey.slice();
    expect(value.generatedRecipientPublicKey.every((byte) => byte === 0))
      .toBe(true);
    expect(value.generatedRecipientPrivateKey.some((byte) => byte !== 0))
      .toBe(true);
    let observed = -1;
    const opened = await value.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      ...resultAuthority(),
      operation: (domains) => {
        observed = domains[0]!.domainKey[0]!;
        return "executed";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "executed" });
    expect(observed).toBe(9);
    expect(value.registry.size).toBe(0);
    expect(value.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);
    expect(value.attempt.recipientPublicKey).toEqual(publicAttempt);
    expect(await value.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: value.authorizationBytes,
      current: value.current,
      ...resultAuthority(),
      operation: () => "replayed",
    })).toEqual({ status: "unavailable", reason: "recipient_unavailable" });
  });

  test("invalidates execution evidence immediately on abort or clock expiry", async () => {
    let expire = (): void => {
      throw new Error("expiry callback was not scheduled");
    };
    const aborted = await fixture({
      scheduleAt: (_deadline, callback) => {
        expire = callback;
        return { cancel() {} };
      },
    });
    const abortedExecution = aborted.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: aborted.authorizationBytes,
      current: aborted.current,
      ...resultAuthority(),
      operation: (_domains, signal, evidence) => {
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
          .not.toThrow();
        expire();
        expect(signal.aborted).toBe(true);
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
          .toThrow("not active");
        return "expired";
      },
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(abortedExecution).rejects.toThrow("expired");

    const lateTimer = await fixture();
    const lateTimerExecution = await lateTimer.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: lateTimer.authorizationBytes,
      current: lateTimer.current,
      ...resultAuthority(),
      operation: (_domains, signal, evidence) => {
        expect(signal.aborted).toBe(false);
        lateTimer.setNow(NOW + 30_000);
        expect(signal.aborted).toBe(false);
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence))
          .toThrow("not active");
        return "clock-expired";
      },
    });
    expect(lateTimerExecution).toEqual({
      status: "opened",
      value: "clock-expired",
    });
  });

  test("rejects substituted work, generation, key, and authorization", async () => {
    for (const changed of ["work", "generation", "key", "authorization"] as const) {
      const value = await fixture();
      const authorizationBytes = value.authorizationBytes.slice();
      if (changed === "authorization") {
        authorizationBytes[authorizationBytes.length - 1] =
          authorizationBytes[authorizationBytes.length - 1]! ^ 1;
      }
      const result = await value.registry.withOpenedGrant({
        requestId: REQUEST,
        workId: changed === "work" ? "other-work" : WORK,
        recipientGeneration: changed === "generation" ? 1 : 0,
        recipientKeyId: changed === "key" ? "other-key" : KEY,
        claimId: "task-runtime-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes,
        current: value.current,
        ...resultAuthority(),
        operation: () => {
          throw new Error("substituted grant executed");
        },
      });
      expect(result.status).toBe("unavailable");
      value.registry.close();
    }
  });

  test("expiry, caller abort, and close abort execution and remove custody", async () => {
    const expired = await fixture();
    expired.setNow(NOW + 60_000);
    expect(expired.registry.sweep()).toBe(1);
    expect(expired.registry.size).toBe(0);

    let expire = (): void => {
      throw new Error("expiry callback was not scheduled");
    };
    const expiring = await fixture({
      scheduleAt: (_deadline, callback) => {
        expire = callback;
        return { cancel() {} };
      },
    });
    const expiryStarted = Promise.withResolvers<void>();
    const expiryExecution = expiring.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: expiring.authorizationBytes,
      current: expiring.current,
      ...resultAuthority(),
      operation: async (_domains, signal) => {
        expiryStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Task Runtime recipient expired"),
          ), {
            once: true,
          });
        });
      },
    });
    await expiryStarted.promise;
    expire();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(expiryExecution).rejects.toThrow("expired");
    expect(expiring.registry.size).toBe(0);

    const callerAborted = await fixture();
    const callerController = new AbortController();
    const callerStarted = Promise.withResolvers<void>();
    const callerExecution = callerAborted.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: callerAborted.authorizationBytes,
      current: callerAborted.current,
      ...resultAuthority(),
      signal: callerController.signal,
      operation: async (_domains, signal) => {
        callerStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Task Runtime recipient cancelled"),
          ), {
            once: true,
          });
        });
      },
    });
    await callerStarted.promise;
    callerController.abort(new Error("caller cancelled"));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(callerExecution).rejects.toThrow("caller cancelled");
    expect(callerAborted.registry.size).toBe(0);

    const running = await fixture();
    const started = Promise.withResolvers<void>();
    const execution = running.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: running.authorizationBytes,
      current: running.current,
      ...resultAuthority(),
      operation: async (_domains, signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Task Runtime recipient aborted"),
          ), {
            once: true,
          });
        });
      },
    });
    await started.promise;
    running.registry.close();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(execution).rejects.toThrow("removed");
    expect(running.registry.size).toBe(0);
  });

  test("enforces constructor, expiry, duplicate-work, and capacity bounds", async () => {
    for (const maxLive of [
      0,
      1.5,
      PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1 + 1,
    ]) {
      expect(() => new TaskRuntimeRecipientRegistryV1(
        new LatticeCrypto(seededRng(402_001)),
        { maxLive },
      )).toThrow(TypeError);
    }
    expect(() => new TaskRuntimeRecipientRegistryV1(
      new LatticeCrypto(seededRng(402_002)),
      { maxLive: PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1 },
    )).not.toThrow();

    const crypto = new LatticeCrypto(seededRng(402_003), { now: () => NOW });
    const generated: Array<Awaited<
      ReturnType<LatticeCrypto["generateEncryptionKeyPair"]>
    >> = [];
    const generateEncryptionKeyPair =
      crypto.generateEncryptionKeyPair.bind(crypto);
    const generator = spyOn(crypto, "generateEncryptionKeyPair")
      .mockImplementation(async () => {
        const pair = await generateEncryptionKeyPair();
        generated.push(pair);
        return pair;
      });
    const registry = new TaskRuntimeRecipientRegistryV1(crypto, {
      now: () => NOW,
      maxLive: 1,
    });
    const create = (
      requestId: string,
      workId: string,
      recipientGeneration = 0,
    ) => registry.createAttempt({
      requestId,
      workId,
      recipientGeneration,
      recipientKeyId: `${requestId}-key`,
      expiresAt: NOW + 60_000,
    });
    try {
      const created = await create("capacity-request-a", "capacity-work-a");
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("attempt was absent");
      const publicAttempt = created.attempt.recipientPublicKey.slice();
      expect(generated[0]!.publicKey.every((byte) => byte === 0)).toBe(true);
      expect(generated[0]!.privateKey.some((byte) => byte !== 0)).toBe(true);
      expect(registry.hasAttempt({
        requestId: "capacity-request-a",
        workId: "capacity-work-a",
        recipientGeneration: 0,
        recipientKeyId: "capacity-request-a-key",
      })).toBe(true);
      for (const mismatch of [
        { workId: "other-work" },
        { recipientGeneration: 1 },
        { recipientKeyId: "other-key" },
      ]) {
        expect(registry.hasAttempt({
          requestId: "capacity-request-a",
          workId: "capacity-work-a",
          recipientGeneration: 0,
          recipientKeyId: "capacity-request-a-key",
          ...mismatch,
        })).toBe(false);
      }

      expect(await create("capacity-request-a", "capacity-work-a"))
        .toEqual({ status: "unavailable", reason: "duplicate_attempt" });
      expect(await create("capacity-request-b", "capacity-work-a"))
        .toEqual({ status: "unavailable", reason: "duplicate_work" });
      expect(await create("capacity-request-b", "capacity-work-b"))
        .toEqual({ status: "unavailable", reason: "process_capacity" });
      expect(generated).toHaveLength(4);
      for (const rejected of generated.slice(1)) {
        expect(rejected.publicKey.every((byte) => byte === 0)).toBe(true);
        expect(rejected.privateKey.every((byte) => byte === 0)).toBe(true);
      }

      registry.close();
      expect(generated[0]!.privateKey.every((byte) => byte === 0)).toBe(true);
      expect(created.attempt.recipientPublicKey).toEqual(publicAttempt);
      expect(registry.hasAttempt({
        requestId: "capacity-request-a",
        workId: "capacity-work-a",
        recipientGeneration: 0,
        recipientKeyId: "capacity-request-a-key",
      })).toBe(false);
      expect(await create("capacity-request-c", "capacity-work-c"))
        .toEqual({ status: "unavailable", reason: "registry_closed" });
      expect(generated).toHaveLength(4);
      registry.close();
    } finally {
      generator.mockRestore();
      registry.close();
    }
  });

  test("rejects invalid recipient lifetime and malformed generated keypairs", async () => {
    const crypto = new LatticeCrypto(seededRng(402_010), { now: () => NOW });
    const registry = new TaskRuntimeRecipientRegistryV1(crypto, {
      now: () => NOW,
    });
    for (const expiresAt of [
      NOW,
      NOW + DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2 + 1,
    ]) {
      const failure = await registry.createAttempt({
        requestId: `lifetime-request-${expiresAt}`,
        workId: `lifetime-work-${expiresAt}`,
        recipientGeneration: 0,
        recipientKeyId: `lifetime-key-${expiresAt}`,
        expiresAt,
      }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RangeError);
    }
    const exact = await registry.createAttempt({
      requestId: "lifetime-request-exact",
      workId: "lifetime-work-exact",
      recipientGeneration: 0,
      recipientKeyId: "lifetime-key-exact",
      expiresAt: NOW + DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
    });
    expect(exact.status).toBe("created");
    registry.close();

    let now = NOW;
    const delayedCrypto = new LatticeCrypto(
      seededRng(402_011),
      { now: () => now },
    );
    const generated = await delayedCrypto.generateEncryptionKeyPair();
    const delayedGenerator = spyOn(
      delayedCrypto,
      "generateEncryptionKeyPair",
    ).mockImplementation(() => {
      now = NOW + 100;
      return Promise.resolve(generated);
    });
    const delayedRegistry = new TaskRuntimeRecipientRegistryV1(delayedCrypto, {
      now: () => now,
    });
    try {
      const failure = await delayedRegistry.createAttempt({
        requestId: "lifetime-request-delayed",
        workId: "lifetime-work-delayed",
        recipientGeneration: 0,
        recipientKeyId: "lifetime-key-delayed",
        expiresAt: NOW + 100,
      }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RangeError);
      expect(generated.publicKey.every((byte) => byte === 0)).toBe(true);
      expect(generated.privateKey.every((byte) => byte === 0)).toBe(true);
      expect(delayedRegistry.size).toBe(0);
    } finally {
      delayedGenerator.mockRestore();
      delayedRegistry.close();
    }

    for (const malformed of ["private", "public"] as const) {
      const malformedCrypto = new LatticeCrypto(seededRng(
        malformed === "private" ? 402_012 : 402_013,
      ), { now: () => NOW });
      const pair = {
        privateKey: new Uint8Array(
          malformed === "private" ? V2_LIMITS.hpkePrivateKeyBytes - 1 :
            V2_LIMITS.hpkePrivateKeyBytes,
        ).fill(0x41),
        publicKey: new Uint8Array(
          malformed === "public" ? V2_LIMITS.hpkePublicKeyBytes - 1 :
            V2_LIMITS.hpkePublicKeyBytes,
        ).fill(0x42),
      };
      const malformedGenerator = spyOn(
        malformedCrypto,
        "generateEncryptionKeyPair",
      ).mockResolvedValue(pair);
      const malformedRegistry = new TaskRuntimeRecipientRegistryV1(
        malformedCrypto,
        { now: () => NOW },
      );
      try {
        const failure = await malformedRegistry.createAttempt({
          requestId: `malformed-${malformed}-request`,
          workId: `malformed-${malformed}-work`,
          recipientGeneration: 0,
          recipientKeyId: `malformed-${malformed}-key`,
          expiresAt: NOW + 60_000,
        }).then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(TypeError);
        expect(pair.publicKey.every((byte) => byte === 0)).toBe(true);
        expect(pair.privateKey.every((byte) => byte === 0)).toBe(true);
      } finally {
        malformedGenerator.mockRestore();
        malformedRegistry.close();
      }
    }
  });

  test("rejects every stale result-to-current-authority relationship", async () => {
    type Result = TaskRuntimeExecutionEvidenceInputV1["result"];
    type NamespaceRequirements =
      TaskRuntimeExecutionEvidenceInputV1["namespaceRequirements"];
    const requirement = CURRENT_NAMESPACES[0];
    if (requirement === undefined) {
      throw new Error("current Namespace requirement is absent");
    }
    const cases: readonly Readonly<{
      name: string;
      result?: Result;
      namespaces?: NamespaceRequirements;
      current?(value: Awaited<ReturnType<typeof fixture>>):
        DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    }>[] = [
      {
        name: "result revision",
        result: { ...RESULT, contentRevision: 2 } as unknown as Result,
      },
      {
        name: "result operation",
        result: {
          ...RESULT,
          namespace: { ...RESULT.namespace, operations: ["decrypt"] },
        } as unknown as Result,
      },
      { name: "missing Namespace", namespaces: [] },
      {
        name: "duplicate Namespace",
        namespaces: [requirement, requirement],
      },
      {
        name: "Namespace Domain",
        namespaces: [{ ...requirement, domainId: "other-domain" }],
      },
      {
        name: "Namespace operation count",
        namespaces: [{ ...requirement, operations: ["encrypt"] }],
      },
      {
        name: "Namespace operation order",
        namespaces: [{
          ...requirement,
          operations: ["encrypt", "decrypt"],
        }] as unknown as NamespaceRequirements,
      },
      {
        name: "Namespace policy revision",
        namespaces: [{ ...requirement, expectedPolicyRevision: 8 }],
      },
      {
        name: "current policy revision",
        current: (value) => ({ ...value.current, policyRevision: 8 }),
      },
      {
        name: "duplicate current Domain",
        current: (value) => ({
          ...value.current,
          domains: [value.current.domains[0]!, value.current.domains[0]!],
        }),
      },
    ];
    for (const item of cases) {
      const value = await fixture();
      let invoked = false;
      const result = await value.registry.withOpenedGrant({
        requestId: REQUEST,
        workId: WORK,
        recipientGeneration: 0,
        recipientKeyId: KEY,
        claimId: "task-runtime-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes: value.authorizationBytes,
        current: item.current?.(value) ?? value.current,
        result: item.result ?? RESULT,
        currentNamespaceRequirements:
          item.namespaces ?? CURRENT_NAMESPACES,
        operation: () => {
          invoked = true;
        },
      });
      if (result.status !== "unavailable") {
        throw new Error(`substituted ${item.name} was accepted`);
      }
      expect(result.reason).toBe("authority_stale");
      expect(invoked).toBe(false);
      value.registry.close();
      expect(value.generatedRecipientPrivateKey.every((byte) => byte === 0))
        .toBe(true);
    }
  });

  test("fences current recipient identity, pre-abort, in-use, and deadline boundaries", async () => {
    for (const changed of [
      "authorization",
      "generation",
      "key",
    ] as const) {
      const value = await fixture();
      const current = {
        ...value.current,
        ...(changed === "authorization"
          ? { authorizationId: "other-request" }
          : changed === "generation"
            ? { recipientRuntimeGeneration: 1 }
            : { recipientKeyId: "other-key" }),
      };
      expect(await value.registry.withOpenedGrant({
        requestId: REQUEST,
        workId: WORK,
        recipientGeneration: 0,
        recipientKeyId: KEY,
        claimId: "task-runtime-claim",
        claimExpiresAt: NOW + 30_000,
        authorizationBytes: value.authorizationBytes,
        current,
        ...resultAuthority(),
        operation: () => {
          throw new Error(`substituted current ${changed} executed`);
        },
      })).toEqual({
        status: "unavailable",
        reason: "recipient_key_mismatch",
      });
      value.registry.close();
    }

    const deadline = await fixture();
    deadline.setNow(NOW + 30_000);
    expect(await deadline.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: deadline.authorizationBytes,
      current: deadline.current,
      ...resultAuthority(),
      operation: () => {
        throw new Error("expired recipient executed");
      },
    })).toEqual({ status: "unavailable", reason: "recipient_expired" });
    expect(deadline.registry.size).toBe(0);
    expect(deadline.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);

    const preAborted = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const failure = await preAborted.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: preAborted.authorizationBytes,
      current: preAborted.current,
      ...resultAuthority(),
      signal: controller.signal,
      operation: () => {
        throw new Error("pre-aborted recipient executed");
      },
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(preAborted.registry.size).toBe(1);
    expect(preAborted.generatedRecipientPrivateKey.some((byte) => byte !== 0))
      .toBe(true);
    preAborted.registry.close();

    const running = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = running.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: running.authorizationBytes,
      current: running.current,
      ...resultAuthority(),
      operation: async () => {
        started.resolve();
        await release.promise;
        return "first";
      },
    });
    await started.promise;
    expect(await running.registry.withOpenedGrant({
      requestId: REQUEST,
      workId: WORK,
      recipientGeneration: 0,
      recipientKeyId: KEY,
      claimId: "task-runtime-second-claim",
      claimExpiresAt: NOW + 30_000,
      authorizationBytes: running.authorizationBytes,
      current: running.current,
      ...resultAuthority(),
      operation: () => "second",
    })).toEqual({ status: "unavailable", reason: "recipient_in_use" });
    release.resolve();
    expect(await first).toEqual({ status: "opened", value: "first" });
    expect(running.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);
  });

  test("delete and sweep erase custody without mutating the public attempt copy", async () => {
    const deleted = await fixture();
    const publicAttempt = deleted.attempt.recipientPublicKey.slice();
    expect(deleted.registry.delete(REQUEST, 0)).toBe(true);
    expect(deleted.registry.delete(REQUEST, 0)).toBe(false);
    expect(deleted.registry.size).toBe(0);
    expect(deleted.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);
    expect(deleted.attempt.recipientPublicKey).toEqual(publicAttempt);

    const swept = await fixture();
    swept.setNow(NOW + 60_000);
    expect(swept.registry.sweep()).toBe(1);
    expect(swept.registry.sweep()).toBe(0);
    expect(swept.generatedRecipientPrivateKey.every((byte) => byte === 0))
      .toBe(true);
    expect(swept.registry.size).toBe(0);
  });
});

const READ_RESULT = { ...RESULT,
  objectId: `task-run-result:v1:${bytesToHex(sha256(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${RESULT.taskId}\n${WORK}\n1`,
  )))}`,
  terminalStatus: "completed" as const, cryptoAccessRevision: 0 as const,
  genesisManifestHash: bytes(71),
  namespace: { ...RESULT.namespace, operations: ["decrypt"] as const },
};
const WAKE_JOB = "474b01a6-658f-5664-889e-79aedbf85413";

async function readFixture(wake = false, separateForeground = true, authorizationExpiresAt = NOW + 60_000) {
  const requestId = wake ? `task-wake-authorization:${WAKE_JOB}`
    : `task-run-delivery-result-authorization:${WORK}`;
  const value = await fixture(undefined, false, requestId, {
    workId: wake ? WAKE_JOB : WORK, separateForeground, authorizationExpiresAt,
  });
  const common = { bindingId: `task-run-output:${WORK}`, roomId: ROOM,
    sessionId: value.current.sessionId };
  const invocation = wake ? { ...common, kind: "wake" as const, jobId: WAKE_JOB,
    operationId: `task-run-delivery-wake:${WORK}`, reference: {
      kind: "protected_task_delivery_v1" as const, taskId: RESULT.taskId,
      taskRunId: WORK, bindingId: common.bindingId, resultObjectId: READ_RESULT.objectId,
      wakeOperationId: `task-run-delivery-wake:${WORK}`,
    } } : { ...common, kind: "raw" as const, operationId: `task-run-delivery-message:${WORK}` };
  const input = { requestId, workId: wake ? WAKE_JOB : WORK,
    workKind: wake ? "task.delivery_wake" as const : "task.deliver_result" as const,
    recipientGeneration: 0, recipientKeyId: KEY, claimId: "result-read-claim",
    claimExpiresAt: NOW + 30_000, authorizationBytes: value.authorizationBytes,
    current: value.current, requesterHumanId: value.current.subjectHumanId,
    result: READ_RESULT, invocation,
    currentNamespaceRequirements: separateForeground ? [
      { ordinal: 0, ...READ_RESULT.namespace },
      { ordinal: 1, namespaceId: "foreground-namespace", domainId: "foreground-domain",
        expectedAccessRevision: 4, expectedPolicyRevision: 7,
        operations: wake ? ["decrypt", "encrypt"] as const : ["encrypt"] as const },
    ] : [{ ordinal: 0, ...READ_RESULT.namespace, operations: ["decrypt", "encrypt"] as const }],
    currentForegroundNamespaceRequirements: [{ ordinal: 0,
      namespaceId: separateForeground ? "foreground-namespace" : RESULT.namespace.namespaceId,
      domainId: separateForeground ? "foreground-domain" : RESULT.namespace.domainId,
      expectedAccessRevision: 4, expectedPolicyRevision: 7,
      operations: wake ? ["decrypt", "encrypt"] as const : ["encrypt"] as const,
    }],
  };
  return { ...value, input };
}

describe("closed Task result read grants", () => {
  test.each([false, true])("authenticates fresh raw/wake custody and keeps private result out of foreground (%s)", async wake => {
    const value = await readFixture(wake);
    let retained: TaskRuntimeRunResultReadEvidenceV1 | undefined;
    let sourceKey: Uint8Array | undefined;
    const opened = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
      operation: (partitions, _signal, evidence) => {
        const expectedWriteDomain = value.current.domains.find(
          domain => domain.domainId === "foreground-domain",
        );
        if (!wake && expectedWriteDomain === undefined) {
          throw new Error("foreground Domain fixture missing");
        }
        assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
        expect(evidence.operations).toEqual(["decrypt"]);
        expect(evidence.result).toEqual(READ_RESULT);
        expect(evidence.workId).toBe(wake ? WAKE_JOB : WORK);
        expect(evidence.messageWrite).toEqual(wake ? null : {
          taskId: READ_RESULT.taskId,
          taskRunId: READ_RESULT.taskRunId,
          bindingId: `task-run-output:${WORK}`,
          messageOperationId: `task-run-delivery-message:${WORK}`,
          roomId: ROOM,
          sessionId: value.current.sessionId,
          signerAgentId: READ_RESULT.signerAgentId,
          namespace: {
            namespaceId: value.input.currentForegroundNamespaceRequirements[0]!.namespaceId,
            domainId: value.input.currentForegroundNamespaceRequirements[0]!.domainId,
            operations: ["encrypt"],
            expectedAccessRevision: value.input.currentForegroundNamespaceRequirements[0]!.expectedAccessRevision,
            expectedPolicyRevision: value.input.currentForegroundNamespaceRequirements[0]!.expectedPolicyRevision,
          },
          domain: expectedWriteDomain!,
        });
        expect(partitions.resultDomains.map(d => d.domainId)).toEqual([RESULT.namespace.domainId]);
        expect(partitions.foregroundDomains.map(d => d.domainId)).toEqual(["foreground-domain"]);
        expect(partitions.foregroundNamespaceRequirements.map(n => n.namespaceId)).toEqual(["foreground-namespace"]);
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence as unknown as TaskRuntimeExecutionEvidenceV1)).toThrow();
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence as unknown as TaskRuntimeTerminalMessageEvidenceV1)).toThrow();
        retained = evidence; sourceKey = partitions.resultDomains[0].domainKey;
        return "result";
      } });
    expect(opened).toEqual({ status: "opened", value: "result" });
    expect(value.registry.size).toBe(0);
    expect(value.generatedRecipientPrivateKey.every(b => b === 0)).toBe(true);
    expect(sourceKey!.every(b => b === 0)).toBe(true);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(retained!)).toThrow();
  });

  test.each([false, true])("allows independently canonical identical Namespace without duplicating source requirement (%s)", async wake => {
    const value = await readFixture(wake, false);
    expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
      operation: (partitions, _signal, evidence) => {
        expect(partitions.resultDomains[0]).toBe(partitions.foregroundDomains[0]!);
        expect(evidence.result.namespace.operations).toEqual(["decrypt"]);
        expect(evidence.messageWrite?.namespace.namespaceId)
          .toBe(wake ? undefined : READ_RESULT.namespace.namespaceId);
        expect(evidence.messageWrite?.domain.sourceNamespaceId)
          .toBe(wake ? undefined : READ_RESULT.namespace.namespaceId);
        return true;
      } })).toEqual({ status: "opened", value: true });
  });

  test("does not mint Message write authority for cancellation revision or wake delivery", async () => {
    const wake = await readFixture(true);
    expect(await wake.registry.withOpenedRunResultReadGrant({ ...wake.input,
      operation: (_partitions, _signal, evidence) => evidence.messageWrite,
    })).toEqual({ status: "opened", value: null });

    const raw = await readFixture();
    const cancelledResult = { ...READ_RESULT, terminalStatus: "cancelled" as const,
      contentRevision: 2 as const, objectId: CANCEL_RESULT.objectId };
    expect(await raw.registry.withOpenedRunResultReadGrant({ ...raw.input,
      result: cancelledResult,
      currentNamespaceRequirements: [{ ordinal: 0, ...cancelledResult.namespace },
        raw.input.currentNamespaceRequirements[1]!],
      operation: (_partitions, _signal, evidence) => evidence.messageWrite,
    })).toEqual({ status: "opened", value: null });
  });

  test("rejects wrong purpose, work, result, invocation, requester and foreground authority before callback", async () => {
    const changes = [
      { workKind: "task.deliver_message" }, { workId: WAKE_JOB },
      { result: { ...READ_RESULT, contentRevision: 2 } },
      { result: { ...READ_RESULT, objectId: CANCEL_RESULT.objectId } },
      { requesterHumanId: "another-human" },
      { invocation: { kind: "raw", bindingId: `task-run-output:${WORK}`, operationId: `task-run-delivery-message:${WORK}`, roomId: "another-room", sessionId: "task-runtime-episode" } },
      { currentForegroundNamespaceRequirements: [] },
      { currentNamespaceRequirements: [] },
      { currentNamespaceRequirements: CURRENT_NAMESPACES },
      { requestId: `task-wake-authorization:${WAKE_JOB}` },
      { currentForegroundNamespaceRequirements: [{ ...CURRENT_NAMESPACES[0], expectedAccessRevision: 5, operations: ["encrypt"] }] },
    ];
    for (const change of changes) {
      const value = await readFixture();
      let called = false;
      const outcome = await value.registry.withOpenedRunResultReadGrant({ ...value.input, ...change,
        operation: () => { called = true; },
      } as Parameters<typeof value.registry.withOpenedRunResultReadGrant>[0]).catch(() => null);
      expect(called).toBe(false);
      expect(outcome?.status).not.toBe("opened");
      value.registry.close();
    }
  });

  test("rejects expired/disabled grant and invalidates modified or expired evidence within callback", async () => {
    for (const mode of ["disabled", "expired", "tamper", "callback-expiry"] as const) {
      const value = await readFixture();
      if (mode === "expired") value.setNow(NOW + 60_000);
      let called = false;
      const result = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
        current: mode === "disabled" ? { ...value.current, committerDeviceActive: false } : value.current,
        operation: (_partitions, _signal, evidence) => {
          called = true;
          if (mode === "tamper") evidence.result.genesisManifestHash[0] = evidence.result.genesisManifestHash[0]! ^ 1;
          if (mode === "callback-expiry") value.setNow(NOW + 31_000);
          expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow();
        } }).catch(() => null);
      expect(called).toBe(mode === "tamper" || mode === "callback-expiry");
      expect(result?.status).not.toBe("opened");
      expect(value.generatedRecipientPrivateKey.every(b => b === 0)).toBe(true);
      value.registry.close();
    }
  });
});

test("result read expires at the signed grant deadline even when claim and recipient remain live", async () => {
  const value = await readFixture(false, true, NOW + 10_000);
  const failure = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    operation: (_partitions, signal, evidence) => {
      expect(evidence.claimExpiresAt).toBe(NOW + 30_000);
      expect(evidence.recipientExpiresAt).toBe(NOW + 60_000);
      expect(evidence.authorizationExpiresAt).toBe(NOW + 10_000);
      expect(evidence.expiresAt).toBe(NOW + 10_000);
      expect(signal.aborted).toBe(false);
      value.setNow(NOW + 10_000);
      expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow();
    },
  }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(TypeError);
  expect(value.generatedRecipientPrivateKey.every(b => b === 0)).toBe(true);
});

test("shared Domain does not insert source Namespace into independently admitted foreground", async () => {
  const value = await readFixture(false, false);
  const target = { ...value.input.currentForegroundNamespaceRequirements[0]!, namespaceId: "other-foreground-namespace" };
  expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    currentForegroundNamespaceRequirements: [target],
    currentNamespaceRequirements: [{ ordinal: 0, ...READ_RESULT.namespace }, { ...target, ordinal: 1 }],
    operation: (partitions, _signal, evidence) => {
      expect(partitions.foregroundNamespaceRequirements.map(n => n.namespaceId)).toEqual([target.namespaceId]);
      expect(partitions.resultDomains[0]).toBe(partitions.foregroundDomains[0]!);
      expect(evidence.result.namespace.namespaceId).toBe(RESULT.namespace.namespaceId);
      return true;
    },
  })).toEqual({ status: "opened", value: true });
});

test("wake read rejects transplanted or extended durable Job reference before opening", async () => {
  for (const change of [{ taskRunId: RESULT.taskId }, { resultObjectId: CANCEL_RESULT.objectId },
    { wakeOperationId: "other" }, { extra: "not-opaque" }]) {
    const value = await readFixture(true);
    if (value.input.invocation.kind !== "wake") throw new Error("wake fixture missing");
    let called = false;
    const failure = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
      invocation: { ...value.input.invocation, reference: { ...value.input.invocation.reference, ...change } },
      operation: () => { called = true; },
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(called).toBe(false);
    value.registry.close();
  }
});


test.each([false, true])("registry mints foreground evidence only for a verified signed wake (%s)", async wake => {
  const value = await readFixture(wake);
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | null = null;
  let secret: Uint8Array | undefined;
  expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    operation: (partitions, _signal, read, foreground) => {
      expect(read.operations).toEqual(["decrypt"]);
      expect(foreground === null).toBe(!wake);
      if (foreground) {
        retained = foreground;
        assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(foreground);
        expect(foreground.workKind).toBe("task.delivery_wake");
        expect(foreground.namespaceRequirements).toEqual(partitions.foregroundNamespaceRequirements);
        expect(foreground.domainRequirements.map(domain => domain.domainId)).toEqual(["foreground-domain"]);
        expect(foreground.committerDeviceId).toBe(value.current.committerDeviceId);
        expect(foreground.committerDeviceSigningPublicKeyHash).toEqual(value.crypto.hash(value.current.committerDeviceSigningPublicKey));
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(foreground as never)).toThrow();
        expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(read as never)).toThrow();
      }
      secret = partitions.foregroundDomains[0]!.domainKey;
      return true;
    },
  })).toEqual({ status: "opened", value: true });
  expect(secret!.every(byte => byte === 0)).toBe(true);
  expect(value.generatedRecipientPrivateKey.every(byte => byte === 0)).toBe(true);
  if (retained) expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(retained!)).toThrow();
});

test("wake foreground evidence preserves independently admitted same-Namespace roles", async () => {
  const value = await readFixture(true, false);
  expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    operation: (partitions, _signal, read, wake) => {
      if (!wake) throw new Error("missing wake proof");
      assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(wake);
      expect(read.result.namespace.operations).toEqual(["decrypt"]);
      expect(wake.namespaceRequirements[0]!.operations).toEqual(["decrypt", "encrypt"]);
      expect(wake.domainRequirements).toHaveLength(1);
      expect(partitions.resultDomains[0]).toBe(partitions.foregroundDomains[0]!);
      return true;
    },
  })).toEqual({ status: "opened", value: true });
});

test.each(["disabled Device", "Device key", "Domain", "expired", "signature"])(
  "wake proof is never minted after %s denial", async changed => {
    const value = await readFixture(true);
    const current = { ...value.current };
    const authorizationBytes = Uint8Array.from(value.authorizationBytes);
    if (changed === "disabled Device") current.committerDeviceActive = false;
    if (changed === "Device key") current.committerDeviceSigningPublicKey = new Uint8Array(65);
    if (changed === "Domain") current.domains = current.domains.map(domain => ({ ...domain, authorizationRevision: 999 as never }));
    if (changed === "expired") value.setNow(NOW + 30_000);
    if (changed === "signature") authorizationBytes[authorizationBytes.length - 1]! ^= 1;
    let calls = 0;
    const result = await value.registry.withOpenedRunResultReadGrant({ ...value.input, current, authorizationBytes,
      operation: () => { calls++; },
    }).catch(() => null);
    expect(result?.status).not.toBe("opened"); expect(calls).toBe(0);
  });

test("wake foreground admits distinct Namespaces sharing one Domain without importing the private role", async () => {
  const value = await readFixture(true, false);
  const foreground = { ...value.input.currentForegroundNamespaceRequirements[0]!, namespaceId: "other-foreground", ordinal: 1 };
  expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    currentNamespaceRequirements: [{ ordinal: 0, ...READ_RESULT.namespace }, foreground],
    currentForegroundNamespaceRequirements: [foreground],
    operation: (partitions, _signal, read, wake) => {
      if (!wake) throw new Error("missing wake proof");
      assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(wake);
      expect(wake.namespaceRequirements.map(n => n.namespaceId)).toEqual(["other-foreground"]);
      expect(wake.domainRequirements).toHaveLength(1);
      expect(read.result.namespace.namespaceId).toBe(READ_RESULT.namespace.namespaceId);
      expect(partitions.foregroundDomains[0]).toBe(partitions.resultDomains[0]);
      return true;
    },
  })).toEqual({ status: "opened", value: true });
});

test.each(["throw", "expiry", "delete"])("wake foreground revokes and wipes Domain custody on %s", async reason => {
  const value = await readFixture(true);
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | undefined;
  let key: Uint8Array | undefined;
  const result = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    operation: (partitions, _signal, _read, wake) => {
      if (!wake) throw new Error("missing wake proof");
      retained = wake; key = partitions.foregroundDomains[0]!.domainKey;
      if (reason === "throw") throw new Error("callback failed");
      if (reason === "expiry") value.setNow(NOW + 30_000);
      if (reason === "delete") value.registry.delete(value.input.requestId, 0);
      expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(wake)).toThrow();
    },
  }).catch(() => null);
  expect(result?.status).not.toBe("opened");
  expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(retained!)).toThrow();
  expect(key!.every(byte => byte === 0)).toBe(true);
  expect(value.generatedRecipientPrivateKey.every(byte => byte === 0)).toBe(true);
  expect(value.registry.size).toBe(0);
});


test("signed wake lends a separate encrypt-only destination sharing a Domain without adding source reads", async () => {
  const value = await readFixture(true, false);
  const foreground = { ...value.input.currentForegroundNamespaceRequirements[0]!, namespaceId: "ordinary-foreground", ordinal: 1 };
  const mutation = { roomId: "projection-room", semanticDigest: "a".repeat(64),
    namespace: { ...foreground, namespaceId: "projection-destination", ordinal: 2, operations: ["encrypt"] as const } };
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | undefined;
  let secret: Uint8Array | undefined;
  expect(await value.registry.withOpenedRunResultReadGrant({ ...value.input,
    currentNamespaceRequirements: [{ ordinal: 0, ...READ_RESULT.namespace }, foreground, mutation.namespace],
    currentForegroundNamespaceRequirements: [foreground], currentAdditionalMutationDestination: mutation,
    operation: (partitions, _signal, read, wake) => {
      if (!wake) throw new Error("wake evidence missing");
      retained = wake;
      assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(wake);
      expect(read.operations).toEqual(["decrypt"]);
      expect(wake.namespaceRequirements.map(n => n.namespaceId)).toEqual(["ordinary-foreground"]);
      expect(wake.additionalMutationDestination).toEqual(mutation);
      expect(wake.additionalMutationDestination?.namespace.operations).toEqual(["encrypt"]);
      expect(partitions.additionalMutationDomains).toHaveLength(1);
      expect(partitions.additionalMutationDomains![0]).toBe(partitions.foregroundDomains[0]);
      secret = partitions.additionalMutationDomains![0]!.domainKey;
      return true;
    },
  })).toEqual({ status: "opened", value: true });
  expect(secret!.every(b => b === 0)).toBe(true);
  expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(retained!)).toThrow();
});

test.each(["decrypt", "ordinary alias", "private alias", "unsigned Domain", "semantic digest", "raw"])(
  "additional wake mutation refuses %s before custody", async changed => {
    const value = await readFixture(changed !== "raw", false);
    const foreground = { ...value.input.currentForegroundNamespaceRequirements[0]!, namespaceId: "ordinary", ordinal: 1 };
    const mutation = { roomId: "projection-room", semanticDigest: changed === "semantic digest" ? "invalid" : "a".repeat(64),
      namespace: { ...foreground, ordinal: 2,
        namespaceId: changed === "ordinary alias" ? foreground.namespaceId : changed === "private alias" ? READ_RESULT.namespace.namespaceId : "target",
        domainId: changed === "unsigned Domain" ? "not-signed" : foreground.domainId,
        operations: changed === "decrypt" ? ["decrypt", "encrypt"] as const : ["encrypt"] as const } };
    let calls = 0;
    const outcome = await value.registry.withOpenedRunResultReadGrant({ ...value.input,
      currentNamespaceRequirements: [{ ordinal: 0, ...READ_RESULT.namespace }, foreground, mutation.namespace],
      currentForegroundNamespaceRequirements: [foreground], currentAdditionalMutationDestination: mutation,
      operation: () => { calls++; },
    }).catch(() => null);
    expect(outcome?.status).not.toBe("opened"); expect(calls).toBe(0);
  },
);
