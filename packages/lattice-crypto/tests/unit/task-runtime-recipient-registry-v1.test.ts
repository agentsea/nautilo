import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  domainForegroundNamespaceBindingSetDigestV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import { TaskRuntimeRecipientRegistryV1 } from
  "../../src/background/task-runtime-recipient-registry-v1.ts";
import type { TaskRuntimeRecipientDeadlineSchedulerV1 } from
  "../../src/background/task-runtime-recipient-registry-v1.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_400_000_000;
const REQUEST = "task-runtime-request";
const WORK = "10000000-0000-4000-8000-000000000001";
const KEY = "task-runtime-key";
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
const CURRENT_NAMESPACES = Object.freeze([Object.freeze({
  ordinal: 0,
  namespaceId: RESULT.namespace.namespaceId,
  domainId: RESULT.namespace.domainId,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
  expectedAccessRevision: RESULT.namespace.expectedAccessRevision,
  expectedPolicyRevision: RESULT.namespace.expectedPolicyRevision,
})]);

const resultAuthority = () => ({
  result: RESULT,
  currentNamespaceRequirements: CURRENT_NAMESPACES,
});

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture(
  scheduler?: TaskRuntimeRecipientDeadlineSchedulerV1,
) {
  let now = NOW;
  const crypto = new LatticeCrypto(seededRng(401_001), { now: () => now });
  const registry = new TaskRuntimeRecipientRegistryV1(crypto, {
    now: () => now,
    ...(scheduler === undefined ? {} : { scheduler }),
  });
  const attempt = await registry.createAttempt({
    requestId: REQUEST,
    workId: WORK,
    recipientGeneration: 0,
    recipientKeyId: KEY,
    expiresAt: NOW + 60_000,
  });
  if (attempt.status !== "created") throw new Error("recipient unavailable");
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
    authorizationId: REQUEST,
    policyRevision: 7,
    sessionId: "task-runtime-episode",
    roomId: "task-runtime-room",
    subjectHumanId: humanId("task-runtime-human"),
    committerDeviceId: cryptoDeviceId("task-runtime-device"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(6),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: KEY,
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const secrets: readonly DomainForegroundSecretEntryV2[] = [{
    ...domain,
    domainKey: bytes(9),
  }];
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
    registry,
    attempt: attempt.attempt,
    authorizationBytes,
    current,
    setNow: (value: number) => { now = value; },
  };
}

describe("Task Runtime recipient registry", () => {
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
          sourceRoomId: "task-runtime-room",
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
});
