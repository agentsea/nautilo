import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectDatabase } from "@nautilo/db";
import { HumanEditLeaseRegistry } from "@nautilo/document-mutations";
import type { WorkspaceFileContentCommitRequest } from "@nautilo/agent";
import {
  buildWorkspaceFileContentPlan,
  createWorkspaceFileContentCommitExecution,
} from "../../src/document-mutations/workspace-file-content-coordinator-adapter";

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function request(
  overrides: Partial<WorkspaceFileContentCommitRequest> = {},
): WorkspaceFileContentCommitRequest {
  return {
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
    mutationRequestId: "request-1",
    command: "str_replace",
    commandArgs: { oldString: "before", newString: "after" },
    source: {
      artifactInternalId: "11111111-1111-4111-8111-111111111111",
      artifactId: "public-artifact-1",
      logicalPath: "notes/a.txt",
      revision: 7,
      bytes: bytes("before"),
    },
    output: {
      artifactInternalId: "11111111-1111-4111-8111-111111111111",
      artifactId: "public-artifact-1",
      logicalPath: "notes/a.txt",
      bytes: bytes("after"),
    },
    ...overrides,
  };
}

function createRequest(): WorkspaceFileContentCommitRequest {
  const { source: _source, ...base } = request();
  return {
    ...base,
    command: "write",
    output: {
      artifactInternalId: "22222222-2222-4222-8222-222222222222",
      artifactId: "public-artifact-2",
      logicalPath: "notes/new.txt",
      bytes: bytes("new"),
    },
  };
}

function leases() {
  return new HumanEditLeaseRegistry({
    ttlMs: 60_000,
    newLeaseId: () => "lease-1",
  });
}

