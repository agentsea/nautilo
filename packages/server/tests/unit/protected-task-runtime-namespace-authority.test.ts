import { expect, test } from "bun:test";

import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  InitialTaskRuntimeNamespaceAuthority,
} from "@nautilo/lattice-bridge/server";
import type {
  ProtectedTaskOccurrence,
  ProtectedTaskPredispatchPlan,
} from "@nautilo/runtime";

import {
  createProtectedTaskRuntimeNamespaceAuthorityResolver,
  type ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies,
} from "../../src/routes/protected-task-runtime-namespace-authority";

const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const CONTENT = "60000000-0000-4000-8000-000000000006";
const READABLE = "70000000-0000-4000-8000-000000000007";
const SOURCE_ROOM = "80000000-0000-4000-8000-000000000008";
const DOMAIN_A = "90000000-0000-4000-8000-000000000009";
const DOMAIN_B = "a0000000-0000-4000-8000-00000000000a";
const SCOPE = "b0000000-0000-4000-8000-00000000000b";
const MEMORY_ROOM = "c0000000-0000-4000-8000-00000000000c";

function occurrence(
  representation: "dual" | "protected" = "protected",
): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: REQUESTER,
      requestorId: REQUESTER,
      agentId: AGENT,
      callingRoomId: null,
      scheduleKind: "cron" as const,
      contentRepresentation: representation,
      contentNamespaceId: CONTENT,
      contentRevision: 4,
      cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoAccessRevision: 3,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `task:${TASK}:${RUN}`,
      status: "awaiting" as const,
      startedAt: new Date(1_800_000_000_000),
    }),
  });
}

function predispatch(
  value: ProtectedTaskOccurrence,
): ProtectedTaskPredispatchPlan {
  return {
    occurrence: value,
    scheduling: {} as ProtectedTaskPredispatchPlan["scheduling"],
    target: { roomId: MEMORY_ROOM, targetUserIds: [REQUESTER] },
    memory: {} as ProtectedTaskPredispatchPlan["memory"],
  };
}

function authority(): InitialTaskRuntimeNamespaceAuthority {
  return Object.freeze({
    sourceRoomId: SOURCE_ROOM,
    sourceNamespaceId: CONTENT,
    facts: Object.freeze([
      Object.freeze({
        namespaceId: CONTENT,
        domainId: DOMAIN_A,
        expectedAccessRevision: 3,
        expectedPolicyRevision: 7,
        expectedDomainEpoch: 5,
        expectedAuthorizationRevision: 9,
      }),
      Object.freeze({
        namespaceId: READABLE,
        domainId: DOMAIN_B,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 7,
        expectedDomainEpoch: 6,
        expectedAuthorizationRevision: 10,
      }),
    ]),
  });
}

function dependencies(
  inspect: ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies[
    "inspectAuthority"
  ],
): Partial<ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies> {
  return {
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example.test",
    db: {} as ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies["db"],
    restricted: () => (
      {} as ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies[
        "restricted"
      ] extends () => infer Value ? Value : never
    ),
    readPolicy: async () => ({
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    }),
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async (_userId, _agentId, namespaceId) => {
      expect(namespaceId).toBe(CONTENT);
      return {
        roomId: SOURCE_ROOM,
        namespaceId: CONTENT,
      };
    },
    createProductContext: async () => ({
      canonicalRunner: { marker: "runner" },
    } as never),
    inspectAuthority: inspect,
  };
}

test("passes exact discovered Task authority into the locked bridge owner", async () => {
  const value = occurrence();
  let inspected: Parameters<
    ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies[
      "inspectAuthority"
    ]
  >[0] | null = null;
  const current = authority();
  const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver(
    dependencies(async input => {
      inspected = input;
      return current;
    }),
  );

  const plan = predispatch(value);
  const resolving = resolver({
    occurrence: value,
    predispatch: plan,
    namespaceIds: [CONTENT, READABLE],
  });
  (plan.target as { roomId: string }).roomId = SOURCE_ROOM;
  await Promise.resolve(expect(resolving).resolves.toEqual({
    ...current,
    policy: {
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    },
  }));
  expect(inspected).toMatchObject({
    serverScope: "https://server.example.test",
    taskId: TASK,
    requesterUserId: REQUESTER,
    requesterHumanId: HUMAN,
    agentId: AGENT,
    contentNamespaceId: CONTENT,
    sourceRoomId: SOURCE_ROOM,
    targetRoomId: MEMORY_ROOM,
    namespaceIds: [CONTENT, READABLE],
    expectedPolicyRevision: 7,
  });
});

