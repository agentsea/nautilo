import {
  documentVersionSchema,
  mergeTextHumanPriority,
  type DocumentIdentity,
  type DocumentVersion,
} from "@nautilo/types";
import type {
  BackendCommitPlan,
  BackendConflictEvidence,
  BackendConflictSnapshot,
  DocumentMutationBackendKind,
} from "./backend";
import type { HashBytes } from "./plan-validation";

export type StaleTextPlanRebaseOutcome<K extends DocumentMutationBackendKind> =
  | {
      readonly kind: "rebased";
      readonly plan: BackendCommitPlan<K>;
    }
  | {
      readonly kind: "conflict";
      readonly code: "human_edit_conflict" | "reapply_required";
    };

function identityEquals(left: DocumentIdentity, right: DocumentIdentity): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace_artifact"
    ? right.kind === "workspace_artifact" &&
        left.artifactId === right.artifactId &&
        left.logicalPath === right.logicalPath
    : right.kind === "local_file" &&
        left.relayId === right.relayId &&
        left.canonicalPath === right.canonicalPath;
}

function versionEquals(left: DocumentVersion, right: DocumentVersion): boolean {
  const a = documentVersionSchema.safeParse(left);
  const b = documentVersionSchema.safeParse(right);
  if (!a.success || !b.success) return false;
  return (
    identityEquals(a.data.identity, b.data.identity) &&
    a.data.sha256 === b.data.sha256 &&
    a.data.backendVersion.kind === b.data.backendVersion.kind &&
    (a.data.backendVersion.kind === "artifact_revision"
      ? b.data.backendVersion.kind === "artifact_revision" &&
        a.data.backendVersion.revision === b.data.backendVersion.revision
      : b.data.backendVersion.kind === "local_sha" &&
        a.data.backendVersion.sha256 === b.data.backendVersion.sha256)
  );
}

function snapshotForEvidence<K extends DocumentMutationBackendKind>(
  evidence: BackendConflictEvidence<K>,
  snapshots: readonly BackendConflictSnapshot<K>[],
): BackendConflictSnapshot<K> | undefined {
  return snapshots.find(
    (snapshot) =>
      identityEquals(snapshot.identity, evidence.currentVersion.identity) &&
      versionEquals(snapshot.currentVersion, evidence.currentVersion),
  );
}

/**
 * Rebuilds only stale update entries from exact backend conflict evidence.
 *
 * Structural mutations, preconditions, binary/non-UTF-8 bytes, incomplete
 * evidence, and overlaps fail closed. The returned plan retains the original
 * operation/actor/turn identity and entry order.
 */
export async function rebaseStaleTextPlan<K extends DocumentMutationBackendKind>(
  input: {
    readonly plan: BackendCommitPlan<K>;
    readonly evidence: readonly BackendConflictEvidence<K>[];
    readonly currentSnapshots:
      | readonly BackendConflictSnapshot<K>[]
      | undefined;
    readonly hashBytes: HashBytes;
  },
): Promise<StaleTextPlanRebaseOutcome<K>> {
  const { plan, evidence, currentSnapshots, hashBytes } = input;
  if (
    plan.actor.kind !== "agent" ||
    evidence.length === 0 ||
    currentSnapshots === undefined ||
    currentSnapshots.length !== evidence.length
  ) {
    return { kind: "conflict", code: "reapply_required" };
  }

  const replacements = new Map<number, BackendCommitPlan<K>["entries"][number]>();
  for (const item of evidence) {
    if (item.path.kind !== "update") {
      return { kind: "conflict", code: "reapply_required" };
    }
    const path = item.path;
    const entryIndex = plan.entries.findIndex(
      (entry) =>
        entry.kind === "update" &&
        identityEquals(entry.before.identity, path.before) &&
        identityEquals(entry.after.identity, path.after),
    );
    if (entryIndex < 0 || replacements.has(entryIndex)) {
      return { kind: "conflict", code: "reapply_required" };
    }
    const entry = plan.entries[entryIndex]!;
    if (entry.kind !== "update") {
      return { kind: "conflict", code: "reapply_required" };
    }
    const current = snapshotForEvidence(item, currentSnapshots);
    if (
      current === undefined ||
      !identityEquals(current.identity, entry.before.identity) ||
      (await hashBytes(current.bytes)) !== current.currentVersion.sha256
    ) {
      return { kind: "conflict", code: "reapply_required" };
    }

    let base: string;
    let humanDraft: string;
    let agentPostimage: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      base = decoder.decode(entry.before.bytes);
      humanDraft = decoder.decode(current.bytes);
      agentPostimage = decoder.decode(entry.after.bytes);
    } catch {
      return { kind: "conflict", code: "reapply_required" };
    }
    const merged = mergeTextHumanPriority({
      base,
      humanDraft,
      agentPostimage,
    });
    if (!merged.ok) {
      // Backend drift proves changed bytes, not an active human lease. Preserve
      // that distinction: lease-proven overlap is human_edit_conflict; stale
      // authoritative overlap requires a reread/reapply.
      return { kind: "conflict", code: "reapply_required" };
    }
    const bytes = new TextEncoder().encode(merged.text);
    replacements.set(entryIndex, {
      kind: "update",
      before: {
        identity: entry.before.identity,
        expectedVersion: current.currentVersion,
        bytes: current.bytes,
      },
      after: {
        identity: entry.after.identity,
        sha256: await hashBytes(bytes),
        bytes,
      },
    } as BackendCommitPlan<K>["entries"][number]);
  }

  return {
    kind: "rebased",
    plan: {
      ...plan,
      entries: plan.entries.map(
        (entry, index) => replacements.get(index) ?? entry,
      ),
    },
  };
}
