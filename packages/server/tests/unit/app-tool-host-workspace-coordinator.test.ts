import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import {
  createDocumentMutationCoordinator,
  createHumanEditAdmission,
  HumanEditLeaseRegistry,
  InMemoryDocumentLockManager,
} from "@nautilo/document-mutations";
import type { WorkspaceFileContentCommitExecution } from "@nautilo/agent";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createProductionDocumentOperations } from "../../src/apps/app-tool-host";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { createWorkspaceFileContentCommitExecution } from "../../src/document-mutations/workspace-file-content-coordinator-adapter";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";

const internalId = "11111111-1111-4111-8111-111111111111";
const publicId = "public-artifact-1";
const logicalPath = "Deck.presentation.html";
const bytes = (value: string) => Buffer.from(value, "utf8");
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function context(
  overrides: Partial<AppToolRunnerContext> = {},
): AppToolRunnerContext {
  const memoryAccessEnvelope = {
    ownerId: "owner-1",
    actorId: "human-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: ["namespace-1"],
    mutableNamespaces: ["namespace-1"],
    writableNamespaces: ["namespace-1"],
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
  return {
    ownerId: "owner-1",
    userId: "human-1",
    agentId: "agent-1",
    roomId: "room-1",
    turnId: "turn-1",
    memoryAccessEnvelope,
    ...overrides,
  };
}

function targetVersion(content: Uint8Array, revision: number) {
  return {
    identity: {
      kind: "workspace_artifact" as const,
      artifactId: internalId,
      logicalPath,
    },
    backendVersion: { kind: "artifact_revision" as const, revision },
    sha256: sha256(content),
  };
}

function coordinatedHarness(initial: string, leaseState: "clean" | "dirty") {
  let canonical = bytes(initial);
  let revision = 7;
  let commits = 0;
  const registry = new HumanEditLeaseRegistry({
    ttlMs: 60_000,
    newLeaseId: () => "lease-1",
  });
  registry.register({
    sessionId: "editor-1",
    humanId: "human-1",
    identity: targetVersion(canonical, revision).identity,
    baseVersion: targetVersion(canonical, revision),
    state: leaseState,
  });

  const coordinator = createDocumentMutationCoordinator({
    backend: {
      kind: "workspace" as const,
      prepare: async () => ({ kind: "prepared" as const, prepared: {} }),
      commitPrepared: async ({
        plan,
        revisionGroupId,
        buildCommittedEventBatch,
      }) => {
        commits += 1;
        const entry = plan.entries[0];
        if (!entry || entry.kind !== "update")
          throw new Error("expected one update");
        canonical = Buffer.from(entry.after.bytes);
        revision += 1;
        const receipt = {
          backend: "workspace" as const,
          operationId: plan.operationId,
          revisionGroupId,
          entries: [
            {
              kind: "update" as const,
              entryIndex: 0,
              revisionIds: [`revision-${revision}`] as [string],
              undoRecordIds: [`undo-${revision}`] as [string],
              before: entry.before.expectedVersion,
              after: targetVersion(canonical, revision),
            },
          ],
        };
        return {
          kind: "committed" as const,
          receipt,
          enlistedEventBatch: buildCommittedEventBatch(receipt),
        };
      },
      compensate: async () => ({
        kind: "failed" as const,
        code: "backend_failure" as const,
        diagnostics: [],
      }),
      disposePrepared: () => undefined,
    },
    hashBytes: sha256,
    lockManager: new InMemoryDocumentLockManager(),
    allocateRevisionGroupId: () => "group-1",
    eventPublisher: {
      publishAtomic: async () => ({ kind: "published" as const }),
    },
    humanEditAdmission: createHumanEditAdmission(registry),
  });
  const execution = createWorkspaceFileContentCommitExecution({
    humanEditLeases: registry,
    db: {} as DirectDatabase,
    executeCoordinator: coordinator.execute.bind(coordinator),
    lookupCommittedRevisionIds: async () => [[`revision-${revision}`]],
    lookupCommittedPostimages: async () => [{ revision, sha256: sha256(canonical), size: canonical.byteLength, storageUri: "test://canonical" }],
    readCommittedContent: async () => Buffer.from(canonical),
  });
  const operations = createProductionDocumentOperations({
    appId: "nautilo-presentation",
    appsRoot: "/apps",
    manifest: TEST_MINI_APP_MANIFEST,
    context: context(),
    resolveWorkspaceArtifactFn: (async () => ({
      ok: true,
      artifact: {
        id: internalId,
        artifactId: publicId,
        path: logicalPath,
        revision,
        mimeType: "text/html",
      },
      physicalPath: "/not-read-directly",
    })) as never,
    readWorkspaceFile: async () => Buffer.from(canonical),
    workspaceContentCommitExecution: execution,
  });
  return {
    operations,
    canonical: () => canonical.toString("utf8"),
    commits: () => commits,
  };
}

describe("app-tool Workspace coordinator admission", () => {
  test("refuses an acknowledged dirty lease without persisting the app candidate", async () => {
    const harness = coordinatedHarness("before", "dirty");
    const result = await harness.operations.write(
      { surface: "workspace", path: logicalPath },
      { content: "agent after" },
      { baseRevision: 7 },
    );

    expect(result).toEqual({ kind: "conflict", currentSha256: null });
    expect(harness.commits()).toBe(0);
    expect(harness.canonical()).toBe("before");
  });

  for (const initial of ["before", ""] as const) {
    test(`commits a clean lease through the coordinator from ${initial ? "text" : "an empty base"}`, async () => {
      const harness = coordinatedHarness(initial, "clean");
      const result = await harness.operations.write(
        { surface: "workspace", path: logicalPath },
        { content: "agent after" },
        { baseRevision: 7 },
      );

      expect(result).toEqual({
        kind: "saved",
        sha256: sha256(bytes("agent after")),
        revision: 8,
        size: bytes("agent after").byteLength,
      });
      expect(harness.commits()).toBe(1);
      expect(harness.canonical()).toBe("agent after");
    });
  }

  test("fails closed when the coordinator or trusted turn context is unavailable", async () => {
    const calls: unknown[] = [];
    const unavailable: WorkspaceFileContentCommitExecution = async (
      request,
    ) => {
      calls.push(request);
      throw new Error("must not run");
    };
    const makeOperations = (
      runnerContext: AppToolRunnerContext,
      execution?: WorkspaceFileContentCommitExecution,
    ) =>
      createProductionDocumentOperations({
        appId: "nautilo-presentation",
        appsRoot: "/apps",
        manifest: TEST_MINI_APP_MANIFEST,
        context: runnerContext,
        resolveWorkspaceArtifactFn: (async () => ({
          ok: true,
          artifact: {
            id: internalId,
            artifactId: publicId,
            path: logicalPath,
            revision: 7,
            mimeType: "text/html",
          },
          physicalPath: "/not-read-directly",
        })) as never,
        readWorkspaceFile: async () => bytes("before"),
        ...(execution ? { workspaceContentCommitExecution: execution } : {}),
      });

    expect(
      await makeOperations(context()).write(
        { surface: "workspace", path: logicalPath },
        { content: "after" },
      ),
    ).toEqual({
      kind: "error",
      message:
        "Workspace document mutation coordinator context is unavailable.",
    });

    const noTurn = makeOperations(context({ turnId: null }), unavailable);
    expect(
      await noTurn.write(
        { surface: "workspace", path: logicalPath },
        { content: "after" },
      ),
    ).toEqual({
      kind: "error",
      message:
        "Workspace document mutation coordinator context is unavailable.",
    });
    expect(calls).toHaveLength(0);
  });

  test("uses the immutable coordinator receipt instead of the requested postimage", async () => {
    const requested = bytes("agent candidate");
    const merged = bytes("agent candidate plus human");
    const requestIds: string[] = [];
    let reads = 0;
    const execution: WorkspaceFileContentCommitExecution = async (request) => {
      requestIds.push(request.mutationRequestId);
      expect(Buffer.from(request.source!.bytes).toString("utf8")).toBe(
        "before",
      );
      return {
        ok: true,
        revisionId: "revision-8",
        committed: { bytes: merged, sha256: sha256(merged), revision: 8, size: merged.byteLength },
      };
    };
    const operations = createProductionDocumentOperations({
      appId: "nautilo-presentation",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      resolveWorkspaceArtifactFn: (async () => ({
        ok: true,
        artifact: {
          id: internalId,
          artifactId: publicId,
          path: logicalPath,
          revision: 7,
          mimeType: "text/html",
        },
        physicalPath: "/not-read-directly",
      })) as never,
      readWorkspaceFile: async () => {
        reads += 1;
        return bytes("before");
      },
      workspaceContentCommitExecution: execution,
    });

    expect(
      await operations.write(
        { surface: "workspace", path: logicalPath },
        { content: requested.toString("utf8") },
        { baseRevision: 7 },
      ),
    ).toEqual({ kind: "saved", sha256: sha256(merged), revision: 8, size: merged.byteLength });
    expect(
      await operations.write(
        { surface: "workspace", path: logicalPath },
        { content: "different candidate" },
        { baseRevision: 7 },
      ),
    ).toEqual({
      kind: "error",
      message:
        "Read the Workspace document again before editing; the previous save included concurrent changes.",
    });
    expect(requestIds).toHaveLength(1);

    expect(
      await operations.read({ surface: "workspace", path: logicalPath }),
    ).toMatchObject({
      content: "before",
      baseRevision: 7,
    });
    expect(reads).toBe(2);
    expect(
      await operations.write(
        { surface: "workspace", path: logicalPath },
        { content: "different candidate" },
        { baseRevision: 7 },
      ),
    ).toEqual({ kind: "saved", sha256: sha256(merged), revision: 8, size: merged.byteLength });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^d448:[0-9a-f]{64}:[0-9a-f]{64}$/);
    expect(requestIds[1]).toMatch(/^d448:[0-9a-f]{64}:[0-9a-f]{64}$/);
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });
});