test("copies and passes a fixed Scope inventory into the locked bridge owner", async () => {
  const value = occurrence();
  let inspected: Parameters<
    ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies["inspectAuthority"]
  >[0] | null = null;
  const current = authority();
  const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver(
    dependencies(async input => {
      inspected = input;
      return current;
    }),
  );
  const readableNamespaceIds = [READABLE];
  const resolving = resolver({
    occurrence: value,
    predispatch: predispatch(value),
    namespaceIds: [CONTENT, READABLE],
    scopeMemory: {
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: READABLE,
      readableNamespaceIds,
    },
  });
  readableNamespaceIds[0] = CONTENT;

  await Promise.resolve(expect(resolving).resolves.toEqual({
    ...current,
    policy: {
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    },
  }));
  const captured = inspected as Parameters<
    ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies["inspectAuthority"]
  >[0] | null;
  expect(captured?.scopeMemory).toEqual({
    scopeId: SCOPE,
    memoryRoomId: MEMORY_ROOM,
    originWritableNamespaceId: READABLE,
    readableNamespaceIds: [READABLE],
  });
  expect(Object.isFrozen(captured?.scopeMemory?.readableNamespaceIds)).toBe(true);
});

test("admits a dual Task in Shadow and parks it after transition to Full", async () => {
  const value = occurrence("dual");
  let inspections = 0;
  const current = authority();
  const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver(
    {
      ...dependencies(async input => {
        inspections += 1;
        expect(input.expectedPolicyRevision).toBe(7);
        return current;
      }),
      readPolicy: async () => ({
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 7,
      }),
    },
  );

  await Promise.resolve(expect(resolver({
    occurrence: value,
    predispatch: predispatch(value),
    namespaceIds: [CONTENT, READABLE],
  })).resolves.toEqual({
    ...current,
    policy: {
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 7,
    },
  }));
  expect(inspections).toBe(1);

  const full = createProtectedTaskRuntimeNamespaceAuthorityResolver(
    dependencies(async () => {
      inspections += 1;
      return current;
    }),
  );
  await Promise.resolve(expect(full({
    occurrence: value,
    predispatch: predispatch(value),
    namespaceIds: [CONTENT, READABLE],
  })).rejects.toThrow("Namespace authority is unavailable"));
  expect(inspections).toBe(1);
});

test("fails closed when requester or canonical private Room discovery is missing", async () => {
  const value = occurrence();
  let inspections = 0;
  const base = dependencies(async () => {
    inspections += 1;
    return authority();
  });
  for (const missing of ["requester", "room"] as const) {
    const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver({
      ...base,
      ...(missing === "requester"
        ? { resolveRequesterHuman: async () => null }
        : { resolveRequesterPrivateRoom: async () => null }),
    });
    await Promise.resolve(expect(resolver({
      occurrence: value,
      predispatch: predispatch(value),
      namespaceIds: [CONTENT, READABLE],
    })).rejects.toThrow("Namespace authority is unavailable"));
  }
  expect(inspections).toBe(0);
});

test("fails closed when locked authority disappears or changes", async () => {
  const value = occurrence();
  for (const changed of [
    null,
    Object.freeze({ ...authority(), sourceRoomId: RUN }),
    Object.freeze({ ...authority(), facts: authority().facts.slice(0, 1) }),
    Object.freeze({
      ...authority(),
      facts: authority().facts.map((fact, index) => index === 0
        ? Object.freeze({ ...fact, expectedPolicyRevision: 8 })
        : fact),
    }),
  ]) {
    const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver(
      dependencies(async () => changed),
    );
    await Promise.resolve(expect(resolver({
      occurrence: value,
      predispatch: predispatch(value),
      namespaceIds: [CONTENT, READABLE],
    })).rejects.toThrow("Namespace authority changed"));
  }
});

test("rejects policy and Namespace coordinate drift before bridge inspection", async () => {
  const value = occurrence();
  let inspections = 0;
  const base = dependencies(async () => {
    inspections += 1;
    return authority();
  });
  const plain = createProtectedTaskRuntimeNamespaceAuthorityResolver({
    ...base,
    readPolicy: async () => ({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 7,
    }),
  });
  await Promise.resolve(expect(plain({
    occurrence: value,
    predispatch: predispatch(value),
    namespaceIds: [CONTENT, READABLE],
  })).rejects.toThrow("Namespace authority is unavailable"));

  const resolver = createProtectedTaskRuntimeNamespaceAuthorityResolver(base);
  await Promise.resolve(expect(resolver({
    occurrence: value,
    predispatch: predispatch(value),
    namespaceIds: [READABLE, CONTENT],
  })).rejects.toThrow("coordinates are invalid"));
  expect(inspections).toBe(0);
});
