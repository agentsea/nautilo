import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DocumentCommitPlan,
  DocumentIdentity,
  DocumentMutationActor,
  DocumentMutationCommittedEvent,
  DocumentMutationPath,
  DocumentVersion,
} from "@nautilo/types";
import type {
  BackendCommitPlan,
  BackendCommitReceipt,
  BackendCompensationOutcome,
  DocumentMutationBackend,
  DocumentMutationBackendKind,
} from "../../src/backend";
import {
  createDocumentMutationCoordinator,
  type AtomicDocumentMutationEventBatch,
  type EventPublicationOutcome,
} from "../../src/coordinator";
import { createHumanEditAdmission } from "../../src/human-edit-admission";
import { HumanEditLeaseRegistry } from "../../src/human-edit-leases";
import {
  buildAtomicDocumentMutationEventBatch,
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  validateAtomicDocumentMutationEventBatch,
} from "../../src/committed-events";
import type { DocumentMutationDiagnosticInput } from "../../src/diagnostics";
import {
  InMemoryDocumentLockManager,
  type DocumentLockManager,
} from "../../src/lock-manager";

const hashBytes = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function workspaceIdentity(index: number, path: string) {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    kind: "workspace_artifact" as const,
    artifactId: `00000000-0000-4000-8000-${suffix}`,
    logicalPath: path,
  };
}

function localIdentity(index: number, path: string) {
  return {
    kind: "local_file" as const,
    relayId: "relay-1",
    canonicalPath: `/tmp/d448/${index}-${path}`,
  };
}

function version(
  backend: DocumentMutationBackendKind,
  identity: DocumentIdentity,
  bytes: Uint8Array,
  revision = 1,
): DocumentVersion {
  const sha256 = hashBytes(bytes);
  return backend === "workspace" && identity.kind === "workspace_artifact"
    ? {
        identity,
        backendVersion: { kind: "artifact_revision", revision },
        sha256,
      }
    : {
        identity: identity as Extract<DocumentIdentity, { kind: "local_file" }>,
        backendVersion: { kind: "local_sha", sha256 },
        sha256,
      };
}

function makePlan(backend: DocumentMutationBackendKind, large = false): DocumentCommitPlan {
  const identity =
    backend === "workspace" ? workspaceIdentity : localIdentity;
  const createBytes = new Uint8Array(large ? 17 * 1024 * 1024 : 1);
  createBytes[createBytes.length - 1] = 1;
  const updateBefore = new Uint8Array([2]);
  const updateAfter = new Uint8Array([3]);
  const moveBefore = new Uint8Array([4]);
  const destinationBefore = new Uint8Array([5]);
  const moveAfter = new Uint8Array([6]);
  const deleteBefore = new Uint8Array([7]);
  const createIdentity = identity(1, "create.md");
  const updateIdentity = identity(2, "update.md");
  const moveSource = identity(3, "move-source.md");
  const moveAfterIdentity =
    backend === "workspace"
      ? { ...moveSource, logicalPath: "move-after.md" }
      : { ...moveSource, canonicalPath: "/tmp/d448/3-move-after.md" };
  const moveDestination =
    backend === "workspace"
      ? identity(4, "move-after.md")
      : {
          ...identity(4, "move-after.md"),
          canonicalPath: (
            moveAfterIdentity as Extract<DocumentIdentity, { kind: "local_file" }>
          ).canonicalPath,
        };
  const deleteIdentity = identity(5, "delete.md");
  return {
    operationId: "operation-1",
    actor: { kind: "agent", agentId: "agent-1" },
    turnId: "turn-1",
    entries: [
      {
        kind: "create",
        after: {
          identity: createIdentity,
          sha256: hashBytes(createBytes),
          bytes: createBytes,
        },
      },
      {
        kind: "update",
        before: {
          identity: updateIdentity,
          expectedVersion: version(backend, updateIdentity, updateBefore),
          bytes: updateBefore,
        },
        after: {
          identity: updateIdentity,
          sha256: hashBytes(updateAfter),
          bytes: updateAfter,
        },
      },
      {
        kind: "move",
        source: {
          identity: moveSource,
          expectedVersion: version(backend, moveSource, moveBefore),
          bytes: moveBefore,
        },
        destinationBefore: {
          identity: moveDestination,
          expectedVersion: version(backend, moveDestination, destinationBefore),
          bytes: destinationBefore,
        },
        after: {
          identity: moveAfterIdentity,
          sha256: hashBytes(moveAfter),
          bytes: moveAfter,
        },
      },
      {
        kind: "delete",
        before: {
          identity: deleteIdentity,
          expectedVersion: version(backend, deleteIdentity, deleteBefore),
          bytes: deleteBefore,
        },
      },
    ],
  };
}

function planPaths(plan: DocumentCommitPlan): readonly DocumentMutationPath[] {
  return plan.entries.map((entry) => {
    switch (entry.kind) {
      case "create":
        return { kind: "create", after: entry.after.identity };
      case "update":
        return {
          kind: "update",
          before: entry.before.identity,
          after: entry.after.identity,
        };
      case "move":
        return entry.destinationBefore === undefined
          ? {
              kind: "move",
              overwrite: false,
              before: entry.source.identity,
              after: entry.after.identity,
            }
          : {
              kind: "move",
              overwrite: true,
              before: entry.source.identity,
              destinationBefore: entry.destinationBefore.identity,
              after: entry.after.identity,
            };
      case "delete":
        return { kind: "delete", before: entry.before.identity };
    }
  });
}

function identitiesForTestPath(
  path: DocumentMutationPath,
): readonly DocumentIdentity[] {
  switch (path.kind) {
    case "create":
      return [path.after];
    case "update":
      return [path.before, path.after];
    case "move":
      return path.overwrite
        ? [path.before, path.destinationBefore, path.after]
        : [path.before, path.after];
    case "delete":
      return [path.before];
  }
}

function evidenceForPath(
  backend: DocumentMutationBackendKind,
  path: DocumentMutationPath,
) {
  const identity =
    path.kind === "create"
      ? path.after
      : path.kind === "delete"
        ? path.before
        : path.before;
  return {
    path,
    currentVersion: version(backend, identity, new Uint8Array([99]), 99),
  };
}

function workspaceEditorPlan(input: {
  baseText: string;
  currentText: string;
  afterText: string;
  anchoredPatch?: {
    readonly kind: "anchored_text";
    readonly oldString: string;
    readonly newString: string;
  };
  currentBytes?: Uint8Array;
}): BackendCommitPlan<"workspace"> {
  const identity = workspaceIdentity(20, "editor.md");
  const baseBytes = new TextEncoder().encode(input.baseText);
  const currentBytes =
    input.currentBytes === undefined
      ? new TextEncoder().encode(input.currentText)
      : Uint8Array.from(input.currentBytes);
  const afterBytes = new TextEncoder().encode(input.afterText);
  const currentVersion = version(
    "workspace",
    identity,
    currentBytes,
    2,
  ) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
  return {
    operationId: "editor-operation",
    actor: { kind: "human", humanId: "human-1" },
    editorSave: {
      kind: "editor_save",
      checkpoint: true,
      baseVersion:
        input.baseText === input.currentText && input.currentBytes === undefined
          ? currentVersion
          : version("workspace", identity, baseBytes, 1),
      ...(input.anchoredPatch === undefined
        ? {}
        : { anchoredPatch: input.anchoredPatch }),
    },
    entries: [{
      kind: "update",
      before: {
        identity,
        expectedVersion: currentVersion,
        bytes: currentBytes,
      },
      after: {
        identity,
        sha256: hashBytes(afterBytes),
        bytes: afterBytes,
      },
    }],
  };
}

function committedVersion(
  backend: DocumentMutationBackendKind,
  identity: DocumentIdentity,
  sha256: string,
  revision: number,
): DocumentVersion {
  return backend === "workspace" && identity.kind === "workspace_artifact"
    ? {
        identity,
        backendVersion: { kind: "artifact_revision", revision },
        sha256,
      }
    : {
        identity: identity as Extract<DocumentIdentity, { kind: "local_file" }>,
        backendVersion: { kind: "local_sha", sha256 },
        sha256,
      };
}

function makeReceipt<K extends DocumentMutationBackendKind>(
  backend: K,
  plan: BackendCommitPlan<K>,
  revisionGroupId: string,
): BackendCommitReceipt<K> {
  return {
    backend,
    operationId: plan.operationId,
    revisionGroupId,
    entries: plan.entries.map((entry, entryIndex) => {
      const base = {
        entryIndex,
        revisionIds: [`revision-${entryIndex}`] as [string],
        undoRecordIds: [`undo-${entryIndex}`] as [string],
      };
      switch (entry.kind) {
        case "create":
          return {
            ...base,
            kind: "create" as const,
            after: committedVersion(
              backend,
              entry.after.identity,
              entry.after.sha256,
              entryIndex + 10,
            ),
          };
        case "update":
          return {
            ...base,
            kind: "update" as const,
            before: entry.before.expectedVersion,
            after: committedVersion(
              backend,
              entry.after.identity,
              entry.after.sha256,
              entryIndex + 10,
            ),
          };
        case "move":
          return {
            ...base,
            kind: "move" as const,
            before: entry.source.expectedVersion,
            ...(entry.destinationBefore === undefined
              ? {}
              : { destinationBefore: entry.destinationBefore.expectedVersion }),
            after: committedVersion(
              backend,
              entry.after.identity,
              entry.after.sha256,
              entryIndex + 10,
            ),
          };
        case "delete":
          return {
            ...base,
            kind: "delete" as const,
            before: entry.before.expectedVersion,
          };
      }
    }) as BackendCommitReceipt<K>["entries"],
  };
}

