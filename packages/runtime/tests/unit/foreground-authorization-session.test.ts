import { describe, expect, test } from "bun:test";

import type {
  ProtectedInvocationCapability,
  ProtectedInvocationCapabilityDescription,
} from "@nautilo/lattice-bridge";

import {
  FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS,
  FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
  FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS,
  FOREGROUND_AUTHORIZATION_MAX_SESSIONS,
  TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  ForegroundAuthorizationSessionRegistry,
  foregroundAuthorizationChildWorkDescriptorDigest,
  type ForegroundAuthorizationBinding,
  type ForegroundAuthorizationContentPort,
  type ForegroundAuthorizationNamespaceSetPort,
  type ForegroundAuthorizationCapabilityDescription,
  type TaskRuntimeAuthorizationBinding,
} from "../../src/protected-execution/foreground-authorization-session";
import type { ProtectedInvocationCapabilityPort } from "../../src/protected-execution/lease-registry";

const NOW = 1_000_000;
const SECRET = "M237-FOREGROUND-SESSION-SECRET";

function childWorkDigest(childExecutionId = "child-execution"): Uint8Array {
  return foregroundAuthorizationChildWorkDescriptorDigest({
    parentInvocationId: "parent-invocation",
    childExecutionId,
  });
}

type FakeCapability = ProtectedInvocationCapability & {
  readonly description: ProtectedInvocationCapabilityDescription;
};

function binding(
  overrides: Partial<ForegroundAuthorizationBinding> = {},
): ForegroundAuthorizationBinding {
  return Object.freeze({
    humanId: "human-alice",
    issuingDeviceId: "device-alice",
    recipientAgentId: "agent-genie",
    ...overrides,
  });
}

function taskRuntimeBinding(
  overrides: Partial<TaskRuntimeAuthorizationBinding> = {},
): TaskRuntimeAuthorizationBinding {
  return Object.freeze({
    humanId: "human-alice",
    issuingDeviceId: "device-alice",
    recipientKind: "nautilo_task_runtime",
    taskRunId: "task-run-a",
    authorizationEpisodeId: "task-episode-a",
    sourceRoomId: "room-source-a",
    ...overrides,
  });
}

