import {
  applyAnchoredTextPatch,
  documentVersionSchema,
  mergeTextHumanPriority,
  type DocumentCommitPlan,
  type DocumentIdentity,
  type DocumentMutationPath,
  type DocumentVersion,
  type HumanEditLeaseRecord,
} from "@nautilo/types";
import type { BackendCommitPlan, DocumentMutationBackendKind } from "./backend";
import type { DocumentMutationLane } from "./lane-cutover";

/** Read-only lease access. The coordinator never changes human presence. */
export interface HumanEditLeaseReader {
  getForIdentity(identity: DocumentIdentity): readonly HumanEditLeaseRecord[];
}

export type HumanEditAdmissionSnapshot = readonly {
  /** Identity is retained only to classify a final semantic drift accurately. */
  readonly identity: DocumentIdentity;
  readonly fingerprint: string;
}[];

export type HumanEditAdmissionOutcome<K extends DocumentMutationBackendKind> =
  | { readonly kind: "admitted"; readonly snapshot: HumanEditAdmissionSnapshot }
  | {
      readonly kind: "conflict";
      readonly code: "human_edit_conflict" | "reapply_required";
      readonly evidence: readonly [{ readonly path: DocumentMutationPath; readonly currentVersion: K extends "workspace" ? Extract<DocumentVersion, { identity: { kind: "workspace_artifact" } }> : Extract<DocumentVersion, { identity: { kind: "local_file" } }> }];
    }
  | {
      /** A lease on a read-only plan precondition has no legal mutation path
       * for public conflict evidence. Fail closed rather than misidentify a
       * write target. */
      readonly kind: "blocked";
      readonly code: "human_edit_precondition";
    };

export interface HumanEditAdmission {
  prepare<K extends DocumentMutationBackendKind>(input: {
    readonly plan: BackendCommitPlan<K>;
    readonly lane: DocumentMutationLane;
  }): HumanEditAdmissionOutcome<K>;
  verify<K extends DocumentMutationBackendKind>(input: {
    readonly plan: BackendCommitPlan<K>;
    readonly lane: DocumentMutationLane;
    readonly snapshot: HumanEditAdmissionSnapshot;
  }): HumanEditAdmissionOutcome<K>;
}

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
  const parsedLeft = documentVersionSchema.safeParse(left);
  const parsedRight = documentVersionSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) return false;
  const a = parsedLeft.data;
  const b = parsedRight.data;
  return (
    identityEquals(a.identity, b.identity) &&
    a.sha256 === b.sha256 &&
    a.backendVersion.kind === b.backendVersion.kind &&
    (a.backendVersion.kind === "artifact_revision"
      ? b.backendVersion.kind === "artifact_revision" &&
        a.backendVersion.revision === b.backendVersion.revision
      : b.backendVersion.kind === "local_sha" &&
        a.backendVersion.sha256 === b.backendVersion.sha256)
  );
}

function identityKey(identity: DocumentIdentity): string {
  return identity.kind === "workspace_artifact"
    ? `workspace:${identity.artifactId}\u0000${identity.logicalPath}`
    : `local:${identity.relayId}\u0000${identity.canonicalPath}`;
}

function planIdentities(plan: DocumentCommitPlan): readonly DocumentIdentity[] {
  const identities = plan.entries.flatMap((entry) => {
    switch (entry.kind) {
      case "create":
        return [entry.after.identity];
      case "update":
        return [entry.before.identity];
      case "move":
        return [
          entry.source.identity,
          ...(entry.destinationBefore === undefined
            ? []
            : [entry.destinationBefore.identity]),
          entry.after.identity,
        ];
      case "delete":
        return [entry.before.identity];
    }
  });
  return [...new Map([
    ...identities.map((identity) => [identityKey(identity), identity] as const),
    ...(plan.preconditions ?? []).map((item) => [identityKey(item.identity), item.identity] as const),
  ]).values()];
}

