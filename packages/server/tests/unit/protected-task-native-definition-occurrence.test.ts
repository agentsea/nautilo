import { describe, expect, test } from "bun:test";

import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";

import {
  createCurrentNativeProtectedTaskDefinitionOccurrenceLoader,
  type LoadCurrentNativeProtectedTaskDefinitionOccurrenceInput,
} from "../../src/routes/protected-task-native-definition-occurrence";
import type {
  CurrentProtectedTaskRuntimeAuthorityPort,
  HeldProtectedTaskRuntimeAuthority,
} from "../../src/routes/task-runtime-current-authority";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "25000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
const DEVICE = "60000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const NAMESPACE = "80000000-0000-4000-8000-000000000008";
const DOMAIN = "90000000-0000-4000-8000-000000000009";

function occurrence(
  overrides: Partial<ProtectedTaskRunningOccurrence["task"]> = {},
): ProtectedTaskRunningOccurrence {
  const contentRevision = overrides.contentRevision ?? 4;
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: null,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: TASK,
        contentRevision,
      }),
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      ...overrides,
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: JOB,
      graphThreadId: `task:${TASK}:${RUN}`,
      status: "running" as const,
      startedAt: new Date(1_800_000_000_000),
    }),
  });
}

function held(overrides: Readonly<{
  roomId?: string;
  policyRevision?: number;
  accessRevision?: number;
  nativeExecutionSupported?: boolean;
}> = {}): HeldProtectedTaskRuntimeAuthority {
  const policyRevision = overrides.policyRevision ?? 7;
  return {
    foreground: {
      authorizationId: "authorization:task",
      policyRevision,
      sessionId: `task-run:${RUN}`,
      roomId: overrides.roomId ?? ROOM,
      subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningGeneration: 1,
      committerDeviceSigningPublicKey: new Uint8Array(32),
      committerDeviceActive: true,
      hostAuthorizationRevision: authorizationRevision(1),
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 1,
      recipientKeyId: `task-runtime:${RUN}:1`,
      recipientAuthorized: true,
      domains: [],
    },
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: overrides.accessRevision ?? 3,
      expectedPolicyRevision: policyRevision,
    }],
    ...(overrides.nativeExecutionSupported === undefined
      ? {}
      : { nativeExecutionSupported: overrides.nativeExecutionSupported }),
  };
}

function input(
  value: ProtectedTaskRunningOccurrence = occurrence(),
): LoadCurrentNativeProtectedTaskDefinitionOccurrenceInput {
  return {
    runner: {} as never,
    restricted: {} as never,
    crypto: {} as never,
    serverScope: "https://nautilo.example",
    subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE },
    occurrence: value,
    record: {
      snapshot: { state: "claimed", workId: RUN },
      domainId: DOMAIN,
      expectedNamespaceAccessRevision: 3,
      expectedPolicyRevision: 7,
      authoritySet: {
        namespaceRequirements: [{
          ordinal: 0,
          namespaceId: NAMESPACE,
          domainId: DOMAIN,
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 3,
          expectedPolicyRevision: 7,
        }],
        domainRequirements: [],
      },
    } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3,
    request: { workId: RUN, sourceRoomId: ROOM } as never,
    now: () => 1_800_000_000_000,
  };
}

function port(
  current: HeldProtectedTaskRuntimeAuthority | null,
): CurrentProtectedTaskRuntimeAuthorityPort {
  return async value => current === null ? null : value.use(current);
}

describe("native protected Task definition occurrence loader", () => {
  test("opens from the real claimed-before-running-record order after current authority releases", async () => {
    let insideAuthority = false;
    const observedState: { value: string | null } = { value: null };
    const withCurrentAuthority: CurrentProtectedTaskRuntimeAuthorityPort =
      async value => {
        insideAuthority = true;
        observedState.value = value.record.snapshot.state;
        const result = value.use(held());
        insideAuthority = false;
        return result;
      };
    const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority,
    });
    const result = await loader(input());

    expect(insideAuthority).toBe(false);
    expect(observedState.value).toBe("claimed");
    expect(result).toEqual({
      taskId: TASK,
      taskRunId: RUN,
      sourceRoomId: ROOM,
      agentId: AGENT,
      requesterHumanId: HUMAN,
      objectId: occurrence().task.cryptoObjectId,
      contentRevision: 4,
      cryptoAccessRevision: 0,
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      expectedAccessRevision: 3,
      expectedPolicyRevision: 7,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("admits only claimed or running durable execution phases", async () => {
    let authorityCalls = 0;
    const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority: async value => {
        authorityCalls += 1;
        return value.use(held());
      },
    });
    const stale = input();
    const awaiting = {
      ...stale,
      record: {
        ...stale.record,
        snapshot: { ...stale.record.snapshot, state: "grant_ready" },
      } as BackgroundAuthorizationTaskRuntimeRecordV3,
    };
    expect(await loader(awaiting)).toBeNull();
    expect(authorityCalls).toBe(0);

    const running = {
      ...stale,
      record: {
        ...stale.record,
        snapshot: { ...stale.record.snapshot, state: "running" },
      } as BackgroundAuthorizationTaskRuntimeRecordV3,
    };
    expect(await loader(running)).not.toBeNull();
    expect(authorityCalls).toBe(1);

    const unavailable = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority: port(null),
    });
    expect(await unavailable(input())).toBeNull();
  });

  test("rejects source Room, policy, or Namespace revision drift", async () => {
    for (const current of [
      held({ roomId: "room:changed" }),
      {
        ...held(),
        namespaceRequirements: [{
          ...held().namespaceRequirements[0]!,
          expectedPolicyRevision: 8,
        }],
      },
      held({ accessRevision: 4 }),
    ]) {
      const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
        withCurrentAuthority: port(current),
      });
      expect(await loader(input())).toBeNull();
    }
  });

  test("rejects substituted encrypted definition object or access revision", async () => {
    let authorityCalls = 0;
    const withCurrentAuthority: CurrentProtectedTaskRuntimeAuthorityPort =
      async value => {
        authorityCalls += 1;
        return value.use(held());
      };
    const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority,
    });
    const wrongObject = occurrence({
      cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    });
    const wrongRevision = occurrence({ cryptoAccessRevision: 1 });

    expect(await loader(input(wrongObject))).toBeNull();
    expect(await loader(input(wrongRevision))).toBeNull();
    expect(authorityCalls).toBe(0);
  });

  test("requires an explicit current native route only when requested", async () => {
    for (const current of [
      held({ nativeExecutionSupported: false }),
      held(),
    ]) {
      const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader(
        { withCurrentAuthority: port(current) },
        { requireNativeExecution: true },
      );
      expect(await loader(input())).toBeNull();
    }

    const required = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader(
      { withCurrentAuthority: port(held({ nativeExecutionSupported: true })) },
      { requireNativeExecution: true },
    );
    expect(await required(input())).not.toBeNull();

    const compatible = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority: port(held()),
    });
    expect(await compatible(input())).not.toBeNull();
  });
});
