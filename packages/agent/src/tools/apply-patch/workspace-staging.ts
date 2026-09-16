/** D448 — injected private-tree materialization for workspace artifacts. */
import {
  type ApplyPatchError,
  type ApplyPatchPreflightSummary,
  validateApplyPatchPreflight,
} from "./contract";
import { classifyApplyPatchText } from "./text-classifier";

export type WorkspaceArtifactSnapshot = {
  readonly logicalPath: string;
  readonly artifactId: string;
  readonly revision: number | null;
  readonly bytes: Uint8Array;
};

/** This is the authorization boundary; it accepts logical paths only. */
export interface ApplyPatchWorkspaceArtifactReadPort {
  readAuthorized(path: string): Promise<WorkspaceArtifactSnapshot | null>;
}

/** The adapter owns physical temp paths, which are never part of public data. */
export interface ApplyPatchWorkspaceTreePort<TreeHandle> {
  create(): Promise<TreeHandle>;
  writeFile(tree: TreeHandle, logicalPath: string, bytes: Uint8Array): Promise<void>;
  readFile(tree: TreeHandle, logicalPath: string): Promise<Uint8Array | null>;
  cleanup(tree: TreeHandle): Promise<void>;
}

export type WorkspaceApplyPatchStage<TreeHandle> = {
  readonly tree: TreeHandle;
  readonly preflight: ApplyPatchPreflightSummary;
  readonly paths: readonly { readonly path: string; readonly before: WorkspaceArtifactSnapshot | null }[];
};

export type WorkspaceStageResult<TreeHandle> =
  | { readonly ok: true; readonly stage: WorkspaceApplyPatchStage<TreeHandle> }
  | { readonly ok: false; readonly error: ApplyPatchError };

function fail(code: ApplyPatchError["code"], message: string, path?: string): WorkspaceStageResult<never> {
  return { ok: false, error: { code, message, ...(path === undefined ? {} : { path }), retryable: false } };
}

function paths(summary: ApplyPatchPreflightSummary): string[] {
  return summary.operations.flatMap((operation) =>
    operation.operation === "move" ? [operation.fromPath, operation.path] : [operation.path],
  );
}

function requiredExisting(summary: ApplyPatchPreflightSummary): ReadonlySet<string> {
  return new Set(summary.operations.flatMap((operation) =>
    operation.operation === "add" ? [] : operation.operation === "move" ? [operation.fromPath] : [operation.path],
  ));
}

/**
 * Materialize only namespace-authorized logical bytes. Existing destination
 * bytes are included as well because native add/move may overwrite them.
 */
export async function stageWorkspaceApplyPatch<TreeHandle>(input: {
  readonly preflight: ApplyPatchPreflightSummary;
  readonly artifacts: ApplyPatchWorkspaceArtifactReadPort;
  readonly tree: ApplyPatchWorkspaceTreePort<TreeHandle>;
}): Promise<WorkspaceStageResult<TreeHandle>> {
  const candidatePaths = paths(input.preflight);
  const required = requiredExisting(input.preflight);
  let privateTree: TreeHandle | undefined;
  let handedOff = false;
  try {
    const before = new Map<string, WorkspaceArtifactSnapshot | null>();
    for (const path of candidatePaths) {
      const snapshot = await input.artifacts.readAuthorized(path);
      if (snapshot === null) {
        if (required.has(path)) return fail("stale_context", "A required workspace artifact no longer exists.", path);
      } else {
        if (snapshot.logicalPath !== path) {
          return fail("runtime_corrupt", "Workspace artifact port returned a mismatched logical path.", path);
        }
        const classified = classifyApplyPatchText(snapshot.bytes);
        if (!classified.supported) return { ok: false, error: { ...classified.error, path } };
      }
      before.set(path, snapshot);
    }

    const validated = validateApplyPatchPreflight(input.preflight);
    if (!validated.ok) return validated;

    privateTree = await input.tree.create();
    for (const path of candidatePaths) {
      const snapshot = before.get(path)!;
      if (snapshot !== null) await input.tree.writeFile(privateTree, path, snapshot.bytes);
    }
    handedOff = true;
    return {
      ok: true,
      stage: {
        tree: privateTree,
        preflight: validated.summary,
        paths: candidatePaths.map((path) => ({ path, before: before.get(path)! })),
      },
    };
  } catch {
    return fail("runtime_unavailable", "Workspace staging is unavailable.");
  } finally {
    if (privateTree !== undefined && !handedOff) {
      try {
        await input.tree.cleanup(privateTree);
      } catch {
        // Tree was never exposed, and the original staging failure remains fail-closed.
      }
    }
  }
}

export async function cleanupWorkspaceApplyPatchStage<TreeHandle>(
  stage: WorkspaceApplyPatchStage<TreeHandle>,
  tree: ApplyPatchWorkspaceTreePort<TreeHandle>,
): Promise<void> {
  await tree.cleanup(stage.tree);
}
