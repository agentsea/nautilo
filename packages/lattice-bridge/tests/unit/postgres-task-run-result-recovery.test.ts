import { describe, expect, test } from "bun:test";
import {
  taskRunResultCryptoRevisions,
  taskRuns,
  type ExactProtectedTaskRunResultPublicationProof,
  type ProtectedTaskDurableJobReference,
  type ProtectedTaskRunResultPublicationTransaction,
  type SettlePublishedProtectedTaskRunAuthorizationInput,
} from "@nautilo/db";

import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TASK_CONTENT_RECONCILE_MAX_ATTEMPTS,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  type VerifiedTaskContentCryptoRevisionV1,
} from "../../src/task/task-content-repository.ts";
import type { TaskContentAuthorityV1 } from
  "../../src/task/task-content-authority-v1.ts";
import {
  withTaskContentNamespaceAuthority,
  type InitialTaskRuntimeNamespaceAuthority,
} from "../../src/server/task/initial-task-runtime-namespace-authority.ts";
import {
  reconcilePostgresTaskRunResultPublication,
  type PostgresTaskRunResultRecoveryInput,
} from "../../src/server/task/postgres-task-run-result-recovery.ts";

const IDS = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  user: "40000000-0000-4000-8000-000000000004",
  human: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
  domain: "70000000-0000-4000-8000-000000000007",
  sourceRoom: "80000000-0000-4000-8000-000000000008",
  agent: "90000000-0000-4000-8000-000000000009",
  lease: "a0000000-0000-4000-8000-00000000000a",
  otherLease: "b0000000-0000-4000-8000-00000000000b",
  otherNamespace: "c0000000-0000-4000-8000-00000000000c",
} as const;

const RESULT_COORDINATE = Object.freeze({
  kind: "run_result" as const,
  taskId: IDS.task,
  taskRunId: IDS.run,
  contentRevision: 1,
});
const RESULT_OBJECT = deriveTaskContentCryptoObjectIdV1(RESULT_COORDINATE);
const DEFINITION_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const COMPLETED_AT = new Date("2026-10-08T08:01:00.000Z");
const REQUIRED_FINGERPRINT = new Uint8Array(32).fill(0x31);

type Proof = ExactProtectedTaskRunResultPublicationProof;
type Transaction = ProtectedTaskRunResultPublicationTransaction;
type WithAuthorityInput<Value> =
  Parameters<typeof withTaskContentNamespaceAuthority<Value>>[0];

function currentAuthority(
  overrides: Partial<TaskContentAuthorityV1> = {},
): TaskContentAuthorityV1 {
  return Object.freeze({
    authorityVersion: 1,
    kind: "requester_private_namespace",
    keyClass: "ai",
    requesterHumanId: IDS.human,
    namespaceId: IDS.namespace,
    domainId: IDS.domain,
    expectedAccessRevision: 9,
    expectedPolicyRevision: 7,
    ...overrides,
  });
}

function reference(): ProtectedTaskDurableJobReference {
  return Object.freeze({
    kind: "protected_task_run_v1",
    taskId: IDS.task,
    taskRunId: IDS.run,
    inputObjectId: DEFINITION_OBJECT,
    resultObjectId: RESULT_OBJECT,
    authorizationRequestId: `task-run-authorization:${IDS.run}`,
    policyRevision: 7,
    executionSegment: 1,
  });
}

function publication(): SettlePublishedProtectedTaskRunAuthorizationInput {
  return Object.freeze({ jobId: IDS.job, reference: reference() });
}

type ProofOptions = Readonly<{
  leaseToken?: string | null;
  attemptCount?: number;
  representation?: "protected" | "dual";
  requesterHumanId?: string;
  namespaceId?: string;
  authorityFingerprint?: Uint8Array;
}>;

function proof(options: ProofOptions = {}): Proof {
  const representation = options.representation ?? "protected";
  const requesterHumanId = options.requesterHumanId ?? IDS.human;
  const namespaceId = options.namespaceId ?? IDS.namespace;
  const fingerprint = options.authorityFingerprint
    ?? fingerprintTaskContentAuthorityV1(currentAuthority({
      requesterHumanId,
      namespaceId,
    }));
  return Object.freeze({
    phase: "unmapped",
    reference: reference(),
    task: Object.freeze({ id: IDS.task, requestorId: IDS.user }),
    run: Object.freeze({
      id: IDS.run,
      outcome: "completed",
      completedAt: new Date(COMPLETED_AT),
    }),
    job: Object.freeze({
      id: IDS.job,
      status: "running",
      startedAt: new Date("2026-10-08T08:00:00.000Z"),
      completedAt: null,
    }),
    binding: Object.freeze({
      bindingId: `task-run-output:${IDS.run}`,
      deliveryMode: "none",
      resultAttachedAt: null,
      completedAt: null,
    }),
    lifecycle: Object.freeze({
      sequence: 1,
      operationId: `task-run-result:${IDS.run}`,
      authorityFingerprint: fingerprint.slice(),
      requesterHumanId,
      contentNamespaceId: namespaceId,
      cryptoObjectId: RESULT_OBJECT,
      representation,
      requiredNamespaceFingerprint: REQUIRED_FINGERPRINT.slice(),
      attemptCount: options.attemptCount ?? 0,
      leaseToken: options.leaseToken ?? null,
      cryptoCompletedAt: null,
    }),
  });
}

