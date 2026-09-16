import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RelaySandboxProfile } from "@nautilo/relay";
import {
  applyPatchExecutionCapability,
  executeRelayApplyPatchDispatch,
  prepareRelayApplyPatchDispatch,
  requiredOperationsForApplyPatch,
  terminateDesktopApplyPatchProcess,
} from "../../electron/apply-patch-dispatch.ts";

const ADD_PATCH =
  "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch";

function request(
  patch: string,
  root: string,
) {
  return {
    args: {
      operation: {
        kind: "apply_patch",
        version: 1,
        patch,
        routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
      },
      expectedCurrentFolder: root,
    },
  };
}

function sandboxEnvelope(workspace: string): RelaySandboxProfile {
  return {
    workspace,
    dataDir: workspace,
    toolsBin: "/owned/tools",
    mode: "desktop-locked",
    securityLevel: "standard",
    failIfNoBackend: true,
    config: {
      mode: "enabled",
      writablePaths: [workspace],
      projectPaths: [workspace],
      passthroughEnv: [],
      protectedPaths: ["/canonical/protected"],
      protectedFileMaskPath: "/owned/protected-mask",
    },
  };
}

const runtime = () => ({
  ok: true,
  binaryPath: "/owned/apply-patch",
  platformKey: "darwin-arm64",
  origin: "source",
  runtimeVersion: "0.1.0",
  protocol: "nautilo.apply_patch/v1",
  provenance: {
    format: "nautilo.apply_patch.provenance/v1",
    upstreamRevision: "u",
    licenseSha256: "a",
    noticeSha256: "b",
    nautiloExtractionRevision: "n",
  },
  integrity: "pristine-byte-sha256",
} as const);

function successfulAddReport() {
  return {
    ok: true as const,
    process: {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      cancelled: false,
    },
    report: {
      protocol: "nautilo.apply_patch/v1",
      runtimeVersion: "0.1.0",
      upstreamRevision: "u",
      nautiloExtractionRevision: "n",
      ok: true,
      partial: false,
      plannedPaths: ["new.txt"],
      appliedPaths: ["new.txt"],
      plannedOperations: [{ kind: "add" as const, path: "new.txt" }],
      operationStates: [{
        kind: "add" as const,
        path: "new.txt",
        state: "applied" as const,
      }],
    },
  };
}

test("derives the exact local authority set from patch semantics", () => {
  const root = "/tmp/d448-root";
  const prepared = prepareRelayApplyPatchDispatch(request(
    "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch",
    root,
  ));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(requiredOperationsForApplyPatch(prepared.preparation.preflight))
    .toEqual(["read", "create_modify", "delete"]);
  expect(
    prepareRelayApplyPatchDispatch(request(ADD_PATCH, root)),
  ).toMatchObject({
    ok: true,
    preparation: { requiredOperations: ["read", "create_modify"] },
  });
});