function fixture(options: Readonly<{
  readonly block?: boolean;
  readonly neverSettle?: boolean;
  readonly denyExecution?: number;
  readonly contentResult?: "executed" | "authorization_unavailable"
    | "content_unavailable" | "content_invalid";
}> = {}) {
  let now = NOW;
  let nextSessionId = 0;
  let nextViewId = 0;
  let nextLeaseId = 0;
  let executions = 0;
  const observedTargets: Array<Readonly<{
    namespaceId: string;
    domainId: string;
  }>> = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const known = new WeakSet<object>();
  const destroyed: ProtectedInvocationCapability[] = [];
  const capabilityPort: ProtectedInvocationCapabilityPort = {
    inspect: (candidate) =>
      known.has(candidate)
        ? (candidate as FakeCapability).description
        : null,
    destroy: (candidate) => {
      if (known.delete(candidate)) destroyed.push(candidate);
    },
  };
  const contentPort: ForegroundAuthorizationContentPort = {
    execute: async (input) => {
      executions += 1;
      observedTargets.push({
        namespaceId: input.namespaceId,
        domainId: input.domainId,
      });
      if (options.neverSettle === true) {
        return await new Promise<never>(() => {});
      }
      if (options.denyExecution === executions) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      if (options.block === true) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          const completed = () => {
            input.signal?.removeEventListener("abort", completed);
            resolve();
          };
          input.signal?.addEventListener("abort", completed, {
            once: true,
          });
          void blocked.then(completed);
        });
      }
      if (input.signal?.aborted === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      if (
        options.contentResult !== undefined
        && options.contentResult !== "executed"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: options.contentResult,
        });
      }
      const plaintext = new TextEncoder().encode(SECRET);
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await input.execute(plaintext),
        });
      } finally {
        plaintext.fill(0);
      }
    },
  };
  const registry = new ForegroundAuthorizationSessionRegistry({
    capabilityPort,
    contentPort,
    now: () => now,
    createSessionId: () => `session-${++nextSessionId}`,
    createViewId: () => `view-${++nextViewId}`,
    createLeaseId: () => `lease-${++nextLeaseId}`,
    startSweep: false,
  });
  const createCapability = (
    invocationId = "invocation-a",
    overrides: Partial<ProtectedInvocationCapabilityDescription> = {},
  ) => {
    const description = Object.freeze({
      invocationId,
      grantId: `grant-${invocationId}`,
      issuedAt: NOW,
      expiresAt: NOW + 4 * 60 * 60 * 1_000,
      issuingDeviceId: "device-alice",
      issuingHumanId: "human-alice",
      recipientAgentId: "agent-genie",
      recipientKeyId: `key-${invocationId}`,
      namespaceIds: Object.freeze(["namespace-a", "namespace-b"]),
      domainIds: Object.freeze(["domain-a", "domain-b"]),
      ...overrides,
    });
    const capability = Object.freeze({
      invocationId,
      expiresAt: description.expiresAt,
      description,
    }) as FakeCapability;
    known.add(capability);
    return capability;
  };

  return {
    createCapability,
    destroyed,
    executions: () => executions,
    observedTargets,
    registry,
    unblock() {
      unblock?.();
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function register(
  state: ReturnType<typeof fixture>,
  overrides: Readonly<{
    capability?: FakeCapability;
    authenticatedBinding?: ForegroundAuthorizationBinding;
    sessionDeadline?: number;
  }> = {},
) {
  const result = state.registry.register({
    capability: overrides.capability ?? state.createCapability(),
    authenticatedBinding:
      overrides.authenticatedBinding ?? binding(),
    allowedOperations: Object.freeze(["decrypt", "encrypt"]),
    ...(overrides.sessionDeadline === undefined
      ? {}
      : { sessionDeadline: overrides.sessionDeadline }),
  });
  if (result.status !== "registered") {
    throw new Error(`registration failed: ${result.reason}`);
  }
  return result;
}

function lease(
  state: ReturnType<typeof fixture>,
  view: ReturnType<typeof register>["rootView"],
  overrides: Readonly<{
    operation?: "decrypt" | "encrypt";
    namespaceId?: string;
    domainId?: string;
    executionDeadline?: number;
  }> = {},
) {
  const result = state.registry.leaseOperation({
    view,
    entrypointId: "foreground.main",
    operation: overrides.operation ?? "decrypt",
    namespaceId: overrides.namespaceId ?? "namespace-a",
    domainId: overrides.domainId ?? "domain-a",
    ...(overrides.executionDeadline === undefined
      ? {}
      : { executionDeadline: overrides.executionDeadline }),
  });
  if (result.status !== "leased") {
    throw new Error(`lease failed: ${result.reason}`);
  }
  return result.lease;
}

function leaseSet(
  state: ReturnType<typeof fixture>,
  view: ReturnType<typeof register>["rootView"],
  overrides: Readonly<{
    operation?: "decrypt" | "encrypt";
    namespaceIds?: readonly string[];
    executionDeadline?: number;
  }> = {},
) {
  const result = state.registry.leaseNamespaceSetOperation({
    view,
    entrypointId: "foreground.main",
    operation: overrides.operation ?? "decrypt",
    namespaceIds:
      overrides.namespaceIds ?? Object.freeze(["namespace-a", "namespace-b"]),
    ...(overrides.executionDeadline === undefined
      ? {}
      : { executionDeadline: overrides.executionDeadline }),
  });
  if (result.status !== "leased") {
    throw new Error(`set lease failed: ${result.reason}`);
  }
  return result.lease;
}

function namespaceSetPort(options: Readonly<{
  readonly block?: boolean;
  readonly deny?: boolean;
}> = {}) {
  const observed: Array<Readonly<{
    capability: ProtectedInvocationCapability;
    entrypointId: string;
    operation: "decrypt" | "encrypt";
    namespaceIds: readonly string[];
    domainIds: readonly string[];
  }>> = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const port: ForegroundAuthorizationNamespaceSetPort = {
    execute: async (input) => {
      observed.push(Object.freeze({
        capability: input.capability,
        entrypointId: input.entrypointId,
        operation: input.operation,
        namespaceIds: input.namespaceIds,
        domainIds: input.domainIds,
      }));
      if (options.block === true) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          const completed = () => {
            input.signal?.removeEventListener("abort", completed);
            resolve();
          };
          input.signal?.addEventListener("abort", completed, { once: true });
          void blocked.then(completed);
        });
      }
      if (input.signal?.aborted === true || options.deny === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      return Object.freeze({
        status: "executed" as const,
        value: await input.execute(),
      });
    },
  };
  return {
    observed,
    port,
    unblock() {
      unblock?.();
    },
  };
}

