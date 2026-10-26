import { expect, mock, test } from "bun:test";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from "@nautilo/lattice-bridge";
import { createLiveShadowDataOperationPolicyBinding, type TaskObserverDeps } from "@nautilo/runtime";
import {
  createTaskOccurrencePolicyPorts,
  type TaskOccurrencePolicyHealth,
} from "../../src/routes/task-occurrence-policy";

type ProtectedPort = Parameters<Parameters<NonNullable<TaskObserverDeps["protectedOccurrencePort"]>["withCurrent"]>[0]>[0];

test.each([
  ["plaintext_only", "fallback", true, false],
  ["shadow_encryption", "fallback", true, true],
  ["shadow_encryption", "strict", false, true],
  ["encrypted_only", "strict", false, true],
] as const)("%s/%s selects occurrence queries before either family runs", async (
  mode, shadowBehavior, ordinaryAllowed, protectedAllowed,
) => {
  const owner = bindEncryptionDataOperationOwner({
    policy: createLiveShadowDataOperationPolicyBinding(async () => ({ mode, shadowBehavior, revision: 1 })),
  });
  const port: ProtectedPort = { observeProtectedTaskOccurrence: async () => {} };
  const initialize = mock(async () => port);
  const ordinaryQueries = mock(async () => "ordinary-claim");
  const protectedQueries = mock(async (current: typeof port) => {
    expect(current).toBe(port);
    return "protected-claim";
  });
  const occurrence = createTaskOccurrencePolicyPorts(owner, initialize);
  expect(await occurrence.ordinary.withCurrent(ordinaryQueries))
    .toBe(ordinaryAllowed ? "ordinary-claim" : null);
  expect(await occurrence.protected.withCurrent(protectedQueries))
    .toBe(protectedAllowed ? "protected-claim" : null);
  expect(ordinaryQueries).toHaveBeenCalledTimes(ordinaryAllowed ? 1 : 0);
  expect(protectedQueries).toHaveBeenCalledTimes(protectedAllowed ? 1 : 0);
  expect(initialize).toHaveBeenCalledTimes(protectedAllowed ? 1 : 0);
});

test("unavailable current policy enters neither ordinary nor protected queries", async () => {
  const owner = bindEncryptionDataOperationOwner({
    policy: { resolve: async () => { throw new Error("Policy unavailable"); }, revalidate: async () => {} },
  });
  const initialize = mock(async () => null);
  const queries = mock(async () => true);
  const occurrence = createTaskOccurrencePolicyPorts(owner, initialize);
  expect(occurrence.ordinary.withCurrent(queries)).rejects.toThrow("Policy unavailable");
  expect(occurrence.protected.withCurrent(queries)).rejects.toThrow("Policy unavailable");
  expect(queries).not.toHaveBeenCalled();
  expect(initialize).not.toHaveBeenCalled();
});

function protectedOwner(revision = 7) {
  return bindEncryptionDataOperationOwner({
    policy: createLiveShadowDataOperationPolicyBinding(async () => ({
      mode: "encrypted_only",
      shadowBehavior: "fallback",
      revision,
    })),
  });
}

function health(currentRevision: number | null = 7) {
  return {
    resolveExactPolicyRevision: mock(async (_token: number) => currentRevision),
    record: mock(async (_observation: unknown) => {}),
    retireLegacyUnsupported: mock(async (_policyRevision: number) => {}),
  };
}

test("records a verified Task observer only after a real protected handoff succeeds", async () => {
  const observation = health();
  const publish = mock(async () => {});
  const occurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({ observeProtectedTaskOccurrence: publish }),
    observation,
  );

  expect(await occurrence.protected.withCurrent(async port => {
    await port.observeProtectedTaskOccurrence(null as never);
    return "observed";
  })).toBe("observed");
  expect(publish).toHaveBeenCalledTimes(1);
  expect(observation.resolveExactPolicyRevision).toHaveBeenCalledWith(7);
  expect(observation.record).toHaveBeenCalledWith({
    policyRevision: 7,
    state: "verified",
    reason: "none",
    retryable: false,
  });
  expect(observation.retireLegacyUnsupported).not.toHaveBeenCalled();
});

test("an idle successful scan retires only the exact legacy signal without claiming verified", async () => {
  const observation = health();
  const occurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({ observeProtectedTaskOccurrence: async () => {} }),
    observation,
  );

  expect(await occurrence.protected.withCurrent(async () => "idle")).toBe("idle");
  expect(observation.retireLegacyUnsupported).toHaveBeenCalledWith(7);
  expect(observation.record).not.toHaveBeenCalled();
});

test("a changed policy token records and retires nothing", async () => {
  const observation = health(null);
  const occurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({ observeProtectedTaskOccurrence: async () => {} }),
    observation,
  );

  await occurrence.protected.withCurrent(async port => {
    await port.observeProtectedTaskOccurrence(null as never);
  });
  expect(observation.record).not.toHaveBeenCalled();
  expect(observation.retireLegacyUnsupported).not.toHaveBeenCalled();
});