test("fails closed before native execution without the coordinator port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const prepared = prepareRelayApplyPatchDispatch(request(ADD_PATCH, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let ran = false;
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      runProcess: async () => {
        ran = true;
        throw new Error("must not run");
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "runtime_unavailable" });
    expect(ran).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves a native context rejection as an actionable reapply request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const patch = "*** Begin Patch\n*** Update File: current.txt\n@@\n-old\n+new\n*** End Patch";
    await fs.writeFile(path.join(root, "current.txt"), "current\n");
    const prepared = prepareRelayApplyPatchDispatch(request(patch, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let committed = false;
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async () => ({
        ok: false,
        error: {
          code: "reapply_required",
          message: "The target files did not match the patch context. Read the affected files again and construct a new patch.",
          retryable: false,
        },
      }),
      commitApplied: async () => {
        committed = true;
        throw new Error("must not commit");
      },
    });
    expect(outcome).toEqual({
      ok: false,
      code: "reapply_required",
      message: "The target files did not match the patch context. Read the affected files again and construct a new patch.",
    });
    expect(committed).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("native runs in a private tree and the coordinator is the only live writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const prepared = prepareRelayApplyPatchDispatch(request(ADD_PATCH, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let stagedRoot = "";
    let committedRoot = "";
    let committedText = "";
    let liveExistedBeforeCommit = true;
    let reauthorizations = 0;
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {
        reauthorizations += 1;
      },
      runProcess: async (input) => {
        stagedRoot = input.root;
        expect(input.root).not.toBe(root);
        expect(input.sandboxEnvelope.workspace).toBe(input.root);
        expect(input.sandboxEnvelope.config.writablePaths).toEqual([]);
        expect(input.sandboxEnvelope.config.projectPaths).toEqual([]);
        await fs.writeFile(path.join(input.root, "new.txt"), "hello\n");
        expect(await fs.stat(path.join(root, "new.txt")).catch(() => null))
          .toBeNull();
        return successfulAddReport();
      },
      commitApplied: async (input) => {
        await input.reauthorize();
        committedRoot = input.root;
        const operation = input.operations[0]!;
        if (operation.operation !== "add") throw new Error("unexpected");
        committedText = new TextDecoder().decode(operation.destination.after);
        liveExistedBeforeCommit =
          await fs.stat(path.join(root, "new.txt")).catch(() => null) !== null;
        await fs.writeFile(path.join(root, "new.txt"), operation.destination.after);
        return {
          rebased: true,
          operations: [{
            operation: "add",
            path: "new.txt",
            state: "committed",
            revisionIds: ["revision-1"],
          }],
        };
      },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        revisionIds: ["revision-1"],
        partial: false,
        rebased: true,
      },
    });
    expect(committedRoot).toBe(await fs.realpath(root));
    expect(committedText).toBe("hello\n");
    expect(liveExistedBeforeCommit).toBe(false);
    expect(reauthorizations).toBe(1);
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("hello\n");
    expect(await fs.stat(stagedRoot).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delete/add of one path returns the coordinator's one update receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    await fs.writeFile(path.join(root, "replacement.txt"), "old\n");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: replacement.txt",
      "*** Add File: replacement.txt",
      "+new",
      "*** End Patch",
    ].join("\n");
    const prepared = prepareRelayApplyPatchDispatch(request(patch, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let liveTextBeforeCommit = "";
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async (input) => {
        await fs.rm(path.join(input.root, "replacement.txt"));
        await fs.writeFile(path.join(input.root, "replacement.txt"), "new\n");
        const report = successfulAddReport();
        return {
          ...report,
          report: {
            ...report.report,
            plannedPaths: ["replacement.txt", "replacement.txt"],
            appliedPaths: ["replacement.txt", "replacement.txt"],
            plannedOperations: [
              { kind: "delete" as const, path: "replacement.txt" },
              { kind: "add" as const, path: "replacement.txt" },
            ],
            operationStates: [
              { kind: "delete" as const, path: "replacement.txt", state: "applied" as const },
              { kind: "add" as const, path: "replacement.txt", state: "applied" as const },
            ],
          },
        };
      },
      commitApplied: async (input) => {
        expect(input.operations).toHaveLength(1);
        const operation = input.operations[0]!;
        expect(operation.operation).toBe("update");
        if (operation.operation !== "update") throw new Error("expected replacement update");
        liveTextBeforeCommit = await fs.readFile(path.join(root, "replacement.txt"), "utf8");
        await fs.writeFile(path.join(root, "replacement.txt"), operation.destination.after);
        return {
          operations: [{
            operation: "update",
            path: "replacement.txt",
            state: "committed",
            revisionIds: ["revision-replacement"],
          }],
        };
      },
    });
    expect(outcome).toEqual({
      ok: true,
      result: {
        status: "applied",
        partial: false,
        operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
        pathResults: [{
          operation: "update",
          path: "replacement.txt",
          status: "applied",
          revisionId: "revision-replacement",
        }],
        changedFiles: [{
          operation: "update",
          path: "replacement.txt",
          status: "applied",
          revisionId: "revision-replacement",
        }],
        revisionIds: ["revision-replacement"],
        unifiedDiff: outcome.ok ? outcome.result.unifiedDiff : "",
        runtimeVersion: "0.1.0",
        turnId: "turn-1",
      },
    });
    if (!outcome.ok) throw new Error("expected successful replacement update");
    expect(outcome.result.unifiedDiff).toContain("+new");
    expect(liveTextBeforeCommit).toBe("old\n");
    expect(await fs.readFile(path.join(root, "replacement.txt"), "utf8")).toBe("new\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("nested adds stage from the Current Folder when parent directories do not exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const patch =
      "*** Begin Patch\n*** Add File: missing/nested/new.txt\n+hello\n*** End Patch";
    const prepared = prepareRelayApplyPatchDispatch(request(patch, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let ran = false;
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async (input) => {
        ran = true;
        await fs.mkdir(path.join(input.root, "missing", "nested"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(input.root, "missing", "nested", "new.txt"),
          "hello\n",
        );
        const report = successfulAddReport();
        return {
          ...report,
          report: {
            ...report.report,
            plannedPaths: ["missing/nested/new.txt"],
            appliedPaths: ["missing/nested/new.txt"],
            plannedOperations: [{
              kind: "add" as const,
              path: "missing/nested/new.txt",
            }],
            operationStates: [{
              kind: "add" as const,
              path: "missing/nested/new.txt",
              state: "applied" as const,
            }],
          },
        };
      },
      commitApplied: async (input) => ({
        operations: input.operations.map((operation) => ({
          operation: operation.operation,
          path: operation.path,
          state: "committed" as const,
          revisionIds: ["revision-nested"],
        })),
      }),
    });
    expect(ran).toBe(true);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        revisionIds: ["revision-nested"],
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial native prefix produces zero live writes and never calls commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const prepared = prepareRelayApplyPatchDispatch(request(ADD_PATCH, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let committed = false;
    let stagedRoot = "";
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async (input) => {
        stagedRoot = input.root;
        await fs.writeFile(path.join(input.root, "new.txt"), "partial\n");
        const report = successfulAddReport();
        return {
          ...report,
          report: {
            ...report.report,
            ok: false,
            partial: true,
          },
        };
      },
      commitApplied: async () => {
        committed = true;
        throw new Error("must not commit");
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "partial_execution" });
    expect(committed).toBe(false);
    expect(await fs.stat(path.join(root, "new.txt")).catch(() => null)).toBeNull();
    expect(await fs.stat(stagedRoot).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("native cancellation produces zero live writes and never calls commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    const prepared = prepareRelayApplyPatchDispatch(request(ADD_PATCH, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let committed = false;
    let stagedRoot = "";
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async (input) => {
        stagedRoot = input.root;
        await fs.writeFile(path.join(input.root, "new.txt"), "cancelled prefix\n");
        return {
          ok: false,
          error: {
            code: "cancelled",
            message: "cancelled",
            retryable: true,
          },
        };
      },
      commitApplied: async () => {
        committed = true;
        throw new Error("must not commit");
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "cancelled" });
    expect(committed).toBe(false);
    expect(await fs.stat(path.join(root, "new.txt")).catch(() => null)).toBeNull();
    expect(await fs.stat(stagedRoot).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("staging never reads or creates through a symlinked parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "d448-outside-"));
  try {
    await fs.writeFile(path.join(outside, "secret.txt"), "outside secret\n");
    await fs.writeFile(path.join(root, "source.txt"), "inside source\n");
    await fs.symlink(outside, path.join(root, "link"));
    const cases = [
      {
        patch: "*** Begin Patch\n*** Update File: link/secret.txt\n@@\n-outside secret\n+stolen\n*** End Patch",
      },
      {
        patch: "*** Begin Patch\n*** Delete File: link/secret.txt\n*** End Patch",
      },
      {
        patch: "*** Begin Patch\n*** Update File: link/secret.txt\n*** Move to: moved.txt\n@@\n-outside secret\n+moved\n*** End Patch",
      },
      {
        patch: "*** Begin Patch\n*** Add File: link/new.txt\n+escape\n*** End Patch",
      },
      {
        patch: "*** Begin Patch\n*** Update File: source.txt\n*** Move to: link/moved.txt\n@@\n-inside source\n+moved\n*** End Patch",
      },
    ] as const;
    for (const item of cases) {
      const prepared = prepareRelayApplyPatchDispatch(
        request(item.patch, root),
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      let ran = false;
      let committed = false;
      const outcome = await executeRelayApplyPatchDispatch({
        preparation: prepared.preparation,
        sandboxEnvelope: sandboxEnvelope(root),
        resolveRuntime: runtime,
        trustedIdentity: {
          ownerId: "user",
          agentId: "agent-1",
          turnId: "turn-1",
        },
        reauthorize: async () => {},
        runProcess: async () => {
          ran = true;
          throw new Error("must not receive outside bytes");
        },
        commitApplied: async () => {
          committed = true;
          throw new Error("must not commit");
        },
      });
      expect(outcome.ok).toBe(false);
      expect(ran).toBe(false);
      expect(committed).toBe(false);
    }
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8"))
      .toBe("outside secret\n");
    expect(await fs.stat(path.join(outside, "new.txt")).catch(() => null))
      .toBeNull();
    expect(await fs.stat(path.join(outside, "moved.txt")).catch(() => null))
      .toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("unsupported NUL bytes fail before native execution without a leaked private tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-desktop-root-"));
  try {
    await fs.writeFile(path.join(root, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
    const patch =
      "*** Begin Patch\n*** Update File: binary.txt\n@@\n-a\n+b\n*** End Patch";
    const prepared = prepareRelayApplyPatchDispatch(request(patch, root));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const before = new Set(
      (await fs.readdir(os.tmpdir()))
        .filter((name) => name.startsWith("nautilo-apply-patch-workspace-")),
    );
    let ran = false;
    const outcome = await executeRelayApplyPatchDispatch({
      preparation: prepared.preparation,
      sandboxEnvelope: sandboxEnvelope(root),
      resolveRuntime: runtime,
      trustedIdentity: {
        ownerId: "user",
        agentId: "agent-1",
        turnId: "turn-1",
      },
      reauthorize: async () => {},
      runProcess: async () => {
        ran = true;
        throw new Error("must not run");
      },
      commitApplied: async () => {
        throw new Error("must not commit");
      },
    });
    const after = (await fs.readdir(os.tmpdir()))
      .filter((name) => name.startsWith("nautilo-apply-patch-workspace-"));
    expect(outcome).toMatchObject({
      ok: false,
      code: "unsupported_encoding_or_type",
    });
    expect(ran).toBe(false);
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("capability requires both a ready runtime and coordinator seam", () => {
  const unavailable = {
    ok: false,
    code: "runtime_unavailable",
    reason: "PLATFORM_UNSUPPORTED",
    message: "no",
  } as const;
  expect(applyPatchExecutionCapability(unavailable, true)).toEqual({});
  expect(applyPatchExecutionCapability(runtime(), false)).toEqual({});
  expect(applyPatchExecutionCapability(runtime(), true))
    .toEqual({ applyPatchExecution: true });
});

test("process-tree cleanup ignores ESRCH", () => {
  const esrch = Object.assign(new Error("already exited"), { code: "ESRCH" });
  expect(() => terminateDesktopApplyPatchProcess(
    { pid: 42, kill: () => true } as never,
    "darwin",
    () => {
      throw esrch;
    },
  )).not.toThrow();
});