function heldAuthority(
  authority = currentAuthority(),
): InitialTaskRuntimeNamespaceAuthority {
  return Object.freeze({
    sourceRoomId: IDS.sourceRoom,
    sourceNamespaceId: authority.namespaceId,
    facts: Object.freeze([Object.freeze({
      namespaceId: authority.namespaceId,
      domainId: authority.domainId,
      expectedAccessRevision: authority.expectedAccessRevision,
      expectedPolicyRevision: authority.expectedPolicyRevision,
      expectedDomainEpoch: 2,
      expectedAuthorizationRevision: 3,
    })]),
  });
}

function verified(
  source: Proof,
  overrides: Partial<VerifiedTaskContentCryptoRevisionV1> = {},
): VerifiedTaskContentCryptoRevisionV1 {
  return Object.freeze({
    coordinate: RESULT_COORDINATE,
    objectId: RESULT_OBJECT,
    objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: source.lifecycle.contentNamespaceId,
    authorityFingerprint: source.lifecycle.authorityFingerprint.slice(),
    ...overrides,
  });
}

type Write = Readonly<{
  table: unknown;
  patch: Readonly<Record<string, unknown>>;
}>;

type HarnessOptions = Readonly<{
  proofs: readonly (Proof | null)[];
  heldAuthorities?: readonly InitialTaskRuntimeNamespaceAuthority[];
  leaseIsLive?: boolean;
  updateResults?: readonly (readonly Readonly<Record<string, unknown>>[])[];
}>;

function harness(options: HarnessOptions) {
  const proofQueue = [...options.proofs];
  const heldQueue = [...(options.heldAuthorities ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const events: string[] = [];
  const writes: Write[] = [];
  const selects: unknown[] = [];
  const lockedProofs: Proof[] = [];
  let authorityDepth = 0;
  const restricted = {} as never;

  const tx = {
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(Object.freeze({ table, patch: Object.freeze({ ...patch }) }));
            events.push(table === taskRuns ? "write-run" : "write-ledger");
            const queued = updateResults.shift();
            if (queued !== undefined) return queued;
            return table === taskRuns ? [{ id: IDS.run }] : [{ sequence: 1 }];
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            selects.push(table);
            events.push("check-lease");
            return options.leaseIsLive === false ? [] : [{ sequence: 1 }];
          },
        }),
      }),
    }),
  } as unknown as Transaction;

  const withAuthority: typeof withTaskContentNamespaceAuthority =
    async <Value>(request: WithAuthorityInput<Value>): Promise<Value | null> => {
      authorityDepth += 1;
      events.push("authority-open");
      try {
        const valid = await request.validateCurrentTaskRun(
          {} as never,
          tx,
          {} as never,
        );
        if (!valid) return null;
        return await request.use(
          heldQueue.shift() ?? heldAuthority(),
          {} as never,
          tx,
          restricted,
        );
      } finally {
        authorityDepth -= 1;
        events.push("authority-close");
      }
    };

  const lockProof = async (
    transaction: Transaction,
    input: SettlePublishedProtectedTaskRunAuthorizationInput,
    phase: "mapped" | "unmapped",
  ): Promise<Proof | null> => {
    expect(transaction).toBe(tx);
    expect(input).toEqual(publication());
    expect(phase).toBe("unmapped");
    events.push("lock-proof");
    const next = proofQueue.shift() ?? null;
    if (next !== null) lockedProofs.push(next);
    return next;
  };

  return {
    tx,
    restricted,
    events,
    writes,
    selects,
    lockedProofs,
    get authorityDepth() { return authorityDepth; },
    dependencies: {
      withAuthority,
      lockProof,
    },
  };
}

function recoveryInput(overrides: Partial<PostgresTaskRunResultRecoveryInput> = {}):
PostgresTaskRunResultRecoveryInput {
  return Object.freeze({
    authority: Object.freeze({
      runner: null as never,
      restricted: null as never,
      crypto: null as never,
      serverScope: "https://nautilo.example",
      taskId: IDS.task,
      requesterUserId: IDS.user,
      requesterHumanId: IDS.human,
      agentId: IDS.agent,
      contentNamespaceId: IDS.namespace,
      sourceRoomId: IDS.sourceRoom,
      expectedPolicyRevision: 7,
    }),
    publication: publication(),
    leaseToken: IDS.lease,
    verify: async () => null,
    settleIntegrityFailure: async () => true,
    ...overrides,
  });
}

