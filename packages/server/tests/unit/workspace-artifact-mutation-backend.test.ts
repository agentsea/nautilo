import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  DirectDatabase,
  WorkspaceDocumentMutationCommitReplay,
  WorkspaceDocumentMutationTx,
} from "@nautilo/db";
import {
  buildAtomicDocumentMutationEventBatch,
  createDocumentMutationCoordinator,
  createHumanEditAdmission,
  HumanEditLeaseRegistry,
  InMemoryDocumentLockManager,
  type BackendCommitPlan,
} from "@nautilo/document-mutations";
import {
  WorkspaceArtifactMutationBackend,
  workspaceMutationRequestDigest,
  type AuthorizedWorkspaceArtifact,
  type WorkspaceMutationAuthority,
} from "../../src/document-mutations/workspace-artifact-mutation-backend";

const artifactId = "11111111-1111-4111-8111-111111111111";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const beforeBytes = new TextEncoder().encode("before");
const afterBytes = new TextEncoder().encode("after");
const afterSha = sha(afterBytes);
const candidatePath =
  `/tmp/workspace-document-mutation-content/sha256/${afterSha.slice(0, 2)}/${afterSha}`;
const candidateUri = `file://${candidatePath}`;
const identity = {
  kind: "workspace_artifact" as const,
  artifactId,
  logicalPath: "note.md",
};

function plan(operationId = "op-1"): BackendCommitPlan<"workspace"> {
  return {
    operationId,
    actor: { kind: "human", humanId: "human-1" },
    entries: [{
      kind: "update",
      before: {
        identity,
        expectedVersion: {
          identity,
          backendVersion: { kind: "artifact_revision", revision: 3 },
          sha256: sha(beforeBytes),
        },
        bytes: beforeBytes,
      },
      after: { identity, bytes: afterBytes, sha256: sha(afterBytes) },
    }],
  };
}

function artifact(
  overrides: Partial<AuthorizedWorkspaceArtifact> = {},
): AuthorizedWorkspaceArtifact {
  return {
    id: artifactId,
    logicalPath: "note.md",
    storageUri: "file:///before",
    revision: 3,
    size: beforeBytes.byteLength,
    mimeType: "text/markdown",
    ...overrides,
  };
}

function authority(
  overrides: Partial<WorkspaceMutationAuthority> = {},
): WorkspaceMutationAuthority {
  return {
    actor: { kind: "human", humanId: "human-1" },
    lane: "editor_save",
    artifact: artifact(),
    ...overrides,
  };
}

function fakeDb(): DirectDatabase {
  return {
    transaction: async (callback: (tx: WorkspaceDocumentMutationTx) => unknown) =>
      callback({} as WorkspaceDocumentMutationTx),
  } as unknown as DirectDatabase;
}

function candidateContent(input: {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}) {
  return {
    sha256: input.sha256,
    size: input.bytes.byteLength,
    absolutePath: `/tmp/workspace-document-mutation-content/sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
    storageUri: `file:///tmp/workspace-document-mutation-content/sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
    reused: false,
  };
}

function storedBytes(storageUri: string): Uint8Array {
  return storageUri === candidateUri || storageUri.includes("/live/") ? afterBytes : beforeBytes;
}

function committedReplay(
  p: BackendCommitPlan<"workspace">,
  revisionGroupId = "group-durable",
): WorkspaceDocumentMutationCommitReplay {
  const entry = p.entries[0];
  if (entry?.kind !== "update") throw new Error("test plan must contain one update");
  const receipt = {
    backend: "workspace" as const,
    operationId: p.operationId,
    revisionGroupId,
    entries: [{
      kind: "update" as const,
      entryIndex: 0,
      revisionIds: ["revision-durable"] as const,
      undoRecordIds: ["undo-durable"] as const,
      before: entry.before.expectedVersion,
      after: {
        identity,
        backendVersion: { kind: "artifact_revision" as const, revision: 4 },
        sha256: entry.after.sha256,
      },
    }],
  };
  return {
    receipt,
    enlistedEventBatch: buildAtomicDocumentMutationEventBatch({
      backend: "workspace",
      plan: p,
      receipt,
      revisionGroupId,
      outcome: "applied",
    }),
  };
}

async function prepareCandidate(
  backend: WorkspaceArtifactMutationBackend,
  p: BackendCommitPlan<"workspace">,
) {
  const prepared = await backend.prepare(p);
  if (prepared.kind !== "prepared" || prepared.prepared.kind !== "candidate") {
    throw new Error("expected candidate preparation");
  }
  return prepared.prepared;
}