function pathAndVersionForIdentity<K extends DocumentMutationBackendKind>(
  plan: BackendCommitPlan<K>,
  identity: DocumentIdentity,
): { readonly path: DocumentMutationPath; readonly currentVersion: DocumentVersion } | undefined {
  for (const entry of plan.entries) {
    switch (entry.kind) {
      case "create":
        if (identityEquals(entry.after.identity, identity)) {
          // A human lease can only have been registered against an existing
          // version, so this is deliberately not evidence for a create.
          return undefined;
        }
        break;
      case "update":
        if (identityEquals(entry.before.identity, identity)) {
          return {
            path: { kind: "update", before: entry.before.identity, after: entry.after.identity },
            currentVersion: entry.before.expectedVersion,
          };
        }
        break;
      case "move":
        if (identityEquals(entry.source.identity, identity)) {
          return {
            path: entry.destinationBefore === undefined
              ? { kind: "move", overwrite: false, before: entry.source.identity, after: entry.after.identity }
              : { kind: "move", overwrite: true, before: entry.source.identity, destinationBefore: entry.destinationBefore.identity, after: entry.after.identity },
            currentVersion: entry.source.expectedVersion,
          };
        }
        if (
          entry.destinationBefore !== undefined &&
          identityEquals(entry.destinationBefore.identity, identity)
        ) {
          return {
            path: { kind: "move", overwrite: true, before: entry.source.identity, destinationBefore: entry.destinationBefore.identity, after: entry.after.identity },
            currentVersion: entry.destinationBefore.expectedVersion,
          };
        }
        break;
      case "delete":
        if (identityEquals(entry.before.identity, identity)) {
          return {
            path: { kind: "delete", before: entry.before.identity },
            currentVersion: entry.before.expectedVersion,
          };
        }
        break;
    }
  }
  return undefined;
}

function updateForIdentity<K extends DocumentMutationBackendKind>(
  plan: BackendCommitPlan<K>,
  identity: DocumentIdentity,
) {
  return plan.entries.find(
    (entry): entry is Extract<(typeof plan.entries)[number], { kind: "update" }> =>
      entry.kind === "update" && identityEquals(entry.before.identity, identity),
  );
}

function semanticFingerprint(record: HumanEditLeaseRecord): string {
  const { lease } = record;
  // Deliberately excludes expiry: renewal alone must not reject a commit.
  return JSON.stringify({
    leaseId: lease.leaseId,
    generation: lease.generation,
    state: lease.state,
    baseVersion: lease.baseVersion,
    ...(lease.draftPatch === undefined ? {} : { draftPatch: lease.draftPatch }),
  });
}

function applicableAgentLane(
  plan: DocumentCommitPlan,
  lane: DocumentMutationLane,
): boolean {
  return plan.actor.kind === "agent" &&
    (lane === "apply_patch" || lane === "file_tool" || lane === "officecli");
}

function conflict<K extends DocumentMutationBackendKind>(
  code: "human_edit_conflict" | "reapply_required",
  plan: BackendCommitPlan<K>,
  identity: DocumentIdentity,
): Extract<HumanEditAdmissionOutcome<K>, { readonly kind: "conflict" }> {
  const evidence = pathAndVersionForIdentity(plan, identity);
  // Leases are attached only to existing documents. A mismatch here means a
  // plan no longer describes a safe target and must be regenerated.
  if (!evidence) {
    throw new Error("Human-edit lease has no correlated mutable plan identity");
  }
  return {
    kind: "conflict",
    code,
    evidence: [evidence as Extract<HumanEditAdmissionOutcome<K>, { readonly kind: "conflict" }>["evidence"][number]],
  };
}

function rejectedForIdentity<K extends DocumentMutationBackendKind>(
  code: "human_edit_conflict" | "reapply_required",
  plan: BackendCommitPlan<K>,
  identity: DocumentIdentity,
): HumanEditAdmissionOutcome<K> {
  return pathAndVersionForIdentity(plan, identity)
    ? conflict(code, plan, identity)
    : { kind: "blocked", code: "human_edit_precondition" };
}

