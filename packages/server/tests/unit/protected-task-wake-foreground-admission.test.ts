import { describe, expect, test } from "bun:test";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  roomMembers,
  rooms,
  sessions,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type {
  CanonicalTranscriptTx,
  PolicyResolver,
} from "@nautilo/trust";
import {
  createProtectedTaskWakeForegroundAdmission,
} from "../../src/routes/protected-task-wake-foreground-admission";
import type {
  ProtectedTaskOutputReadIntent,
} from "../../src/routes/protected-task-output-read-product";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "10000000-0000-4000-8000-000000000002";
const USER = "10000000-0000-4000-8000-000000000003";
const HUMAN = "10000000-0000-4000-8000-000000000004";
const AGENT = "10000000-0000-4000-8000-000000000005";
const OTHER_AGENT = "10000000-0000-4000-8000-000000000006";
const ROOM_OWNER = "10000000-0000-4000-8000-000000000007";
const OWNER_HUMAN = "10000000-0000-4000-8000-000000000008";
const CHILD = "20000000-0000-4000-8000-000000000001";
const PARENT = "20000000-0000-4000-8000-000000000002";
const SESSION = "20000000-0000-4000-8000-000000000003";
const CONTENT_NAMESPACE = "30000000-0000-4000-8000-000000000001";
const DESTINATION_NAMESPACE = "30000000-0000-4000-8000-000000000002";
const EXTRA_NAMESPACE = "30000000-0000-4000-8000-000000000003";
const EXPANDED_NAMESPACE = "30000000-0000-4000-8000-000000000004";

const subject = Object.freeze({ userId: USER, humanActorId: HUMAN });

function intent(): ProtectedTaskOutputReadIntent {
  return Object.freeze({
    requesterUserId: USER,
    requesterHumanId: HUMAN,
    agentId: AGENT,
    contentNamespaceId: CONTENT_NAMESPACE,
    representation: "protected" as const,
    expectedPolicyRevision: 9,
    acceptedPolicyRevision: 8,
    initialState: "wake_queued" as const,
    result: Object.freeze({
      taskId: TASK,
      taskRunId: RUN,
      terminalStatus: "completed" as const,
      contentRevision: 1 as const,
      objectId: protectedTaskRunResultObjectId(TASK, RUN),
      cryptoAccessRevision: 0 as const,
      genesisManifestHash: new Uint8Array(32).fill(7),
      signerAgentId: AGENT,
    }),
    invocation: Object.freeze({
      kind: "wake" as const,
      bindingId: protectedTaskRunOutputBindingId(RUN),
      operationId: protectedTaskRunWakeOperationId(RUN),
      roomId: CHILD,
      sessionId: SESSION,
      jobId: protectedTaskRunWakeJobId(RUN),
      reference: Object.freeze({
        kind: "protected_task_delivery_v1" as const,
        taskId: TASK,
        taskRunId: RUN,
        bindingId: protectedTaskRunOutputBindingId(RUN),
        resultObjectId: protectedTaskRunResultObjectId(TASK, RUN),
        wakeOperationId: protectedTaskRunWakeOperationId(RUN),
      }),
    }),
  });
}

type Options = Readonly<{
  parentRoomId?: string | null;
  readable?: readonly string[];
  held?: readonly string[];
  requesterPresent?: boolean;
  targetAgentPresent?: boolean;
  sessionAgentId?: string;
  scopeEnvelope?: boolean;
  resolverUnavailable?: boolean;
  heldParentRoomId?: string | null;
  heldDestinationNamespaceId?: string;
}>;

