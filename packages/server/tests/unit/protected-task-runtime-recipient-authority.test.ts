import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

import type {
  DirectDatabase,
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  domainForegroundNamespaceBindingSetDigest,
} from "@nautilo/lattice-crypto";
import {
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type {
  InitialTaskRuntimeRecipientAuthority,
  TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import {
  createProtectedTaskRuntimeRecipientAuthorityPort,
  type ProtectedTaskRuntimeRecipientAuthorityDependencies,
} from "../../src/routes/protected-task-runtime-recipient-authority";
import { createProtectedTaskRuntimeRecipientRequestPlan } from
  "../../src/routes/protected-task-runtime-recipient-request-plan";

const OWNER = "10000000-0000-4000-8000-000000000001";
const REQUESTER = "20000000-0000-4000-8000-000000000002";
const HUMAN = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const CALLING_ROOM = "70000000-0000-4000-8000-000000000007";
const DEVICE = "80000000-0000-4000-8000-000000000008";
const CONTENT = "90000000-0000-4000-8000-000000000009";
const READABLE = "a0000000-0000-4000-8000-00000000000a";
const DOMAIN_A = "b0000000-0000-4000-8000-00000000000b";
const DOMAIN_B = "c0000000-0000-4000-8000-00000000000c";
const SOURCE_ROOM = "d0000000-0000-4000-8000-00000000000d";
const SCOPE = "e0000000-0000-4000-8000-00000000000e";
const MEMORY_ROOM = "f0000000-0000-4000-8000-00000000000f";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function occurrence(): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: OWNER,
      requestorId: REQUESTER,
      agentId: AGENT,
      callingRoomId: CALLING_ROOM,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: CONTENT,
      contentRevision: 3,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: TASK,
        contentRevision: 3,
      }),
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(8),
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `subagent:task:${TASK}:${RUN}`,
      status: "awaiting" as const,
      startedAt: new Date(2_000_000_000_000),
    }),
  });
}