describe("Postgres protected Task result publication recovery", () => {
  test("verifies outside held authority and maps only after a fresh exact proof", async () => {
    const initial = proof();
    const final = proof({ leaseToken: IDS.lease });
    const f = harness({ proofs: [initial, final] });
    const outcome = await reconcilePostgresTaskRunResultPublication(
      recoveryInput({
        verify: async (candidate, authority) => {
          expect(f.authorityDepth).toBe(0);
          expect(candidate.objectId).toBe(RESULT_OBJECT);
          expect(authority).toEqual(currentAuthority());
          f.events.push("verify");
          return verified(initial);
        },
      }),
      f.dependencies,
    );

    expect(outcome).toBe("mapped");
    expect(f.lockedProofs).toHaveLength(2);
    expect(f.lockedProofs[0]).not.toBe(f.lockedProofs[1]);
    expect(f.events.indexOf("verify"))
      .toBeGreaterThan(f.events.indexOf("authority-close"));
    expect(f.events.lastIndexOf("lock-proof"))
      .toBeGreaterThan(f.events.indexOf("verify"));
    expect(f.writes.map(write => write.table)).toEqual([
      taskRunResultCryptoRevisions,
      taskRunResultCryptoRevisions,
      taskRuns,
    ]);
    expect(f.selects).toEqual([]);
  });

  test("retries missing or unavailable ciphertext without mapping product state", async () => {
    for (const value of ["missing", "throw"] as const) {
      const initial = proof();
      const final = proof({ leaseToken: IDS.lease });
      const f = harness({ proofs: [initial, final] });
      const outcome = await reconcilePostgresTaskRunResultPublication(
        recoveryInput({
          verify: value === "missing"
            ? async () => null
            : async () => { throw new Error("storage unavailable"); },
        }),
        f.dependencies,
      );

      expect(outcome, value).toBe("pending");
      expect(f.writes.map(write => write.table), value).toEqual([
        taskRunResultCryptoRevisions,
        taskRunResultCryptoRevisions,
      ]);
      expect(f.writes[1]?.patch, value).toMatchObject({
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(f.selects, value).toEqual([taskRunResultCryptoRevisions]);
    }
  });

  test("skips final writes after proof, authority, or lease drift", async () => {
    const cases = [
      {
        name: "proof drift",
        proofs: [proof(), proof({
          leaseToken: IDS.lease,
          requesterHumanId: IDS.agent,
        })],
      },
      {
        name: "authority drift",
        proofs: [proof(), proof({ leaseToken: IDS.lease })],
        heldAuthorities: [
          heldAuthority(),
          heldAuthority(currentAuthority({ expectedAccessRevision: 10 })),
        ],
      },
      {
        name: "lease loss",
        proofs: [proof(), proof({ leaseToken: IDS.otherLease })],
      },
    ];
    for (const value of cases) {
      const f = harness(value);
      expect(await reconcilePostgresTaskRunResultPublication(
        recoveryInput({ verify: async () => verified(value.proofs[0]!) }),
        f.dependencies,
      ), value.name).toBe("pending");
      expect(f.writes.map(write => write.table), value.name)
        .toEqual([taskRunResultCryptoRevisions]);
      expect(f.selects, value.name).toEqual([]);
    }
  });

  test("does not claim or verify when initial held authority has drifted", async () => {
    const initial = proof();
    const f = harness({
      proofs: [initial],
      heldAuthorities: [heldAuthority(currentAuthority({
        expectedAccessRevision: 10,
      }))],
    });
    let verifications = 0;
    let settlements = 0;
    expect(await reconcilePostgresTaskRunResultPublication(
      recoveryInput({
        verify: async () => {
          verifications += 1;
          return verified(initial);
        },
        settleIntegrityFailure: async () => {
          settlements += 1;
          return true;
        },
      }),
      f.dependencies,
    )).toBe("pending");

    expect(verifications).toBe(0);
    expect(settlements).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.selects).toEqual([]);
  });

  test("does not map the Run after losing the final exact lease CAS", async () => {
    const initial = proof();
    const final = proof({ leaseToken: IDS.lease });
    const f = harness({
      proofs: [initial, final],
      updateResults: [[{ sequence: 1 }], []],
    });
    expect(await reconcilePostgresTaskRunResultPublication(
      recoveryInput({ verify: async () => verified(initial) }),
      f.dependencies,
    )).toBe("pending");

    expect(f.writes.map(write => write.table)).toEqual([
      taskRunResultCryptoRevisions,
      taskRunResultCryptoRevisions,
    ]);
    expect(f.writes.some(write => write.table === taskRuns)).toBe(false);
  });

  test("settles exact terminal failure before quarantine and honors denial", async () => {
    for (const allowed of [true, false]) {
      const initial = proof({
        attemptCount: TASK_CONTENT_RECONCILE_MAX_ATTEMPTS - 1,
      });
      const final = proof({
        leaseToken: IDS.lease,
        attemptCount: TASK_CONTENT_RECONCILE_MAX_ATTEMPTS - 1,
      });
      const f = harness({ proofs: [initial, final] });
      let settled = 0;
      const outcome = await reconcilePostgresTaskRunResultPublication(
        recoveryInput({
          verify: async () => null,
          settleIntegrityFailure: async (transaction, exact, restricted) => {
            expect(transaction).toBe(f.tx);
            expect(exact).toBe(final);
            expect(restricted).toBe(f.restricted);
            expect(f.events.at(-1)).toBe("check-lease");
            settled += 1;
            f.events.push("settle-failure");
            return allowed;
          },
        }),
        f.dependencies,
      );

      expect(settled).toBe(1);
      expect(outcome).toBe(allowed ? "quarantined" : "pending");
      expect(f.events.indexOf("settle-failure"))
        .toBeGreaterThan(f.events.indexOf("check-lease"));
      if (allowed) {
        expect(f.events.lastIndexOf("write-ledger"))
          .toBeGreaterThan(f.events.indexOf("settle-failure"));
      } else {
        expect(f.writes).toHaveLength(1);
      }
    }
  });

  test("retains the original verification and settlement callbacks across the claim", async () => {
    const initial = proof({
      attemptCount: TASK_CONTENT_RECONCILE_MAX_ATTEMPTS - 1,
    });
    const final = proof({
      leaseToken: IDS.lease,
      attemptCount: TASK_CONTENT_RECONCILE_MAX_ATTEMPTS - 1,
    });
    const f = harness({ proofs: [initial, final] });
    let originalVerifications = 0;
    let originalSettlements = 0;
    let substitutedVerifications = 0;
    let substitutedSettlements = 0;
    const mutable = {
      ...recoveryInput({
        verify: async () => {
          originalVerifications += 1;
          return null;
        },
        settleIntegrityFailure: async () => {
          originalSettlements += 1;
          return true;
        },
      }),
    };
    const operation = reconcilePostgresTaskRunResultPublication(
      mutable,
      f.dependencies,
    );
    mutable.verify = async () => {
      substitutedVerifications += 1;
      return verified(initial);
    };
    mutable.settleIntegrityFailure = async () => {
      substitutedSettlements += 1;
      return false;
    };

    expect(await operation).toBe("quarantined");
    expect(originalVerifications).toBe(1);
    expect(originalSettlements).toBe(1);
    expect(substitutedVerifications).toBe(0);
    expect(substitutedSettlements).toBe(0);
  });

  test("does not map verified bytes with substituted object, Namespace, or authority", async () => {
    const cases: ReadonlyArray<Readonly<{
      name: string;
      mutate(value: VerifiedTaskContentCryptoRevisionV1): VerifiedTaskContentCryptoRevisionV1;
    }>> = [
      { name: "object", mutate: value => ({ ...value, objectId: `${value.objectId}:other` }) },
      { name: "Namespace", mutate: value => ({ ...value, namespaceId: IDS.otherNamespace }) },
      { name: "authority", mutate: value => ({
        ...value, authorityFingerprint: new Uint8Array(32).fill(0xff),
      }) },
    ];
    for (const value of cases) {
      const initial = proof();
      const final = proof({ leaseToken: IDS.lease });
      const f = harness({ proofs: [initial, final] });
      expect(await reconcilePostgresTaskRunResultPublication(
        recoveryInput({ verify: async () => value.mutate(verified(initial)) }),
        f.dependencies,
      ), value.name).toBe("pending");
      expect(f.writes.some(write => write.table === taskRuns), value.name)
        .toBe(false);
    }
  });

  test("maps dual metadata without overwriting retained plaintext fields", async () => {
    const initial = proof({ representation: "dual" });
    const final = proof({ representation: "dual", leaseToken: IDS.lease });
    const f = harness({ proofs: [initial, final] });
    expect(await reconcilePostgresTaskRunResultPublication(
      recoveryInput({ verify: async () => verified(initial) }),
      f.dependencies,
    )).toBe("mapped");

    const runWrite = f.writes.find(write => write.table === taskRuns);
    expect(runWrite?.patch).toMatchObject({
      resultRepresentation: "dual",
      resultCryptoMappingState: "verified",
    });
    expect(runWrite?.patch).not.toHaveProperty("resultText");
    expect(runWrite?.patch).not.toHaveProperty("lastError");
    expect(new Set(f.writes.map(write => write.table))).toEqual(new Set([
      taskRunResultCryptoRevisions,
      taskRuns,
    ]));
  });
});