describe("M237 foreground authorization session registry", () => {
  test("Task Runtime admits the protocol scope bound without widening foreground sessions", () => {
    const registerCount = (count: number, taskRuntime: boolean) => {
      const ids = Object.freeze(Array.from(
        { length: count },
        (_, index) => String(index).padStart(5, "0"),
      ));
      const capability = Object.freeze({
        description: Object.freeze({
          authorizationId: "scope-authorization",
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
          issuingHumanId: "human-alice",
          issuingDeviceId: "device-alice",
          ...(taskRuntime
            ? {
                recipientKind: "nautilo_task_runtime" as const,
                taskRunId: "task-run-a",
                authorizationEpisodeId: "task-episode-a",
                sourceRoomId: "room-source-a",
              }
            : { recipientAgentId: "agent-genie" }),
          recipientKeyId: "scope-recipient-key",
          namespaceIds: ids,
          domainIds: ids,
        }),
      });
      const registry = new ForegroundAuthorizationSessionRegistry<typeof capability>({
        capabilityPort: {
          inspect: () => capability.description,
          destroy: () => {},
        },
        now: () => NOW,
        createSessionId: () => "scope-session",
        createViewId: () => "scope-view",
        createLeaseId: () => "scope-lease",
        startSweep: false,
      });
      const result = registry.register({
        capability,
        authenticatedBinding: taskRuntime
          ? taskRuntimeBinding()
          : binding(),
        allowedOperations: ["decrypt"],
      });
      registry.close();
      return result.status;
    };

    expect(registerCount(257, false)).toBe("unavailable");
    expect(registerCount(257, true)).toBe("registered");
    expect(registerCount(16_383, true)).toBe("registered");
    expect(registerCount(16_384, true)).toBe("registered");
    expect(registerCount(16_385, true)).toBe("unavailable");
  });

  test("binds Task Runtime sessions to one exact occurrence and authorization episode", () => {
    type TaskCapability = Readonly<{
      description: ForegroundAuthorizationCapabilityDescription;
    }>;
    let now = NOW;
    const destroyed: TaskCapability[] = [];
    const capability = Object.freeze({
      description: Object.freeze({
        authorizationId: "task-authorization-a",
        issuedAt: NOW,
        expiresAt: NOW + 4 * 60 * 60 * 1_000,
        issuingHumanId: "human-alice",
        issuingDeviceId: "device-alice",
        recipientKind: "nautilo_task_runtime" as const,
        taskRunId: "task-run-a",
        authorizationEpisodeId: "task-episode-a",
        sourceRoomId: "room-source-a",
        recipientKeyId: "task-runtime-key-a",
        namespaceIds: Object.freeze(["namespace-a"]),
        domainIds: Object.freeze(["domain-a"]),
      }),
    });
    const registry = new ForegroundAuthorizationSessionRegistry<TaskCapability>({
      capabilityPort: {
        inspect: (candidate) => candidate === capability
          ? candidate.description
          : null,
        destroy: (candidate) => {
          destroyed.push(candidate);
        },
      },
      now: () => now,
      createSessionId: () => "task-session-a",
      createViewId: () => "task-view-a",
      createLeaseId: () => "task-lease-a",
      startSweep: false,
    });
    const registered = registry.register({
      capability,
      authenticatedBinding: taskRuntimeBinding(),
      allowedOperations: Object.freeze(["decrypt"]),
    });
    expect(registered.status).toBe("registered");
    if (registered.status !== "registered") return;

    for (const authenticatedBinding of [
      taskRuntimeBinding({ taskRunId: "task-run-b" }),
      taskRuntimeBinding({ authorizationEpisodeId: "task-episode-b" }),
      taskRuntimeBinding({ sourceRoomId: "room-source-b" }),
      taskRuntimeBinding({ humanId: "human-mallory" }),
      taskRuntimeBinding({ issuingDeviceId: "device-mallory" }),
      binding({ recipientAgentId: "agent-genie" }),
    ]) {
      expect(registry.resolve({
        sessionId: registered.sessionId,
        authenticatedBinding,
      })).toEqual({
        status: "unavailable",
        reason: "binding_mismatch",
      });
    }
    expect(destroyed).toEqual([]);
    expect(registry.leaseOperation({
      view: registered.rootView,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
    })).toEqual({
      status: "unavailable",
      reason: "operation_scope_widened",
    });

    now = NOW + TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS - 1;
    expect(registry.resolve({
      sessionId: registered.sessionId,
      authenticatedBinding: taskRuntimeBinding(),
    }).status).toBe("resolved");
    now = NOW + TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS;
    expect(registry.resolve({
      sessionId: registered.sessionId,
      authenticatedBinding: taskRuntimeBinding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_expired",
    });
    expect(destroyed).toEqual([capability]);
  });

  test("reuses one opaque recipient session across one-shot operation leases", async () => {
    const state = fixture();
    const session = register(state);

    for (const expected of ["first", "second"]) {
      const operation = lease(state, session.rootView);
      expect(await state.registry.execute(
        operation,
        (plaintext) => {
          expect(state.registry.currentOperationLease())
            .toBe(operation);
          expect(new TextDecoder().decode(plaintext)).toBe(SECRET);
          return expected;
        },
      )).toEqual({ status: "executed", value: expected });
      expect(await state.registry.execute(
        operation,
        () => "must-not-run",
      )).toEqual({
        status: "unavailable",
        reason: "lease_unavailable",
      });
    }

    expect(state.executions()).toBe(2);
    expect(state.destroyed).toEqual([]);
    expect(state.registry.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");
    expect(await state.registry.execute(
      { ...lease(state, session.rootView) },
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
  });

  test("enforces the two-hour absolute and thirty-minute idle policy exactly", async () => {
    const state = fixture();
    const session = register(state);

    state.setNow(NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1);
    expect(await state.registry.execute(
      lease(state, session.rootView),
      () => "refresh",
    )).toEqual({ status: "executed", value: "refresh" });

    state.setNow(
      NOW + 2 * FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 2,
    );
    expect(state.registry.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");

    state.setNow(
      NOW + 2 * FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1,
    );
    expect(state.registry.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_idle_expired",
    });
    expect(state.destroyed).toHaveLength(1);

    const absoluteState = fixture();
    const absolute = register(absoluteState);
    absoluteState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS - 1,
    );
    expect(absoluteState.registry.resolve({
      sessionId: absolute.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_idle_expired",
    });

    const activeState = fixture();
    const active = register(activeState);
    for (
      let time = NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1;
      time < NOW + FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS;
      time += FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1
    ) {
      activeState.setNow(time);
      expect((await activeState.registry.execute(
        lease(activeState, active.rootView),
        () => "active",
      )).status).toBe("executed");
    }
    activeState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
    );
    expect(activeState.registry.resolve({
      sessionId: active.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_expired",
    });
  });

  test("uses shorter signed and explicit session deadlines", () => {
    const signedState = fixture();
    const signed = register(signedState, {
      capability: signedState.createCapability("signed", {
        expiresAt: NOW + 1_000,
      }),
    });
    signedState.setNow(NOW + 1_000);
    expect(signedState.registry.resolve({
      sessionId: signed.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_expired",
    });

    const explicitState = fixture();
    const explicit = register(explicitState, {
      sessionDeadline: NOW + 500,
    });
    explicitState.setNow(NOW + 500);
    expect(explicitState.registry.resolve({
      sessionId: explicit.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_expired",
    });
  });

  test("does not refresh idle on lookup, failure, or unauthorized execution", async () => {
    for (
      const contentResult of [
        "content_unavailable",
        "content_invalid",
      ] as const
    ) {
      const state = fixture({ contentResult });
      const session = register(state);
      state.setNow(
        NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1,
      );
      expect((await state.registry.execute(
        lease(state, session.rootView),
        () => "must-not-run",
      )).status).toBe("unavailable");
      state.setNow(NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS);
      expect(state.registry.resolve({
        sessionId: session.sessionId,
        authenticatedBinding: binding(),
      })).toEqual({
        status: "unavailable",
        reason: "session_idle_expired",
      });
    }

    const lookupState = fixture();
    const lookup = register(lookupState);
    lookupState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1,
    );
    expect(lookupState.registry.resolve({
      sessionId: lookup.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");
    lookupState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
    );
    expect(lookupState.registry.resolve({
      sessionId: lookup.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("unavailable");

    const failedState = fixture();
    const failed = register(failedState);
    failedState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS - 1,
    );
    const failure = await failedState.registry.execute(
      lease(failedState, failed.rootView),
      () => {
        throw new Error("M237-SECRET-FAILURE-CANARY");
      },
    );
    expect(failure).toEqual({
      status: "unavailable",
      reason: "execution_failed",
    });
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    failedState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
    );
    expect(failedState.registry.resolve({
      sessionId: failed.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("unavailable");

    const deniedState = fixture({
      contentResult: "authorization_unavailable",
    });
    const denied = register(deniedState);
    const denial = await deniedState.registry.execute(
      lease(deniedState, denied.rootView),
      () => "must-not-run",
    );
    expect(denial.status).toBe("unavailable");
    if (denial.status !== "unavailable") return;
    expect(denial.reason).toBe("authorization_unavailable");
    expect(deniedState.destroyed).toHaveLength(1);
    expect(deniedState.registry.resolve({
      sessionId: denied.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("unavailable");
  });

  test("lets an operation begun before idle finish and refresh, but aborts at absolute expiry", async () => {
    const idleState = fixture({ block: true });
    const idleSession = register(idleState);
    const running = idleState.registry.execute(
      lease(idleState, idleSession.rootView),
      () => "finished",
    );
    await Promise.resolve();
    idleState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
    );
    expect(idleState.registry.resolve({
      sessionId: idleSession.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_idle_expired",
    });
    expect(idleState.destroyed).toEqual([]);
    idleState.unblock();
    expect(await running).toEqual({
      status: "executed",
      value: "finished",
    });
    expect(idleState.registry.resolve({
      sessionId: idleSession.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");

    const absoluteState = fixture({ block: true });
    const absoluteSession = register(absoluteState);
    const expires = absoluteState.registry.execute(
      lease(absoluteState, absoluteSession.rootView),
      () => "must-not-complete",
    );
    await Promise.resolve();
    absoluteState.setNow(
      NOW + FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
    );
    expect(absoluteState.registry.sweep()).toBe(1);
    expect(await expires).toEqual({
      status: "unavailable",
      reason: "session_expired",
    });
    expect(absoluteState.destroyed).toHaveLength(1);
  });

  test("separates operation cancellation and deadline from terminal session cancellation", async () => {
    const abortedState = fixture({ block: true });
    const abortedSession = register(abortedState);
    const controller = new AbortController();
    const aborted = abortedState.registry.execute(
      lease(abortedState, abortedSession.rootView),
      () => "must-not-complete",
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    expect(await aborted).toEqual({
      status: "unavailable",
      reason: "lease_cancelled",
    });
    expect(abortedState.destroyed).toEqual([]);
    expect(abortedState.registry.resolve({
      sessionId: abortedSession.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");

    const deadlineState = fixture({ block: true });
    const deadlineSession = register(deadlineState);
    const deadline = deadlineState.registry.execute(
      lease(deadlineState, deadlineSession.rootView, {
        executionDeadline: NOW + 10,
      }),
      () => "must-not-complete",
    );
    await Promise.resolve();
    deadlineState.setNow(NOW + 10);
    deadlineState.registry.sweep();
    expect(await deadline).toEqual({
      status: "unavailable",
      reason: "lease_expired",
    });
    expect(deadlineState.destroyed).toEqual([]);

    const cancelledState = fixture({ block: true });
    const cancelledSession = register(cancelledState);
    const cancelled = cancelledState.registry.execute(
      lease(cancelledState, cancelledSession.rootView),
      () => "must-not-complete",
    );
    await Promise.resolve();
    expect(cancelledState.registry.cancelSession({
      sessionId: cancelledSession.sessionId,
      authenticatedBinding: binding(),
    })).toBe(true);
    expect(await cancelled).toEqual({
      status: "unavailable",
      reason: "session_cancelled",
    });
    expect(cancelledState.destroyed).toHaveLength(1);
  });

  test("allows bounded concurrent operation leases and cascades current-authority loss", async () => {
    const concurrentState = fixture({ block: true });
    const concurrentSession = register(concurrentState);
    const first = concurrentState.registry.execute(
      lease(concurrentState, concurrentSession.rootView),
      () => "first",
    );
    const second = concurrentState.registry.execute(
      lease(concurrentState, concurrentSession.rootView),
      () => "second",
    );
    await Promise.resolve();
    expect(concurrentState.executions()).toBe(2);
    concurrentState.unblock();
    expect(await Promise.all([first, second])).toEqual([
      { status: "executed", value: "first" },
      { status: "executed", value: "second" },
    ]);
    expect(concurrentState.destroyed).toEqual([]);

    const revokedState = fixture({
      block: true,
      denyExecution: 2,
    });
    const revokedSession = register(revokedState);
    const active = revokedState.registry.execute(
      lease(revokedState, revokedSession.rootView),
      () => "must-not-complete",
    );
    await Promise.resolve();
    const denial = await revokedState.registry.execute(
      lease(revokedState, revokedSession.rootView),
      () => "must-not-run",
    );
    expect(denial).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(await active).toEqual({
      status: "unavailable",
      reason: "session_cancelled",
    });
    expect(revokedState.destroyed).toHaveLength(1);
  });

  test("requires the exact authenticated Human, device, and recipient Agent", () => {
    const state = fixture();
    const session = register(state);

    for (const authenticatedBinding of [
      binding({ humanId: "human-mallory" }),
      binding({ issuingDeviceId: "device-mallory" }),
      binding({ recipientAgentId: "agent-other" }),
    ]) {
      expect(state.registry.resolve({
        sessionId: session.sessionId,
        authenticatedBinding,
      })).toEqual({
        status: "unavailable",
        reason: "binding_mismatch",
      });
    }
    expect(state.destroyed).toEqual([]);

    const falseHuman = fixture();
    const falseHumanCapability = falseHuman.createCapability(
      "false-human",
      { issuingHumanId: "human-alice" },
    );
    expect(falseHuman.registry.register({
      capability: falseHumanCapability,
      authenticatedBinding: binding({ humanId: "human-mallory" }),
      allowedOperations: Object.freeze(["decrypt"]),
    })).toEqual({
      status: "unavailable",
      reason: "binding_invalid",
    });
    expect(falseHuman.destroyed).toEqual([falseHumanCapability]);
  });

  test("creates bounded child views without widening scope or lifetime", async () => {
    const state = fixture();
    const session = register(state);
    const child = state.registry.createChildView({
      parent: session.rootView,
      namespaceIds: Object.freeze(["namespace-a"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: childWorkDigest(),
      deadline: NOW + 10_000,
    });
    expect(child.status).toBe("created");
    if (child.status !== "created") return;
    expect(child.view.workDescriptorDigestBase64url).toBe(
      Buffer.from(childWorkDigest()).toString("base64url"),
    );

    expect(state.registry.leaseOperation({
      view: child.view,
      entrypointId: "subagent.scope",
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
    })).toEqual({
      status: "unavailable",
      reason: "operation_scope_widened",
    });
    expect(state.registry.createChildView({
      parent: child.view,
      namespaceIds: Object.freeze(["namespace-a", "namespace-b"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: childWorkDigest("nested-child"),
    })).toEqual({
      status: "unavailable",
      reason: "child_scope_widened",
    });

    for (
      let index = 1;
      index < FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS;
      index += 1
    ) {
      expect(state.registry.createChildView({
        parent: session.rootView,
        namespaceIds: Object.freeze(["namespace-a"]),
        domainIds: Object.freeze(["domain-a"]),
        operations: Object.freeze(["decrypt"]),
        workDescriptorDigest: childWorkDigest(`capacity-child-${index}`),
      }).status).toBe("created");
    }
    expect(state.registry.createChildView({
      parent: session.rootView,
      namespaceIds: Object.freeze(["namespace-a"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: childWorkDigest("capacity-overflow"),
    })).toEqual({
      status: "unavailable",
      reason: "child_capacity",
    });

    const exactLease = lease(state, child.view, {
      namespaceId: "namespace-a",
      domainId: "domain-a",
    });
    expect(await state.registry.execute(
      exactLease,
      () => "child-result",
    )).toEqual({
      status: "executed",
      value: "child-result",
    });
    expect(state.observedTargets).toEqual([{
      namespaceId: "namespace-a",
      domainId: "domain-a",
    }]);
  });

  test("binds child views to exact content-free parent and child identities", () => {
    const first = childWorkDigest("child-a");
    const second = childWorkDigest("child-b");
    const otherParent = foregroundAuthorizationChildWorkDescriptorDigest({
      parentInvocationId: "other-parent",
      childExecutionId: "child-a",
    });
    expect(first).toHaveLength(32);
    expect(first).not.toEqual(second);
    expect(first).not.toEqual(otherParent);

    const state = fixture();
    const session = register(state);
    expect(state.registry.createChildView({
      parent: session.rootView,
      namespaceIds: Object.freeze(["namespace-a"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: new Uint8Array(31),
    })).toEqual({
      status: "unavailable",
      reason: "child_scope_invalid",
    });
  });

  test("rejects every deferred background entrypoint", () => {
    const state = fixture();
    const session = register(state);
    const deferredEntrypoints = [
      "task.dispatch",
      "task.execute",
      "task.approval_resume",
      "compaction.model",
      "stenographer.extraction",
      "stenographer.compaction",
      "memory.review",
      "memory.exit_flush",
      "artifact.read",
      "artifact.write",
    ] as const;

    expect(FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS).not.toContain(
      deferredEntrypoints[0],
    );
    for (const entrypointId of deferredEntrypoints) {
      expect(state.registry.leaseOperation({
        view: session.rootView,
        entrypointId,
        operation: "decrypt",
        namespaceId: "namespace-a",
        domainId: "domain-a",
      })).toEqual({
        status: "unavailable",
        reason: "operation_scope_widened",
      });
    }
  });

  test("admits the foreground Conductor as a decrypt-only root operation", async () => {
    expect(FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS).toContain(
      "foreground.conductor",
    );
    const state = fixture();
    const session = register(state);
    const leased = state.registry.leaseOperation({
      view: session.rootView,
      entrypointId: "foreground.conductor",
      operation: "decrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
    });
    expect(leased.status).toBe("leased");
    if (leased.status !== "leased") return;
    expect(await state.registry.execute(leased.lease, (plaintext) =>
      new TextDecoder().decode(plaintext)
    )).toEqual({ status: "executed", value: SECRET });
  });

  test("destroys terminal recipient authority even when execution never settles", async () => {
    const state = fixture({ neverSettle: true });
    const session = register(state);
    void state.registry.execute(
      lease(state, session.rootView),
      () => "must-never-run",
    );
    await Promise.resolve();

    expect(state.registry.cancelSession({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    })).toBe(true);
    expect(state.destroyed).toHaveLength(1);
    expect(state.registry.size).toBe(0);

    const replacement = register(state);
    expect(replacement.status).toBe("registered");
  });

  test("reclaims operation capacity when non-cooperative work is cancelled", async () => {
    const callerState = fixture({ neverSettle: true });
    const callerSession = register(callerState);
    const controller = new AbortController();
    const callerResult = callerState.registry.execute(
      lease(callerState, callerSession.rootView),
      () => "must-never-run",
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    expect(await callerResult).toEqual({
      status: "unavailable",
      reason: "lease_cancelled",
    });

    const deadlineState = fixture({ neverSettle: true });
    const deadlineSession = register(deadlineState);
    const deadlineResult = deadlineState.registry.execute(
      lease(deadlineState, deadlineSession.rootView, {
        executionDeadline: NOW + 1,
      }),
      () => "must-never-run",
    );
    await Promise.resolve();
    deadlineState.setNow(NOW + 1);
    deadlineState.registry.sweep();
    expect(await deadlineResult).toEqual({
      status: "unavailable",
      reason: "lease_expired",
    });

    const childState = fixture({ neverSettle: true });
    const childSession = register(childState);
    const child = childState.registry.createChildView({
      parent: childSession.rootView,
      namespaceIds: Object.freeze(["namespace-a"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: childWorkDigest("cancelled-child"),
    });
    if (child.status !== "created") throw new Error("child unavailable");
    const childResult = childState.registry.execute(
      lease(childState, child.view),
      () => "must-never-run",
    );
    await Promise.resolve();
    expect(childState.registry.releaseView(child.view)).toBe(true);
    expect(await childResult).toEqual({
      status: "unavailable",
      reason: "lease_cancelled",
    });

    for (const [state, session] of [
      [callerState, callerSession],
      [deadlineState, deadlineSession],
      [childState, childSession],
    ] as const) {
      expect(state.registry.liveOperationCount).toBe(0);
      state.registry.cancelSession({
        sessionId: session.sessionId,
        authenticatedBinding: binding(),
      });
    }
  });

  test("leases only canonical Namespace-set subsets and privately binds exact view Domains", async () => {
    const state = fixture();
    const capability = state.createCapability();
    const session = register(state, { capability });

    for (const namespaceIds of [
      Object.freeze([]),
      Object.freeze(["namespace-a", "namespace-a"]),
      Object.freeze(["namespace-b", "namespace-a"]),
      Object.freeze(["namespace-a", "namespace-c"]),
    ]) {
      expect(state.registry.leaseNamespaceSetOperation({
        view: session.rootView,
        entrypointId: "foreground.main",
        operation: "decrypt",
        namespaceIds,
      })).toEqual({
        status: "unavailable",
        reason: "operation_scope_widened",
      });
    }
    expect(state.registry.leaseNamespaceSetOperation({
      view: session.rootView,
      entrypointId: "memory.review",
      operation: "decrypt",
      namespaceIds: Object.freeze(["namespace-a"]),
    })).toEqual({
      status: "unavailable",
      reason: "operation_scope_widened",
    });

    const setPort = namespaceSetPort();
    const operation = leaseSet(state, session.rootView, {
      namespaceIds: Object.freeze(["namespace-b"]),
    });
    expect(await state.registry.executeNamespaceSet(operation, {
      contentPort: setPort.port,
      execute: () => "set-result",
    })).toEqual({ status: "executed", value: "set-result" });
    expect(setPort.observed).toEqual([{
      capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceIds: ["namespace-b"],
      domainIds: ["domain-a", "domain-b"],
    }]);
    expect(state.registry.liveOperationCount).toBe(0);
    expect(await state.registry.executeNamespaceSet(operation, {
      contentPort: setPort.port,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
  });

  test("keeps Namespace-set child views narrowed and rejects the wrong lease kind", async () => {
    const state = fixture();
    const session = register(state);
    const child = state.registry.createChildView({
      parent: session.rootView,
      namespaceIds: Object.freeze(["namespace-a"]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt"]),
      workDescriptorDigest: childWorkDigest("namespace-set-child"),
    });
    if (child.status !== "created") throw new Error("child unavailable");

    expect(state.registry.leaseNamespaceSetOperation({
      view: child.view,
      entrypointId: "subagent.scope",
      operation: "decrypt",
      namespaceIds: Object.freeze(["namespace-a", "namespace-b"]),
    })).toEqual({
      status: "unavailable",
      reason: "operation_scope_widened",
    });
    const setPort = namespaceSetPort();
    const childLease = state.registry.leaseNamespaceSetOperation({
      view: child.view,
      entrypointId: "subagent.scope",
      operation: "decrypt",
      namespaceIds: Object.freeze(["namespace-a"]),
    });
    if (childLease.status !== "leased") throw new Error("set lease unavailable");
    expect(await state.registry.executeNamespaceSet(childLease.lease, {
      contentPort: setPort.port,
      execute: () => "child-set",
    })).toEqual({ status: "executed", value: "child-set" });
    expect(setPort.observed[0]).toMatchObject({
      namespaceIds: ["namespace-a"],
      domainIds: ["domain-a"],
    });

    const wrongSingular = lease(state, session.rootView);
    expect(await state.registry.executeNamespaceSet(wrongSingular, {
      contentPort: setPort.port,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
    const wrongSet = leaseSet(state, session.rootView);
    expect(await state.registry.execute(
      wrongSet,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
    expect(state.registry.liveOperationCount).toBe(0);
  });

  test("applies expiry, revocation, and cancellation semantics to Namespace-set leases", async () => {
    const expiredState = fixture();
    const expiredSession = register(expiredState);
    const expiredLease = leaseSet(expiredState, expiredSession.rootView, {
      executionDeadline: NOW + 1,
    });
    expiredState.setNow(NOW + 1);
    expect(await expiredState.registry.executeNamespaceSet(expiredLease, {
      contentPort: namespaceSetPort().port,
      execute: () => "must-not-run",
    })).toEqual({ status: "unavailable", reason: "lease_expired" });
    expect(expiredState.registry.liveOperationCount).toBe(0);

    const sessionExpiryState = fixture();
    const sessionExpiry = register(sessionExpiryState, {
      capability: sessionExpiryState.createCapability("set-expiry", {
        expiresAt: NOW + 2,
      }),
    });
    const sessionExpiryLease = leaseSet(
      sessionExpiryState,
      sessionExpiry.rootView,
    );
    sessionExpiryState.setNow(NOW + 2);
    expect(await sessionExpiryState.registry.executeNamespaceSet(
      sessionExpiryLease,
      {
        contentPort: namespaceSetPort().port,
        execute: () => "must-not-run",
      },
    )).toEqual({ status: "unavailable", reason: "session_expired" });
    expect(sessionExpiryState.destroyed).toHaveLength(1);
    expect(sessionExpiryState.registry.liveOperationCount).toBe(0);

    const callerState = fixture();
    const callerSession = register(callerState);
    const callerPort = namespaceSetPort({ block: true });
    const controller = new AbortController();
    const cancelled = callerState.registry.executeNamespaceSet(
      leaseSet(callerState, callerSession.rootView),
      {
        contentPort: callerPort.port,
        execute: () => "must-not-complete",
        signal: controller.signal,
      },
    );
    await Promise.resolve();
    controller.abort();
    expect(await cancelled).toEqual({
      status: "unavailable",
      reason: "lease_cancelled",
    });
    expect(callerState.destroyed).toEqual([]);
    expect(callerState.registry.liveOperationCount).toBe(0);

    const revokedState = fixture();
    const revokedSession = register(revokedState);
    expect(await revokedState.registry.executeNamespaceSet(
      leaseSet(revokedState, revokedSession.rootView),
      {
        contentPort: namespaceSetPort({ deny: true }).port,
        execute: () => "must-not-run",
      },
    )).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(revokedState.destroyed).toHaveLength(1);
    expect(revokedState.registry.size).toBe(0);

    const sessionState = fixture();
    const activeSession = register(sessionState);
    const activePort = namespaceSetPort({ block: true });
    const active = sessionState.registry.executeNamespaceSet(
      leaseSet(sessionState, activeSession.rootView),
      {
        contentPort: activePort.port,
        execute: () => "must-not-complete",
      },
    );
    await Promise.resolve();
    expect(sessionState.registry.cancelSession({
      sessionId: activeSession.sessionId,
      authenticatedBinding: binding(),
    })).toBeTrue();
    expect(await active).toEqual({
      status: "unavailable",
      reason: "session_cancelled",
    });
    expect(sessionState.destroyed).toHaveLength(1);
    expect(sessionState.registry.liveOperationCount).toBe(0);
  });

  test("supports distinct concurrent Namespace-set leases while each lease remains one-shot", async () => {
    const state = fixture();
    const session = register(state);
    const setPort = namespaceSetPort({ block: true });
    const firstLease = leaseSet(state, session.rootView, {
      namespaceIds: Object.freeze(["namespace-a"]),
    });
    const secondLease = leaseSet(state, session.rootView, {
      namespaceIds: Object.freeze(["namespace-b"]),
    });
    const first = state.registry.executeNamespaceSet(firstLease, {
      contentPort: setPort.port,
      execute: () => "first",
    });
    const second = state.registry.executeNamespaceSet(secondLease, {
      contentPort: setPort.port,
      execute: () => "second",
    });
    await Promise.resolve();
    expect(setPort.observed).toHaveLength(2);
    expect(await state.registry.executeNamespaceSet(firstLease, {
      contentPort: setPort.port,
      execute: () => "duplicate",
    })).toEqual({
      status: "unavailable",
      reason: "lease_in_use",
    });
    setPort.unblock();
    expect(await Promise.all([first, second])).toEqual([
      { status: "executed", value: "first" },
      { status: "executed", value: "second" },
    ]);
    expect(state.registry.liveOperationCount).toBe(0);
  });

  test("cascades explicit cancellation and registry close without reconstruction", () => {
    const state = fixture();
    const session = register(state);
    const resolved = state.registry.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    });
    expect(resolved.status).toBe("resolved");
    expect(state.registry.cancelSession({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    })).toBe(true);
    expect(state.destroyed).toHaveLength(1);
    expect(state.registry.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("unavailable");

    const restarted = fixture().registry;
    expect(restarted.resolve({
      sessionId: session.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_unavailable",
    });

    const second = register(state);
    state.registry.close();
    expect(state.destroyed).toHaveLength(2);
    expect(state.registry.resolve({
      sessionId: second.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "registry_closed",
    });
  });

  test("enforces the process session bound", () => {
    const state = fixture();
    for (
      let index = 0;
      index < FOREGROUND_AUTHORIZATION_MAX_SESSIONS;
      index += 1
    ) {
      expect(state.registry.register({
        capability: state.createCapability(`invocation-${index}`),
        authenticatedBinding: binding(),
        allowedOperations: Object.freeze(["decrypt"]),
      }).status).toBe("registered");
    }
    const overflow = state.createCapability("overflow");
    expect(state.registry.register({
      capability: overflow,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt"]),
    })).toEqual({
      status: "unavailable",
      reason: "process_capacity",
    });
    expect(state.destroyed).toEqual([overflow]);
  });
});