describe("Workspace file content coordinator adapter", () => {
  test("uses the canonical storage reader for literal hash and percent characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-postimage-"));
    try {
      const path = join(root, "retained #100%.html");
      await writeFile(path, "after");
      const execute = createWorkspaceFileContentCommitExecution({
        humanEditLeases: leases(), db: {} as DirectDatabase,
        executeCoordinator: async () => ({ kind: "completed", commitState: "committed", result: { kind: "applied" }, events: [] }) as never,
        lookupCommittedRevisionIds: async () => [["revision-1"]],
        lookupCommittedPostimages: async () => [{ revision: 8, sha256: sha256(bytes("after")), size: 5, storageUri: `file://${path}` }],
      });
      expect(await execute(request())).toMatchObject({ ok: true, committed: { bytes: bytes("after"), revision: 8 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("builds exact update and create plans without storage authority", () => {
    const update = buildWorkspaceFileContentPlan({
      operationId: "workspace-file:request-1",
      request: request(),
    });
    expect(update).toMatchObject({
      operationId: "workspace-file:request-1",
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [{
        kind: "update",
        before: {
          identity: {
            artifactId: "11111111-1111-4111-8111-111111111111",
            logicalPath: "notes/a.txt",
          },
          expectedVersion: {
            backendVersion: { kind: "artifact_revision", revision: 7 },
            sha256: sha256(bytes("before")),
          },
        },
        after: { sha256: sha256(bytes("after")) },
      }],
    });

    const createCommitRequest = createRequest();
    const create = buildWorkspaceFileContentPlan({
      operationId: "workspace-file:patch-create",
      request: createCommitRequest,
    });
    const retry = buildWorkspaceFileContentPlan({
      operationId: "workspace-file:patch-create",
      request: createCommitRequest,
    });
    const createdArtifactId =
      create?.entries[0]?.kind === "create"
        ? create.entries[0].after.identity.artifactId
        : "";
    expect(create?.entries[0]).toMatchObject({
      kind: "create",
      after: {
        identity: {
          logicalPath: "notes/new.txt",
        },
      },
    });
    expect(createdArtifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retry?.entries[0]?.kind === "create"
      ? retry.entries[0].after.identity.artifactId
      : "").toBe(createdArtifactId);
    expect(createdArtifactId).not.toBe(
      createCommitRequest.output.artifactInternalId,
    );
  });

  test("retries a lost create response with the same operation and output identity", async () => {
    const coordinatorInputs: unknown[] = [];
    let receiptLookups = 0;
    const execute = createWorkspaceFileContentCommitExecution({
      humanEditLeases: leases(),
      db: {} as DirectDatabase,
      executeCoordinator: async (input) => {
        coordinatorInputs.push(input);
        return {
          kind: "completed",
          commitState: "committed",
          result: { kind: "applied" },
          events: [],
        } as never;
      },
      lookupCommittedRevisionIds: async () => {
        receiptLookups += 1;
        return receiptLookups === 1 ? null : [["revision-create"]];
      },
      lookupCommittedPostimages: async () => [{
        revision: 1,
        sha256: sha256(bytes("new")),
        size: 3,
        storageUri: "test://new",
      }],
      readCommittedContent: async () => bytes("new"),
    });
    const createCommitRequest = createRequest();

    expect(await execute(createCommitRequest)).toMatchObject({
      ok: false,
      code: "unknown",
      retryable: true,
    });
    const retry = await execute(createCommitRequest);
    expect(retry).toMatchObject({
      ok: true,
      revisionId: "revision-create",
    });
    expect(coordinatorInputs).toHaveLength(2);
    const firstInput = coordinatorInputs[0] as {
      operationId: string;
      plan: { entries: readonly unknown[] };
    };
    const retryInput = coordinatorInputs[1] as {
      operationId: string;
      plan: { entries: readonly unknown[] };
    };
    expect(firstInput.operationId).toBe(retryInput.operationId);
    const firstEntry = firstInput.plan.entries[0] as {
      after: { identity: { artifactId: string } };
    };
    const retryEntry = retryInput.plan.entries[0] as {
      after: { identity: { artifactId: string } };
    };
    expect(retryEntry.after.identity.artifactId).toBe(
      firstEntry.after.identity.artifactId,
    );
    expect(retry).toMatchObject({
      artifactId: firstEntry.after.identity.artifactId,
      artifactInternalId: firstEntry.after.identity.artifactId,
    });
  });

  test("invokes the shared coordinator on file_tool with turn grouping and projects its receipt", async () => {
    let coordinatorInput: unknown;
    let pumps = 0;
    const execute = createWorkspaceFileContentCommitExecution({
      humanEditLeases: leases(),
      db: {} as DirectDatabase,
      executeCoordinator: async (input) => {
        coordinatorInput = input;
        return {
          kind: "completed",
          commitState: "committed",
          result: { kind: "applied" },
          events: [],
        } as never;
      },
      lookupCommittedRevisionIds: async () => [["revision-1"]],
      lookupCommittedPostimages: async () => [{
        revision: 8,
        sha256: sha256(bytes("after")),
        size: 5,
        storageUri: "test://after",
      }],
      readCommittedContent: async () => bytes("after"),
      onCommitted: () => {
        pumps += 1;
      },
    });
    expect(await execute(request())).toEqual({
      ok: true,
      revisionId: "revision-1",
      committed: {
        bytes: bytes("after"),
        sha256: sha256(bytes("after")),
        revision: 8,
        size: 5,
      },
    });
    expect(coordinatorInput).toMatchObject({
      operationId: "workspace-file:request-1",
      lane: "file_tool",
      plan: {
        turnId: "turn-1",
        entries: [{ kind: "update" }],
      },
    });
    expect(pumps).toBe(1);
  });

  test("maps human and stale conflicts to stable file-tool reapply results", async () => {
    for (const conflictCode of [
      "human_edit_conflict",
      "reapply_required",
    ] as const) {
      const execute = createWorkspaceFileContentCommitExecution({
        humanEditLeases: leases(),
        db: {} as DirectDatabase,
        executeCoordinator: async () => ({
          kind: "rejected",
          result: {
            kind: "conflict",
            operationId: "workspace-file:patch-1",
            backend: "workspace",
            code: conflictCode,
            paths: ["notes/a.txt"],
            evidence: [],
          },
        }) as never,
      });
      const result = await execute(request());
      expect(result).toMatchObject({
        ok: false,
        code: conflictCode,
      });
    }
  });

  test("returns the verified rebased postimage rather than the submitted candidate", async () => {
    const merged = bytes("human\nagent\n");
    const execute = createWorkspaceFileContentCommitExecution({
      humanEditLeases: leases(),
      db: {} as DirectDatabase,
      executeCoordinator: async () => ({
        kind: "completed",
        commitState: "committed",
        result: { kind: "rebased" },
        events: [],
      }) as never,
      lookupCommittedRevisionIds: async () => [["revision-rebased"]],
      lookupCommittedPostimages: async () => [{
        revision: 9,
        sha256: sha256(merged),
        size: merged.byteLength,
        storageUri: "test://rebased",
      }],
      readCommittedContent: async () => merged,
    });

    expect(await execute(request())).toEqual({
      ok: true,
      revisionId: "revision-rebased",
      rebased: true,
      committed: {
        bytes: merged,
        sha256: sha256(merged),
        revision: 9,
        size: merged.byteLength,
      },
    });
  });

  test("keeps a committed outcome unknown when retained postimage bytes fail receipt verification", async () => {
    const execute = createWorkspaceFileContentCommitExecution({
      humanEditLeases: leases(),
      db: {} as DirectDatabase,
      executeCoordinator: async () => ({
        kind: "completed",
        commitState: "committed",
        result: { kind: "applied" },
        events: [],
      }) as never,
      lookupCommittedRevisionIds: async () => [["revision-1"]],
      lookupCommittedPostimages: async () => [{
        revision: 8,
        sha256: sha256(bytes("after")),
        size: 5,
        storageUri: "test://after",
      }],
      readCommittedContent: async () => bytes("tampered"),
    });

    expect(await execute(request())).toMatchObject({
      ok: false,
      code: "unknown",
      retryable: true,
      mutationRequestId: "request-1",
    });
  });

  test("keeps a durable commit recoverable when postimage lookup throws or has wrong cardinality", async () => {
    for (const lookupCommittedPostimages of [
      async () => { throw new Error("db unavailable after commit"); },
      async () => [],
      async () => [
        { revision: 8, sha256: sha256(bytes("after")), size: 5, storageUri: "test://one" },
        { revision: 9, sha256: sha256(bytes("after")), size: 5, storageUri: "test://two" },
      ],
    ]) {
      const execute = createWorkspaceFileContentCommitExecution({
        humanEditLeases: leases(),
        db: {} as DirectDatabase,
        executeCoordinator: async () => ({
          kind: "completed",
          commitState: "committed",
          result: { kind: "applied" },
          events: [],
        }) as never,
        lookupCommittedRevisionIds: async () => [["revision-1"]],
        lookupCommittedPostimages,
        readCommittedContent: async () => bytes("after"),
      });
      expect(await execute(request())).toMatchObject({
        ok: false,
        code: "unknown",
        retryable: true,
        mutationRequestId: "request-1",
      });
    }
  });

  test("fails closed for missing authority and never invokes the coordinator", async () => {
    let calls = 0;
    const execute = createWorkspaceFileContentCommitExecution({
      humanEditLeases: leases(),
      db: {} as DirectDatabase,
      executeCoordinator: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });
    const mismatched = request({
      authority: {
        ...request().authority,
        ownerId: "other-owner",
      },
    });
    expect(await execute(mismatched)).toMatchObject({
      ok: false,
      code: "missing_context",
    });
    expect(calls).toBe(0);
  });
});