function admit<K extends DocumentMutationBackendKind>(input: {
  readonly reader: HumanEditLeaseReader;
  readonly plan: BackendCommitPlan<K>;
  readonly lane: DocumentMutationLane;
}): HumanEditAdmissionOutcome<K> {
  const { plan, lane, reader } = input;
  if (!applicableAgentLane(plan, lane)) return { kind: "admitted", snapshot: [] };

  const records = planIdentities(plan)
    .flatMap((identity) => reader.getForIdentity(identity))
    .sort((a, b) => a.lease.leaseId.localeCompare(b.lease.leaseId));
  const snapshot = records.map((record) => ({
    identity: record.lease.identity,
    fingerprint: semanticFingerprint(record),
  }));

  for (const record of records) {
    const lease = record.lease;
    // OfficeCLI is an opaque/binary producer. Its active-editor lockout is
    // intentionally stricter than text apply_patch: no lease state can be
    // merged or silently bypassed, including a currently clean editor.
    if (lane === "officecli") {
      return rejectedForIdentity("human_edit_conflict", plan, lease.identity);
    }
    if (lease.state === "clean") continue;
    if (lease.state === "conflict") return rejectedForIdentity("human_edit_conflict", plan, lease.identity);
    if (lease.state === "saving") return rejectedForIdentity("reapply_required", plan, lease.identity);

    const update = updateForIdentity(plan, lease.identity);
    if ((lane !== "apply_patch" && lane !== "file_tool") || update === undefined) {
      return rejectedForIdentity("reapply_required", plan, lease.identity);
    }
    if (lease.draftPatch === undefined || !versionEquals(lease.baseVersion, update.before.expectedVersion)) {
      return rejectedForIdentity("reapply_required", plan, lease.identity);
    }

    let base: string;
    let humanDraft: string;
    let agentPostimage: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      base = decoder.decode(update.before.bytes);
      const applied = applyAnchoredTextPatch(base, lease.draftPatch);
      if (!applied.ok) return rejectedForIdentity("reapply_required", plan, lease.identity);
      humanDraft = applied.text;
      agentPostimage = decoder.decode(update.after.bytes);
    } catch {
      return rejectedForIdentity("reapply_required", plan, lease.identity);
    }
    if (!mergeTextHumanPriority({ base, humanDraft, agentPostimage }).ok) {
      return rejectedForIdentity("human_edit_conflict", plan, lease.identity);
    }
  }
  return { kind: "admitted", snapshot };
}

/**
 * Human-priority admission around agent writes. It validates only while the
 * coordinator's document locks are held; it never writes leases or rewrites
 * candidate agent bytes.
 */
export function createHumanEditAdmission(reader: HumanEditLeaseReader): HumanEditAdmission {
  return {
    prepare: (input) => admit({ reader, ...input }),
    verify: (input) => {
      const current = admit({ reader, plan: input.plan, lane: input.lane });
      if (current.kind !== "admitted") return current;
      return current.snapshot.length === input.snapshot.length &&
        current.snapshot.every(
          (value, index) =>
            identityEquals(value.identity, input.snapshot[index]!.identity) &&
            value.fingerprint === input.snapshot[index]!.fingerprint,
        )
        ? current
        : (() => {
            const changed = current.snapshot.find(
              (item, index) =>
                !identityEquals(item.identity, input.snapshot[index]?.identity ?? item.identity) ||
                item.fingerprint !== input.snapshot[index]?.fingerprint,
            ) ?? input.snapshot.find(
              (item, index) =>
                !identityEquals(item.identity, current.snapshot[index]?.identity ?? item.identity) ||
                item.fingerprint !== current.snapshot[index]?.fingerprint,
            );
            if (!changed) throw new Error("Human-edit fingerprint drift lost its identity");
            return rejectedForIdentity("reapply_required", input.plan, changed.identity);
          })();
    },
  };
}
