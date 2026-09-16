import { describe, expect, test } from "bun:test";
import {
  executeWorkspaceApplyPatch,
  type ApplyPatchWorkspaceRunner,
  type WorkspaceCommitAdmission,
  type WorkspaceCommitResult,
  type WorkspaceApplyPatchOperationReconciliation,
  type WorkspaceCommitOutcome,
} from "../../src/tools/apply-patch/workspace-executor";
import type { ApplyPatchNativeExecutionReport, ApplyPatchProcessWrapperResult } from "../../src/tools/apply-patch/process-wrapper";
import type { ApplyPatchWorkspaceTreePort, WorkspaceArtifactSnapshot } from "../../src/tools/apply-patch/workspace-staging";

type Tree = Map<string, Uint8Array>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function runtime(
  operations: ApplyPatchNativeExecutionReport["plannedOperations"],
  states: ApplyPatchNativeExecutionReport["operationStates"],
  partial = false,
): ApplyPatchProcessWrapperResult {
  const report: ApplyPatchNativeExecutionReport = {
    protocol: "p", runtimeVersion: "v", upstreamRevision: "u", nautiloExtractionRevision: "n",
    ok: !partial, partial,
    plannedPaths: operations.map((operation) => operation.path),
    appliedPaths: states.filter((state) => state.state === "applied").map((state) => state.path),
    plannedOperations: operations,
    operationStates: states,
    ...(partial ? { diagnostic: "partial" } : {}),
  };
  return {
    ok: true,
    process: { stdout: "{}", stderr: "", exitCode: partial ? 1 : 0, signal: null, cancelled: false },
    report,
  };
}

function setup(
  patch: string,
  initial: Record<string, string>,
  runner: ApplyPatchWorkspaceRunner<Tree>,
  commit?: (
    operations: readonly WorkspaceApplyPatchOperationReconciliation[],
    admission: WorkspaceCommitAdmission | undefined,
  ) => Promise<WorkspaceCommitResult>,
  cleanupFails = false,
) {
  let cleanup = 0;
  const tree: ApplyPatchWorkspaceTreePort<Tree> = {
    create: async () => new Map(),
    writeFile: async (target, path, bytes) => { target.set(path, bytes); },
    readFile: async (target, path) => target.get(path) ?? null,
    cleanup: async () => {
      cleanup += 1;
      if (cleanupFails) throw new Error("cleanup");
    },
  };
  const committed: readonly WorkspaceApplyPatchOperationReconciliation[][] = [];
  const artifacts = Object.fromEntries(Object.entries(initial).map(([path, text]) => [
    path,
    { logicalPath: path, artifactId: `uuid-${path}`, revision: 1, bytes: encoder.encode(text) } satisfies WorkspaceArtifactSnapshot,
  ]));
  return {
    input: {
      patch, tree, runner,
      artifacts: { readAuthorized: async (path: string) => artifacts[path] ?? null },
      commit: { reconcileApplied: async (
        operations: readonly WorkspaceApplyPatchOperationReconciliation[],
        admission?: WorkspaceCommitAdmission,
      ) => {
        (committed as WorkspaceApplyPatchOperationReconciliation[][]).push([...operations]);
        return commit
          ? await commit(operations, admission)
          : {
              operations: operations.map((operation) => operation.operation === "move"
                ? { operation: "move" as const, fromPath: operation.fromPath, path: operation.path, state: "committed" as const, revisionIds: ["r1", "r2"] }
                : { operation: operation.operation, path: operation.path, state: "committed" as const, revisionIds: ["r1"] }),
            };
      } },
    },
    committed,
    cleanup: () => cleanup,
  };
}

