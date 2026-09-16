/** D448 — render committed Workspace observations with the shared diff library. */
import { createTwoFilesPatch } from "diff";
import type { WorkspaceApplyPatchOperationReconciliation } from "./workspace-executor";

function text(bytes: Uint8Array | null): string {
  return bytes === null ? "" : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function beforeLabel(path: string, before: Uint8Array | null): string {
  return before === null ? "/dev/null" : `a/${path}`;
}

function afterLabel(path: string, after: Uint8Array | null): string {
  return after === null ? "/dev/null" : `b/${path}`;
}

function renderChange(input: Readonly<{
  beforePath: string;
  before: Uint8Array | null;
  afterPath: string;
  after: Uint8Array | null;
}>): string {
  return createTwoFilesPatch(
    beforeLabel(input.beforePath, input.before),
    afterLabel(input.afterPath, input.after),
    text(input.before),
    text(input.after),
  );
}

/**
 * Emit only facts that the authoritative commit port reports committed.
 * A move has two observable file-state transitions: source removal and
 * destination creation/replacement. Keeping them separate preserves an
 * overwritten destination's actual before bytes rather than inventing a
 * rename-shaped diff that hides that replacement.
 */
export function buildWorkspaceUnifiedDiff(
  operations: readonly WorkspaceApplyPatchOperationReconciliation[],
): string {
  return operations.flatMap((operation) => {
    if (operation.operation === "move") {
      return [
        renderChange({
          beforePath: operation.source.path,
          before: operation.source.before?.bytes ?? null,
          afterPath: operation.source.path,
          after: operation.source.after,
        }),
        renderChange({
          beforePath: operation.destination.path,
          before: operation.destination.before?.bytes ?? null,
          afterPath: operation.destination.path,
          after: operation.destination.after,
        }),
      ];
    }
    return [renderChange({
      beforePath: operation.destination.path,
      before: operation.destination.before?.bytes ?? null,
      afterPath: operation.destination.path,
      after: operation.destination.after,
    })];
  }).join("");
}