test("known initialization and handoff waits remain non-verified metadata", async () => {
  const unavailable = health();
  const unavailableOccurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => null,
    unavailable,
  );
  expect(await unavailableOccurrence.protected.withCurrent(async () => "unused"))
    .toBeNull();
  expect(unavailable.record).toHaveBeenCalledWith({
    policyRevision: 7,
    state: "waiting_for_authority",
    reason: "recovery_required",
    retryable: true,
  });

  const waiting = health();
  const waitingOccurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({
      observeProtectedTaskOccurrence: async () => {
        throw new ClassifiedDataOperationError("key_waiting", "device offline");
      },
    }),
    waiting,
  );
  await waitingOccurrence.protected.withCurrent(async port => {
    const error = await port.observeProtectedTaskOccurrence(null as never)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(error).toMatchObject({ message: "device offline" });
  });
  expect(waiting.record).toHaveBeenCalledWith({
    policyRevision: 7,
    state: "waiting_for_authority",
    reason: "recovery_required",
    retryable: true,
  });
  expect(waiting.retireLegacyUnsupported).not.toHaveBeenCalled();
});

test("an initializer failure records health without replacing the scheduler error", async () => {
  const observation = health();
  const original = new ClassifiedDataOperationError(
    "key_waiting",
    "initial authority unavailable",
  );
  const occurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => { throw original; },
    observation,
  );

  const error = await occurrence.protected.withCurrent(async () => "unused")
    .catch((cause: unknown) => cause);
  expect(error).toBe(original);
  expect(observation.record).toHaveBeenCalledWith({
    policyRevision: 7,
    state: "waiting_for_authority",
    reason: "recovery_required",
    retryable: true,
  });
  expect(observation.retireLegacyUnsupported).not.toHaveBeenCalled();
});

test("an actual unsupported handoff remains failed after a later idle scan", async () => {
  type Observation = Parameters<TaskOccurrencePolicyHealth["record"]>[0];
  let stored: Observation | null = {
    policyRevision: 7,
    state: "unsupported",
    reason: "unsupported_operation",
    retryable: false,
  };
  const observation: TaskOccurrencePolicyHealth = {
    resolveExactPolicyRevision: mock(async () => 7),
    record: mock(async (current: Observation) => { stored = current; }),
    retireLegacyUnsupported: mock(async (policyRevision: number) => {
      if (
        stored?.policyRevision === policyRevision
        && stored.state === "unsupported"
        && stored.reason === "unsupported_operation"
      ) {
        stored = null;
      }
    }),
  };
  const rejected = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({
      observeProtectedTaskOccurrence: async () => {
        throw new ClassifiedDataOperationError(
          "unsupported",
          "selected occurrence cannot be handed off",
        );
      },
    }),
    observation,
  );

  const original = await rejected.protected.withCurrent(async port =>
    port.observeProtectedTaskOccurrence(null as never),
  ).catch((cause: unknown) => cause);
  expect(original).toBeInstanceOf(ClassifiedDataOperationError);
  expect(stored).toEqual({
    policyRevision: 7,
    state: "failed",
    reason: "unknown_result",
    retryable: false,
  });

  const idle = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({ observeProtectedTaskOccurrence: async () => {} }),
    observation,
  );
  expect(await idle.protected.withCurrent(async () => "idle")).toBe("idle");
  expect(observation.retireLegacyUnsupported).toHaveBeenCalledWith(7);
  expect(stored).toEqual({
    policyRevision: 7,
    state: "failed",
    reason: "unknown_result",
    retryable: false,
  });
});

test("Plain performs no Task observer health writes", async () => {
  const observation = health(3);
  const owner = bindEncryptionDataOperationOwner({
    policy: createLiveShadowDataOperationPolicyBinding(async () => ({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 3,
    })),
  });
  const occurrence = createTaskOccurrencePolicyPorts(
    owner,
    async () => ({ observeProtectedTaskOccurrence: async () => {} }),
    observation,
  );

  expect(await occurrence.protected.withCurrent(async () => "protected"))
    .toBeNull();
  expect(observation.resolveExactPolicyRevision).not.toHaveBeenCalled();
  expect(observation.record).not.toHaveBeenCalled();
  expect(observation.retireLegacyUnsupported).not.toHaveBeenCalled();
});

test("health metadata failures never alter the protected scheduler result", async () => {
  const observation = health();
  observation.record.mockImplementation(async () => {
    throw new Error("health unavailable");
  });
  const occurrence = createTaskOccurrencePolicyPorts(
    protectedOwner(),
    async () => ({ observeProtectedTaskOccurrence: async () => {} }),
    observation,
  );

  expect(await occurrence.protected.withCurrent(async port => {
    await port.observeProtectedTaskOccurrence(null as never);
    return "scheduled";
  })).toBe("scheduled");
});