function restoration(
  plan: DocumentCommitPlan,
  revisionGroupId: string,
): BackendCompensationOutcome {
  return {
    kind: "compensated",
    operationId: plan.operationId,
    revisionGroupId,
    disposition: "rolled_back",
    entries: plan.entries.map((entry, entryIndex) => {
      switch (entry.kind) {
        case "create":
          return {
            kind: "create" as const,
            entryIndex,
            identity: entry.after.identity,
            absent: true as const,
          };
        case "update":
          return {
            kind: "update" as const,
            entryIndex,
            restored: entry.before.expectedVersion,
          };
        case "move":
          return {
            kind: "move" as const,
            entryIndex,
            sourceRestored: entry.source.expectedVersion,
            destination:
              entry.destinationBefore === undefined
                ? ({
                    kind: "absent",
                    identity: entry.after.identity,
                  } as const)
                : ({
                    kind: "restored",
                    version: entry.destinationBefore.expectedVersion,
                  } as const),
          };
        case "delete":
          return {
            kind: "delete" as const,
            entryIndex,
            restored: entry.before.expectedVersion,
          };
      }
    }),
  };
}

interface HarnessState {
  prepare: number;
  commit: number;
  compensate: number;
  dispose: number;
  allocate: number;
  enlist: number;
  publish: number;
  timeline: string[];
  diagnostics: DocumentMutationDiagnosticInput[];
  events: readonly DocumentMutationCommittedEvent[];
  committedRevisionGroupId?: string;
  eventBatch?: AtomicDocumentMutationEventBatch;
  allocationInput?: {
    readonly backend: DocumentMutationBackendKind;
    readonly lane:
      | "editor_save"
      | "apply_patch"
      | "file_tool"
      | "officecli"
      | "artifact_lifecycle"
      | "desktop_files_ui";
    readonly operationId: string;
    readonly actor: DocumentMutationActor;
    readonly turnId?: string;
  };
  disposedPrepared?: unknown;
}

function makeHarness<K extends DocumentMutationBackendKind>(
  backendKind: K,
  plan: BackendCommitPlan<K>,
  options: {
    prepareConflict?: boolean;
    prepareConflictOnce?: {
      readonly bytes: Uint8Array;
      readonly currentVersion: DocumentVersion;
    };
    prepareConflicts?: readonly {
      readonly bytes: Uint8Array;
      readonly currentVersion: DocumentVersion;
    }[];
    invalidPrepareConflict?: boolean;
    commitConflictPaths?: readonly DocumentMutationPath[];
    commitConflictEvidence?: readonly unknown[];
    commitConflictCode?: "stale_version" | "human_edit_conflict" | "reapply_required";
    commitConflictOnce?: {
      readonly bytes: Uint8Array;
      readonly currentVersion: DocumentVersion;
    };
    commitFailure?: "none" | "compensate";
    compensationValid?: boolean;
    publication?: EventPublicationOutcome | "throw";
    mutateReceipt?: (
      receipt: BackendCommitReceipt<K>,
    ) => BackendCommitReceipt<K>;
    mutateEnlistedEventBatch?: (
      batch: AtomicDocumentMutationEventBatch,
    ) => AtomicDocumentMutationEventBatch;
    omitEnlistedEventBatch?: boolean;
    allocate?: "blank" | "throw";
    preparedRevisionGroupIdHint?: string;
    commitThrow?: boolean;
    compensationOutcome?: (
      outcome: BackendCompensationOutcome,
    ) => BackendCompensationOutcome;
    preparedValue?: { readonly token: "prepared" } | undefined;
    disposeThrow?: boolean;
    releaseThrow?: boolean;
    humanEditAdmission?: Parameters<typeof createDocumentMutationCoordinator>[0]["humanEditAdmission"];
    afterPrepare?: () => void;
    onCommitPlan?: (value: BackendCommitPlan<K>) => void;
    freshlyCommitted?: boolean;
    onFreshCommit?: Parameters<typeof createDocumentMutationCoordinator>[0]["onFreshCommit"];
  } = {},
) {
  const state: HarnessState = {
    prepare: 0,
    commit: 0,
    compensate: 0,
    dispose: 0,
    allocate: 0,
    enlist: 0,
    publish: 0,
    timeline: [],
    diagnostics: [],
    events: [],
  };
  type Prepared = { readonly token: "prepared" } | undefined;
  type Receipt = BackendCommitReceipt<K>;
  const lockManager: DocumentLockManager = options.releaseThrow
    ? {
        acquire: async () => ({
          keys: [],
          release: () => {
            throw new Error("release failed");
          },
        }),
      }
    : new InMemoryDocumentLockManager();
  const backend: DocumentMutationBackend<K, Prepared, Receipt> = {
    kind: backendKind,
    prepare: async (preparedPlan) => {
      state.prepare += 1;
      options.afterPrepare?.();
      const conflictOnce =
        options.prepareConflicts?.[state.prepare - 1] ??
        (state.prepare === 1 ? options.prepareConflictOnce : undefined);
      const conflictPath = conflictOnce === undefined
        ? undefined
        : planPaths(preparedPlan).find((path) =>
            identitiesForTestPath(path).some((identity) =>
              JSON.stringify(identity) ===
                JSON.stringify(conflictOnce.currentVersion.identity)
            )
          );
      return options.prepareConflict ||
        options.invalidPrepareConflict ||
        conflictOnce !== undefined
        ? {
            kind: "conflict",
            code: "stale_version",
            evidence: options.invalidPrepareConflict
              ? []
              : conflictOnce === undefined
                ? [evidenceForPath(backendKind, planPaths(plan)[0]!)]
                : [{
                    path: conflictPath ?? planPaths(preparedPlan)[0]!,
                    currentVersion: conflictOnce.currentVersion,
                  }],
            ...(conflictOnce === undefined
              ? {}
              : {
                  currentSnapshots: [{
                    identity: conflictOnce.currentVersion.identity,
                    currentVersion: conflictOnce.currentVersion,
                    bytes: conflictOnce.bytes,
                  }],
                }),
            diagnostics: [],
          } as never
        : {
            kind: "prepared",
            prepared:
              "preparedValue" in options
                ? options.preparedValue
                : { token: "prepared" },
            ...(options.preparedRevisionGroupIdHint === undefined
              ? {}
              : { revisionGroupIdHint: options.preparedRevisionGroupIdHint }),
          };
    },
    commitPrepared: async ({
      plan: committedPlan,
      revisionGroupId,
      buildCommittedEventBatch,
    }) => {
      state.commit += 1;
      options.onCommitPlan?.(committedPlan);
      state.committedRevisionGroupId = revisionGroupId;
      if (options.commitThrow) throw new Error("commit failed");
      if (
        options.commitConflictPaths !== undefined ||
        options.commitConflictEvidence !== undefined ||
        (options.commitConflictOnce !== undefined && state.commit === 1)
      ) {
        const conflictOnce =
          state.commit === 1 ? options.commitConflictOnce : undefined;
        return {
          kind: "conflict",
          code: options.commitConflictCode ??
            (conflictOnce === undefined
              ? "human_edit_conflict"
              : "stale_version"),
          evidence:
            options.commitConflictEvidence ??
            options.commitConflictPaths?.map((path) =>
              evidenceForPath(backendKind, path)
            ) ??
            [{
              path: planPaths(committedPlan)[0]!,
              currentVersion: conflictOnce!.currentVersion,
            }],
          ...(conflictOnce === undefined
            ? {}
            : {
                currentSnapshots: [{
                  identity: conflictOnce.currentVersion.identity,
                  currentVersion: conflictOnce.currentVersion,
                  bytes: conflictOnce.bytes,
                }],
              }),
          diagnostics: [],
        } as never;
      }
      if (options.commitFailure !== undefined) {
        return {
          kind: "failed",
          code: "backend_failure",
          requiresCompensation: options.commitFailure === "compensate",
          diagnostics: [],
        };
      }
      const receipt = makeReceipt(backendKind, committedPlan, revisionGroupId);
      const enlistedEventBatch = buildCommittedEventBatch(receipt);
      state.enlist += 1;
      state.timeline.push("enlist", "commit");
      return {
        kind: "committed",
        receipt: options.mutateReceipt?.(receipt) ?? receipt,
        ...(options.freshlyCommitted === undefined ? {} : { freshlyCommitted: options.freshlyCommitted }),
        enlistedEventBatch: options.omitEnlistedEventBatch
          ? (undefined as never)
          : (options.mutateEnlistedEventBatch?.(enlistedEventBatch) ??
            enlistedEventBatch),
      };
    },
    compensate: async ({ revisionGroupId }) => {
      state.compensate += 1;
      return options.compensationValid === false
        ? {
            kind: "failed",
            code: "inconsistent_outcome",
            diagnostics: [],
          }
        : (options.compensationOutcome?.(
            restoration(plan, revisionGroupId),
          ) ?? restoration(plan, revisionGroupId));
    },
    disposePrepared: (value) => {
      state.dispose += 1;
      state.disposedPrepared = value;
      if (options.disposeThrow) throw new Error("dispose failed");
    },
  };
  const coordinator = createDocumentMutationCoordinator({
    backend,
    ...(options.onFreshCommit ? { onFreshCommit: options.onFreshCommit } : {}),
    hashBytes,
    lockManager,
    allocateRevisionGroupId: (input) => {
      state.allocate += 1;
      state.allocationInput = input;
      if (options.allocate === "throw") throw new Error("allocation failed");
      if (options.allocate === "blank") return " ";
      return "group-1";
    },
    eventPublisher: {
      publishAtomic: async (batch) => {
        state.publish += 1;
        state.timeline.push("publish");
        state.eventBatch = batch;
        state.events = batch.events;
        if (options.publication === "throw") throw new Error("unknown");
        return options.publication ?? { kind: "published" };
      },
    },
    ...(options.humanEditAdmission === undefined
      ? {}
      : { humanEditAdmission: options.humanEditAdmission }),
    diagnostics: {
      emit: async (diagnostic) => {
        state.diagnostics.push(diagnostic);
      },
      flush: async () => undefined,
    },
  });
  return { coordinator, state };
}

