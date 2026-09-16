/**
 * D448 Workspace apply_patch native-runtime adapter.
 *
 * This module owns only invocation-private filesystem materialization and the
 * packaged native runner. Authoritative Workspace reads and the single atomic
 * coordinator commit are server-owned injected ports; this package never
 * writes artifact storage, rows, history, or events directly.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLogicalPath } from "../file/artifact-store";
import {
  runApplyPatchProcess,
  type ApplyPatchRuntimeIdentity,
  type ApplyPatchSandboxAdapter,
} from "./process-wrapper";
import type {
  ApplyPatchWorkspaceCommitPort,
  ApplyPatchWorkspaceRunner,
} from "./workspace-executor";
import type {
  ApplyPatchWorkspaceArtifactReadPort,
  ApplyPatchWorkspaceTreePort,
} from "./workspace-staging";

/** Private paths are intentionally opaque to callers and result formatting. */
export type WorkspaceApplyPatchPrivateTree = { readonly root: string };

export type WorkspaceApplyPatchProductionPorts = {
  readonly artifacts: ApplyPatchWorkspaceArtifactReadPort;
  readonly commit: ApplyPatchWorkspaceCommitPort;
};

export type WorkspaceApplyPatchProductionAdapter =
  WorkspaceApplyPatchProductionPorts & {
    readonly tree: ApplyPatchWorkspaceTreePort<WorkspaceApplyPatchPrivateTree>;
    readonly runner: ApplyPatchWorkspaceRunner<WorkspaceApplyPatchPrivateTree>;
  };

function privatePath(root: string, logicalPath: string): string {
  const checked = validateLogicalPath(logicalPath);
  if (!checked.ok) throw new Error("invalid logical path for private tree");
  const candidate = path.resolve(root, ...checked.path.split("/"));
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("private tree path escaped root");
  }
  return candidate;
}

export function createWorkspaceApplyPatchPrivateTreePort():
ApplyPatchWorkspaceTreePort<WorkspaceApplyPatchPrivateTree> {
  return {
    create: async () => ({
      root: await fsp.mkdtemp(
        path.join(os.tmpdir(), "nautilo-apply-patch-workspace-"),
      ),
    }),
    writeFile: async (tree, logicalPath, bytes) => {
      const target = privatePath(tree.root, logicalPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
    },
    readFile: async (tree, logicalPath) => {
      try {
        return new Uint8Array(
          await fsp.readFile(privatePath(tree.root, logicalPath)),
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) return null;
        throw error;
      }
    },
    cleanup: async (tree) => {
      await fsp.rm(tree.root, { recursive: true, force: true });
    },
  };
}

export function createWorkspaceApplyPatchProductionAdapter(input: {
  readonly ports: WorkspaceApplyPatchProductionPorts;
  readonly binaryPath: string;
  readonly runtime: ApplyPatchRuntimeIdentity;
  readonly sandbox: ApplyPatchSandboxAdapter<unknown>;
  readonly signal?: AbortSignal;
}): WorkspaceApplyPatchProductionAdapter {
  const tree = createWorkspaceApplyPatchPrivateTreePort();
  return {
    ...input.ports,
    tree,
    runner: {
      run: async ({ tree: privateTree, patch }) => runApplyPatchProcess({
        root: privateTree.root,
        patch,
        binaryPath: input.binaryPath,
        expectedRuntime: input.runtime,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        sandbox: input.sandbox,
      }),
    },
  };
}