describe("D448 workspace executor", () => {
  test("preflight failure never calls runner or commit", async () => {
    let calls = 0;
    const ctx = setup("not a patch", {}, { run: async () => { calls += 1; return runtime([], []); } });
    expect(await executeWorkspaceApplyPatch(ctx.input)).toMatchObject({ ok: false, error: { code: "parse_error" } });
    expect(calls).toBe(0);
    expect(ctx.committed).toEqual([]);
  });

  test("reconciles add, delete, and move as operation-shaped effects", async () => {
    const addPatch = "*** Begin Patch\n*** Add File: add.txt\n+new\n*** End Patch";
    const add = setup(addPatch, {}, { run: async ({ tree }) => {
      tree.set("add.txt", encoder.encode("new\n"));
      return runtime([{ kind: "add", path: "add.txt" }], [{ kind: "add", path: "add.txt", state: "applied" }]);
    } });
    expect(await executeWorkspaceApplyPatch(add.input)).toMatchObject({ ok: true });
    expect(add.committed[0]![0]).toMatchObject({ operation: "add", destination: { path: "add.txt", before: null } });

    const deletePatch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
    const deletion = setup(deletePatch, { "old.txt": "old\n" }, { run: async ({ tree }) => {
      tree.delete("old.txt");
      return runtime([{ kind: "delete", path: "old.txt" }], [{ kind: "delete", path: "old.txt", state: "applied" }]);
    } });
    expect(await executeWorkspaceApplyPatch(deletion.input)).toMatchObject({ ok: true });
    expect(deletion.committed[0]![0]).toMatchObject({ operation: "delete", destination: { path: "old.txt", after: null } });

    const movePatch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch";
    const move = setup(movePatch, { "old.txt": "old\n" }, { run: async ({ tree }) => {
      tree.delete("old.txt");
      tree.set("new.txt", encoder.encode("new\n"));
      return runtime([{ kind: "move", path: "new.txt", fromPath: "old.txt" }], [{ kind: "move", path: "new.txt", fromPath: "old.txt", state: "applied" }]);
    } });
    expect(await executeWorkspaceApplyPatch(move.input)).toMatchObject({ ok: true });
    const moveChange = move.committed[0]![0]!;
    expect(moveChange.operation).toBe("move");
    if (moveChange.operation !== "move") throw new Error("expected move reconciliation");
    expect(moveChange.fromPath).toBe("old.txt");
    expect(moveChange.source.path).toBe("old.txt");
    expect(moveChange.source.after).toBeNull();
    expect(moveChange.destination.path).toBe("new.txt");
    expect(moveChange.destination.after).toBeInstanceOf(Uint8Array);
  });

  test("rejects contradictions between reported state and observed bytes", async () => {
    const patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
    const ctx = setup(patch, { "old.txt": "old\n" }, { run: async () =>
      runtime([{ kind: "delete", path: "old.txt" }], [{ kind: "delete", path: "old.txt", state: "applied" }]) });
    expect(await executeWorkspaceApplyPatch(ctx.input)).toMatchObject({ ok: false, error: { code: "runtime_corrupt" } });
    expect(ctx.committed).toEqual([]);
  });

  test("reconciles an isolated delete/add same-path pair as its terminal replacement", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: replacement.txt",
      "*** Add File: replacement.txt",
      "+new",
      "*** End Patch",
    ].join("\n");
    const ctx = setup(patch, { "replacement.txt": "old\n" }, { run: async ({ tree }) => {
      tree.delete("replacement.txt");
      tree.set("replacement.txt", encoder.encode("new\n"));
      return runtime(
        [{ kind: "delete", path: "replacement.txt" }, { kind: "add", path: "replacement.txt" }],
        [{ kind: "delete", path: "replacement.txt", state: "applied" }, { kind: "add", path: "replacement.txt", state: "applied" }],
      );
    } });

    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result.ok).toBe(true);
    expect(ctx.committed).toHaveLength(1);
    expect(ctx.committed[0]).toHaveLength(1);
    expect(ctx.committed[0]![0]).toMatchObject({
      operation: "update",
      path: "replacement.txt",
      destination: { path: "replacement.txt", before: { logicalPath: "replacement.txt" } },
    });
    if (result.ok) {
      expect(result.unifiedDiff).toContain("-old");
      expect(result.unifiedDiff).toContain("+new");
      expect(result.unifiedDiff).not.toContain("/dev/null");
    }
  });

  test("fails closed when a reported delete/add replacement has no terminal bytes", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: replacement.txt",
      "*** Add File: replacement.txt",
      "+new",
      "*** End Patch",
    ].join("\n");
    const ctx = setup(patch, { "replacement.txt": "old\n" }, { run: async ({ tree }) => {
      tree.delete("replacement.txt");
      return runtime(
        [{ kind: "delete", path: "replacement.txt" }, { kind: "add", path: "replacement.txt" }],
        [{ kind: "delete", path: "replacement.txt", state: "applied" }, { kind: "add", path: "replacement.txt", state: "applied" }],
      );
    } });

    expect(await executeWorkspaceApplyPatch(ctx.input)).toMatchObject({
      ok: false,
      error: { code: "runtime_corrupt" },
    });
    expect(ctx.committed).toEqual([]);
  });

  test("never sends a native partial prefix to the authoritative commit port", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** Update File: b.txt\n@@\n-b\n+c\n*** End Patch";
    const ctx = setup(patch, { "a.txt": "a\n", "b.txt": "b\n" }, { run: async ({ tree }) => {
      tree.set("a.txt", encoder.encode("b\n"));
      return runtime(
        [{ kind: "update", path: "a.txt" }, { kind: "update", path: "b.txt" }],
        [{ kind: "update", path: "a.txt", state: "applied" }, { kind: "update", path: "b.txt", state: "not_applied" }],
        true,
      );
    } }, async (operations) => ({
      operations: operations.map((operation) => ({ operation: operation.operation, path: operation.path, state: "unknown" as const })),
    }) as WorkspaceCommitOutcome);
    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "partial_execution" },
      commit: { operations: [] },
      unifiedDiff: "",
    });
    expect(ctx.committed).toHaveLength(0);
  });

  test("preserves a typed commit admission conflict as a top-level error, never partial execution", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch";
    const ctx = setup(patch, { "a.txt": "a\n" }, { run: async ({ tree }) => {
      tree.set("a.txt", encoder.encode("b\n"));
      return runtime([{ kind: "update", path: "a.txt" }], [{ kind: "update", path: "a.txt", state: "applied" }]);
    } }, async () => ({
      rejected: true,
      operations: [],
      error: {
        code: "human_edit_conflict",
        message: "A target is open in Writer.",
        retryable: true,
      },
    }));
    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "human_edit_conflict", retryable: true },
    });
    expect(result).not.toHaveProperty("commit");
  });

  test("passes every staged existing artifact identity to batch admission", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: existing.txt",
      "+replacement",
      "*** Update File: source.txt",
      "*** Move to: destination.txt",
      "@@",
      "-source",
      "+moved",
      "*** End Patch",
    ].join("\n");
    let admission: WorkspaceCommitAdmission | undefined;
    const ctx = setup(patch, {
      "existing.txt": "existing\n",
      "source.txt": "source\n",
      "destination.txt": "destination\n",
    }, { run: async ({ tree }) => {
      tree.set("existing.txt", encoder.encode("replacement\n"));
      tree.delete("source.txt");
      tree.set("destination.txt", encoder.encode("moved\n"));
      return runtime(
        [{ kind: "add", path: "existing.txt" }, { kind: "move", path: "destination.txt", fromPath: "source.txt" }],
        [{ kind: "add", path: "existing.txt", state: "applied" }, { kind: "move", path: "destination.txt", fromPath: "source.txt", state: "applied" }],
      );
    } }, async (_operations, receivedAdmission) => {
      admission = receivedAdmission;
      return {
        rejected: true,
        operations: [],
        error: { code: "human_edit_conflict", message: "open", retryable: true },
      };
    });
    expect(await executeWorkspaceApplyPatch(ctx.input)).toMatchObject({
      ok: false,
      error: { code: "human_edit_conflict" },
    });
    expect(admission).toEqual({
      existingArtifactIds: ["uuid-existing.txt", "uuid-source.txt", "uuid-destination.txt"],
    });
  });

  test("retains commit truth when cleanup fails after authority was called", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch";
    const ctx = setup(patch, { "a.txt": "a\n" }, { run: async ({ tree }) => {
      tree.set("a.txt", encoder.encode("b\n"));
      return runtime([{ kind: "update", path: "a.txt" }], [{ kind: "update", path: "a.txt", state: "applied" }]);
    } }, undefined, true);
    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected committed result");
    expect(result.cleanupWarning).toContain("cleanup");
    expect(result.commit.operations[0]?.state).toBe("committed");
    expect(ctx.cleanup()).toBe(1);
    if (result.ok) expect(decoder.decode((ctx.committed[0]![0] as { destination: { after: Uint8Array } }).destination.after)).toBe("b\n");
  });

  test("renders committed observations, including overwrite and both move states", async () => {
    const patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+next\n*** End Patch";
    const ctx = setup(patch, { "old.txt": "old\n", "new.txt": "existing\n" }, { run: async ({ tree }) => {
      tree.delete("old.txt");
      tree.set("new.txt", encoder.encode("next\n"));
      return runtime(
        [{ kind: "move", path: "new.txt", fromPath: "old.txt" }],
        [{ kind: "move", path: "new.txt", fromPath: "old.txt", state: "applied" }],
      );
    } });
    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Source removal and destination replacement are separate observed facts:
    // neither a destination overwrite nor its prior bytes disappear into a
    // cosmetic rename-only patch.
    expect(result.unifiedDiff).toContain("--- a/old.txt");
    expect(result.unifiedDiff).toContain("+++ /dev/null");
    expect(result.unifiedDiff).toContain("--- a/new.txt");
    expect(result.unifiedDiff).toContain("+++ b/new.txt");
    expect(result.unifiedDiff).toContain("-existing");
    expect(result.unifiedDiff).toContain("+next");
  });

  test("uses actual add-overwrite and delete labels instead of synthetic empty files", async () => {
    const addPatch = "*** Begin Patch\n*** Add File: exists.txt\n+replacement\n*** End Patch";
    const add = setup(addPatch, { "exists.txt": "prior\n" }, { run: async ({ tree }) => {
      tree.set("exists.txt", encoder.encode("replacement\n"));
      return runtime([{ kind: "add", path: "exists.txt" }], [{ kind: "add", path: "exists.txt", state: "applied" }]);
    } });
    const addResult = await executeWorkspaceApplyPatch(add.input);
    expect(addResult.ok).toBe(true);
    if (addResult.ok) {
      expect(addResult.unifiedDiff).toContain("--- a/exists.txt");
      expect(addResult.unifiedDiff).toContain("+++ b/exists.txt");
      expect(addResult.unifiedDiff).toContain("-prior");
      expect(addResult.unifiedDiff).toContain("+replacement");
    }

    const deletePatch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
    const deletion = setup(deletePatch, { "old.txt": "old\n" }, { run: async ({ tree }) => {
      tree.delete("old.txt");
      return runtime([{ kind: "delete", path: "old.txt" }], [{ kind: "delete", path: "old.txt", state: "applied" }]);
    } });
    const deleteResult = await executeWorkspaceApplyPatch(deletion.input);
    expect(deleteResult.ok).toBe(true);
    if (deleteResult.ok) {
      expect(deleteResult.unifiedDiff).toContain("--- a/old.txt");
      expect(deleteResult.unifiedDiff).toContain("+++ /dev/null");
      expect(deleteResult.unifiedDiff).toContain("-old");
    }
  });

  test("excludes private-tree changes whose authoritative commit did not complete", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch";
    const ctx = setup(patch, { "a.txt": "a\n" }, { run: async ({ tree }) => {
      tree.set("a.txt", encoder.encode("b\n"));
      return runtime([{ kind: "update", path: "a.txt" }], [{ kind: "update", path: "a.txt", state: "applied" }]);
    } }, async (operations) => ({
      operations: operations.map((operation) => operation.operation === "move"
        ? { operation: "move" as const, fromPath: operation.fromPath, path: operation.path, state: "failed" as const }
        : { operation: operation.operation, path: operation.path, state: "failed" as const }),
    }));
    const result = await executeWorkspaceApplyPatch(ctx.input);
    expect(result).toMatchObject({ ok: false, error: { code: "partial_execution" }, unifiedDiff: "" });
  });
});
