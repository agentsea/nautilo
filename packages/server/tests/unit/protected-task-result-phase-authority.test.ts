import { expect, test } from "bun:test";

import type { DirectDatabase } from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  TaskContentAuthorityV1,
  TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import {
  createProtectedTaskResultPhaseAuthorityResolver,
  type ProtectedTaskResultPhaseAuthorityDependencies,
  type ProtectedTaskResultPhaseAuthorityInput,
} from "../../src/routes/protected-task-result-phase-authority";
import type { HeldProtectedTaskRuntimeAuthority } from "../../src/routes/task-runtime-current-authority";

const OWNER = "10000000-0000-4000-8000-000000000001";
const REQUESTER = "20000000-0000-4000-8000-000000000002";
const HUMAN = "30000000-0000-4000-8000-000000000003";
const DEVICE = "40000000-0000-4000-8000-000000000004";
const AGENT = "50000000-0000-4000-8000-000000000005";
const TASK = "60000000-0000-4000-8000-000000000006";
const RUN = "70000000-0000-4000-8000-000000000007";
const ROOM = "80000000-0000-4000-8000-000000000008";
const NAMESPACE = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const REQUEST = `task-run-authorization:${RUN}`;

function bytes(fill: number, length: number = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function occurrence(): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: OWNER,
      requestorId: REQUESTER,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 2,
      cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(1),
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `task:${TASK}:${RUN}`,
      status: "awaiting" as const,
      startedAt: new Date(2_000_000_000_000),
    }),
  });
}

