import { expect, test } from "bun:test";

import type { DirectDatabase } from "@nautilo/db";
import type { TaskContentCoordinateV1 } from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  createProtectedTaskResultContentAuthorityResolver,
  type ProtectedTaskResultContentAuthorityDependencies,
} from "../../src/routes/protected-task-result-content-authority";

const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const CONTENT = "60000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const DOMAIN = "80000000-0000-4000-8000-000000000008";
const CHANGED_REQUESTER = "90000000-0000-4000-8000-000000000009";
const JOB = "a0000000-0000-4000-8000-00000000000a";
const OWNER = "b0000000-0000-4000-8000-00000000000b";
const DEFINITION_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT = `task-run-result:v1:${"b".repeat(64)}`;

const coordinate: Extract<TaskContentCoordinateV1, { kind: "run_result" }> =
  Object.freeze({
    kind: "run_result",
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 1,
  });

type TestTask = NonNullable<Awaited<ReturnType<
  ProtectedTaskResultContentAuthorityDependencies["loadTask"]
>>>;
type TestRun = NonNullable<Awaited<ReturnType<
  ProtectedTaskResultContentAuthorityDependencies["loadRun"]
>>>;

function fingerprint(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

function task(): TestTask {
  return Object.freeze({
    id: TASK,
    ownerId: REQUESTER,
    requestorId: REQUESTER,
    agentId: AGENT,
    scheduleKind: "now" as const,
    status: "completed",
    contentRepresentation: "protected" as const,
    contentNamespaceId: CONTENT,
    contentRevision: 3,
    cryptoObjectId: DEFINITION_OBJECT,
    cryptoAccessRevision: 4,
    cryptoRequiredNamespaceFingerprint: fingerprint(),
    cryptoMappingState: "verified",
  });
}

function run(): TestRun {
  return Object.freeze({
    id: RUN,
    taskId: TASK,
    jobId: JOB,
    status: "completed",
    completedAt: new Date("2026-09-28T12:00:00.000Z"),
    resultRepresentation: "ordinary" as const,
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
  });
}

function dependencies(input: Readonly<{
  task?: TestTask | null;
  run?: TestRun | null;
  mode?: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  inspect?: ProtectedTaskResultContentAuthorityDependencies["inspectAuthority"];
}> = {}): Partial<ProtectedTaskResultContentAuthorityDependencies> {
  return {
    db: {} as DirectDatabase,
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example.test",
    restricted: () => ({} as never),
    readPolicy: async () => ({
      mode: input.mode ?? "encrypted_only",
      revision: 11,
    }),
    loadTask: async () => input.task === undefined ? task() : input.task,
    loadRun: async () => input.run === undefined ? run() : input.run,
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async () => ({
      roomId: ROOM,
      namespaceId: CONTENT,
    }),
    createProductContext: async () => ({
      canonicalRunner: { marker: "runner" },
    } as never),
    inspectAuthority: input.inspect ?? (async () => Object.freeze({
      sourceRoomId: ROOM,
      sourceNamespaceId: CONTENT,
      facts: Object.freeze([Object.freeze({
        namespaceId: CONTENT,
        domainId: DOMAIN,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 11,
        expectedDomainEpoch: 3,
        expectedAuthorizationRevision: 5,
      })]),
    })),
  };
}

test("resolves current result repository authority after TaskRun terminalization", async () => {
  let inspected: Parameters<
    ProtectedTaskResultContentAuthorityDependencies["inspectAuthority"]
  >[0] | null = null;
  const resolver = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies({ inspect: async input => {
      inspected = input;
      return {
        sourceRoomId: ROOM,
        sourceNamespaceId: CONTENT,
        facts: [{
          namespaceId: CONTENT,
          domainId: DOMAIN,
          expectedAccessRevision: 4,
          expectedPolicyRevision: 11,
          expectedDomainEpoch: 3,
          expectedAuthorizationRevision: 5,
        }],
      };
    } }),
  );

  await Promise.resolve(expect(resolver({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toEqual({
    authorityVersion: 1,
    kind: "requester_private_namespace",
    keyClass: "ai",
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
    domainId: DOMAIN,
    expectedAccessRevision: 4,
    expectedPolicyRevision: 11,
  }));
  expect(inspected).toMatchObject({
    taskId: TASK,
    requesterUserId: REQUESTER,
    requesterHumanId: HUMAN,
    agentId: AGENT,
    contentNamespaceId: CONTENT,
    sourceRoomId: ROOM,
    expectedPolicyRevision: 11,
  });
  expect(inspected).not.toHaveProperty("targetRoomId");
  expect(inspected).not.toHaveProperty("scopeMemory");
  expect(inspected).not.toHaveProperty("namespaceIds");
});

test("does not require a live execution grant or running TaskRun", async () => {
  const resolver = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies(),
  );
  await Promise.resolve(expect(resolver({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.not.toBeNull());
});

test("keeps Task owner distinct from the current requester authority", async () => {
  const resolver = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies({ task: Object.freeze({
      ...task(),
      ownerId: OWNER,
    }) }),
  );

  await Promise.resolve(expect(resolver({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toMatchObject({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  }));
});

test("rejects Plain policy and substituted repository authority", async () => {
  const plain = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies({ mode: "plaintext_only" }),
  );
  await Promise.resolve(expect(plain({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toBeNull());

  const resolver = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies(),
  );
  await Promise.resolve(expect(resolver({
    requesterHumanId: CHANGED_REQUESTER,
    namespaceId: CONTENT,
  })).resolves.toBeNull());
  await Promise.resolve(expect(resolver({
    requesterHumanId: HUMAN,
    namespaceId: ROOM,
  })).resolves.toBeNull());
});

test("rejects missing, nonterminal and changed Task/result coordinates", async () => {
  const missing = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies({ run: null }),
  );
  await Promise.resolve(expect(missing({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toBeNull());

  const nonterminal = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    dependencies({ run: Object.freeze({
      ...run(),
      status: "running",
      completedAt: null,
    }) }),
  );
  await Promise.resolve(expect(nonterminal({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toBeNull());

  let taskReads = 0;
  const changed = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    {
      ...dependencies(),
      loadTask: async () => {
        taskReads += 1;
        return taskReads === 1 ? task() : Object.freeze({
          ...task(),
          requestorId: CHANGED_REQUESTER,
        });
      },
    },
  );
  await Promise.resolve(expect(changed({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toBeNull());
});

test("rejects unavailable or substituted locked Namespace authority", async () => {
  for (const inspected of [
    null,
    {
      sourceRoomId: ROOM,
      sourceNamespaceId: CONTENT,
      facts: [{
        namespaceId: CONTENT,
        domainId: DOMAIN,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 12,
        expectedDomainEpoch: 3,
        expectedAuthorizationRevision: 5,
      }],
    },
  ]) {
    const resolver = createProtectedTaskResultContentAuthorityResolver(
      coordinate,
      dependencies({ inspect: async () => inspected }),
    );
    await Promise.resolve(expect(resolver({
      requesterHumanId: HUMAN,
      namespaceId: CONTENT,
    })).resolves.toBeNull());
  }
});

test("rejects definition revision and crypto-coordinate changes", async () => {
  for (const changedTask of [
    Object.freeze({ ...task(), contentRevision: 4 }),
    Object.freeze({
      ...task(),
      cryptoObjectId: `task-definition:v1:${"c".repeat(64)}`,
    }),
    Object.freeze({
      ...task(),
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(8),
    }),
  ]) {
    let reads = 0;
    const resolver = createProtectedTaskResultContentAuthorityResolver(
      coordinate,
      {
        ...dependencies(),
        loadTask: async () => ++reads === 1 ? task() : changedTask,
      },
    );
    await Promise.resolve(expect(resolver({
      requesterHumanId: HUMAN,
      namespaceId: CONTENT,
    })).resolves.toBeNull());
  }
});

test("rejects a result mapping that changes during authority inspection", async () => {
  let reads = 0;
  const resolver = createProtectedTaskResultContentAuthorityResolver(
    coordinate,
    {
      ...dependencies(),
      loadRun: async () => ++reads === 1 ? run() : Object.freeze({
        ...run(),
        resultRepresentation: "protected" as const,
        resultContentNamespaceId: CONTENT,
        resultRevision: 1,
        resultCryptoObjectId: RESULT_OBJECT,
        resultCryptoAccessRevision: 0,
        resultCryptoRequiredNamespaceFingerprint: fingerprint(),
        resultCryptoMappingState: "verified",
      }),
    },
  );

  await Promise.resolve(expect(resolver({
    requesterHumanId: HUMAN,
    namespaceId: CONTENT,
  })).resolves.toBeNull());
});
