import { describe, expect, test } from "bun:test";

import { deriveTaskContentCryptoObjectIdV1, taskContentRevisionObjectIdV1 } from "@nautilo/lattice-bridge";
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
  repoDocsSelection?: { mode: "init" | "update" | "auto"; publish: "branch" | "push" | "pr" };
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
    ...(overrides.repoDocsSelection === undefined
      ? {}
      : { repoDocsSelection: overrides.repoDocsSelection }),
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

  test("rejects substituted encrypted definition object or malformed access revision", async () => {
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
    expect(await loader(input(wrongObject))).toBeNull();
    for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await loader(input(occurrence({ cryptoAccessRevision: revision })))).toBeNull();
    }
    expect(authorityCalls).toBe(0);
  });

  test("carries the exact current mapped rewrap revision through genuine runtime authority", async () => {
    const value = occurrence({ cryptoAccessRevision: 3 });
    const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority: async request => {
        expect(request.occurrence.task.cryptoAccessRevision).toBe(3);
        return request.use(held());
      },
    });
    const opened = await loader(input(value));
    expect(opened?.cryptoAccessRevision).toBe(3);
    expect(opened?.expectedAccessRevision).toBe(3);
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

    const repoDocs = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader(
      { withCurrentAuthority: port(held({ repoDocsSelection: { mode: "update", publish: "pr" } })) },
      { requireRepoDocsSelection: { mode: "update", publish: "pr" } },
    );
    expect(await repoDocs(input())).not.toBeNull();
    const substituted = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader(
      { withCurrentAuthority: port(held({ repoDocsSelection: { mode: "init", publish: "pr" } })) },
      { requireRepoDocsSelection: { mode: "update", publish: "pr" } },
    );
    expect(await substituted(input())).toBeNull();
  });
});


test("native occurrence loader preserves exact historical provenance for the full-chain opener", async () => {
  const provenance = { version: 2, claimId: RUN, publisherDeviceId: DEVICE, signedRequestDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64), sourcePayloadHash: "c".repeat(64), sourceRevision: 0,
    genesisManifestHash: "d".repeat(64) } as const;
  const current = input();
  const historical = occurrence({ contentRevision: 1, definitionHistoricalRepair: provenance,
    cryptoObjectId: taskContentRevisionObjectIdV1({ coordinate: { kind: "definition", taskId: TASK, contentRevision: 1 },
      namespaceId: NAMESPACE, historicalRepair: provenance }) });
  const loader = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({ withCurrentAuthority: port(held()) });
  const result = await loader({ ...current, occurrence: historical });
  expect(result?.definitionHistoricalRepair).toEqual(provenance);
  expect(result?.objectId).toBe(historical.task.cryptoObjectId);
  expect(await loader({ ...current, occurrence: { ...historical, task: { ...historical.task,
    definitionHistoricalRepair: null } } })).toBeNull();
});
