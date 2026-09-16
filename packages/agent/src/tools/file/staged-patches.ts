/**
 * D087 Phase 1 — patch shape builders for immediate-apply file edits.
 *
 * `constructPatch` builds the in-memory patch object used by apply-core
 * guards, diffs, metadata, and backup recording. No store — patches are
 * ephemeral and applied in the same tool invocation.
 */

import * as crypto from "node:crypto";
import type { ZoneContext } from "./zones";

export interface StagedPatch {
  patchId: string;
  turnId: string;
  ownerId: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  zoneCtx: ZoneContext;
  originalBytes: Buffer;
  originalSha256: string;
  newBytes: Buffer;
  anchoredEdit?: AnchoredEdit;
  unifiedDiff: string;
  stats: { additions: number; deletions: number };
  createdAt: number;
  metadata: {
    command: string;
    args: Record<string, unknown>;
    [key: string]: unknown;
  };
  structural?: StructuralOp;
}

export interface AnchoredEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  scope?: { from: number; to: number };
}

export type StructuralOp =
  | {
      kind: "delete";
      recursive?: boolean;
    }
  | {
      kind: "move";
      sourcePath: string;
      sourceSha256: string;
    }
  | {
      kind: "copy";
      sourcePath: string;
    };

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function newPatchId(turnId: string): string {
  return `${turnId}:${crypto.randomBytes(4).toString("hex")}`;
}

export function countDiffStats(unifiedDiff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function constructPatch(input: {
  turnId: string;
  ownerId: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  zoneCtx: ZoneContext;
  originalBytes: Buffer;
  originalSha256: string;
  newBytes: Buffer;
  anchoredEdit?: AnchoredEdit;
  unifiedDiff: string;
  metadata: { command: string; args: Record<string, unknown>; [key: string]: unknown };
  structural?: StructuralOp;
}): StagedPatch {
  const patchId = newPatchId(input.turnId);
  const stats = countDiffStats(input.unifiedDiff);
  return {
    patchId,
    turnId: input.turnId,
    ownerId: input.ownerId,
    path: input.path,
    zone: input.zone,
    zoneCtx: {
      workspaceRoot: input.zoneCtx.workspaceRoot,
      currentFolder: input.zoneCtx.currentFolder,
    },
    originalBytes: input.originalBytes,
    originalSha256: input.originalSha256,
    newBytes: input.newBytes,
    ...(input.anchoredEdit ? { anchoredEdit: input.anchoredEdit } : {}),
    unifiedDiff: input.unifiedDiff,
    stats,
    createdAt: Date.now(),
    metadata: input.metadata,
    ...(input.structural ? { structural: input.structural } : {}),
  };
}