for (const backendKind of ["workspace", "desktop"] as const) {
  describe(`D448 ${backendKind} coordinator conformance`, () => {
    test("fresh observer is post-commit, replay-silent and cannot change business success", async () => {
      for (const fresh of [true, false, undefined]) {
        const plan = makePlan(backendKind) as BackendCommitPlan<typeof backendKind>;
        let observed = 0;
        const { coordinator, state } = makeHarness(backendKind, plan, {
          ...(fresh === undefined ? {} : { freshlyCommitted: fresh }),
          onFreshCommit: events => {
            expect(state.timeline).toContain("commit");
            expect(events).toHaveLength(4);
            observed++;
            throw new Error("optional feed failed");
          },
        });
        const result = await coordinator.execute({ operationId: plan.operationId, plan, lane: "apply_patch" });
        expect(result.kind).toBe("completed");
        expect(observed).toBe(fresh === true ? 1 : 0);
      }
    });
    test("commits create/update/overwrite-move/delete and publishes exact order", async () => {
      const plan = makePlan(backendKind) as BackendCommitPlan<typeof backendKind>;
      const { coordinator, state } = makeHarness(backendKind, plan);
      const outcome = await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      });

      expect(outcome).toMatchObject({
        kind: "completed",
        commitState: "committed",
        result: { kind: "applied", revisionGroupId: "group-1" },
      });
      expect(state).toMatchObject({
        prepare: 1,
        commit: 1,
        compensate: 0,
        dispose: 1,
        allocate: 1,
        publish: 1,
      });
      expect(state.events.map((event) => [event.sequence, event.mutation])).toEqual([
        [0, "create"],
        [1, "update"],
        [2, "move"],
        [3, "delete"],
      ]);
      expect(state.events[2]).toMatchObject({
        overwrite: true,
        path: { overwrite: true },
      });
      expect(state.timeline).toEqual(["enlist", "commit", "publish"]);
    });

    test("derives rebased from the original editor base and exact anchored postimage", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(20, "editor.md")
          : localIdentity(20, "editor.md");
      const originalBytes = new TextEncoder().encode("original\n");
      const currentBytes = new TextEncoder().encode("current\n");
      const afterBytes = new TextEncoder().encode("current edited\n");
      const plan = {
        operationId: "editor-operation",
        actor: { kind: "human" as const, humanId: "human-1" },
        editorSave: {
          kind: "editor_save" as const,
          checkpoint: true,
          baseVersion: version(backendKind, identity, originalBytes, 1),
          anchoredPatch: {
            kind: "anchored_text" as const,
            oldString: "current",
            newString: "current edited",
          },
        },
        entries: [{
          kind: "update" as const,
          before: {
            identity,
            expectedVersion: version(backendKind, identity, currentBytes, 2),
            bytes: currentBytes,
          },
          after: {
            identity,
            sha256: hashBytes(afterBytes),
            bytes: afterBytes,
          },
        }],
      } as BackendCommitPlan<typeof backendKind>;
      const { coordinator, state } = makeHarness(backendKind, plan);
      const outcome = await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "editor_save",
      });

      expect(outcome).toMatchObject({
        kind: "completed",
        result: { kind: "rebased" },
      });
      expect(state.events).toHaveLength(plan.entries.length);
      expect(state.events.every((event) => event.outcome === "rebased")).toBe(true);
      expect(state.events[0]).toMatchObject({
        editorSave: {
          checkpoint: true,
          anchoredPatch: {
            kind: "anchored_text",
            oldString: "current",
            newString: "current edited",
          },
        },
      });
      const rebasedEvent = state.events[0]!;
      if (rebasedEvent.mutation !== "update") throw new Error("expected update event");
      expect(rebasedEvent.editorSave).not.toHaveProperty("baseVersion");
    });

    test("stale prepare rejects before allocation or any write", async () => {
      const plan = makePlan(backendKind) as BackendCommitPlan<typeof backendKind>;
      const { coordinator, state } = makeHarness(backendKind, plan, {
        prepareConflict: true,
      });
      const outcome = await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "file_tool",
      });

      expect(outcome).toMatchObject({
        kind: "rejected",
        result: {
          kind: "conflict",
          code: "reapply_required",
          evidence: [{
            path: planPaths(plan)[0],
            currentVersion: evidenceForPath(
              backendKind,
              planPaths(plan)[0]!,
            ).currentVersion,
          }],
        },
      });
      expect(state).toMatchObject({
        prepare: 1,
        commit: 0,
        compensate: 0,
        dispose: 0,
        allocate: 0,
        publish: 0,
      });
    });

    test("rebases a disjoint stale agent text plan onto the latest human save", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(21, "co-edit.md")
          : localIdentity(21, "co-edit.md");
      const baseBytes = new TextEncoder().encode("agent target\nhuman target\n");
      const agentBytes = new TextEncoder().encode("agent changed\nhuman target\n");
      const humanBytes = new TextEncoder().encode("agent target\nhuman changed\n");
      const mergedBytes = new TextEncoder().encode("agent changed\nhuman changed\n");
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `stale-text-rebase-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        turnId: "turn-1",
        entries: [{
          kind: "update",
          before: {
            identity,
            expectedVersion: version(backendKind, identity, baseBytes, 1) as never,
            bytes: baseBytes,
          },
          after: {
            identity,
            sha256: hashBytes(agentBytes),
            bytes: agentBytes,
          },
        }],
      };
      let committedPlan: BackendCommitPlan<typeof backendKind> | undefined;
      const { coordinator, state } = makeHarness(backendKind, plan, {
        prepareConflictOnce: {
          bytes: humanBytes,
          currentVersion: version(backendKind, identity, humanBytes, 2),
        },
        onCommitPlan: (value) => {
          committedPlan = value;
        },
      });

      const outcome = await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      });

      expect(outcome).toMatchObject({
        kind: "completed",
        result: { kind: "rebased" },
      });
      expect(state).toMatchObject({
        prepare: 2,
        commit: 1,
        compensate: 0,
        dispose: 1,
        allocate: 1,
        publish: 1,
      });
      expect(committedPlan?.entries[0]).toMatchObject({
        kind: "update",
        before: {
          bytes: humanBytes,
          expectedVersion: version(backendKind, identity, humanBytes, 2),
        },
        after: {
          bytes: mergedBytes,
          sha256: hashBytes(mergedBytes),
        },
      });
    });

    test("rejects an overlapping stale path before any multi-file history or commit", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(23, "overlap-co-edit.md")
          : localIdentity(23, "overlap-co-edit.md");
      const otherIdentity =
        backendKind === "workspace"
          ? workspaceIdentity(25, "other-co-edit.md")
          : localIdentity(25, "other-co-edit.md");
      const baseBytes = new TextEncoder().encode("shared line\n");
      const agentBytes = new TextEncoder().encode("agent line\n");
      const humanBytes = new TextEncoder().encode("human line\n");
      const otherBaseBytes = new TextEncoder().encode("other base\n");
      const otherAgentBytes = new TextEncoder().encode("other agent\n");
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `stale-text-overlap-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        entries: [
          {
            kind: "update",
            before: {
              identity,
              expectedVersion: version(backendKind, identity, baseBytes, 1) as never,
              bytes: baseBytes,
            },
            after: {
              identity,
              sha256: hashBytes(agentBytes),
              bytes: agentBytes,
            },
          },
          {
            kind: "update",
            before: {
              identity: otherIdentity,
              expectedVersion: version(
                backendKind,
                otherIdentity,
                otherBaseBytes,
                1,
              ) as never,
              bytes: otherBaseBytes,
            },
            after: {
              identity: otherIdentity,
              sha256: hashBytes(otherAgentBytes),
              bytes: otherAgentBytes,
            },
          },
        ],
      };
      const { coordinator, state } = makeHarness(backendKind, plan, {
        prepareConflictOnce: {
          bytes: humanBytes,
          currentVersion: version(backendKind, identity, humanBytes, 2),
        },
      });

      expect(await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      })).toMatchObject({
        kind: "rejected",
        result: {
          kind: "conflict",
          code: "reapply_required",
          evidence: [{
            currentVersion: version(backendKind, identity, humanBytes, 2),
          }],
        },
      });
      expect(state).toMatchObject({
        prepare: 1,
        commit: 0,
        dispose: 0,
        allocate: 0,
        publish: 0,
      });
    });

    test("rebases a disjoint no-write commit CAS loss and retries with fresh preparation", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(22, "commit-co-edit.md")
          : localIdentity(22, "commit-co-edit.md");
      const baseBytes = new TextEncoder().encode("agent target\nhuman target\n");
      const agentBytes = new TextEncoder().encode("agent changed\nhuman target\n");
      const humanBytes = new TextEncoder().encode("agent target\nhuman changed\n");
      const mergedBytes = new TextEncoder().encode("agent changed\nhuman changed\n");
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `commit-stale-text-rebase-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        entries: [{
          kind: "update",
          before: {
            identity,
            expectedVersion: version(backendKind, identity, baseBytes, 1) as never,
            bytes: baseBytes,
          },
          after: {
            identity,
            sha256: hashBytes(agentBytes),
            bytes: agentBytes,
          },
        }],
      };
      let committedPlan: BackendCommitPlan<typeof backendKind> | undefined;
      const { coordinator, state } = makeHarness(backendKind, plan, {
        commitConflictOnce: {
          bytes: humanBytes,
          currentVersion: version(backendKind, identity, humanBytes, 2),
        },
        onCommitPlan: (value) => {
          committedPlan = value;
        },
      });

      expect(await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      })).toMatchObject({
        kind: "completed",
        result: { kind: "rebased" },
      });
      expect(state).toMatchObject({
        prepare: 2,
        commit: 2,
        dispose: 2,
        compensate: 0,
        allocate: 1,
        publish: 1,
      });
      expect(committedPlan?.entries[0]).toMatchObject({
        kind: "update",
        before: {
          bytes: humanBytes,
          expectedVersion: version(backendKind, identity, humanBytes, 2),
        },
        after: {
          bytes: mergedBytes,
          sha256: hashBytes(mergedBytes),
        },
      });
    });

    test("composes a second disjoint human autosave after prepare rebase", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(24, "continuous-co-edit.md")
          : localIdentity(24, "continuous-co-edit.md");
      const baseBytes = new TextEncoder().encode(
        "agent target\nhuman target one\nhuman target two\n",
      );
      const agentBytes = new TextEncoder().encode(
        "agent changed\nhuman target one\nhuman target two\n",
      );
      const firstHumanBytes = new TextEncoder().encode(
        "agent target\nhuman changed one\nhuman target two\n",
      );
      const secondHumanBytes = new TextEncoder().encode(
        "agent target\nhuman changed one\nhuman changed two\n",
      );
      const mergedBytes = new TextEncoder().encode(
        "agent changed\nhuman changed one\nhuman changed two\n",
      );
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `continuous-stale-text-rebase-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        entries: [{
          kind: "update",
          before: {
            identity,
            expectedVersion: version(backendKind, identity, baseBytes, 1) as never,
            bytes: baseBytes,
          },
          after: {
            identity,
            sha256: hashBytes(agentBytes),
            bytes: agentBytes,
          },
        }],
      };
      let committedPlan: BackendCommitPlan<typeof backendKind> | undefined;
      const { coordinator, state } = makeHarness(backendKind, plan, {
        prepareConflictOnce: {
          bytes: firstHumanBytes,
          currentVersion: version(
            backendKind,
            identity,
            firstHumanBytes,
            2,
          ),
        },
        commitConflictOnce: {
          bytes: secondHumanBytes,
          currentVersion: version(
            backendKind,
            identity,
            secondHumanBytes,
            3,
          ),
        },
        onCommitPlan: (value) => {
          committedPlan = value;
        },
      });

      expect(await coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      })).toMatchObject({
        kind: "completed",
        result: { kind: "rebased" },
      });
      expect(state).toMatchObject({
        prepare: 3,
        commit: 2,
        dispose: 2,
        compensate: 0,
        allocate: 1,
        publish: 1,
      });
      expect(committedPlan?.entries[0]).toMatchObject({
        kind: "update",
        before: {
          bytes: secondHumanBytes,
          expectedVersion: version(
            backendKind,
            identity,
            secondHumanBytes,
            3,
          ),
        },
        after: {
          bytes: mergedBytes,
          sha256: hashBytes(mergedBytes),
        },
      });
    });

    test("rebases every independently stale text path before one multi-file commit", async () => {
      const first =
        backendKind === "workspace"
          ? workspaceIdentity(26, "first-stale.md")
          : localIdentity(26, "first-stale.md");
      const second =
        backendKind === "workspace"
          ? workspaceIdentity(27, "second-stale.md")
          : localIdentity(27, "second-stale.md");
      const baseBytes = new TextEncoder().encode("agent target\nhuman target\n");
      const agentBytes = new TextEncoder().encode("agent changed\nhuman target\n");
      const firstHuman = new TextEncoder().encode("agent target\nhuman first\n");
      const secondHuman = new TextEncoder().encode("agent target\nhuman second\n");
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `multi-stale-text-rebase-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        entries: [first, second].map((identity) => ({
          kind: "update" as const,
          before: {
            identity,
            expectedVersion: version(
              backendKind,
              identity,
              baseBytes,
              1,
            ) as never,
            bytes: baseBytes,
          },
          after: {
            identity,
            sha256: hashBytes(agentBytes),
            bytes: agentBytes,
          },
        })),
      };
      let committedPlan: BackendCommitPlan<typeof backendKind> | undefined;
      const harness = makeHarness(backendKind, plan, {
        prepareConflicts: [
          {
            bytes: firstHuman,
            currentVersion: version(backendKind, first, firstHuman, 2),
          },
          {
            bytes: secondHuman,
            currentVersion: version(backendKind, second, secondHuman, 2),
          },
        ],
        onCommitPlan: (value) => {
          committedPlan = value;
        },
      });

      expect(await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      })).toMatchObject({
        kind: "completed",
        result: { kind: "rebased" },
      });
      expect(harness.state).toMatchObject({
        prepare: 3,
        commit: 1,
        allocate: 1,
        publish: 1,
      });
      expect(committedPlan?.entries.map((entry) =>
        entry.kind === "update"
          ? new TextDecoder().decode(entry.after.bytes)
          : null
      )).toEqual([
        "agent changed\nhuman first\n",
        "agent changed\nhuman second\n",
      ]);
    });

    test("stops when a backend repeats identical stale evidence without progress", async () => {
      const identity =
        backendKind === "workspace"
          ? workspaceIdentity(28, "repeated-stale.md")
          : localIdentity(28, "repeated-stale.md");
      const baseBytes = new TextEncoder().encode("agent target\nhuman target\n");
      const agentBytes = new TextEncoder().encode("agent changed\nhuman target\n");
      const humanBytes = new TextEncoder().encode("agent target\nhuman changed\n");
      const currentVersion = version(backendKind, identity, humanBytes, 2);
      const plan: BackendCommitPlan<typeof backendKind> = {
        operationId: `repeated-stale-text-${backendKind}`,
        actor: { kind: "agent", agentId: "agent-1" },
        entries: [{
          kind: "update",
          before: {
            identity,
            expectedVersion: version(backendKind, identity, baseBytes, 1) as never,
            bytes: baseBytes,
          },
          after: {
            identity,
            sha256: hashBytes(agentBytes),
            bytes: agentBytes,
          },
        }],
      };
      const harness = makeHarness(backendKind, plan, {
        prepareConflicts: [
          { bytes: humanBytes, currentVersion },
          { bytes: humanBytes, currentVersion },
        ],
      });

      expect(await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      })).toMatchObject({
        kind: "rejected",
        result: {
          kind: "conflict",
          code: "reapply_required",
          evidence: [{ currentVersion }],
        },
      });
      expect(harness.state).toMatchObject({
        prepare: 2,
        commit: 0,
        allocate: 0,
        publish: 0,
      });
    });

    test("shares proven and unproven commit rollback semantics", async () => {
      const plan = makePlan(backendKind) as BackendCommitPlan<typeof backendKind>;
      const proven = makeHarness(backendKind, plan, {
        commitFailure: "compensate",
      });
      expect(
        await proven.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "backend_failure" },
      });
      expect(proven.state.compensate).toBe(1);

      const unproven = makeHarness(backendKind, plan, {
        commitFailure: "compensate",
        compensationValid: false,
      });
      expect(
        await unproven.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "recovery_required",
        commitState: "unknown",
      });
    });

    test("keeps a durably enlisted commit when live publication is pending", async () => {
      const plan = makePlan(backendKind) as BackendCommitPlan<typeof backendKind>;
      const harness = makeHarness(backendKind, plan, {
        publication: { kind: "not_published" },
      });
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "completed",
        commitState: "committed",
        result: { kind: "applied" },
      });
      expect(harness.state).toMatchObject({
        commit: 1,
        enlist: 1,
        publish: 1,
        compensate: 0,
        dispose: 1,
      });
      expect(
        harness.state.diagnostics.some(
          (diagnostic) =>
            diagnostic.phase === "event" &&
            diagnostic.outcome === "pending" &&
            diagnostic.severity === "warning",
        ),
      ).toBe(true);
    });
  });
}

describe("D448 coordinator lifecycle and recovery truth", () => {
  const plan = makePlan("workspace") as BackendCommitPlan<"workspace">;

  test("preview prepares and disposes without allocating, writing, or publishing", async () => {
    const { coordinator, state } = makeHarness("workspace", plan);
    const outcome = await coordinator.preview({
      operationId: plan.operationId,
      plan,
      lane: "apply_patch",
    });

    expect(outcome.kind).toBe("prepared");
    expect(state).toMatchObject({
      prepare: 1,
      dispose: 1,
      allocate: 0,
      commit: 0,
      compensate: 0,
      publish: 0,
    });
  });

  test("compensates a commit-started failure and requires recovery if proof fails", async () => {
    const successful = makeHarness("workspace", plan, {
      commitFailure: "compensate",
    });
    expect(
      await successful.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "rejected", result: { kind: "failed" } });
    expect(successful.state.compensate).toBe(1);

    const failed = makeHarness("workspace", plan, {
      commitFailure: "compensate",
      compensationValid: false,
    });
    expect(
      await failed.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "recovery_required",
      commitState: "unknown",
    });
  });

  test("never compensates a durable commit for live publication uncertainty", async () => {
    for (const publication of [
      { kind: "not_published" } as const,
      { kind: "unknown" } as const,
      "throw" as const,
    ]) {
      const pending = makeHarness("workspace", plan, { publication });
      const outcome = await pending.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        });
      expect(outcome).toMatchObject({
        kind: "completed",
        commitState: "committed",
      });
      if (outcome.kind !== "completed") {
        throw new Error("expected completed outcome");
      }
      expect(outcome.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
      expect(pending.state).toMatchObject({
        enlist: 1,
        publish: 1,
        compensate: 0,
      });
    }
  });

  test("requires recovery for duplicate committed receipt IDs without false compensation", async () => {
    const harness = makeHarness("workspace", plan, {
      mutateReceipt: (receipt) => {
        const first = receipt.entries[0]!;
        return {
          ...receipt,
          entries: [
            first,
            { ...receipt.entries[1]!, revisionIds: first.revisionIds },
            ...receipt.entries.slice(2),
          ],
        } as BackendCommitReceipt<"workspace">;
      },
    });
    expect(
      await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "recovery_required",
      commitState: "committed",
      code: "inconsistent_outcome",
    });
    expect(harness.state.compensate).toBe(0);
    expect(harness.state.publish).toBe(0);
  });

  test("requires recovery when a committed backend omits or alters its enlisted batch", async () => {
    const cases = [
      { omitEnlistedEventBatch: true },
      {
        mutateEnlistedEventBatch: (batch: AtomicDocumentMutationEventBatch) => ({
          ...batch,
          idempotencyKey: `${batch.idempotencyKey}:wrong`,
        }),
      },
      {
        mutateEnlistedEventBatch: (batch: AtomicDocumentMutationEventBatch) => ({
          ...batch,
          events: [...batch.events].reverse(),
        }),
      },
    ];

    for (const options of cases) {
      const harness = makeHarness("workspace", plan, options);
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "recovery_required",
        commitState: "committed",
        code: "inconsistent_outcome",
        events: [],
      });
      expect(harness.state).toMatchObject({
        compensate: 0,
        publish: 0,
      });
    }
  });

  test("builds and validates one exact ordered batch from the prospective receipt", () => {
    const receipt = makeReceipt("workspace", plan, "group-1");
    const input = {
      backend: "workspace" as const,
      plan,
      receipt,
      revisionGroupId: "group-1",
      outcome: "applied" as const,
    };
    const first = buildAtomicDocumentMutationEventBatch(input);
    const retry = buildAtomicDocumentMutationEventBatch(input);

    expect(retry).toEqual(first);
    expect(first.events.map((event) => [event.sequence, event.mutation])).toEqual([
      [0, "create"],
      [1, "update"],
      [2, "move"],
      [3, "delete"],
    ]);
    expect(
      validateAtomicDocumentMutationEventBatch({ ...input, batch: first }),
    ).toBe(true);
    expect(
      validateAtomicDocumentMutationEventBatch({
        ...input,
        batch: { ...first, events: [...first.events].reverse() },
      }),
    ).toBe(false);
    expect(() =>
      buildAtomicDocumentMutationEventBatch({
        ...input,
        receipt: { ...receipt, operationId: "wrong-operation" },
      })
    ).toThrow("does not exactly match");
    expect(() =>
      buildAtomicDocumentMutationEventBatch({
        ...input,
        receipt: {
          ...receipt,
          entries: [
            receipt.entries[1]!,
            receipt.entries[0]!,
            ...receipt.entries.slice(2),
          ],
        },
      })
    ).toThrow("does not exactly match");

    for (const field of ["revisionIds", "undoRecordIds"] as const) {
      for (const malformed of [
        "not-an-array",
        { 0: "id", length: 1 },
        [1, "id"],
      ]) {
        expect(() =>
          buildAtomicDocumentMutationEventBatch({
            ...input,
            receipt: {
              ...receipt,
              entries: [
                {
                  ...receipt.entries[0]!,
                  [field]: malformed,
                },
                ...receipt.entries.slice(1),
              ],
            } as unknown as BackendCommitReceipt<"workspace">,
          })
        ).toThrow("does not exactly match");
      }
    }
    expect(() =>
      buildAtomicDocumentMutationEventBatch({
        ...input,
        receipt: {
          ...receipt,
          entries: { 0: receipt.entries[0]!, length: 1 },
        } as unknown as BackendCommitReceipt<"workspace">,
      })
    ).toThrow("does not exactly match");
  });

  test("copies only proven editor-save correlation into the committed update", () => {
    const exactPatch = {
      kind: "anchored_text" as const,
      oldString: "current",
      newString: "current edited",
    };
    const seededEditorPlan = workspaceEditorPlan({
      baseText: "current\n",
      currentText: "current\n",
      afterText: "current edited\n",
      anchoredPatch: exactPatch,
    });
    if (seededEditorPlan.editorSave === undefined) {
      throw new Error("expected editor-save plan");
    }
    const editorPlan = {
      ...seededEditorPlan,
      editorSave: {
        ...seededEditorPlan.editorSave,
        requestId: "request-1",
        clientMutationId: "client-mutation-1",
      },
    } as BackendCommitPlan<"workspace">;
    const input = {
      backend: "workspace" as const,
      plan: editorPlan,
      receipt: makeReceipt("workspace", editorPlan, "group-1"),
      revisionGroupId: "group-1",
      outcome: "applied" as const,
    };
    const event = buildAtomicDocumentMutationEventBatch(input).events[0]!;
    expect(event).toMatchObject({
      mutation: "update",
      editorSave: {
        checkpoint: true,
        requestId: "request-1",
        clientMutationId: "client-mutation-1",
        anchoredPatch: exactPatch,
      },
    });
    if (event.mutation !== "update") throw new Error("expected update event");
    expect(event.editorSave).not.toHaveProperty("baseVersion");

    const snapshotPlan = workspaceEditorPlan({
      baseText: "current\n",
      currentText: "current\n",
      afterText: "snapshot replacement\n",
    });
    const snapshotEvent = buildAtomicDocumentMutationEventBatch({
      backend: "workspace",
      plan: snapshotPlan,
      receipt: makeReceipt("workspace", snapshotPlan, "group-1"),
      revisionGroupId: "group-1",
      outcome: "applied",
    }).events[0]!;
    if (snapshotEvent.mutation !== "update") throw new Error("expected update event");
    expect(snapshotEvent.editorSave).toEqual({ checkpoint: true });
  });

  test("builds an anchored editor event in Node without a Bun global", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "d448-node-event-"));
    const entrypoint = join(tempDirectory, "node-editor-event.ts");
    try {
      await writeFile(
        entrypoint,
        `
          import { buildAtomicDocumentMutationEventBatch } from ${JSON.stringify(
            new URL("../../src/committed-events.ts", import.meta.url).pathname,
          )};

          if (globalThis.Bun !== undefined) {
            throw new Error("Node regression unexpectedly has a Bun global");
          }
          const identity = {
            kind: "workspace_artifact",
            artifactId: "00000000-0000-4000-8000-000000000020",
            logicalPath: "editor.md",
          };
          const beforeBytes = new TextEncoder().encode("current\\n");
          const afterBytes = new TextEncoder().encode("current edited\\n");
          const before = {
            identity,
            backendVersion: { kind: "artifact_revision", revision: 2 },
            sha256: "48aa6cae8c70abdb28631d22b316e6d9f9d0768ec2911de7090e248b2afe6ca1",
          };
          const after = {
            identity,
            backendVersion: { kind: "artifact_revision", revision: 3 },
            sha256: "07397b345f9a2a5681d3f03a0a6baa71a34d0bc0d1806fdf55f692d26518f84a",
          };
          const plan = {
            operationId: "node-editor-operation",
            actor: { kind: "human", humanId: "human-1" },
            editorSave: {
              kind: "editor_save",
              checkpoint: true,
              baseVersion: before,
              requestId: "node-request",
              anchoredPatch: {
                kind: "anchored_text",
                oldString: "current",
                newString: "current edited",
              },
            },
            entries: [{
              kind: "update",
              before: { identity, expectedVersion: before, bytes: beforeBytes },
              after: { identity, sha256: after.sha256, bytes: afterBytes },
            }],
          };
          const receipt = {
            backend: "workspace",
            operationId: plan.operationId,
            revisionGroupId: "node-group",
            entries: [{
              kind: "update",
              entryIndex: 0,
              revisionIds: ["revision-1"],
              undoRecordIds: ["undo-1"],
              before,
              after,
            }],
          };
          const event = buildAtomicDocumentMutationEventBatch({
            backend: "workspace",
            plan,
            receipt,
            revisionGroupId: "node-group",
            outcome: "applied",
          }).events[0];
          if (
            event?.mutation !== "update" ||
            event.editorSave?.requestId !== "node-request" ||
            event.editorSave.anchoredPatch?.newString !== "current edited"
          ) {
            throw new Error("portable editor event proof failed");
          }
        `,
        "utf8",
      );
      const bundled = await Bun.build({
        entrypoints: [entrypoint],
        target: "node",
        format: "esm",
      });
      expect(bundled.success).toBe(true);
      const output = await bundled.outputs[0]!.text();
      const bundledEntrypoint = join(tempDirectory, "node-editor-event.mjs");
      await writeFile(bundledEntrypoint, output, "utf8");
      const node = Bun.spawnSync({
        cmd: ["node", bundledEntrypoint],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(node.exitCode).toBe(0);
      expect(node.stderr.toString()).toBe("");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("rejects stale or hash-mismatched editor patches despite a valid receipt", () => {
    const stalePatchPlan = workspaceEditorPlan({
      baseText: "stale\n",
      currentText: "current\n",
      afterText: "current edited\n",
      anchoredPatch: {
        kind: "anchored_text",
        oldString: "stale",
        newString: "current edited",
      },
    });
    const staleInput = {
      backend: "workspace" as const,
      plan: stalePatchPlan,
      receipt: makeReceipt("workspace", stalePatchPlan, "group-1"),
      revisionGroupId: "group-1",
      outcome: "rebased" as const,
    };
    expect(() => buildAtomicDocumentMutationEventBatch(staleInput)).toThrow(
      "does not apply to the actual before bytes",
    );

    const exactPatchPlan = workspaceEditorPlan({
      baseText: "current\n",
      currentText: "current\n",
      afterText: "current edited\n",
      anchoredPatch: {
        kind: "anchored_text",
        oldString: "current",
        newString: "current edited",
      },
    });
    const exactEntry = exactPatchPlan.entries[0]!;
    if (exactEntry.kind !== "update") throw new Error("expected update entry");
    const hashMismatchedPlan = {
      ...exactPatchPlan,
      entries: [{
        ...exactEntry,
        after: {
          ...exactEntry.after,
          sha256: "f".repeat(64),
        },
      }],
    } as BackendCommitPlan<"workspace">;
    expect(() =>
      buildAtomicDocumentMutationEventBatch({
        backend: "workspace",
        plan: hashMismatchedPlan,
        receipt: makeReceipt("workspace", hashMismatchedPlan, "group-1"),
        revisionGroupId: "group-1",
        outcome: "applied",
      }),
    ).toThrow("declared SHA-256 contract");
  });

  test("uses collision-free idempotency keys for opaque delimiter and Unicode IDs", () => {
    const delimitedLeft = deriveAtomicDocumentMutationBatchIdempotencyKey(
      "a:b",
      "c",
    );
    const delimitedRight = deriveAtomicDocumentMutationBatchIdempotencyKey(
      "a",
      "b:c",
    );
    const unicode = deriveAtomicDocumentMutationBatchIdempotencyKey(
      "操作:🧞",
      "révision:\n一",
    );

    expect(delimitedLeft).not.toBe(delimitedRight);
    expect(unicode).toBe(
      deriveAtomicDocumentMutationBatchIdempotencyKey(
        "操作:🧞",
        "révision:\n一",
      ),
    );
    expect(unicode.startsWith("document-mutation:v1:[")).toBe(true);
  });

  test("public event builder rejects runtime-invalid plans before an empty batch", () => {
    expect(() =>
      buildAtomicDocumentMutationEventBatch({
        backend: "workspace",
        plan: {
          operationId: "operation-1",
          actor: { kind: "agent", agentId: "agent-1" },
          entries: [],
        } as unknown as DocumentCommitPlan,
        receipt: {
          backend: "workspace",
          operationId: "operation-1",
          revisionGroupId: "group-1",
          entries: [],
        },
        revisionGroupId: "group-1",
        outcome: "applied",
      })
    ).toThrow("shared plan contract");
  });

  test("has no byte ceiling and rejects trusted/plan operation mismatch", async () => {
    const largePlan = makePlan("workspace", true) as BackendCommitPlan<"workspace">;
    const large = makeHarness("workspace", largePlan);
    expect(
      await large.coordinator.execute({
        operationId: largePlan.operationId,
        plan: largePlan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "completed" });

    const mismatch = makeHarness("workspace", plan);
    expect(
      await mismatch.coordinator.execute({
        operationId: "trusted-operation",
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "rejected",
      result: { kind: "failed", operationId: "trusted-operation", code: "invalid_plan" },
    });
    expect(mismatch.state.prepare).toBe(0);
  });

  test("derives applied for exact editor patches and matching-base snapshots", async () => {
    for (const editorPlan of [
      workspaceEditorPlan({
        baseText: "current\n",
        currentText: "current\n",
        afterText: "current edited\n",
        anchoredPatch: {
          kind: "anchored_text",
          oldString: "current",
          newString: "current edited",
        },
      }),
      workspaceEditorPlan({
        baseText: "current\n",
        currentText: "current\n",
        afterText: "snapshot replacement\n",
      }),
    ]) {
      const harness = makeHarness("workspace", editorPlan);
      const outcome = await harness.coordinator.execute({
        operationId: editorPlan.operationId,
        plan: editorPlan,
        lane: "editor_save",
      });
      expect(outcome).toMatchObject({
        kind: "completed",
        result: { kind: "applied" },
      });
      expect(harness.state.events.every((event) => event.outcome === "applied")).toBe(true);
    }
  });

  test("rejects unproved editor rebases, byte mismatches, non-UTF8 patches, and lane misuse before prepare", async () => {
    const exactPatch = {
      kind: "anchored_text" as const,
      oldString: "current",
      newString: "current edited",
    };
    const invalidPlans: Array<{
      readonly plan: unknown;
      readonly lane: "editor_save" | "apply_patch";
    }> = [
      {
        plan: workspaceEditorPlan({
          baseText: "stale\n",
          currentText: "current\n",
          afterText: "snapshot replacement\n",
        }),
        lane: "editor_save",
      },
      {
        plan: workspaceEditorPlan({
          baseText: "current\n",
          currentText: "current\n",
          afterText: "does not match patch\n",
          anchoredPatch: exactPatch,
        }),
        lane: "editor_save",
      },
      {
        plan: workspaceEditorPlan({
          baseText: "",
          currentText: "",
          currentBytes: new Uint8Array([0xff]),
          afterText: "anything",
          anchoredPatch: {
            kind: "anchored_text",
            oldString: "",
            newString: "anything",
          },
        }),
        lane: "editor_save",
      },
      {
        plan: workspaceEditorPlan({
          baseText: "current\n",
          currentText: "current\n",
          afterText: "current edited\n",
          anchoredPatch: exactPatch,
        }),
        lane: "apply_patch",
      },
      {
        plan: makePlan("workspace"),
        lane: "editor_save",
      },
      {
        plan: {
          ...makePlan("workspace"),
          intendedOutcome: "rebased",
        },
        lane: "apply_patch",
      },
    ];

    for (const fixture of invalidPlans) {
      const harness = makeHarness(
        "workspace",
        makePlan("workspace") as BackendCommitPlan<"workspace">,
      );
      expect(
        await harness.coordinator.execute({
          operationId: "operationId" in (fixture.plan as object)
            ? String((fixture.plan as { operationId: unknown }).operationId)
            : "invalid-editor-operation",
          plan: fixture.plan,
          lane: fixture.lane,
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "invalid_plan" },
      });
      expect(harness.state).toMatchObject({
        prepare: 0,
        commit: 0,
        publish: 0,
      });
    }
  });

  test("passes exact allocation context and rejects blank or thrown allocation", async () => {
    const valid = makeHarness("workspace", plan);
    await valid.coordinator.execute({
      operationId: plan.operationId,
      plan,
      lane: "officecli",
    });
    expect(valid.state.allocationInput).toEqual({
      backend: "workspace",
      lane: "officecli",
      operationId: plan.operationId,
      actor: plan.actor,
      ...(plan.turnId === undefined ? {} : { turnId: plan.turnId }),
    });
    expect(valid.state.allocate).toBe(1);

    for (const allocate of ["blank", "throw"] as const) {
      const harness = makeHarness("workspace", plan, { allocate });
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "backend_failure" },
      });
      expect(harness.state).toMatchObject({
        allocate: 1,
        commit: 0,
        publish: 0,
        dispose: 1,
      });
    }
  });

  test("reuses a trusted durable replay group and rejects invalid replay hints", async () => {
    const replayed = makeHarness("workspace", plan, {
      preparedRevisionGroupIdHint: "persisted-group-1",
    });
    expect(
      await replayed.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "completed",
      result: { revisionGroupId: "persisted-group-1" },
    });
    expect(replayed.state).toMatchObject({
      allocate: 0,
      commit: 1,
      committedRevisionGroupId: "persisted-group-1",
    });

    for (const preparedRevisionGroupIdHint of ["", " \t ", 42 as never]) {
      const invalid = makeHarness("workspace", plan, {
        preparedRevisionGroupIdHint,
      });
      expect(
        await invalid.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "backend_failure" },
      });
      expect(invalid.state).toMatchObject({
        allocate: 0,
        commit: 0,
        publish: 0,
        dispose: 1,
      });
    }
  });

  test("compensates a thrown commit and preserves authoritative recovery truth", async () => {
    const restored = makeHarness("workspace", plan, { commitThrow: true });
    expect(
      await restored.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "rejected",
      result: { kind: "failed", code: "backend_failure" },
    });
    expect(restored.state.compensate).toBe(1);

    const unproven = makeHarness("workspace", plan, {
      commitThrow: true,
      compensationValid: false,
    });
    expect(
      await unproven.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "recovery_required",
      commitState: "unknown",
      revisionGroupId: "group-1",
    });
  });

  test("publishes one atomic batch with a stable operation/group idempotency key", async () => {
    const harness = makeHarness("workspace", plan);
    await harness.coordinator.execute({
      operationId: plan.operationId,
      plan,
      lane: "apply_patch",
    });
    expect(harness.state.eventBatch).toEqual({
      operationId: plan.operationId,
      revisionGroupId: "group-1",
      idempotencyKey: `document-mutation:v1:${JSON.stringify([
        plan.operationId,
        "group-1",
      ])}`,
      events: harness.state.events,
    });
  });

  test("returns committed success when live publication is definitively pending", async () => {
    const harness = makeHarness("workspace", plan, {
      publication: { kind: "not_published" },
      compensationValid: false,
    });
    expect(
      await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "completed",
      commitState: "committed",
      result: { revisionGroupId: "group-1" },
    });
    expect(harness.state.compensate).toBe(0);
  });

  test("does not trust empty or unrelated backend conflict paths", async () => {
    const invalidPrepare = makeHarness("workspace", plan, {
      invalidPrepareConflict: true,
    });
    expect(
      await invalidPrepare.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "rejected",
      result: { kind: "failed", code: "backend_failure" },
    });
    expect(invalidPrepare.state).toMatchObject({
      allocate: 0,
      commit: 0,
      publish: 0,
    });

    for (const commitConflictPaths of [
      [],
      [
        {
          kind: "delete" as const,
          before: workspaceIdentity(999, "unrelated.md"),
        },
      ],
    ]) {
      const harness = makeHarness("workspace", plan, { commitConflictPaths });
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "backend_failure" },
      });
      expect(harness.state).toMatchObject({ compensate: 0, publish: 0 });
    }
  });

  test("rejects forged or malformed correlated conflict version evidence", async () => {
    const path = planPaths(plan)[1]!;
    const valid = evidenceForPath("workspace", path);
    const cases: readonly (readonly unknown[])[] = [
      [],
      [{ ...valid, currentVersion: { ...valid.currentVersion, sha256: "bad" } }],
      [{
        ...valid,
        currentVersion: {
          identity: localIdentity(99, "forged.md"),
          backendVersion: { kind: "local_sha", sha256: "0".repeat(64) },
          sha256: "0".repeat(64),
        },
      }],
      [
        valid,
        { ...valid },
      ],
    ];

    for (const commitConflictEvidence of cases) {
      const harness = makeHarness("workspace", plan, {
        commitConflictEvidence,
      });
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "rejected",
        result: { kind: "failed", code: "backend_failure" },
      });
      expect(harness.state).toMatchObject({ compensate: 0, publish: 0 });
    }
  });

  test("requires recovery for malformed committed receipts without false compensation", async () => {
    const mutations: Array<
      (receipt: BackendCommitReceipt<"workspace">) => BackendCommitReceipt<"workspace">
    > = [
      (receipt) =>
        ({
          ...receipt,
          entries: [receipt.entries[1]!, receipt.entries[0]!, ...receipt.entries.slice(2)],
        }) as BackendCommitReceipt<"workspace">,
      (receipt) =>
        ({
          ...receipt,
          entries: [
            { ...receipt.entries[0]!, kind: "delete" },
            ...receipt.entries.slice(1),
          ],
        }) as unknown as BackendCommitReceipt<"workspace">,
      (receipt) => {
        const update = receipt.entries[1]!;
        if (update.kind !== "update") throw new Error("invalid fixture");
        return {
          ...receipt,
          entries: [
            receipt.entries[0]!,
            {
              ...update,
              after: {
                ...update.after,
                sha256: "0".repeat(64),
              },
            },
            ...receipt.entries.slice(2),
          ],
        };
      },
      (receipt) => ({
        ...receipt,
        entries: [
          { ...receipt.entries[0]!, revisionIds: [" "] },
          ...receipt.entries.slice(1),
        ],
      }),
    ];

    for (const mutateReceipt of mutations) {
      const harness = makeHarness("workspace", plan, { mutateReceipt });
      expect(
        await harness.coordinator.execute({
          operationId: plan.operationId,
          plan,
          lane: "apply_patch",
        }),
      ).toMatchObject({
        kind: "recovery_required",
        commitState: "committed",
        code: "inconsistent_outcome",
      });
      expect(harness.state).toMatchObject({ compensate: 0, publish: 0 });
    }
  });

  test("rejects malformed rollback restoration, including exact move destination absence", async () => {
    const overwrite = makeHarness("workspace", plan, {
      commitFailure: "compensate",
      compensationOutcome: (outcome) => {
        if (outcome.kind !== "compensated") return outcome;
        return {
          ...outcome,
          entries: [
            ...outcome.entries.slice(0, 1),
            { ...outcome.entries[1]!, entryIndex: 99 },
            ...outcome.entries.slice(2),
          ],
        };
      },
    });
    expect(
      await overwrite.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "recovery_required", commitState: "unknown" });

    const moveIndex = plan.entries.findIndex((entry) => entry.kind === "move");
    const move = plan.entries[moveIndex]!;
    if (move.kind !== "move") throw new Error("invalid fixture");
    const nonOverwritePlan = {
      ...plan,
      entries: plan.entries.map((entry, index) =>
        index === moveIndex
          ? {
              kind: "move" as const,
              source: move.source,
              after: move.after,
            }
          : entry,
      ),
    } as BackendCommitPlan<"workspace">;
    const wrongDestination = makeHarness("workspace", nonOverwritePlan, {
      commitFailure: "compensate",
      compensationOutcome: (outcome) => {
        if (outcome.kind !== "compensated") return outcome;
        const restoredMove = outcome.entries[moveIndex]!;
        if (restoredMove.kind !== "move") throw new Error("invalid fixture");
        return {
          ...outcome,
          entries: outcome.entries.map((entry, index) =>
            index === moveIndex
              ? {
                  ...restoredMove,
                  destination: {
                    kind: "absent" as const,
                    identity: workspaceIdentity(999, "wrong.md"),
                  },
                }
              : entry,
          ),
        };
      },
    });
    expect(
      await wrongDestination.coordinator.execute({
        operationId: nonOverwritePlan.operationId,
        plan: nonOverwritePlan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "recovery_required", commitState: "unknown" });
  });

  test("accepts append-only Workspace revisions as exact byte restoration proof", async () => {
    const harness = makeHarness("workspace", plan, {
      commitFailure: "compensate",
      compensationOutcome: (outcome) => {
        if (outcome.kind !== "compensated") return outcome;
        return {
          ...outcome,
          entries: outcome.entries.map((entry) => {
            const bump = (value: DocumentVersion): DocumentVersion =>
              value.backendVersion.kind === "artifact_revision" &&
              value.identity.kind === "workspace_artifact"
                ? {
                    ...value,
                    backendVersion: {
                      kind: "artifact_revision",
                      revision: value.backendVersion.revision + 100,
                    },
                  } as DocumentVersion
                : value;
            switch (entry.kind) {
              case "create":
                return entry;
              case "update":
                return { ...entry, restored: bump(entry.restored) };
              case "move":
                return {
                  ...entry,
                  sourceRestored: bump(entry.sourceRestored),
                  destination:
                    entry.destination.kind === "restored"
                      ? {
                          kind: "restored" as const,
                          version: bump(entry.destination.version),
                        }
                      : entry.destination,
                };
              case "delete":
                return { ...entry, restored: bump(entry.restored) };
            }
          }),
        };
      },
    });
    expect(
      await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({
      kind: "rejected",
      result: { kind: "failed", code: "backend_failure" },
    });
  });

  test("disposes undefined prepared values and ignores dispose/release cleanup failures", async () => {
    const harness = makeHarness("workspace", plan, {
      preparedValue: undefined,
      disposeThrow: true,
      releaseThrow: true,
    });
    expect(
      await harness.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "completed", commitState: "committed" });
    expect(harness.state.dispose).toBe(1);
    expect(harness.state.disposedPrepared).toBeUndefined();

    const preview = makeHarness("workspace", plan, {
      preparedValue: undefined,
      disposeThrow: true,
      releaseThrow: true,
    });
    expect(
      await preview.coordinator.preview({
        operationId: plan.operationId,
        plan,
        lane: "apply_patch",
      }),
    ).toMatchObject({ kind: "prepared" });
    expect(preview.state.dispose).toBe(1);
  });

  test("admits a dirty disjoint human draft without rewriting authoritative agent bytes", async () => {
    const identity = workspaceIdentity(81, "human-priority.md");
    const base = new TextEncoder().encode("title\nbody\n");
    const agentAfter = new TextEncoder().encode("agent-title\nbody\n");
    const expected = version("workspace", identity, base, 1) as Extract<
      DocumentVersion,
      { identity: { kind: "workspace_artifact" } }
    >;
    const p: BackendCommitPlan<"workspace"> = {
      operationId: "human-priority-disjoint",
      actor: { kind: "agent", agentId: "agent-1" },
      entries: [{
        kind: "update",
        before: { identity, expectedVersion: expected, bytes: base },
        after: { identity, bytes: agentAfter, sha256: hashBytes(agentAfter) },
      }],
    };
    const registry = new HumanEditLeaseRegistry({
      ttlMs: 60_000,
      newLeaseId: () => "lease-disjoint",
    });
    expect(registry.register({
      sessionId: "session-1",
      humanId: "human-1",
      identity,
      baseVersion: expected,
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "body", newString: "human-body" },
    }).status).toBe("ok");
    let committedPlan: BackendCommitPlan<"workspace"> | undefined;
    const harness = makeHarness("workspace", p, {
      humanEditAdmission: createHumanEditAdmission(registry),
      onCommitPlan: (value) => { committedPlan = value; },
    });

    expect(await harness.coordinator.execute({
      operationId: p.operationId,
      plan: p,
      lane: "apply_patch",
    })).toMatchObject({ kind: "completed", result: { kind: "applied" } });
    expect(harness.state).toMatchObject({ prepare: 1, commit: 1, dispose: 1 });
    expect(committedPlan?.entries[0]).toMatchObject({
      kind: "update",
      after: { bytes: agentAfter },
    });
  });

  test("rejects overlapping, saving, and precondition-only human leases before agent persistence", async () => {
    const identity = workspaceIdentity(82, "human-priority-conflict.md");
    const sourceIdentity = workspaceIdentity(83, "human-priority-source.md");
    const base = new TextEncoder().encode("title\nbody\n");
    const agentAfter = new TextEncoder().encode("agent-title\nbody\n");
    const expected = version("workspace", identity, base, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const sourceVersion = version("workspace", sourceIdentity, base, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const basePlan = (operationId: string, postimage = agentAfter): BackendCommitPlan<"workspace"> => ({
      operationId,
      actor: { kind: "agent", agentId: "agent-1" },
      entries: [{
        kind: "update",
        before: { identity, expectedVersion: expected, bytes: base },
        after: { identity, bytes: postimage, sha256: hashBytes(postimage) },
      }],
    });
    const overlapLeases = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: () => "lease-overlap" });
    overlapLeases.register({
      sessionId: "session-1", humanId: "human-1", identity, baseVersion: expected,
      state: "dirty", draftPatch: { kind: "anchored_text", oldString: "title\n", newString: "human-title\n" },
    });
    const overlappingAgentPostimage = new TextEncoder().encode("agent heading\nbody\n");
    const overlapPlan = basePlan("human-priority-overlap", overlappingAgentPostimage);
    const overlap = makeHarness("workspace", overlapPlan, {
      humanEditAdmission: createHumanEditAdmission(overlapLeases),
    });
    expect(await overlap.coordinator.execute({
      operationId: "human-priority-overlap", plan: overlapPlan, lane: "apply_patch",
    })).toMatchObject({ kind: "rejected", result: { kind: "conflict", code: "human_edit_conflict" } });
    expect(overlap.state).toMatchObject({ prepare: 0, commit: 0, publish: 0 });

    const preconditionLeases = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: () => "lease-precondition" });
    preconditionLeases.register({
      sessionId: "session-1", humanId: "human-1", identity: sourceIdentity, baseVersion: sourceVersion,
      state: "dirty", draftPatch: { kind: "anchored_text", oldString: "body", newString: "human-body" },
    });
    const preconditionPlan = { ...basePlan("human-priority-precondition"), preconditions: [{ identity: sourceIdentity, expectedVersion: sourceVersion, bytes: base }] };
    const precondition = makeHarness("workspace", preconditionPlan, {
      humanEditAdmission: createHumanEditAdmission(preconditionLeases),
    });
    expect(await precondition.coordinator.execute({
      operationId: preconditionPlan.operationId, plan: preconditionPlan, lane: "apply_patch",
    })).toMatchObject({ kind: "rejected", result: { kind: "failed", code: "backend_failure" } });
    expect(precondition.state).toMatchObject({ prepare: 0, commit: 0, publish: 0 });
  });

  test("rejects semantic lease drift on its actual non-first target immediately before commit", async () => {
    const first = workspaceIdentity(84, "first.md");
    const second = workspaceIdentity(85, "second.md");
    const base = new TextEncoder().encode("title\nbody\n");
    const after = new TextEncoder().encode("agent-title\nbody\n");
    const firstVersion = version("workspace", first, base, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const secondVersion = version("workspace", second, base, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const p: BackendCommitPlan<"workspace"> = {
      operationId: "human-priority-drift",
      actor: { kind: "agent", agentId: "agent-1" },
      entries: [first, second].map((identity, index) => ({
        kind: "update" as const,
        before: { identity, expectedVersion: index === 0 ? firstVersion : secondVersion, bytes: base },
        after: { identity, bytes: after, sha256: hashBytes(after) },
      })),
    };
    const registry = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: () => "lease-second" });
    expect(registry.register({
      sessionId: "session-1", humanId: "human-1", identity: second, baseVersion: secondVersion,
      state: "dirty", draftPatch: { kind: "anchored_text", oldString: "body", newString: "human-body" },
    }).status).toBe("ok");
    const harness = makeHarness("workspace", p, {
      humanEditAdmission: createHumanEditAdmission(registry),
      afterPrepare: () => {
        expect(registry.update({
          leaseId: "lease-second", sessionId: "session-1", humanId: "human-1", expectedGeneration: 0,
          baseVersion: secondVersion, state: "saving",
        }).status).toBe("ok");
      },
    });
    expect(await harness.coordinator.execute({ operationId: p.operationId, plan: p, lane: "apply_patch" })).toMatchObject({
      kind: "rejected",
      result: { kind: "conflict", code: "reapply_required", evidence: [{ path: { before: second } }] },
    });
    expect(harness.state).toMatchObject({ prepare: 1, commit: 0, dispose: 1, publish: 0 });
  });

  test("keeps OfficeCLI's clean target and precondition editor lockouts without text merge", async () => {
    const target = workspaceIdentity(86, "office-target.docx");
    const source = workspaceIdentity(87, "office-source.docx");
    const bytes = new Uint8Array([1, 2, 3]);
    const targetVersion = version("workspace", target, bytes, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const sourceVersion = version("workspace", source, bytes, 1) as Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }>;
    const makeOfficePlan = (operationId: string): BackendCommitPlan<"workspace"> => ({
      operationId,
      actor: { kind: "agent", agentId: "agent-1" },
      entries: [{
        kind: "update",
        before: { identity: target, expectedVersion: targetVersion, bytes },
        after: { identity: target, bytes: new Uint8Array([4, 5, 6]), sha256: hashBytes(new Uint8Array([4, 5, 6])) },
      }],
    });
    const targetLeases = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: () => "office-target-lease" });
    targetLeases.register({
      sessionId: "session-1", humanId: "human-1", identity: target, baseVersion: targetVersion, state: "clean",
    });
    const targetPlan = makeOfficePlan("office-clean-target");
    const targetHarness = makeHarness("workspace", targetPlan, {
      humanEditAdmission: createHumanEditAdmission(targetLeases),
    });
    expect(await targetHarness.coordinator.execute({
      operationId: targetPlan.operationId, plan: targetPlan, lane: "officecli",
    })).toMatchObject({ kind: "rejected", result: { kind: "conflict", code: "human_edit_conflict" } });
    expect(targetHarness.state).toMatchObject({ prepare: 0, commit: 0 });

    const sourceLeases = new HumanEditLeaseRegistry({ ttlMs: 60_000, newLeaseId: () => "office-source-lease" });
    sourceLeases.register({
      sessionId: "session-1", humanId: "human-1", identity: source, baseVersion: sourceVersion, state: "clean",
    });
    const sourcePlan = {
      ...makeOfficePlan("office-clean-source"),
      preconditions: [{ identity: source, expectedVersion: sourceVersion, bytes }],
    };
    const sourceHarness = makeHarness("workspace", sourcePlan, {
      humanEditAdmission: createHumanEditAdmission(sourceLeases),
    });
    expect(await sourceHarness.coordinator.execute({
      operationId: sourcePlan.operationId, plan: sourcePlan, lane: "officecli",
    })).toMatchObject({ kind: "rejected", result: { kind: "failed", code: "backend_failure" } });
    expect(sourceHarness.state).toMatchObject({ prepare: 0, commit: 0 });
  });

  test("normalizes only agent commit-stage stale versions to reapply_required", async () => {
    const agentPlan = {
      ...makePlan("workspace"),
      actor: { kind: "agent" as const, agentId: "agent-1" },
    } as BackendCommitPlan<"workspace">;
    const agent = makeHarness("workspace", agentPlan, {
      commitConflictPaths: [planPaths(agentPlan)[0]!],
      commitConflictCode: "stale_version",
    });
    expect(await agent.coordinator.execute({
      operationId: agentPlan.operationId, plan: agentPlan, lane: "apply_patch",
    })).toMatchObject({ kind: "rejected", result: { kind: "conflict", code: "reapply_required" } });

    const humanPlan = workspaceEditorPlan({
      baseText: "base\n",
      currentText: "base\n",
      afterText: "human save\n",
    });
    const human = makeHarness("workspace", humanPlan, {
      commitConflictPaths: [planPaths(humanPlan)[0]!],
      commitConflictCode: "stale_version",
    });
    expect(await human.coordinator.execute({
      operationId: humanPlan.operationId, plan: humanPlan, lane: "editor_save",
    })).toMatchObject({ kind: "rejected", result: { kind: "conflict", code: "stale_version" } });
  });
});