function fixture(options: Options = {}) {
  const parentRoomId = options.parentRoomId === undefined
    ? PARENT : options.parentRoomId;
  const topLevelRoomId = parentRoomId ?? CHILD;
  const threadId = `room:${CHILD}:bot:${AGENT}`;
  const members = [
    ...(options.requesterPresent === false ? [] : [{
      actorId: HUMAN,
      kind: "user",
      ownerId: USER,
      agentId: null,
    }]),
    {
      actorId: OWNER_HUMAN,
      kind: "user",
      ownerId: ROOM_OWNER,
      agentId: null,
    },
    ...(options.targetAgentPresent === false ? [] : [{
      actorId: "40000000-0000-4000-8000-000000000001",
      kind: "agent",
      ownerId: ROOM_OWNER,
      agentId: AGENT,
    }]),
    {
      actorId: "40000000-0000-4000-8000-000000000002",
      kind: "agent",
      ownerId: ROOM_OWNER,
      agentId: OTHER_AGENT,
    },
  ];
  const events: string[] = [];
  let canonicalHeld = false;
  let canonicalTransactions = 0;
  const createTransaction = (
    currentParentRoomId: string | null,
    destinationNamespaceId: string,
  ) => {
    let roomReads = 0;
    return {
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) { table = value; return builder; },
        innerJoin() { return builder; },
        where() { return builder; },
        orderBy() { return builder; },
        limit() { return builder; },
        for() { return builder; },
        then(resolve: (value: readonly unknown[]) => unknown) {
          if (table === rooms) {
            roomReads += 1;
            return Promise.resolve(resolve(roomReads % 2 === 1 ? [{
              id: CHILD,
              namespaceId: destinationNamespaceId,
              parentRoomId: currentParentRoomId,
            }] : [{
              id: CHILD,
              ownerId: ROOM_OWNER,
              namespaceId: destinationNamespaceId,
              parentRoomId: currentParentRoomId,
              kind: currentParentRoomId === null ? "group" : "subthread",
              archivedAt: null,
              graphThreadId: `room:${CHILD}`,
            }]));
          }
          if (table === roomMembers) return Promise.resolve(resolve(members));
          if (table === sessions) return Promise.resolve(resolve([{
            id: SESSION,
            ownerId: ROOM_OWNER,
            agentId: options.sessionAgentId ?? AGENT,
            roomId: CHILD,
            threadId,
            personaId: "owner",
            endedAt: new Date("2026-10-12T08:00:00.000Z"),
          }]));
          throw new Error("unexpected table");
        },
      };
      return builder;
    },
    } as unknown as CanonicalTranscriptTx;
  };
  const transaction = createTransaction(
    options.heldParentRoomId === undefined
      ? parentRoomId : options.heldParentRoomId,
    options.heldDestinationNamespaceId ?? DESTINATION_NAMESPACE,
  );
  const optimistic = createTransaction(parentRoomId, DESTINATION_NAMESPACE);
  const product: PostgresJsBridgeConnection = {
    query: async () => [],
    transaction: async use => use(product),
    transactionOnce: async use => use(product),
  };
  const resolver = {
    buildEnvelope: async (_actor: string, lane: string, agentId: string,
      roomId: string) => {
      events.push(`resolver:${lane}:${roomId}:${agentId}`);
      if (canonicalHeld) {
        throw new Error("resolver called while canonical transaction is held");
      }
      if (options.resolverUnavailable === true) {
        throw new Error("policy unavailable");
      }
      if (options.scopeEnvelope === true) return {
        memoryMode: "scope" as const,
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId,
        scopeId: "50000000-0000-4000-8000-000000000001",
        toolPolicy: {},
      };
      return {
        memoryMode: "namespace" as const,
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId,
        readableNamespaces: [...(options.readable
          ?? [EXTRA_NAMESPACE, DESTINATION_NAMESPACE])],
        mutableNamespaces: [],
        writableNamespaces: [DESTINATION_NAMESPACE],
        toolPolicy: {},
      };
    },
  } as unknown as PolicyResolver;
  const held = options.held ?? [DESTINATION_NAMESPACE, EXTRA_NAMESPACE];
  let authorityProduct: PostgresJsBridgeConnection | undefined;
  let authorityNamespaceIds: readonly string[] | undefined;
  const admission = createProtectedTaskWakeForegroundAdmission({
    db: optimistic as never,
    resolver,
  }, {
    createProductContext: (async () => ({
      handle: {} as never,
      canonicalRunner: {
        transaction: async (use: (tx: CanonicalTranscriptTx,
          executor: PostgresJsBridgeConnection) => Promise<unknown>) => {
          events.push("discover-transaction");
          canonicalTransactions += 1;
          canonicalHeld = true;
          try {
            return await use(createTransaction(
              canonicalTransactions === 1
                ? parentRoomId
                : options.heldParentRoomId === undefined
                ? parentRoomId : options.heldParentRoomId,
              canonicalTransactions === 1
                ? DESTINATION_NAMESPACE
                : options.heldDestinationNamespaceId ?? DESTINATION_NAMESPACE,
            ), product);
          } finally {
            canonicalHeld = false;
          }
        },
      },
    })) as never,
    createNamespaceAuthority: currentProduct => {
      authorityProduct = currentProduct;
      return {
        withCurrentReadableNamespaceSet: async operation => {
          events.push(`owner:${operation.sourceRoomId}:${operation.destinationRoom?.roomId}`);
          authorityNamespaceIds = operation.namespaceIds;
          const entries = held.map(namespaceId => ({
            namespaceId,
            authority: Object.freeze({}),
          }));
          return operation.use(entries as never);
        },
      };
    },
  });
  return {
    admission,
    events,
    product,
    transaction,
    topLevelRoomId,
    authorityProduct: () => authorityProduct,
    authorityNamespaceIds: () => authorityNamespaceIds,
  };
}