function record(
  value: ProtectedTaskOccurrence = occurrence(),
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Object.freeze({
    snapshot: Object.freeze({
      formatVersion: 3,
      credentialSubject: Object.freeze({
        kind: "runtime",
        runtimeKind: "task",
        runtimeVersion: 1,
      }),
      requestId: `task-run-authorization:${value.run.id}`,
      workId: value.run.id,
      namespaceId: CONTENT,
      descriptorDigest: null,
      recipientGeneration: 0,
      recipient: null,
      acceptedResponse: null,
      state: "awaiting_recipient",
      claimId: null,
      claimExpiresAt: null,
      requestRevision: 0,
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
      retryCount: 0,
      lastRetryReason: null,
      nextAttemptAt: null,
      terminalReason: null,
    }),
    workIdentityHash: bytes(1),
    idempotencyKey: `task-run:${value.run.id}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: DOMAIN_A,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 5,
    expectedNamespaceAccessRevision: 3,
    expectedPolicyRevision: 7,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: Object.freeze({
      namespaceRequirements: Object.freeze([
        Object.freeze({
          ordinal: 0,
          namespaceId: CONTENT,
          domainId: DOMAIN_A,
          operations: Object.freeze(["decrypt", "encrypt"] as const),
          expectedAccessRevision: 3,
          expectedPolicyRevision: 7,
        }),
        Object.freeze({
          ordinal: 1,
          namespaceId: READABLE,
          domainId: DOMAIN_B,
          operations: Object.freeze(["decrypt"] as const),
          expectedAccessRevision: 4,
          expectedPolicyRevision: 7,
        }),
      ]),
      domainRequirements: Object.freeze([
        Object.freeze({
          ordinal: 0,
          domainId: DOMAIN_A,
          expectedEpoch: 5,
          expectedAuthorizationRevision: 9,
        }),
        Object.freeze({
          ordinal: 1,
          domainId: DOMAIN_B,
          expectedEpoch: 6,
          expectedAuthorizationRevision: 10,
        }),
      ]),
    }),
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function authority(
  durable: BackgroundAuthorizationTaskRuntimeRecordV3 = record(),
): InitialTaskRuntimeRecipientAuthority {
  return Object.freeze({
    sourceRoomId: SOURCE_ROOM,
    sourceNamespaceId: CONTENT,
    device: Object.freeze({
      userId: REQUESTER,
      humanActorId: HUMAN,
      deviceId: DEVICE,
      deviceGeneration: 2,
      serverInstanceId: "e0000000-0000-4000-8000-00000000000e",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: 4,
      headDigest: bytes(2),
      signingPublicKey: new Uint8Array(65).fill(3),
    }) as InitialTaskRuntimeRecipientAuthority["device"],
    domains: Object.freeze([
      Object.freeze({
        domainId: DOMAIN_A,
        domainKeyGeneration: 5,
        authorizationRevision: 9,
      }),
      Object.freeze({
        domainId: DOMAIN_B,
        domainKeyGeneration: 6,
        authorizationRevision: 10,
      }),
    ]) as InitialTaskRuntimeRecipientAuthority["domains"],
    namespaceRequirements: durable.authoritySet.namespaceRequirements,
    policyRevision: 7,
  });
}

function dependencies(
  input: Readonly<{
    humanId?: string | null;
    room?: Readonly<{ roomId: string; namespaceId: string }> | null;
    borrowed?: InitialTaskRuntimeRecipientAuthority | null;
    currentTaskRun?: boolean;
    inspect?: (
      input: Parameters<
        ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"]
      >[0],
    ) => void;
    inspectRepositoryConnection?: (
      restricted: PostgresJsBridgeConnection,
    ) => void;
    scopedRestricted?: PostgresJsBridgeConnection;
  }> = {},
): Partial<ProtectedTaskRuntimeRecipientAuthorityDependencies> {
  const scopedRestricted = input.scopedRestricted
    ?? ({ query: async () => [] } as never);
  return {
    db: {} as DirectDatabase,
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example.test",
    restricted: () => ({}) as never,
    resolveRequesterHuman: async () =>
      input.humanId === undefined
        ? { id: HUMAN }
        : input.humanId === null
          ? null
          : { id: input.humanId },
    resolveRequesterPrivateRoom: async (_userId, _agentId, namespaceId) => {
      expect(namespaceId).toBe(CONTENT);
      return input.room === undefined
        ? { roomId: SOURCE_ROOM, namespaceId: CONTENT }
        : input.room;
    },
    createProductContext: async () =>
      ({
        canonicalRunner: { marker: "runner" },
      }) as never,
    validateCurrentTaskRun: async () => input.currentTaskRun ?? true,
    withAuthority: (async (current) => {
      input.inspect?.(current);
      if (
        !(await current.validateCurrentTaskRun({ marker: "product" } as never))
      ) {
        return null;
      }
      const borrowed =
        input.borrowed === undefined ? authority() : input.borrowed;
      if (borrowed === null) return null;
      const value = await current.use(borrowed, scopedRestricted);
      await current.validateBeforeCommit?.();
      return value;
    }) as ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"],
    repository: async restricted => {
      input.inspectRepositoryConnection?.(restricted);
      return {
        get: async () => null,
        compareAndSwap: async () => ({ status: "stale", current: null }),
      } as never;
    },
  };
}

const binding = Object.freeze({
  userId: REQUESTER,
  humanActorId: HUMAN,
  deviceId: DEVICE,
});

test("lends exact awaiting recipient authority to the Runtime callback", async () => {
  const value = occurrence();
  const durable = record(value);
  let inspected:
    | Parameters<
        ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"]
      >[0]
    | null = null;
  let calls = 0;
  const port = createProtectedTaskRuntimeRecipientAuthorityPort(
    dependencies({
      inspect: (input) => {
        inspected = input;
      },
    }),
  );

  const request: Parameters<typeof port>[0] = {
    occurrence: value,
    record: durable,
    binding,
    targetRoomId: MEMORY_ROOM,
    use: (current) => {
      calls += 1;
      expect(current).toMatchObject({
        sourceRoomId: SOURCE_ROOM,
        policyRevision: 7,
        device: { userId: REQUESTER, humanActorId: HUMAN, deviceId: DEVICE },
      });
      expect(current.namespaceRequirements).toEqual(
        durable.authoritySet.namespaceRequirements,
      );
      return "bound";
    },
  };
  const pending = port(request);
  (request as { targetRoomId: string }).targetRoomId = SOURCE_ROOM;
  const result = await pending;

  expect(result).toBe("bound");
  expect(calls).toBe(1);
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
    deviceId: DEVICE,
  });
});

test("passes and returns only the exact current fixed Scope binding", async () => {
  const value = occurrence();
  const durable = record(value);
  const scopeMemory = Object.freeze({
    scopeId: SCOPE,
    memoryRoomId: MEMORY_ROOM,
    originWritableNamespaceId: READABLE,
    readableNamespaceIds: Object.freeze([READABLE]),
  });
  let inspectedScope: TaskScopeMemoryBinding | undefined;
  const port = createProtectedTaskRuntimeRecipientAuthorityPort(
    dependencies({
      borrowed: Object.freeze({ ...authority(), scopeMemory }),
      inspect: input => {
        inspectedScope = input.scopeMemory;
      },
    }),
  );

  const result = await port({
    occurrence: value,
    record: durable,
    binding,
    targetRoomId: MEMORY_ROOM,
    scopeMemory,
    use: current => current.scopeMemory,
  });
  expect(result).toEqual(scopeMemory);
  expect(inspectedScope).toEqual(scopeMemory);

  const stale = createProtectedTaskRuntimeRecipientAuthorityPort(
    dependencies({
      borrowed: Object.freeze({
        ...authority(),
        scopeMemory: Object.freeze({ ...scopeMemory, scopeId: TASK }),
      }),
    }),
  );
  expect(await stale({
    occurrence: value,
    record: durable,
    binding,
    targetRoomId: MEMORY_ROOM,
    scopeMemory,
    use: () => "unsafe",
  })).toBeNull();
});

test("rejects stale Human and private Room before lattice use", async () => {
  const value = occurrence();
  const staleCases = [
    dependencies({ humanId: OWNER }),
    dependencies({
      room: Object.freeze({
        roomId: SOURCE_ROOM,
        namespaceId: READABLE,
      }),
    }),
  ];
  for (const stale of staleCases) {
    let called = false;
    const port = createProtectedTaskRuntimeRecipientAuthorityPort({
      ...stale,
      withAuthority: (async () => {
        called = true;
        return "unsafe";
      }) as ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"],
    });
    await Promise.resolve(
      expect(
        port({
          occurrence: value,
          record: record(value),
          binding,
          targetRoomId: MEMORY_ROOM,
          use: () => "unsafe",
        }),
      ).resolves.toBeNull(),
    );
    expect(called).toBe(false);
  }
});

test("validates the locked TaskRun inside lattice authority before Runtime use", async () => {
  let validations = 0;
  let runtimeUses = 0;
  const port = createProtectedTaskRuntimeRecipientAuthorityPort({
    ...dependencies(),
    validateCurrentTaskRun: async ({ product }) => {
      validations += 1;
      expect((product as unknown as { marker: string }).marker).toBe("product");
      return false;
    },
  });

  await Promise.resolve(
    expect(
      port({
        occurrence: occurrence(),
        record: record(),
        binding,
        targetRoomId: MEMORY_ROOM,
        use: () => {
          runtimeUses += 1;
          return "unsafe";
        },
      }),
    ).resolves.toBeNull(),
  );
  expect(validations).toBe(1);
  expect(runtimeUses).toBe(0);
});

test("locks exact production Task and TaskRun rows before recipient construction", async () => {
  type AuthorityInput = Parameters<
    ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"]
  >[0];
  let captured: AuthorityInput | null = null;
  const injected = dependencies();
  const {
    validateCurrentTaskRun: _injectedValidator,
    withAuthority: _injectedAuthority,
    ...productionValidatorDependencies
  } = injected;
  const port = createProtectedTaskRuntimeRecipientAuthorityPort({
    ...productionValidatorDependencies,
    withAuthority: (async (input) => {
      captured = input;
      return null;
    }) as ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"],
  });
  await port({
    occurrence: occurrence(),
    record: record(),
    binding,
    targetRoomId: MEMORY_ROOM,
    use: () => "unused",
  });
  expect(captured).not.toBeNull();

  const taskRow = {
    id: TASK,
    owner_id: OWNER,
    requestor_id: REQUESTER,
    agent_id: AGENT,
    calling_room_id: CALLING_ROOM,
    status: "pending",
    schedule_kind: "now",
    content_representation: "protected",
    content_namespace_id: CONTENT,
    content_revision: 3,
    crypto_object_id: deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: TASK,
      contentRevision: 3,
    }),
    crypto_access_revision: 0,
    crypto_required_namespace_fingerprint: bytes(8),
    crypto_mapping_state: "verified",
  };
  const runRow = {
    id: RUN,
    task_id: TASK,
    job_id: null,
    graph_thread_id: `subagent:task:${TASK}:${RUN}`,
    status: "awaiting",
    result_representation: "ordinary",
    result_content_namespace_id: null,
    result_revision: 0,
    result_crypto_object_id: null,
    result_crypto_access_revision: 0,
    result_crypto_required_namespace_fingerprint: null,
    result_crypto_mapping_state: "unmapped",
  };
  const validate = async (
    changedRun: Record<string, unknown> = runRow,
  ): Promise<Readonly<{ result: boolean; statements: readonly string[] }>> => {
    const statements: string[] = [];
    const product: PostgresJsBridgeConnection = {
      query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
        statements.push(statement);
        expect(statement.toLowerCase()).toContain("for update");
        if (statement.includes('from "tasks"')) {
          return [taskRow] as unknown as readonly Row[];
        }
        if (statement.includes('from "task_runs"')) {
          return [changedRun] as unknown as readonly Row[];
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
      transaction: async (use) => use(product),
      transactionOnce: async (use) => use(product),
    };
    return {
      result: await captured!.validateCurrentTaskRun(product),
      statements,
    };
  };

  const exact = await validate();
  expect(exact.result).toBe(true);
  expect(exact.statements).toHaveLength(2);
  for (const changedRun of [
    { ...runRow, status: "completed" },
    { ...runRow, job_id: CALLING_ROOM },
    { ...runRow, result_revision: 1 },
  ]) {
    const stale = await validate(changedRun);
    expect(stale.result).toBe(false);
    expect(stale.statements).toHaveLength(2);
  }
});

test("rejects non-awaiting and substituted durable records before lattice use", async () => {
  const value = occurrence();
  const current = record(value);
  for (const changed of [
    Object.freeze({
      ...current,
      snapshot: Object.freeze({ ...current.snapshot, state: "grant_ready" }),
    }),
    Object.freeze({
      ...current,
      snapshot: Object.freeze({ ...current.snapshot, workId: OWNER }),
    }),
    Object.freeze({
      ...current,
      authoritySet: Object.freeze({
        ...current.authoritySet,
        namespaceRequirements: Object.freeze([
          Object.freeze({
            ...current.authoritySet.namespaceRequirements[0]!,
            expectedAccessRevision: 99,
          }),
          current.authoritySet.namespaceRequirements[1]!,
        ]),
      }),
    }),
  ]) {
    let called = false;
    const port = createProtectedTaskRuntimeRecipientAuthorityPort({
      ...dependencies(),
      withAuthority: (async () => {
        called = true;
        return "unsafe";
      }) as ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"],
    });
    await Promise.resolve(
      expect(
        port({
          occurrence: value,
          record: changed as BackgroundAuthorizationTaskRuntimeRecordV3,
          binding,
          targetRoomId: MEMORY_ROOM,
          use: () => "unsafe",
        }),
      ).resolves.toBeNull(),
    );
    expect(called).toBe(false);
  }
});

test("rejects substituted device, policy, Namespace, or Domain authority", async () => {
  const current = authority();
  const changedAuthorities: InitialTaskRuntimeRecipientAuthority[] = [
    Object.freeze({
      ...current,
      device: Object.freeze({ ...current.device, deviceId: OWNER }),
    }),
    Object.freeze({ ...current, policyRevision: 8 }),
    Object.freeze({
      ...current,
      namespaceRequirements: Object.freeze([
        Object.freeze({
          ...current.namespaceRequirements[0]!,
          expectedAccessRevision: 99,
        }),
        current.namespaceRequirements[1]!,
      ]),
    }),
    Object.freeze({
      ...current,
      domains: Object.freeze([
        Object.freeze({ ...current.domains[0]!, domainKeyGeneration: 99 }),
        current.domains[1]!,
      ]),
    }),
  ];
  for (const changed of changedAuthorities) {
    let used = false;
    const port = createProtectedTaskRuntimeRecipientAuthorityPort(
      dependencies({ borrowed: changed }),
    );
    await Promise.resolve(
      expect(
        port({
          occurrence: occurrence(),
          record: record(),
          binding,
          targetRoomId: MEMORY_ROOM,
          use: () => {
            used = true;
            return "unsafe";
          },
        }),
      ).resolves.toBeNull(),
    );
    expect(used).toBe(false);
  }
});

test("lends exact bound authority without manufacturing an awaiting record", async () => {
  const crypto = new LatticeCrypto();
  const keyPair = await crypto.generateEncryptionKeyPair();
  const value = occurrence();
  const initial = record(value);
  const current = authority(initial);
  const boundAuthority: InitialTaskRuntimeRecipientAuthority = {
    ...current,
    domains: [{
      domainId: DOMAIN_A,
      sourceNamespaceId: CONTENT,
      participantDigest: bytes(10),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 5,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(11),
      activeNamespaceBindingSetDigest:
        domainForegroundNamespaceBindingSetDigest(crypto, [{
          namespaceId: CONTENT,
          bindingDigest: bytes(12),
        }]),
      activeNamespaceBindingCount: 1,
    }, {
      domainId: DOMAIN_B,
      sourceNamespaceId: READABLE,
      participantDigest: bytes(13),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 6,
      authorizationRevision: authorizationRevision(10),
      headDigest: bytes(14),
      activeNamespaceBindingSetDigest:
        domainForegroundNamespaceBindingSetDigest(crypto, [{
          namespaceId: READABLE,
          bindingDigest: bytes(15),
        }]),
      activeNamespaceBindingCount: 1,
    }],
  };
  const expiresAt = 2_000_000_060_000;
  const recipientKeyId = `task-runtime:${RUN}:0`;
  const requestPlan = createProtectedTaskRuntimeRecipientRequestPlan({
    crypto,
    occurrence: value,
    initialRecord: initial,
    sourceRoomId: SOURCE_ROOM,
    authority: {
      policyRevision: 7,
      namespaces: initial.authoritySet.namespaceRequirements,
      domains: initial.authoritySet.domainRequirements,
    },
    createdAt: initial.snapshot.createdAt,
    recipientTtlMs: 60_000,
  });
  const request = requestPlan.buildRequest({
    record: initial,
    attempt: {
      requestId: initial.snapshot.requestId,
      workId: RUN,
      recipientGeneration: 0,
      recipientKeyId,
      recipientPublicKey: keyPair.publicKey,
      expiresAt,
    },
    binding,
    authority: boundAuthority,
  });
  const descriptorBytes =
    encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const bound = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      state: "awaiting_device" as const,
      requestRevision: 1,
      updatedAt: 2_000_000_000_001,
      descriptorDigest: createHash("sha256")
        .update(descriptorBytes).digest("hex"),
      recipient: {
        recipientKeyId,
        recipientPublicKey: Buffer.from(keyPair.publicKey).toString("base64url"),
        expiresAt,
      },
    },
    descriptorBytes,
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const heldRestricted = { query: async () => [] } as never;
  const scopedRestricted = { query: async () => [] } as never;
  let repositoryConnection: PostgresJsBridgeConnection | null = null;
  try {
    const port = createProtectedTaskRuntimeRecipientAuthorityPort(
      dependencies({
        borrowed: boundAuthority,
        scopedRestricted,
        inspectRepositoryConnection: connection => {
          repositoryConnection = connection;
        },
      }),
    );
    const result = await port({
      occurrence: value,
      record: bound,
      binding,
      targetRoomId: MEMORY_ROOM,
      phase: "bound",
      restricted: heldRestricted,
      validateBeforeCommit: held => held.device.deviceId === DEVICE,
      use: (held, repository) => {
        expect(held.restricted).toBe(scopedRestricted);
        expect(held.restricted).not.toBe(heldRestricted);
        expect(repository).toBeDefined();
        expect(held.device.deviceId).toBe(DEVICE);
        return "bound";
      },
    });
    expect(result).toBe("bound");
    expect(repositoryConnection).toBe(scopedRestricted);

    let clock = expiresAt - 1;
    let scopedOperationsDrained = false;
    const expiring = createProtectedTaskRuntimeRecipientAuthorityPort({
      ...dependencies({ borrowed: boundAuthority, scopedRestricted }),
      now: () => clock,
      withAuthority: (async input => {
        const value = await input.use(boundAuthority, scopedRestricted);
        await Promise.resolve();
        scopedOperationsDrained = true;
        clock = expiresAt;
        await input.validateBeforeCommit?.();
        return value;
      }) as ProtectedTaskRuntimeRecipientAuthorityDependencies["withAuthority"],
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(expiring({
      occurrence: value,
      record: bound,
      binding,
      targetRoomId: MEMORY_ROOM,
      phase: "bound",
      restricted: heldRestricted,
      validateBeforeCommit: () => true,
      use: () => "unsafe",
    })).rejects.toThrow("expired before commit");
    expect(scopedOperationsDrained).toBe(true);
  } finally {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    descriptorBytes.fill(0);
    keyPair.privateKey.fill(0);
    keyPair.publicKey.fill(0);
  }
});