describe("WorkspaceArtifactMutationBackend", () => {
  test("read-only preconditions are exact source CAS checks at prepare and commit without a source receipt or event", async () => {
    const sourceIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: "22222222-2222-4222-8222-222222222222",
      logicalPath: "source.docx",
    };
    const sourceBytes = new TextEncoder().encode("source bytes");
    const sourceVersion = {
      identity: sourceIdentity,
      backendVersion: { kind: "artifact_revision" as const, revision: 9 },
      sha256: sha(sourceBytes),
    };
    const sourceArtifact = artifact({
      id: sourceIdentity.artifactId,
      logicalPath: sourceIdentity.logicalPath,
      storageUri: "file:///source",
      revision: sourceVersion.backendVersion.revision,
      size: sourceBytes.byteLength,
    });
    let sourceCurrent = sourceBytes;
    let pointerWrites = 0;
    let receiptWrites = 0;
    const p: BackendCommitPlan<"workspace"> = {
      ...plan("read-only-precondition"),
      actor: { kind: "agent", agentId: "agent-1" },
      preconditions: [{
        identity: sourceIdentity,
        expectedVersion: sourceVersion,
        bytes: sourceBytes,
      }],
    };
    const batchAuthority = {
      actor: { kind: "agent" as const, agentId: "agent-1" },
      lane: "apply_patch" as const,
      artifacts: [artifact(), sourceArtifact],
      nextMimeTypes: { [artifactId]: "text/markdown" },
      ownerId: "owner-1",
      userId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const { artifacts: _artifacts, ...replayAuthority } = batchAuthority;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => replayAuthority,
        resolve: async () => batchAuthority,
        resolveInTransaction: async () => batchAuthority,
      },
      readContent: async (uri) => {
        if (uri === "file:///before") return beforeBytes;
        if (uri === "file:///source") return sourceCurrent;
        return storedBytes(uri);
      },
      writeCandidate: async (input) => candidateContent(input),
      helpers: {
        acquireOperationLock: async () => ({ operationId: p.operationId }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async () => undefined as never,
        casPointer: async () => {
          pointerWrites += 1;
          throw new Error("stale precondition must not publish output");
        },
        insertReceipt: async () => {
          receiptWrites += 1;
          throw new Error("stale precondition must not record receipt");
        },
      },
    });
    const prepared = await backend.prepare(p);
    expect(prepared).toMatchObject({ kind: "prepared", prepared: { kind: "batch_candidate" } });
    if (prepared.kind !== "prepared") throw new Error("expected prepared plan");
    sourceCurrent = new TextEncoder().encode("human changed source");
    const outcome = await backend.commitPrepared({
      plan: p,
      prepared: prepared.prepared,
      revisionGroupId: "group-read-only-precondition",
      buildCommittedEventBatch: () => {
        throw new Error("stale precondition must not build an event");
      },
    });
    expect(outcome).toMatchObject({ kind: "failed", code: "backend_failure" });
    expect({ pointerWrites, receiptWrites }).toEqual({ pointerWrites: 0, receiptWrites: 0 });

    const staleAtPrepare = await backend.prepare({
      ...p,
      operationId: "read-only-precondition-stale-at-prepare",
    });
    expect(staleAtPrepare).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "stale_precondition" }],
    });
  });

  test("does not hash irrelevant create authority into a non-create batch", () => {
    const updatePlan = plan("non-create-digest");
    const shared = { nextMimeTypes: { [artifactId]: "text/markdown" } };
    expect(workspaceMutationRequestDigest(updatePlan, {
      ...shared,
      createNamespaceId: "current-room-namespace",
    })).toBe(workspaceMutationRequestDigest(updatePlan, {
      ...shared,
      createNamespaceId: "unrelated-return-room-namespace",
    }));
  });

  test("admits an OfficeCLI durable replay at prepare and reauthorizes it at commit", async () => {
    const p: BackendCommitPlan<"workspace"> = {
      ...plan("officecli-replay-admission"),
      actor: { kind: "agent", agentId: "agent-1" },
    };
    const replay = committedReplay(p, "officecli-replay-group");
    let replayAuthorityCalls = 0;
    let authoritativeWrites = 0;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => {
          replayAuthorityCalls += 1;
          return {
            actor: { kind: "agent", agentId: "agent-1" },
            lane: "officecli",
            nextMimeTypes: { [artifactId]: "text/markdown" },
            ownerId: "owner-1",
            userId: "owner-1",
            agentId: "agent-1",
            roomId: "room-1",
          };
        },
        resolve: async () => {
          throw new Error("durable replay must not resolve mutable artifact state");
        },
        resolveInTransaction: async () => {
          throw new Error("durable replay must not resolve mutable artifact state");
        },
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: p.operationId }) as never,
        findReplay: async () => ({ kind: "match", replay }) as never,
        casPointer: async () => {
          authoritativeWrites += 1;
          throw new Error("durable replay must not write");
        },
        insertReceipt: async () => {
          authoritativeWrites += 1;
          throw new Error("durable replay must not write");
        },
      },
    });

    const prepared = await backend.prepare(p);
    expect(prepared).toMatchObject({
      kind: "prepared",
      prepared: {
        kind: "replay",
        authorityScope: "batch",
        replay: { receipt: { revisionGroupId: "officecli-replay-group" } },
      },
      revisionGroupIdHint: "officecli-replay-group",
    });
    if (prepared.kind !== "prepared") throw new Error("expected OfficeCLI replay");

    const committed = await backend.commitPrepared({
      plan: p,
      prepared: prepared.prepared,
      revisionGroupId: "officecli-replay-group",
      buildCommittedEventBatch: () => {
        throw new Error("durable replay owns its enlisted event batch");
      },
    });
    expect(committed).toEqual({
      kind: "committed",
      receipt: replay.receipt,
      enlistedEventBatch: replay.enlistedEventBatch,
    });
    expect(replayAuthorityCalls).toBe(2);
    expect(authoritativeWrites).toBe(0);
  });

  test("replays create, delete, and move before post-state or later human-lease admission", async () => {
    const createBytes = new TextEncoder().encode("created");
    const deleteBytes = new TextEncoder().encode("deleted");
    const moveBytes = new TextEncoder().encode("moved");
    const movedAfterBytes = new TextEncoder().encode("moved-after");
    const createIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: "77777777-7777-4777-8777-777777777777",
      logicalPath: "created.md",
    };
    const deleteIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: "88888888-8888-4888-8888-888888888888",
      logicalPath: "deleted.md",
    };
    const moveIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: "99999999-9999-4999-8999-999999999999",
      logicalPath: "before-move.md",
    };
    const movedIdentity = {
      ...moveIdentity,
      logicalPath: "after-move.md",
    };
    const deleteVersion = {
      identity: deleteIdentity,
      backendVersion: { kind: "artifact_revision" as const, revision: 4 },
      sha256: sha(deleteBytes),
    };
    const moveVersion = {
      identity: moveIdentity,
      backendVersion: { kind: "artifact_revision" as const, revision: 6 },
      sha256: sha(moveBytes),
    };
    const structuralPlan: BackendCommitPlan<"workspace"> = {
      operationId: "structural-replay-op",
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [
        {
          kind: "create",
          after: {
            identity: createIdentity,
            bytes: createBytes,
            sha256: sha(createBytes),
          },
        },
        {
          kind: "delete",
          before: {
            identity: deleteIdentity,
            expectedVersion: deleteVersion,
            bytes: deleteBytes,
          },
        },
        {
          kind: "move",
          source: {
            identity: moveIdentity,
            expectedVersion: moveVersion,
            bytes: moveBytes,
          },
          after: {
            identity: movedIdentity,
            bytes: movedAfterBytes,
            sha256: sha(movedAfterBytes),
          },
        },
      ],
    };
    const receipt = {
      backend: "workspace" as const,
      operationId: structuralPlan.operationId,
      revisionGroupId: "structural-replay-group",
      entries: [
        {
          kind: "create" as const,
          entryIndex: 0,
          revisionIds: ["create-revision"] as const,
          undoRecordIds: ["create-undo"] as const,
          after: {
            identity: createIdentity,
            backendVersion: { kind: "artifact_revision" as const, revision: 1 },
            sha256: sha(createBytes),
          },
        },
        {
          kind: "delete" as const,
          entryIndex: 1,
          revisionIds: ["delete-revision"] as const,
          undoRecordIds: ["delete-undo"] as const,
          before: deleteVersion,
        },
        {
          kind: "move" as const,
          entryIndex: 2,
          revisionIds: ["move-revision"] as const,
          undoRecordIds: ["move-undo"] as const,
          before: moveVersion,
          after: {
            identity: movedIdentity,
            backendVersion: { kind: "artifact_revision" as const, revision: 7 },
            sha256: sha(movedAfterBytes),
          },
        },
      ],
    };
    const replay: WorkspaceDocumentMutationCommitReplay = {
      receipt,
      enlistedEventBatch: buildAtomicDocumentMutationEventBatch({
        backend: "workspace",
        plan: structuralPlan,
        receipt,
        revisionGroupId: receipt.revisionGroupId,
        outcome: "applied",
      }),
    };
    let fullAuthorityCalls = 0;
    let candidateWrites = 0;
    let authoritativeWrites = 0;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => ({
          actor: { kind: "agent", agentId: "agent-1" },
          lane: "apply_patch",
          createNamespaceId: "current-room-namespace",
          nextMimeTypes: {
            [createIdentity.artifactId]: "text/markdown",
            [moveIdentity.artifactId]: "text/markdown",
          },
          ownerId: "owner-1",
          userId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        }),
        resolve: async () => {
          fullAuthorityCalls += 1;
          return null;
        },
        resolveInTransaction: async () => {
          fullAuthorityCalls += 1;
          return null;
        },
      },
      writeCandidate: async (input) => {
        candidateWrites += 1;
        return candidateContent(input);
      },
      helpers: {
        acquireOperationLock: async () =>
          ({ operationId: structuralPlan.operationId }) as never,
        findReplay: async () => ({ kind: "match", replay }) as never,
        casPointer: async () => {
          authoritativeWrites += 1;
          throw new Error("replay must not write");
        },
        casDelete: async () => {
          authoritativeWrites += 1;
          throw new Error("replay must not write");
        },
        createArtifact: async () => {
          authoritativeWrites += 1;
          throw new Error("replay must not write");
        },
        insertReceipt: async () => {
          authoritativeWrites += 1;
          throw new Error("replay must not write");
        },
      },
    });
    const prepared = await backend.prepare(structuralPlan);
    expect(prepared).toMatchObject({
      kind: "prepared",
      prepared: {
        kind: "replay",
        replay: {
          receipt: {
            revisionGroupId: "structural-replay-group",
            entries: [
              { kind: "create" },
              { kind: "delete" },
              { kind: "move" },
            ],
          },
        },
      },
      revisionGroupIdHint: "structural-replay-group",
    });
    if (prepared.kind !== "prepared") throw new Error("expected structural replay");
    const committed = await backend.commitPrepared({
      plan: structuralPlan,
      prepared: prepared.prepared,
      revisionGroupId: "structural-replay-group",
      buildCommittedEventBatch: () => {
        throw new Error("durable replay owns its enlisted event batch");
      },
    });
    expect(committed).toEqual({
      kind: "committed",
      receipt: replay.receipt,
      enlistedEventBatch: replay.enlistedEventBatch,
    });
    expect(fullAuthorityCalls).toBe(0);
    expect(candidateWrites).toBe(0);
    expect(authoritativeWrites).toBe(0);
  });

  test("rejects a pre-existing human lease only after the coordinator holds the shared identity lock", async () => {
    const p: BackendCommitPlan<"workspace"> = {
      ...plan("human-lease-conflict"),
      actor: { kind: "agent", agentId: "agent-1" },
    };
    let lockHeld = false;
    let authorityCalls = 0;
    let mutationCalls = 0;
    const delegate = new InMemoryDocumentLockManager();
    const lockManager = {
      acquire: async (keys: readonly string[]) => {
        const lease = await delegate.acquire(keys);
        lockHeld = true;
        return {
          keys: lease.keys,
          release: async () => {
            lockHeld = false;
            await lease.release();
          },
        };
      },
    };
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => ({
          actor: { kind: "agent", agentId: "agent-1" },
          lane: "apply_patch",
          nextMimeTypes: { [artifactId]: "text/markdown" },
          ownerId: "owner-1",
          userId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        }),
        resolve: async () => {
          authorityCalls += 1;
          throw new Error("lease conflict must precede authority and storage");
        },
        resolveInTransaction: async () => {
          authorityCalls += 1;
          throw new Error("lease conflict must precede authority and storage");
        },
      },
      helpers: {
        acquireOperationLock: async () =>
          ({ operationId: p.operationId }) as never,
        findReplay: async () => ({ kind: "absent" }),
        casPointer: async () => {
          mutationCalls += 1;
          throw new Error("lease conflict must perform zero persistence");
        },
      },
    });
    const registry = new HumanEditLeaseRegistry({
      ttlMs: 60_000,
      newLeaseId: () => "human-lease-1",
    });
    const leasedEntry = p.entries[0];
    if (leasedEntry?.kind !== "update") throw new Error("expected update");
    expect(registry.register({
      sessionId: "session-1",
      humanId: "human-1",
      identity,
      baseVersion: leasedEntry.before.expectedVersion,
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
    }).status).toBe("ok");
    const coordinator = createDocumentMutationCoordinator({
      backend,
      hashBytes: sha,
      lockManager,
      allocateRevisionGroupId: () => "unused-group",
      eventPublisher: {
        publishAtomic: async () => ({ kind: "not_published" }),
      },
      humanEditAdmission: createHumanEditAdmission({
        getForIdentity: (target) => {
          expect(lockHeld).toBe(true);
          return registry.getForIdentity(target);
        },
      }),
    });
    const result = await coordinator.execute({
      operationId: p.operationId,
      lane: "apply_patch",
      plan: p,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      result: {
        kind: "conflict",
        code: "human_edit_conflict",
      },
    });
    expect(lockHeld).toBe(false);
    expect(authorityCalls).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  test("does not expose operation replay state before trusted prepare authority", async () => {
    const calls: string[] = [];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => {
          calls.push("authority");
          return null;
        },
        resolveInTransaction: async () => null,
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          throw new Error("must not inspect guessed operation IDs");
        },
      },
    });
    expect((await backend.prepare(plan())).kind).toBe("failed");
    expect(calls).toEqual(["authority"]);
  });

  test("prepares immutable candidate only after exact live byte validation", async () => {
    const calls: string[] = [];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => {
          calls.push("authority");
          return authority();
        },
        resolveInTransaction: async () => null,
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          return { operationId: "op-1" } as never;
        },
        findReplay: async () => {
          calls.push("replay");
          return { kind: "absent" };
        },
      },
      readContent: async () => {
        calls.push("read");
        return beforeBytes;
      },
      writeCandidate: async (input) => {
        calls.push("write-candidate");
        return candidateContent(input);
      },
    });
    expect(await backend.prepare(plan())).toMatchObject({
      kind: "prepared",
      prepared: { kind: "candidate", candidate: { storageUri: candidateUri } },
    });
    expect(calls).toEqual([
      "authority",
      "operation-lock",
      "replay",
      "read",
      "write-candidate",
      "write-candidate",
      "write-candidate",
    ]);
  });

  test("returns exact private current bytes with a stale prepare conflict", async () => {
    const humanBytes = new TextEncoder().encode("human save");
    const currentArtifact = artifact({
      revision: 4,
      size: humanBytes.byteLength,
      storageUri: "file:///human-save",
    });
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority({ artifact: currentArtifact }),
        resolveInTransaction: async () => null,
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async () => ({ kind: "absent" }),
      },
      readContent: async () => humanBytes,
      writeCandidate: async (input) => candidateContent(input),
    });

    expect(await backend.prepare(plan())).toMatchObject({
      kind: "conflict",
      code: "stale_version",
      evidence: [{
        currentVersion: {
          backendVersion: { kind: "artifact_revision", revision: 4 },
          sha256: sha(humanBytes),
        },
      }],
      currentSnapshots: [{
        bytes: humanBytes,
        currentVersion: {
          backendVersion: { kind: "artifact_revision", revision: 4 },
          sha256: sha(humanBytes),
        },
      }],
    });
  });

  test("returns durable replay group hint and never writes candidate bytes", async () => {
    const p = plan();
    const replay = committedReplay(p);
    let writes = 0;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority({ artifact: artifact({ revision: 4 }) }),
        resolveInTransaction: async () => authority({ artifact: artifact({ revision: 4 }) }),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: p.operationId }) as never,
        findReplay: async () => ({
          kind: "match",
          mutation: {} as never,
          replay,
        }),
      },
      writeCandidate: async () => {
        writes += 1;
        throw new Error("replay cannot write a candidate");
      },
    });
    const prepared = await backend.prepare(p);
    expect(prepared).toMatchObject({
      kind: "prepared",
      revisionGroupIdHint: "group-durable",
      prepared: { kind: "replay" },
    });
    expect(writes).toBe(0);
    if (prepared.kind !== "prepared") throw new Error("expected replay");
    const committed = await backend.commitPrepared({
      plan: p,
      prepared: prepared.prepared,
      revisionGroupId: "group-durable",
      buildCommittedEventBatch: () => {
        throw new Error("replay must use durable enlisted batch");
      },
    });
    expect(committed).toEqual({
      kind: "committed",
      receipt: replay.receipt,
      enlistedEventBatch: replay.enlistedEventBatch,
    });
  });

  test("fails a reused operation ID with a different request digest", async () => {
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => authority(),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async () => ({ kind: "digest_mismatch", mutation: {} as never }),
      },
    });
    expect(await backend.prepare(plan())).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "digest_mismatch" }],
    });
  });

  test("rejects a fabricated or nested-mutated candidate capability before commit", async () => {
    const calls: string[] = [];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => {
          calls.push("authority");
          return authority();
        },
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          return { operationId: "op-1" } as never;
        },
        findReplay: async () => ({ kind: "absent" }),
      },
      readContent: async (storageUri) => storedBytes(storageUri),
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const legitimate = await prepareCandidate(backend, p);
    calls.length = 0;
    expect(Object.isFrozen(legitimate)).toBe(true);
    expect(Object.isFrozen(legitimate.candidate)).toBe(true);
    expect(() => {
      (legitimate.candidate as { storageUri: string }).storageUri =
        "file:///arbitrary";
    }).toThrow();

    const forged = {
      ...legitimate,
      candidate: {
        ...legitimate.candidate,
        storageUri: "file:///arbitrary",
      },
    };
    expect(await backend.commitPrepared({
      plan: p,
      prepared: forged,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      diagnostics: [{
        message: "Workspace candidate was not prepared by this backend instance",
      }],
    });
    expect(calls).toEqual([]);
  });

  test("re-verifies exact canonical candidate bytes before pointer CAS", async () => {
    let casCalls = 0;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => authority(),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async () => undefined,
        casPointer: async () => {
          casCalls += 1;
          throw new Error("must not CAS unproven candidate bytes");
        },
      },
      readContent: async (storageUri) =>
        storageUri === candidateUri
          ? new TextEncoder().encode("xxxxx")
          : beforeBytes,
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    expect(await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      diagnostics: [{
        message:
          "Immutable Workspace candidate bytes no longer prove the planned postimage",
      }],
    });
    expect(casCalls).toBe(0);
  });

  test("binds trusted MIME metadata into idempotency before operation probing", async () => {
    let commitMimeType = "text/markdown";
    const calls: string[] = [];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority({ nextMimeType: "text/markdown" }),
        resolveInTransaction: async () =>
          authority({ nextMimeType: commitMimeType }),
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          return { operationId: "op-1" } as never;
        },
        findReplay: async () => ({ kind: "absent" }),
      },
      readContent: async (storageUri) => storedBytes(storageUri),
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    calls.length = 0;
    commitMimeType = "text/x-markdown";
    expect(await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      diagnostics: [{
        message:
          "Prepared Workspace candidate does not belong to this exact plan and metadata",
      }],
    });
    expect(calls).toEqual([]);
  });

  test("binds a bounded editor request fingerprint into same-operation replay identity", async () => {
    const calls: string[] = [];
    let fingerprint = "a".repeat(64);
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority({ editorRequestFingerprint: fingerprint }),
        resolveInTransaction: async () => authority({ editorRequestFingerprint: fingerprint }),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async (_tx, _lock, digest) => {
          calls.push(digest);
          return { kind: "absent" };
        },
      },
      readContent: async () => beforeBytes,
      writeCandidate: async (input) => candidateContent(input),
    });
    await prepareCandidate(backend, plan("op-retry"));
    fingerprint = "b".repeat(64);
    await prepareCandidate(backend, plan("op-retry"));
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });

  test("commits pointer, immutable preimage receipt, and event batch in one ordered transaction", async () => {
    const calls: string[] = [];
    let transactionCount = 0;
    let inserted: unknown;
    let casInput: unknown;
    let opaque = 0;
    const db = {
      transaction: async (callback: (tx: WorkspaceDocumentMutationTx) => unknown) => {
        transactionCount += 1;
        return callback({} as WorkspaceDocumentMutationTx);
      },
    } as unknown as DirectDatabase;
    const backend = new WorkspaceArtifactMutationBackend({
      db,
      authorityResolver: {
        resolve: async () => authority({
          nextMimeType: "text/x-markdown",
          editorRequestFingerprint: "a".repeat(64),
          clientMutationId: "client-1",
          requestId: "request-1",
        }),
        resolveInTransaction: async () => {
          calls.push(calls.includes("artifact-lock") ? "authority-recheck" : "authority");
          return authority({
            nextMimeType: "text/x-markdown",
            editorRequestFingerprint: "a".repeat(64),
            clientMutationId: "client-1",
            requestId: "request-1",
          });
        },
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          return { operationId: "op-1" } as never;
        },
        findReplay: async () => {
          calls.push("replay");
          return { kind: "absent" };
        },
        acquireArtifactLock: async () => {
          calls.push("artifact-lock");
        },
        casPointer: async (_tx, input) => {
          calls.push("cas");
          casInput = input;
          return {
            ...artifact({
              storageUri: input.nextStorageUri,
              revision: 4,
              size: afterBytes.byteLength,
              mimeType: "text/x-markdown",
            }),
            path: "note.md",
          } as never;
        },
        insertReceipt: async (_tx, _lock, input) => {
          calls.push("insert-receipt");
          inserted = input;
          return {} as never;
        },
      },
      readContent: async (storageUri) => {
        calls.push(storageUri === candidateUri ? "read-candidate" : "read");
        return storedBytes(storageUri);
      },
      writeCandidate: async (input) => candidateContent(input),
      newOpaqueId: () => `opaque-${++opaque}`,
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    calls.length = 0;
    transactionCount = 0;
    const committed = await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: (receipt) => {
        calls.push("build-events");
        return buildAtomicDocumentMutationEventBatch({
          backend: "workspace",
          plan: p,
          receipt,
          revisionGroupId: "group-1",
          outcome: "applied",
        });
      },
    });
    expect(transactionCount).toBe(1);
    expect(calls).toEqual([
      "authority",
      "operation-lock",
      "replay",
      "artifact-lock",
      "authority-recheck",
      "read",
      "read-candidate",
      "read",
      "read",
      "cas",
      "build-events",
      "insert-receipt",
    ]);
    expect(committed).toMatchObject({
      kind: "committed",
      receipt: {
        operationId: "op-1",
        revisionGroupId: "group-1",
        entries: [{
          revisionIds: ["opaque-1"],
          undoRecordIds: ["opaque-2"],
          before: { backendVersion: { revision: 3 }, sha256: sha(beforeBytes) },
          after: { backendVersion: { revision: 4 }, sha256: sha(afterBytes) },
          workspaceArtifactMetadata: {
            beforeMimeType: "text/markdown",
            afterMimeType: "text/x-markdown",
          },
        }],
      },
      enlistedEventBatch: { events: [{ sequence: 0, mutation: "update" }] },
    });
    expect(inserted).toMatchObject({
      operationId: "op-1",
      revisionGroupId: "group-1",
      clientMutationId: "client-1",
      requestId: "request-1",
      entries: [{
        beforeStorageUri: `file:///tmp/workspace-document-mutation-content/sha256/${sha(beforeBytes).slice(0, 2)}/${sha(beforeBytes)}`,
        afterStorageUri: candidateUri,
        beforeSize: beforeBytes.byteLength,
        afterSize: afterBytes.byteLength,
        beforeMimeType: "text/markdown",
        afterMimeType: "text/x-markdown",
      }],
      editorRequestFingerprint: "a".repeat(64),
      eventBatch: { events: [{ sequence: 0, mutation: "update" }] },
    });
    const receiptInput = inserted as { entries: Array<{ beforeStorageUri: string }> };
    // A later writer may mutate file:///before, but replay/history is
    // bound to this content-addressed preimage rather than that live pointer.
    expect(receiptInput.entries[0]!.beforeStorageUri).not.toBe("file:///before");
    expect(casInput).toMatchObject({
      nextStorageUri: prepared.liveCandidate.storageUri,
      nextSize: afterBytes.byteLength,
      nextMimeType: "text/x-markdown",
    });
  });

  test("rechecks commit authority before any operation persistence probe", async () => {
    const calls: string[] = [];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => {
          calls.push("authority");
          return null;
        },
      },
      helpers: {
        acquireOperationLock: async () => {
          calls.push("operation-lock");
          return { operationId: "op-1" } as never;
        },
        findReplay: async () => ({ kind: "absent" }),
      },
      readContent: async (storageUri) => storedBytes(storageUri),
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    calls.length = 0;
    expect(await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({ kind: "failed", code: "backend_failure" });
    expect(calls).toEqual(["authority"]);
  });

  test("returns stale conflict when the exact pointer CAS loses its race", async () => {
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => authority(),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async () => undefined,
        casPointer: async () => null,
      },
      readContent: async (storageUri) => storedBytes(storageUri),
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    expect(await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({
      kind: "conflict",
      code: "stale_version",
      diagnostics: [{ code: "cas_miss" }],
    });
  });

  test("treats an exception after a CAS attempt as recovery-required truth", async () => {
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => authority(),
        resolveInTransaction: async () => authority(),
      },
      helpers: {
        acquireOperationLock: async () => ({ operationId: "op-1" }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async () => undefined,
        casPointer: async () => {
          throw new Error("connection dropped after CAS send");
        },
      },
      readContent: async (storageUri) => storedBytes(storageUri),
      writeCandidate: async (input) => candidateContent(input),
    });
    const p = plan();
    const prepared = await prepareCandidate(backend, p);
    expect(await backend.commitPrepared({
      plan: p,
      prepared,
      revisionGroupId: "group-1",
      buildCommittedEventBatch: () => {
        throw new Error("must not build");
      },
    })).toMatchObject({
      kind: "failed",
      code: "inconsistent_outcome",
      requiresCompensation: true,
    });
  });

  test("commits one ordered multi-entry batch with no authoritative prefix seam", async () => {
    const updateBefore = new TextEncoder().encode("update-before");
    const updateAfter = new TextEncoder().encode("update-after");
    const deleteBefore = new TextEncoder().encode("delete-before");
    const createAfter = new TextEncoder().encode("create-after");
    const updateId = "22222222-2222-4222-8222-222222222222";
    const deleteId = "33333333-3333-4333-8333-333333333333";
    const createId = "44444444-4444-4444-8444-444444444444";
    const updateIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: updateId,
      logicalPath: "update.md",
    };
    const deleteIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: deleteId,
      logicalPath: "delete.md",
    };
    const createIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: createId,
      logicalPath: "create.md",
    };
    const p: BackendCommitPlan<"workspace"> = {
      operationId: "batch-op",
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [
        {
          kind: "update",
          before: {
            identity: updateIdentity,
            expectedVersion: {
              identity: updateIdentity,
              backendVersion: { kind: "artifact_revision", revision: 2 },
              sha256: sha(updateBefore),
            },
            bytes: updateBefore,
          },
          after: {
            identity: updateIdentity,
            bytes: updateAfter,
            sha256: sha(updateAfter),
          },
        },
        {
          kind: "delete",
          before: {
            identity: deleteIdentity,
            expectedVersion: {
              identity: deleteIdentity,
              backendVersion: { kind: "artifact_revision", revision: 4 },
              sha256: sha(deleteBefore),
            },
            bytes: deleteBefore,
          },
        },
        {
          kind: "create",
          after: {
            identity: createIdentity,
            bytes: createAfter,
            sha256: sha(createAfter),
          },
        },
      ],
    };
    const artifacts = [
      artifact({
        id: updateId,
        logicalPath: "update.md",
        storageUri: "file:///update-before",
        revision: 2,
        size: updateBefore.byteLength,
      }),
      artifact({
        id: deleteId,
        logicalPath: "delete.md",
        storageUri: "file:///delete-before",
        revision: 4,
        size: deleteBefore.byteLength,
      }),
    ];
    const batchAuthority = {
      actor: { kind: "agent" as const, agentId: "agent-1" },
      lane: "apply_patch" as const,
      artifacts,
      createNamespaceId: "namespace-1",
      nextMimeTypes: {
        [updateId]: "text/markdown",
        [createId]: "text/markdown",
      },
      ownerId: "owner-1",
      userId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
    };
    const bytesBySha = new Map([
      [sha(updateBefore), updateBefore],
      [sha(updateAfter), updateAfter],
      [sha(deleteBefore), deleteBefore],
      [sha(createAfter), createAfter],
    ]);
    const calls: string[] = [];
    let inserted: unknown;
    let opaque = 0;
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => batchAuthority,
        resolve: async () => batchAuthority,
        resolveInTransaction: async () => batchAuthority,
      },
      readContent: async (uri) => {
        if (uri === "file:///update-before") return updateBefore;
        if (uri === "file:///delete-before") return deleteBefore;
        const digest = [...bytesBySha.keys()].find((candidate) => uri.includes(candidate));
        if (!digest) throw new Error(`unknown content ${uri}`);
        return bytesBySha.get(digest)!;
      },
      writeCandidate: async (input) => candidateContent(input),
      newOpaqueId: () => `batch-opaque-${++opaque}`,
      helpers: {
        acquireOperationLock: async () => ({ operationId: p.operationId }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async (_tx, id) => { calls.push(`lock:${id}`); },
        casPointer: async (_tx, input) => {
          calls.push(`update:${input.artifactInternalId}`);
          const row = artifacts.find((candidate) => candidate.id === input.artifactInternalId)!;
          return {
            ...row,
            path: input.nextLogicalPath ?? row.logicalPath,
            storageUri: input.nextStorageUri,
            size: input.nextSize,
            revision: row.revision + 1,
          } as never;
        },
        casDelete: async (_tx, input) => {
          calls.push(`delete:${input.artifactInternalId}`);
          return { ...artifacts.find((candidate) => candidate.id === input.artifactInternalId)!, deletedAt: new Date() } as never;
        },
        createArtifact: async (_tx, input) => {
          calls.push(`create:${input.internalId}`);
          return {
            id: input.internalId,
            artifactId: input.artifactId,
            path: input.logicalPath,
            storageUri: input.storageUri,
            size: input.size,
            mimeType: input.mimeType,
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
        },
        insertReceipt: async (_tx, _lock, input) => {
          calls.push("receipt");
          inserted = input;
          return {} as never;
        },
      },
    });
    const prepared = await backend.prepare(p);
    expect(prepared).toMatchObject({
      kind: "prepared",
      prepared: { kind: "batch_candidate", entries: [{ entryIndex: 0 }, { entryIndex: 1 }, { entryIndex: 2 }] },
    });
    if (prepared.kind !== "prepared") throw new Error("expected prepared batch");
    const committed = await backend.commitPrepared({
      plan: p,
      prepared: prepared.prepared,
      revisionGroupId: "batch-group",
      buildCommittedEventBatch: (receipt) =>
        buildAtomicDocumentMutationEventBatch({
          backend: "workspace",
          plan: p,
          receipt,
          revisionGroupId: "batch-group",
          outcome: "applied",
        }),
    });
    expect(committed).toMatchObject({
      kind: "committed",
      receipt: {
        entries: [
          { kind: "update", entryIndex: 0 },
          { kind: "delete", entryIndex: 1 },
          { kind: "create", entryIndex: 2 },
        ],
      },
      enlistedEventBatch: {
        events: [
          { mutation: "update", sequence: 0 },
          { mutation: "delete", sequence: 1 },
          { mutation: "create", sequence: 2 },
        ],
      },
    });
    expect(calls.slice(-4)).toEqual([
      `update:${updateId}`,
      `delete:${deleteId}`,
      `create:${createId}`,
      "receipt",
    ]);
    expect(inserted).toMatchObject({
      turnId: "turn-1",
      lane: "apply_patch",
      entries: [
        { kind: "update", sequence: 0 },
        { kind: "delete", sequence: 1 },
        { kind: "create", sequence: 2 },
      ],
    });
  });

  test("keeps overwrite destination history before the public source-move revision", async () => {
    const sourceBefore = new TextEncoder().encode("source-before");
    const destinationBefore = new TextEncoder().encode("destination-before");
    const movedAfter = new TextEncoder().encode("source-after-move");
    const sourceId = "55555555-5555-4555-8555-555555555555";
    const destinationId = "66666666-6666-4666-8666-666666666666";
    const sourceIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: sourceId,
      logicalPath: "source.md",
    };
    const destinationIdentity = {
      kind: "workspace_artifact" as const,
      artifactId: destinationId,
      logicalPath: "destination.md",
    };
    const movedIdentity = {
      ...sourceIdentity,
      logicalPath: destinationIdentity.logicalPath,
    };
    const overwritePlan: BackendCommitPlan<"workspace"> = {
      operationId: "overwrite-move-op",
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [{
        kind: "move",
        source: {
          identity: sourceIdentity,
          expectedVersion: {
            identity: sourceIdentity,
            backendVersion: { kind: "artifact_revision", revision: 5 },
            sha256: sha(sourceBefore),
          },
          bytes: sourceBefore,
        },
        destinationBefore: {
          identity: destinationIdentity,
          expectedVersion: {
            identity: destinationIdentity,
            backendVersion: { kind: "artifact_revision", revision: 7 },
            sha256: sha(destinationBefore),
          },
          bytes: destinationBefore,
        },
        after: {
          identity: movedIdentity,
          bytes: movedAfter,
          sha256: sha(movedAfter),
        },
      }],
    };
    const sourceArtifact = artifact({
      id: sourceId,
      logicalPath: sourceIdentity.logicalPath,
      storageUri: "file:///source-before",
      revision: 5,
      size: sourceBefore.byteLength,
    });
    const destinationArtifact = artifact({
      id: destinationId,
      logicalPath: destinationIdentity.logicalPath,
      storageUri: "file:///destination-before",
      revision: 7,
      size: destinationBefore.byteLength,
    });
    const bytesBySha = new Map([
      [sha(sourceBefore), sourceBefore],
      [sha(destinationBefore), destinationBefore],
      [sha(movedAfter), movedAfter],
    ]);
    const calls: string[] = [];
    let inserted: unknown;
    const opaqueIds = [
      "destination-delete-revision",
      "source-move-revision",
      "destination-delete-undo",
      "source-move-undo",
    ];
    const backend = new WorkspaceArtifactMutationBackend({
      db: fakeDb(),
      authorityResolver: {
        resolve: async () => null,
        resolveInTransaction: async () => null,
      },
      batchAuthorityResolver: {
        resolveReplayInTransaction: async () => ({
          actor: { kind: "agent", agentId: "agent-1" },
          lane: "apply_patch",
          nextMimeTypes: { [sourceId]: "text/markdown" },
          ownerId: "owner-1",
          userId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        }),
        resolve: async () => ({
          actor: { kind: "agent", agentId: "agent-1" },
          lane: "apply_patch",
          artifacts: [sourceArtifact, destinationArtifact],
          nextMimeTypes: { [sourceId]: "text/markdown" },
          ownerId: "owner-1",
          userId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        }),
        resolveInTransaction: async () => ({
          actor: { kind: "agent", agentId: "agent-1" },
          lane: "apply_patch",
          artifacts: [sourceArtifact, destinationArtifact],
          nextMimeTypes: { [sourceId]: "text/markdown" },
          ownerId: "owner-1",
          userId: "owner-1",
          agentId: "agent-1",
          roomId: "room-1",
        }),
      },
      readContent: async (uri) => {
        if (uri === sourceArtifact.storageUri) return sourceBefore;
        if (uri === destinationArtifact.storageUri) return destinationBefore;
        const digest = [...bytesBySha.keys()].find((candidate) => uri.includes(candidate));
        if (!digest) throw new Error(`unknown content ${uri}`);
        return bytesBySha.get(digest)!;
      },
      writeCandidate: async (input) => candidateContent(input),
      newOpaqueId: () => {
        const id = opaqueIds.shift();
        if (!id) throw new Error("unexpected opaque ID allocation");
        return id;
      },
      helpers: {
        acquireOperationLock: async () =>
          ({ operationId: overwritePlan.operationId }) as never,
        findReplay: async () => ({ kind: "absent" }),
        acquireArtifactLock: async (_tx, id) => {
          calls.push(`lock:${id}`);
        },
        casDelete: async (_tx, input) => {
          calls.push(`delete:${input.artifactInternalId}`);
          return { ...destinationArtifact, deletedAt: new Date() } as never;
        },
        casPointer: async (_tx, input) => {
          calls.push(`move:${input.artifactInternalId}`);
          return {
            ...sourceArtifact,
            path: input.nextLogicalPath!,
            storageUri: input.nextStorageUri,
            size: input.nextSize,
            revision: sourceArtifact.revision + 1,
          } as never;
        },
        insertReceipt: async (_tx, _lock, input) => {
          calls.push("receipt");
          inserted = input;
          return {} as never;
        },
      },
    });
    const prepared = await backend.prepare(overwritePlan);
    if (prepared.kind !== "prepared" || prepared.prepared.kind !== "batch_candidate") {
      throw new Error("expected prepared overwrite move");
    }
    const committed = await backend.commitPrepared({
      plan: overwritePlan,
      prepared: prepared.prepared,
      revisionGroupId: "overwrite-move-group",
      buildCommittedEventBatch: (receipt) =>
        buildAtomicDocumentMutationEventBatch({
          backend: "workspace",
          plan: overwritePlan,
          receipt,
          revisionGroupId: "overwrite-move-group",
          outcome: "applied",
        }),
    });
    expect(committed).toMatchObject({
      kind: "committed",
      receipt: {
        entries: [{
          kind: "move",
          revisionIds: [
            "destination-delete-revision",
            "source-move-revision",
          ],
          undoRecordIds: [
            "destination-delete-undo",
            "source-move-undo",
          ],
          destinationBefore: { identity: destinationIdentity },
          after: { identity: movedIdentity },
        }],
      },
      enlistedEventBatch: {
        events: [{
          mutation: "move",
          overwrite: true,
          sequence: 0,
          path: {
            before: sourceIdentity,
            destinationBefore: destinationIdentity,
            after: movedIdentity,
          },
        }],
      },
    });
    expect(calls.slice(-3)).toEqual([
      `delete:${destinationId}`,
      `move:${sourceId}`,
      "receipt",
    ]);
    expect(inserted).toMatchObject({
      entries: [{
        kind: "move",
        revisionIds: [
          "destination-delete-revision",
          "source-move-revision",
        ],
        undoRecordIds: [
          "destination-delete-undo",
          "source-move-undo",
        ],
        destinationBeforeArtifactInternalId: destinationId,
      }],
    });
  });
});