describe("protected Task wake foreground admission", () => {
  test("uses the parent Namespace audience while retaining the actual Subthread Session", async () => {
    const value = fixture();
    expect(await value.admission.discover({ intent: intent(), subject }))
      .toEqual({ namespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE] });
    expect(value.events).toEqual([
      "discover-transaction",
      `resolver:room:${PARENT}:${PARENT}:${AGENT}`,
      "discover-transaction",
      `owner:${PARENT}:${CHILD}`,
    ]);
    expect(value.authorityProduct()).toBeDefined();
  });

  test("borrows the supplied product and transaction for current admission", async () => {
    const value = fixture();
    expect(await value.admission.readCurrent({
      intent: intent(),
      subject,
      product: value.product,
      transaction: value.transaction,
      expectedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
    })).toEqual({ namespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE] });
    expect(value.authorityProduct()).toBe(value.product);
    expect(value.events).not.toContain("discover-transaction");
  });

  test("revalidates the expected current set without calling the resolver", async () => {
    const value = fixture({ held: [DESTINATION_NAMESPACE, EXPANDED_NAMESPACE] });
    expect(await value.admission.readCurrent({
      intent: intent(),
      subject,
      product: value.product,
      transaction: value.transaction,
      expectedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
    })).toBeNull();
    expect(value.events).toEqual([
      `owner:${PARENT}:${CHILD}`,
    ]);
    expect(value.authorityProduct()).toBe(value.product);
  });

  test("keeps a top-level destination as both entry Room and Namespace authority", async () => {
    const value = fixture({ parentRoomId: null });
    expect(await value.admission.discover({ intent: intent(), subject }))
      .toEqual({ namespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE] });
    expect(value.events).toContain(
      `owner:${CHILD}:${CHILD}`,
    );
  });

  test("rejects Room coordinate and Namespace drift under the held owner", async () => {
    expect(await fixture({ heldParentRoomId: CHILD }).admission.discover({
      intent: intent(), subject,
    })).toBeNull();
    expect(await fixture({
      heldDestinationNamespaceId: EXPANDED_NAMESPACE,
    }).admission.discover({ intent: intent(), subject })).toBeNull();
  });

  test("does not silently narrow the ordinary foreground Namespace proposal", async () => {
    const value = fixture({ held: [DESTINATION_NAMESPACE] });
    expect(await value.admission.discover({ intent: intent(), subject }))
      .toBeNull();
  });

  test("retains an exact subset when the ordinary inventory has expanded", async () => {
    const selected = Object.freeze({
      ...intent(),
      continuation: Object.freeze({
        retainedSourceNamespaceIds: [DESTINATION_NAMESPACE],
      }) as never,
    });
    const value = fixture({
      readable: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE, EXPANDED_NAMESPACE],
      held: [DESTINATION_NAMESPACE],
    });
    expect(await value.admission.discover({ intent: selected, subject }))
      .toEqual({ namespaceIds: [DESTINATION_NAMESPACE] });
    expect(value.authorityNamespaceIds()).toEqual([DESTINATION_NAMESPACE]);
  });

  test("rejects Scope inheritance, a removed requester, and target-Agent substitution", async () => {
    expect(await fixture({ scopeEnvelope: true }).admission.discover({
      intent: intent(), subject,
    })).toBeNull();
    expect(await fixture({ requesterPresent: false }).admission.discover({
      intent: intent(), subject,
    })).toBeNull();
    expect(await fixture({ targetAgentPresent: false }).admission.discover({
      intent: intent(), subject,
    })).toBeNull();
    expect(await fixture({ sessionAgentId: OTHER_AGENT }).admission.discover({
      intent: intent(), subject,
    })).toBeNull();
  });

  test("requires the destination Namespace in the complete ordinary proposal", async () => {
    const value = fixture({ readable: [EXTRA_NAMESPACE] });
    expect(await value.admission.discover({ intent: intent(), subject }))
      .toBeNull();
  });

  test("fails closed while ordinary foreground policy is unavailable", async () => {
    const value = fixture({ resolverUnavailable: true });
    expect(await value.admission.discover({ intent: intent(), subject }))
      .toBeNull();
  });
});


test("held accepted inventory requires the exact retained source set", async () => {
  const value = fixture({ readable: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE, EXPANDED_NAMESPACE] });
  expect(await value.admission.readCurrent({ intent: intent(), subject,
    product: value.product, transaction: value.transaction,
    expectedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
    retainedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
  })).toEqual({ namespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE] });
  const revoked = fixture({ held: [DESTINATION_NAMESPACE, EXPANDED_NAMESPACE] });
  expect(await revoked.admission.readCurrent({ intent: intent(), subject,
    product: revoked.product, transaction: revoked.transaction,
    expectedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
    retainedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
  })).toBeNull();
  expect(revoked.authorityProduct()).toBe(revoked.product);
});

test("current admission rejects held audience drift without resolving policy", async () => {
  const value = fixture({ requesterPresent: false });
  expect(await value.admission.readCurrent({ intent: intent(), subject,
    product: value.product, transaction: value.transaction,
    expectedNamespaceIds: [DESTINATION_NAMESPACE, EXTRA_NAMESPACE],
  })).toBeNull();
  expect(value.events).toEqual([`owner:${PARENT}:${CHILD}`]);
});
