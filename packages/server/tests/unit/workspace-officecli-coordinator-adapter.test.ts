import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DirectDatabase, WorkspaceDocumentMutationTx } from "@nautilo/db";
import { HumanEditLeaseRegistry } from "@nautilo/document-mutations";
import {
  buildWorkspaceOfficeCliPlan,
  createWorkspaceOfficeCliCommitExecution,
} from "../../src/document-mutations/workspace-officecli-coordinator-adapter";
import { executeWorkspaceAgentMutation } from "../../src/document-mutations/workspace-agent-mutation-coordinator";

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const request = (overrides: Record<string, unknown> = {}) => ({
  authority: {
    ownerId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    turnId: "turn-1",
    envelope: {
      ownerId: "owner-1",
      actorId: "human-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: ["namespace-1"],
      mutableNamespaces: ["namespace-1"],
      writableNamespaces: ["namespace-1"],
      toolPolicy: {},
    },
  },
  source: {
    artifactInternalId: "11111111-1111-4111-8111-111111111111",
    artifactId: "public-source-artifact",
    logicalPath: "reports/source.docx",
    revision: 7,
    bytes: bytes("source"),
  },
  outputPath: "reports/source.docx",
  postImage: bytes("post-image"),
  commandArgs: { command: "set" },
  ...overrides,
});

function leases() {
  return new HumanEditLeaseRegistry({
    ttlMs: 60_000,
    newLeaseId: () => "lease-1",
  });
}

const roomAuthority = {
  createNamespaceId: "namespace-1",
  readableNamespaceIds: ["namespace-1"],
};

function roomLockQueryRows(): readonly unknown[][] {
  const room = {
    id: "room-1",
    namespaceId: "namespace-1",
    kind: "group",
    parentRoomId: null,
    humanActorIds: ["human-1"],
    namespaceAccessRevision: 1,
  };
  return [
    [{ ...room, publicBoundaryRoomId: null }],
    // Discover the complete readable Room set and its Namespace owners before
    // the ordered Room locks; recheck that exact set before member locks.
    [room], // readable candidates
    [room], // requested Rooms
    [room], // requested Rooms plus Namespace owners
    [room], // ordered Room lock
    [room], // current readable candidates
    [{ actorId: "human-1" }],
    [{ id: "agent-actor-1" }],
    [{ actorId: "agent-actor-1" }],
  ];
}

/** Minimal fluent Drizzle fixture for the DB query helpers used by the shared resolver. */
function queuedDatabase(rows: readonly (readonly unknown[])[]): DirectDatabase {
  let index = 0;
  const next = () => {
    const values = rows[index++];
    if (values === undefined) throw new Error(`unexpected DB query ${index}`);
    const query = [...values] as unknown as Record<string, unknown>;
    for (const method of [
      "from",
      "innerJoin",
      "leftJoin",
      "where",
      "limit",
      "for",
      "orderBy",
    ] as const) {
      query[method] = () => query;
    }
    return query;
  };
  const tx = {
    execute: async () => undefined,
    select: next,
    selectDistinct: next,
  } as unknown as WorkspaceDocumentMutationTx;
  return {
    select: next,
    selectDistinct: next,
    transaction: async (
      callback: (transaction: WorkspaceDocumentMutationTx) => unknown,
    ) => callback(tx),
  } as unknown as DirectDatabase;
}