function record(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Object.freeze({
    snapshot: Object.freeze({
      formatVersion: 3,
      credentialSubject: Object.freeze({
        kind: "runtime",
        runtimeKind: "task",
        runtimeVersion: 1,
      }),
      requestId: REQUEST,
      workId: RUN,
      namespaceId: NAMESPACE,
      descriptorDigest: "11".repeat(32),
      recipientGeneration: 1,
      recipient: Object.freeze({
        recipientKeyId: "recipient:task",
        recipientPublicKey: "public-key",
        expiresAt: 2_000_000_100_000,
      }),
      acceptedResponse: Object.freeze({
        kind: "runtime",
        responseDigest: "22".repeat(32),
        credentialDigest: "22".repeat(32),
        issuingHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        recipientGeneration: 1,
        acceptedAt: 2_000_000_000_000,
      }),
      state: "running",
      claimId: "claim:task",
      claimExpiresAt: 2_000_000_100_000,
      requestRevision: 3,
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
      retryCount: 0,
      lastRetryReason: null,
      nextAttemptAt: null,
      terminalReason: null,
    }),
    workIdentityHash: bytes(2),
    idempotencyKey: `task:${RUN}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: DOMAIN,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 4,
    expectedNamespaceAccessRevision: 5,
    expectedPolicyRevision: 7,
    descriptorBytes: bytes(3, 12),
    acceptedMaterial: Object.freeze({
      responseBytes: bytes(4, 12),
      credentialId: REQUEST,
      issuingDeviceAuthorizationRevision: 6,
      issuerSigningPublicKeyHash: bytes(5),
      authorizationExpiresAt: 2_000_000_100_000,
    }),
    finishedAt: null,
    authoritySet: Object.freeze({
      namespaceRequirements: Object.freeze([
        Object.freeze({
          ordinal: 0,
          namespaceId: NAMESPACE,
          domainId: DOMAIN,
          operations: Object.freeze(["decrypt", "encrypt"] as const),
          expectedAccessRevision: 5,
          expectedPolicyRevision: 7,
        }),
      ]),
      domainRequirements: Object.freeze([
        Object.freeze({
          ordinal: 0,
          domainId: DOMAIN,
          expectedEpoch: 4,
          expectedAuthorizationRevision: 6,
        }),
      ]),
    }),
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function request(): TaskRuntimeBackgroundAuthorizationRequestV1 {
  return Object.freeze({
    formatVersion: 1,
    purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
    requestId: REQUEST,
    workId: RUN,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 1,
    episodeId: `task-run:${RUN}`,
    sourceRoomId: ROOM,
    recipientKeyId: "recipient:task",
    recipientPublicKey: bytes(6, 65),
    authorizationPlanBytes: bytes(7, 10),
    issuedAt: 2_000_000_000_000,
    deadlineAt: 2_000_000_100_000,
  });
}

const coordinate: Extract<TaskContentCoordinateV1, { kind: "run_result" }> =
  Object.freeze({
    kind: "run_result",
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 1,
  });

function input(): ProtectedTaskResultPhaseAuthorityInput {
  return Object.freeze({
    occurrence: occurrence(),
    record: record(),
    request: request(),
    subject: Object.freeze({
      userId: REQUESTER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
    }),
    runner: {} as never,
    restricted: {} as never,
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example.test",
    coordinate,
    now: () => 2_000_000_001_000,
  });
}

function held(
  operations: readonly ("decrypt" | "encrypt")[] = ["decrypt", "encrypt"],
): HeldProtectedTaskRuntimeAuthority {
  return Object.freeze({
    foreground: Object.freeze({
      policyRevision: 7,
      subjectHumanId: HUMAN,
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      domains: Object.freeze([
        Object.freeze({
          domainId: DOMAIN,
          keyClass: "ai",
        }),
      ]),
    }) as HeldProtectedTaskRuntimeAuthority["foreground"],
    namespaceRequirements: Object.freeze([
      Object.freeze({
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: Object.freeze([...operations]),
        expectedAccessRevision: 5,
        expectedPolicyRevision: 7,
      }),
    ]),
  });
}

const expected = Object.freeze({
  requesterHumanId: HUMAN,
  namespaceId: NAMESPACE,
});

const resolved: TaskContentAuthorityV1 = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN,
  namespaceId: NAMESPACE,
  domainId: DOMAIN,
  expectedAccessRevision: 5,
  expectedPolicyRevision: 7,
});

function dependencies(
  options: Readonly<{
    phase: "running" | "terminal" | "unavailable";
    current?: HeldProtectedTaskRuntimeAuthority | null;
    terminal?: TaskContentAuthorityV1 | null;
    calls?: string[];
  }>,
): Partial<ProtectedTaskResultPhaseAuthorityDependencies> {
  const calls = options.calls ?? [];
  return {
    db: {} as DirectDatabase,
    readPhase: async (taskId, taskRunId) => {
      calls.push(`phase:${taskId}:${taskRunId}`);
      return options.phase;
    },
    withCurrentAuthority: (async (current) => {
      calls.push("running");
      return options.current === null
        ? null
        : current.use(options.current ?? held());
    }) as ProtectedTaskResultPhaseAuthorityDependencies["withCurrentAuthority"],
    createTerminalResolver: () => {
      calls.push("terminal:create");
      return async (value) => {
        calls.push(`terminal:${value.requesterHumanId}:${value.namespaceId}`);
        return options.terminal ?? null;
      };
    },
  };
}

test("derives running result authority only from the current accepted grant", async () => {
  const calls: string[] = [];
  const resolver = createProtectedTaskResultPhaseAuthorityResolver(
    input(),
    dependencies({ phase: "running", current: held(), calls }),
  );

  await Promise.resolve(expect(resolver(expected)).resolves.toEqual(resolved));
  expect(calls).toEqual([`phase:${TASK}:${RUN}`, "running"]);
});

test("does not fall back to terminal authority when running authority fails", async () => {
  for (const reason of ["revoked", "expired", "plain"] as const) {
    const calls: string[] = [];
    const resolver = createProtectedTaskResultPhaseAuthorityResolver(
      input(),
      dependencies({
        phase: "running",
        current: null,
        terminal: resolved,
        calls,
      }),
    );
    await Promise.resolve(expect(resolver(expected)).resolves.toBeNull());
    expect(calls).toEqual([`phase:${TASK}:${RUN}`, "running"]);
    expect(reason.length).toBeGreaterThan(0);
  }
});

test("uses only terminal repository authority after exact terminalization", async () => {
  const calls: string[] = [];
  const resolver = createProtectedTaskResultPhaseAuthorityResolver(
    input(),
    dependencies({ phase: "terminal", terminal: resolved, calls }),
  );
  await Promise.resolve(expect(resolver(expected)).resolves.toBe(resolved));
  expect(calls).toEqual([
    `phase:${TASK}:${RUN}`,
    "terminal:create",
    `terminal:${HUMAN}:${NAMESPACE}`,
  ]);

  calls.length = 0;
  const unavailable = createProtectedTaskResultPhaseAuthorityResolver(
    input(),
    dependencies({ phase: "terminal", terminal: null, calls }),
  );
  await Promise.resolve(expect(unavailable(expected)).resolves.toBeNull());
  expect(calls).toEqual([
    `phase:${TASK}:${RUN}`,
    "terminal:create",
    `terminal:${HUMAN}:${NAMESPACE}`,
  ]);
});

test("never returns terminal authority after cancellation", async () => {
  const before = new AbortController();
  before.abort();
  const beforeCalls: string[] = [];
  const beforeInput = Object.freeze({ ...input(), signal: before.signal });
  const beforeResolver = createProtectedTaskResultPhaseAuthorityResolver(
    beforeInput,
    dependencies({ phase: "terminal", terminal: resolved, calls: beforeCalls }),
  );
  await Promise.resolve(expect(beforeResolver(expected)).rejects.toThrow());
  expect(beforeCalls).toEqual([]);

  const during = new AbortController();
  const duringCalls: string[] = [];
  const duringResolver = createProtectedTaskResultPhaseAuthorityResolver(
    Object.freeze({ ...input(), signal: during.signal }),
    {
      ...dependencies({ phase: "terminal", calls: duringCalls }),
      createTerminalResolver: () => async () => {
        duringCalls.push("terminal");
        during.abort();
        return resolved;
      },
    },
  );
  await Promise.resolve(expect(duringResolver(expected)).rejects.toThrow());
  expect(duringCalls).toEqual([`phase:${TASK}:${RUN}`, "terminal"]);
});

test("fails closed for non-running and nonterminal phases", async () => {
  const calls: string[] = [];
  const resolver = createProtectedTaskResultPhaseAuthorityResolver(
    input(),
    dependencies({
      phase: "unavailable",
      current: held(),
      terminal: resolved,
      calls,
    }),
  );
  await Promise.resolve(expect(resolver(expected)).resolves.toBeNull());
  expect(calls).toEqual([`phase:${TASK}:${RUN}`]);
});

test("rejects running Namespace, Human, operation, Domain, and policy drift", async () => {
  const changedAuthorities: HeldProtectedTaskRuntimeAuthority[] = [
    held(["decrypt"]),
    Object.freeze({
      ...held(),
      foreground: Object.freeze({
        ...held().foreground,
        subjectHumanId: OWNER,
      }),
    }) as unknown as HeldProtectedTaskRuntimeAuthority,
    Object.freeze({
      ...held(),
      foreground: Object.freeze({ ...held().foreground, policyRevision: 8 }),
    }),
    Object.freeze({
      ...held(),
      foreground: Object.freeze({
        ...held().foreground,
        domains: Object.freeze([]),
      }),
    }),
  ];
  for (const current of changedAuthorities) {
    const resolver = createProtectedTaskResultPhaseAuthorityResolver(
      input(),
      dependencies({ phase: "running", current }),
    );
    await Promise.resolve(expect(resolver(expected)).resolves.toBeNull());
  }
  const requesterMismatch = createProtectedTaskResultPhaseAuthorityResolver(
    input(),
    dependencies({ phase: "running", current: held() }),
  );
  await Promise.resolve(
    expect(
      requesterMismatch({
        requesterHumanId: OWNER,
        namespaceId: NAMESPACE,
      }),
    ).resolves.toBeNull(),
  );
  await Promise.resolve(
    expect(
      requesterMismatch({
        requesterHumanId: HUMAN,
        namespaceId: ROOM,
      }),
    ).resolves.toBeNull(),
  );
});

test("rejects substituted occurrence, accepted record, request, or subject", () => {
  const base = input();
  const invalid: ProtectedTaskResultPhaseAuthorityInput[] = [
    Object.freeze({
      ...base,
      coordinate: Object.freeze({
        ...coordinate,
        taskRunId: OWNER,
      }),
    }),
    Object.freeze({
      ...base,
      coordinate: Object.freeze({
        ...coordinate,
        contentRevision: 2,
      }),
    }),
    Object.freeze({
      ...base,
      record: Object.freeze({
        ...base.record,
        snapshot: Object.freeze({ ...base.record.snapshot, workId: OWNER }),
      }),
    }),
    Object.freeze({
      ...base,
      request: Object.freeze({
        ...base.request,
        requestId: OWNER,
      }),
    }),
    Object.freeze({
      ...base,
      subject: Object.freeze({
        ...base.subject,
        humanActorId: OWNER,
      }),
    }),
  ];
  for (const changed of invalid) {
    expect(() =>
      createProtectedTaskResultPhaseAuthorityResolver(
        changed,
        dependencies({ phase: "running" }),
      ),
    ).toThrow("coordinates are invalid");
  }
});