function workspaceArtifact(input: {
  readonly internalId: string;
  readonly publicId: string;
  readonly logicalPath: string;
  readonly bytes: Uint8Array;
  readonly revision: number;
  readonly storageUri: string;
}) {
  const now = new Date(0);
  return {
    id: input.internalId,
    artifactId: input.publicId,
    path: input.logicalPath,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: input.bytes.byteLength,
    storageUri: input.storageUri,
    revision: input.revision,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function candidate(input: {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}) {
  const absolutePath = `/tmp/workspace-document-mutation-content/sha256/${input.sha256.slice(0, 2)}/${input.sha256}`;
  return {
    sha256: input.sha256,
    size: input.bytes.byteLength,
    absolutePath,
    storageUri: `file://${absolutePath}`,
    reused: false,
  };
}

function liveCandidate(input: {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}) {
  const absolutePath = `/tmp/workspace-document-mutation-content/live/${input.sha256.slice(0, 2)}/${input.sha256}.test`;
  return {
    sha256: input.sha256,
    size: input.bytes.byteLength,
    absolutePath,
    storageUri: `file://${absolutePath}`,
  };
}

describe("Workspace OfficeCLI coordinator adapter", () => {
  test("in-place OfficeCLI is one exact binary update CAS", () => {
    const plan = buildWorkspaceOfficeCliPlan({
      operationId: "operation-1",
      request: request(),
    });
    expect(plan).toMatchObject({
      operationId: "operation-1",
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [
        {
          kind: "update",
          before: {
            identity: {
              artifactId: "11111111-1111-4111-8111-111111111111",
              logicalPath: "reports/source.docx",
            },
            expectedVersion: { backendVersion: { revision: 7 } },
          },
          after: { identity: { logicalPath: "reports/source.docx" } },
        },
      ],
    });
    expect(plan?.preconditions).toBeUndefined();
  });

  test("distinct output is zero-clobber create plus a read-only exact source precondition", () => {
    const plan = buildWorkspaceOfficeCliPlan({
      operationId: "operation-2",
      request: request({ outputPath: "reports/copy.docx" }),
    });
    expect(plan).toMatchObject({
      preconditions: [
        {
          identity: {
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "reports/source.docx",
          },
          expectedVersion: { backendVersion: { revision: 7 } },
        },
      ],
      entries: [
        {
          kind: "create",
          after: { identity: { logicalPath: "reports/copy.docx" } },
        },
      ],
    });
  });

  test("malformed path and mismatched authority do not invoke a coordinator", async () => {
    let calls = 0;
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: {} as DirectDatabase,
      executeCoordinator: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });
    expect(
      await execute(request({ outputPath: "../escape.docx" })),
    ).toMatchObject({ ok: false, code: "failed" });
    expect(
      await execute(
        request({ authority: { ...request().authority, ownerId: "wrong" } }),
      ),
    ).toMatchObject({ ok: false, code: "missing_context" });
    expect(calls).toBe(0);
  });

  test("uses the durable receipt as idempotency proof and pumps the outbox after commit", async () => {
    let commits = 0;
    let pumped = 0;
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: {} as DirectDatabase,
      executeCoordinator: async () => {
        commits += 1;
        return {
          kind: "completed",
          commitState: "committed",
          result: { kind: "applied" },
          events: [],
        } as never;
      },
      lookupCommittedRevisionIds: async () => [["revision-1"]],
      onCommitted: () => {
        pumped += 1;
      },
    });
    expect(await execute(request())).toEqual({
      ok: true,
      revisionId: "revision-1",
      artifactInternalId: "11111111-1111-4111-8111-111111111111",
      artifactId: "public-source-artifact",
    });
    expect(commits).toBe(1);
    expect(pumped).toBe(1);
  });

  test("accepts the persisted OfficeCLI lane as the default history operation", async () => {
    const operationId = "workspace-officecli:production-receipt";
    const plan = buildWorkspaceOfficeCliPlan({
      operationId,
      request: request({ outputPath: "reports/copy.docx" }),
    });
    if (!plan) throw new Error("expected OfficeCLI plan");
    const entry = plan.entries[0];
    if (!entry || entry.kind !== "create") {
      throw new Error("expected OfficeCLI create entry");
    }
    const artifactInternalId = entry.after.identity.artifactId;
    const result = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: "human-1",
          ownerId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        },
        operationId,
        revisionGroupId: `workspace-officecli-group:${operationId}`,
        lane: "officecli",
        plan,
      },
      {
        humanEditLeases: leases(),
        assertCanWriteArtifacts: async () => {},
        db: queuedDatabase([
          ...roomLockQueryRows(),
          [{
            id: "mutation-officecli-1",
            operationId,
            ownerId: "owner-1",
            userId: "owner-1",
            agentId: "agent-1",
            roomId: "room-1",
            actorKind: "agent",
            actorId: "agent-1",
            lane: "officecli",
            turnId: "turn-1",
          }],
          [{
            id: "entry-officecli-1",
            mutationId: "mutation-officecli-1",
            sequence: 0,
            mutationKind: "create",
            artifactInternalId,
            historyOperation: "officecli",
            restoreFromEntryId: null,
            beforeLogicalPath: null,
            afterLogicalPath: "reports/copy.docx",
          }],
          [{
            mutationEntryId: "entry-officecli-1",
            kind: "revision",
            sequence: 0,
            value: "revision-officecli-1",
          }],
        ]),
        executeCoordinator: async () =>
          ({
            kind: "completed",
            commitState: "committed",
            result: { kind: "applied" },
            events: [],
          }) as never,
      },
    );
    expect(result).toEqual({
      kind: "committed",
      outcome: "completed",
      revisionIds: [["revision-officecli-1"]],
      outputArtifactIds: [artifactInternalId],
    });
  });

  test("shares the committed output's exact internal identity with its producer", async () => {
    const plan = buildWorkspaceOfficeCliPlan({
      operationId: "operation-output-identity",
      request: request({ outputPath: "reports/copy.docx" }),
    });
    if (!plan) throw new Error("expected OfficeCLI plan");
    const output = plan.entries[0];
    if (!output || output.kind === "delete") {
      throw new Error("expected OfficeCLI postimage entry");
    }
    const result = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: "human-1",
          ownerId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        },
        operationId: plan.operationId,
        revisionGroupId: `workspace-officecli-group:${plan.operationId}`,
        lane: "officecli",
        plan,
      },
      {
        humanEditLeases: leases(),
        assertCanWriteArtifacts: async () => {},
        db: {} as DirectDatabase,
        executeCoordinator: async () =>
          ({
            kind: "completed",
            commitState: "committed",
            result: { kind: "applied" },
            events: [],
          }) as never,
        lookupCommittedRevisionIds: async () => [["revision-copy"]],
      },
    );
    expect(result).toMatchObject({
      kind: "committed",
      outputArtifactIds: [output.after.identity.artifactId],
    });
  });

  test("recovers a rebased commit from its trusted durable receipt", async () => {
    const artifactInternalId = "11111111-1111-4111-8111-111111111111";
    const operationId = "workspace-file:rebased-operation";
    const plan = {
      operationId,
      actor: { kind: "agent" as const, agentId: "agent-1" },
      turnId: "turn-1",
      entries: [{
        kind: "update" as const,
        before: {
          identity: {
            kind: "workspace_artifact" as const,
            artifactId: artifactInternalId,
            logicalPath: "notes/rebased.txt",
          },
          expectedVersion: {
            identity: {
              kind: "workspace_artifact" as const,
              artifactId: artifactInternalId,
              logicalPath: "notes/rebased.txt",
            },
            backendVersion: { kind: "artifact_revision" as const, revision: 1 },
            sha256: sha256(bytes("base")),
          },
          bytes: bytes("base"),
        },
        after: {
          identity: {
            kind: "workspace_artifact" as const,
            artifactId: artifactInternalId,
            logicalPath: "notes/rebased.txt",
          },
          bytes: bytes("human plus agent"),
          sha256: sha256(bytes("human plus agent")),
        },
      }],
    };
    const result = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: "human-1",
          ownerId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        },
        operationId,
        revisionGroupId: "workspace-history-turn:turn-1",
        lane: "file_tool",
        historyOperation: "undo",
        restoreFromEntryId: "source-entry-1",
        plan,
      },
      {
        humanEditLeases: leases(),
        assertCanWriteArtifacts: async () => {},
        resolveRoomAuthority: async () => roomAuthority,
        db: queuedDatabase([
          ...roomLockQueryRows(),
          [{
            id: "mutation-1",
            operationId,
            ownerId: "owner-1",
            userId: "owner-1",
            agentId: "agent-1",
            roomId: "room-1",
            actorKind: "agent",
            actorId: "agent-1",
            lane: "file_tool",
            turnId: "turn-1",
          }],
          [{
            id: "entry-1",
            mutationId: "mutation-1",
            sequence: 0,
            mutationKind: "update",
            artifactInternalId,
            historyOperation: "undo",
            restoreFromEntryId: "source-entry-1",
            beforeLogicalPath: "notes/rebased.txt",
            afterLogicalPath: "notes/rebased.txt",
          }],
          [{
            mutationEntryId: "entry-1",
            kind: "revision",
            sequence: 0,
            value: "revision-rebased",
          }],
        ]),
        executeCoordinator: async () =>
          ({
            kind: "completed",
            commitState: "committed",
            result: {
              kind: "rebased",
              operationId,
              revisionGroupId: "workspace-history-turn:turn-1",
              paths: [],
            },
            events: [],
          }) as never,
      },
    );
    expect(result).toMatchObject({
      kind: "committed",
      rebased: true,
      revisionIds: [["revision-rebased"]],
    });
  });

  test("projects a distinct create's committed output identity as both internal and public id", async () => {
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: {} as DirectDatabase,
      executeCoordinator: async () =>
        ({
          kind: "completed",
          commitState: "committed",
          result: { kind: "applied" },
          events: [],
        }) as never,
      lookupCommittedRevisionIds: async () => [["revision-copy"]],
    });
    const result = await execute(request({ outputPath: "reports/copy.docx" }));
    expect(result).toMatchObject({
      ok: true,
      revisionId: "revision-copy",
    });
    if (!result.ok) throw new Error("expected committed copy");
    expect(result.artifactId).toBe(result.artifactInternalId);
    expect(result.artifactInternalId).not.toBe(
      request().source.artifactInternalId,
    );
  });

  test("classifies an occupied distinct output through the real shared backend without mutation", async () => {
    const source = request().source;
    const sourceArtifact = workspaceArtifact({
      internalId: source.artifactInternalId,
      publicId: source.artifactId,
      logicalPath: source.logicalPath,
      bytes: source.bytes,
      revision: source.revision,
      storageUri: "file:///source",
    });
    const occupied = workspaceArtifact({
      internalId: "22222222-2222-4222-8222-222222222222",
      publicId: "public-occupied-artifact",
      logicalPath: "reports/copy.docx",
      bytes: bytes("human destination"),
      revision: 1,
      storageUri: "file:///occupied",
    });
    let pointerWrites = 0;
    let createWrites = 0;
    let receiptWrites = 0;
    let outboxPumps = 0;
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: queuedDatabase([
        ...roomLockQueryRows(),
        [sourceArtifact],
        [occupied],
      ]),
      resolveRoomAuthority: async () => roomAuthority,
      backendTestDependencies: {
        helpers: {
          acquireOperationLock: async () =>
            ({ operationId: "office-operation" }) as never,
          findReplay: async () => ({ kind: "absent" }),
          casPointer: async () => {
            pointerWrites += 1;
            throw new Error("occupied output must not update a pointer");
          },
          createArtifact: async () => {
            createWrites += 1;
            throw new Error("occupied output must not create");
          },
          insertReceipt: async () => {
            receiptWrites += 1;
            throw new Error("occupied output must not write a receipt");
          },
        },
      },
      onCommitted: () => {
        outboxPumps += 1;
      },
    });
    expect(
      await execute(request({ outputPath: "reports/copy.docx" })),
    ).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: true,
    });
    expect({ pointerWrites, createWrites, receiptWrites, outboxPumps }).toEqual(
      {
        pointerWrites: 0,
        createWrites: 0,
        receiptWrites: 0,
        outboxPumps: 0,
      },
    );
  });

  test("classifies source drift after real backend prepare without mutation", async () => {
    const source = request().source;
    const sourceArtifact = workspaceArtifact({
      internalId: source.artifactInternalId,
      publicId: source.artifactId,
      logicalPath: source.logicalPath,
      bytes: source.bytes,
      revision: source.revision,
      storageUri: "file:///source",
    });
    const output = bytes("post-image");
    let currentSource = source.bytes;
    let pointerWrites = 0;
    let createWrites = 0;
    let receiptWrites = 0;
    let outboxPumps = 0;
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: queuedDatabase([
        ...roomLockQueryRows(),
        [sourceArtifact],
        [],
        ...roomLockQueryRows(),
        ...roomLockQueryRows(),
        [sourceArtifact],
        [{ namespaceId: "namespace-1" }],
        [],
        ...roomLockQueryRows(),
        ...roomLockQueryRows(),
        [sourceArtifact],
        [{ namespaceId: "namespace-1" }],
        [],
      ]),
      resolveRoomAuthority: async () => roomAuthority,
      backendTestDependencies: {
        readContent: async (storageUri) => {
          if (storageUri === sourceArtifact.storageUri) return currentSource;
          if (storageUri.includes(sha256(output))) return output;
          throw new Error(`unexpected content read ${storageUri}`);
        },
        writeCandidate: async (input) => candidate(input),
        writeLiveCandidate: async (input) => {
          currentSource = bytes(
            "human changed source after OfficeCLI generation",
          );
          return liveCandidate(input);
        },
        helpers: {
          acquireOperationLock: async () =>
            ({ operationId: "office-operation" }) as never,
          findReplay: async () => ({ kind: "absent" }),
          acquireArtifactLock: async () => undefined as never,
          casPointer: async () => {
            pointerWrites += 1;
            throw new Error("stale source must not update a pointer");
          },
          createArtifact: async () => {
            createWrites += 1;
            throw new Error("stale source must not create output");
          },
          insertReceipt: async () => {
            receiptWrites += 1;
            throw new Error("stale source must not write a receipt");
          },
        },
      },
      onCommitted: () => {
        outboxPumps += 1;
      },
    });
    expect(
      await execute(request({ outputPath: "reports/copy.docx" })),
    ).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: true,
    });
    expect({ pointerWrites, createWrites, receiptWrites, outboxPumps }).toEqual(
      {
        pointerWrites: 0,
        createWrites: 0,
        receiptWrites: 0,
        outboxPumps: 0,
      },
    );
  });

  test("stale source or an occupied zero-clobber target is a retryable coordinator conflict with no outbox pump", async () => {
    let pumped = 0;
    const execute = createWorkspaceOfficeCliCommitExecution({
      humanEditLeases: leases(),
      assertCanWriteArtifacts: async () => {},
      db: {} as DirectDatabase,
      // The real backend produces this result after exact source CAS or
      // create-path vacancy admission. The adapter must not turn it into a
      // legacy write or claim success.
      executeCoordinator: async () =>
        ({
          kind: "rejected",
          result: {
            kind: "conflict",
            code: "stale_version",
            evidence: [],
            diagnostics: [],
          },
          events: [],
        }) as never,
      onCommitted: () => {
        pumped += 1;
      },
    });
    expect(
      await execute(request({ outputPath: "reports/copy.docx" })),
    ).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: true,
    });
    expect(pumped).toBe(0);
  });
});
