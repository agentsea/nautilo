/**
 * D448 Phase 9 — Desktop coordinator backend for atomic local-file plans.
 *
 * Plans are never filesystem authority. The configured relay identity,
 * GuardedFileAdapter, actor generation, exact preimages, and all canonical
 * paths are re-checked before the first authoritative write.
 */

import { randomUUID } from "node:crypto";
import {
  type AtomicDocumentMutationEventBatch,
  type BackendCommitOutcome,
  type BackendCommitPlan,
  type BackendCommitReceipt,
  type BackendCompensationOutcome,
  type BackendPrepareOutcome,
  type CommitPreparedInput,
  type CompensateCommitInput,
  type DesktopFileMutationBackend as DesktopFileMutationBackendContract,
  validateAtomicDocumentMutationEventBatch,
} from "@nautilo/document-mutations";
import {
  documentCommitPlanSchema,
  type DocumentMutationActor,
  type DocumentMutationPath,
  type LocalDocumentIdentity,
  type LocalDocumentVersion,
} from "@nautilo/types";

import type { GuardedFileAdapter } from "../local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../local-file-history/durable-mutations.ts";
import { snapshotFromBytes } from "../local-file-history/hash.ts";
import { withCanonicalPathLocks } from "../local-file-history/mutation-lock.ts";
import type {
  BeginLocalMutationIntentInput,
  FileStateSnapshot,
  LocalMutationIntentV2,
  LocalMutationOutboxBatch,
  LocalMutationProducerMetadata,
} from "../local-file-history/types.ts";

type ByteSnapshot = Extract<FileStateSnapshot, { kind: "bytes" }>;
type DurableReplay = {
  readonly intent: LocalMutationIntentV2;
  readonly outbox: LocalMutationOutboxBatch;
};
type PreparedEntry = {
  readonly kind: "create" | "update" | "move" | "delete";
  readonly canonicalPath: string;
  readonly sourceCanonicalPath?: string;
  readonly locations: readonly {
    readonly canonicalPath: string;
    readonly before: FileStateSnapshot;
    readonly after: FileStateSnapshot;
  }[];
};

export type PreparedDesktopFileMutation = {
  readonly kind: "candidate" | "replay";
  readonly operationId: string;
  readonly relayId: string;
  readonly canonicalPaths: readonly string[];
  readonly entries: readonly PreparedEntry[];
  readonly replay?: DurableReplay;
};

export type DesktopFileMutationBackendDependencies = {
  readonly getTrustedRelayId: () => string | Promise<string>;
  readonly assertTrustedActor: (
    actor: DocumentMutationActor,
    operationId: string,
  ) => void | Promise<void>;
  readonly fileAdapter: GuardedFileAdapter;
  readonly journal: LocalDurableMutationJournal;
  readonly producerMetadata: (
    plan: BackendCommitPlan<"desktop">,
  ) => LocalMutationProducerMetadata;
  readonly newOpaqueId?: () => string;
};

class PublishConflictError extends Error {
  constructor(
    readonly entryIndex: number,
    readonly canonicalPath: string,
    readonly appliedCount: number,
  ) {
    super("local file changed at the authoritative publish boundary");
    this.name = "PublishConflictError";
  }
}

function exactValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactValueEquals(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) =>
      key === bKeys[index] && exactValueEquals(a[key], b[key])
    );
}

function actorEquals(left: DocumentMutationActor, right: DocumentMutationActor): boolean {
  return left.kind === right.kind &&
    (left.kind === "human"
      ? right.kind === "human" && left.humanId === right.humanId
      : right.kind === "agent" && left.agentId === right.agentId);
}

function bytesSnapshot(bytes: Uint8Array): ByteSnapshot {
  const snapshot = snapshotFromBytes(bytes);
  if (snapshot.kind !== "bytes") throw new Error("invalid byte snapshot");
  return snapshot;
}

function sameSnapshot(left: FileStateSnapshot, right: FileStateSnapshot): boolean {
  return left.kind === right.kind &&
    (left.kind === "missing" ||
      (right.kind === "bytes" &&
        left.sha256 === right.sha256 && left.size === right.size));
}

function sameStateMetadata(
  left: { kind: "missing" } | { kind: "bytes"; sha256: string; size: number },
  right: { kind: "missing" } | { kind: "bytes"; sha256: string; size: number },
): boolean {
  return left.kind === right.kind &&
    (left.kind === "missing" ||
      (right.kind === "bytes" &&
        left.sha256 === right.sha256 && left.size === right.size));
}

function version(
  identity: LocalDocumentIdentity,
  sha256: string,
): LocalDocumentVersion {
  return {
    identity,
    backendVersion: { kind: "local_sha", sha256 },
    sha256,
  };
}

function identityAt(relayId: string, canonicalPath: string): LocalDocumentIdentity {
  return { kind: "local_file", relayId, canonicalPath };
}

function failed(
  message: string,
  diagnosticCode: string,
  code: "backend_failure" | "inconsistent_outcome" = "backend_failure",
): Extract<
  BackendCommitOutcome<"desktop", BackendCommitReceipt<"desktop">>,
  { kind: "failed" }
> {
  return code === "inconsistent_outcome"
    ? {
        kind: "failed",
        code,
        requiresCompensation: true,
        diagnostics: [{ code: diagnosticCode, message }],
      }
    : {
        kind: "failed",
        code,
        requiresCompensation: false,
        diagnostics: [{ code: diagnosticCode, message }],
      };
}

function entryIdentities(
  entry: BackendCommitPlan<"desktop">["entries"][number],
): readonly LocalDocumentIdentity[] {
  switch (entry.kind) {
    case "create": return [entry.after.identity];
    case "update": return [entry.before.identity, entry.after.identity];
    case "move":
      return [
        entry.source.identity,
        ...(entry.destinationBefore ? [entry.destinationBefore.identity] : []),
        entry.after.identity,
      ];
    case "delete": return [entry.before.identity];
  }
}

function expectedSnapshot(
  bytes: Uint8Array,
  expectedSha: string,
): ByteSnapshot | null {
  const snapshot = bytesSnapshot(bytes);
  return snapshot.sha256 === expectedSha ? snapshot : null;
}

function invalidPlan(plan: BackendCommitPlan<"desktop">): string | null {
  if (!documentCommitPlanSchema.safeParse(plan).success) {
    return "plan violates the shared mutation contract";
  }
  for (const precondition of plan.preconditions ?? []) {
    if (
      precondition.identity.kind !== "local_file" ||
      precondition.expectedVersion.identity.kind !== "local_file" ||
      precondition.expectedVersion.backendVersion.kind !== "local_sha" ||
      !expectedSnapshot(precondition.bytes, precondition.expectedVersion.sha256) ||
      precondition.expectedVersion.backendVersion.sha256 !==
        precondition.expectedVersion.sha256
    ) return "Desktop precondition bytes do not match their declared SHA-256";
  }
  for (const entry of plan.entries) {
    for (const identity of entryIdentities(entry)) {
      if (identity.kind !== "local_file") {
        return "Desktop plan contains a non-local identity";
      }
    }
    switch (entry.kind) {
      case "create":
        if (bytesSnapshot(entry.after.bytes).sha256 !== entry.after.sha256) {
          return "Desktop create bytes do not match their declared SHA-256";
        }
        break;
      case "update":
        if (
          !expectedSnapshot(entry.before.bytes, entry.before.expectedVersion.sha256) ||
          entry.before.expectedVersion.backendVersion.sha256 !==
            entry.before.expectedVersion.sha256 ||
          bytesSnapshot(entry.after.bytes).sha256 !== entry.after.sha256
        ) return "Desktop update bytes do not match their declared SHA-256";
        break;
      case "move":
        if (
          !expectedSnapshot(entry.source.bytes, entry.source.expectedVersion.sha256) ||
          entry.source.expectedVersion.backendVersion.sha256 !==
            entry.source.expectedVersion.sha256 ||
          (entry.destinationBefore !== undefined &&
            (!expectedSnapshot(
              entry.destinationBefore.bytes,
              entry.destinationBefore.expectedVersion.sha256,
            ) ||
              entry.destinationBefore.expectedVersion.backendVersion.sha256 !==
                entry.destinationBefore.expectedVersion.sha256)) ||
          bytesSnapshot(entry.after.bytes).sha256 !== entry.after.sha256
        ) return "Desktop move bytes do not match their declared SHA-256";
        break;
      case "delete":
        if (
          !expectedSnapshot(entry.before.bytes, entry.before.expectedVersion.sha256) ||
          entry.before.expectedVersion.backendVersion.sha256 !==
            entry.before.expectedVersion.sha256
        ) return "Desktop delete bytes do not match their declared SHA-256";
        break;
    }
  }
  return null;
}

function preparedEntries(plan: BackendCommitPlan<"desktop">): readonly PreparedEntry[] {
  return plan.entries.map((entry): PreparedEntry => {
    switch (entry.kind) {
      case "create":
        return {
          kind: "create",
          canonicalPath: entry.after.identity.canonicalPath,
          locations: [{
            canonicalPath: entry.after.identity.canonicalPath,
            before: { kind: "missing" },
            after: bytesSnapshot(entry.after.bytes),
          }],
        };
      case "update":
        return {
          kind: "update",
          canonicalPath: entry.before.identity.canonicalPath,
          locations: [{
            canonicalPath: entry.before.identity.canonicalPath,
            before: bytesSnapshot(entry.before.bytes),
            after: bytesSnapshot(entry.after.bytes),
          }],
        };
      case "move":
        return {
          kind: "move",
          canonicalPath: entry.after.identity.canonicalPath,
          sourceCanonicalPath: entry.source.identity.canonicalPath,
          locations: [
            {
              canonicalPath: entry.source.identity.canonicalPath,
              before: bytesSnapshot(entry.source.bytes),
              after: { kind: "missing" },
            },
            {
              canonicalPath: entry.after.identity.canonicalPath,
              before: entry.destinationBefore
                ? bytesSnapshot(entry.destinationBefore.bytes)
                : { kind: "missing" },
              after: bytesSnapshot(entry.after.bytes),
            },
          ],
        };
      case "delete":
        return {
          kind: "delete",
          canonicalPath: entry.before.identity.canonicalPath,
          locations: [{
            canonicalPath: entry.before.identity.canonicalPath,
            before: bytesSnapshot(entry.before.bytes),
            after: { kind: "missing" },
          }],
        };
    }
  });
}

function canonicalPaths(
  plan: BackendCommitPlan<"desktop">,
  entries: readonly PreparedEntry[],
): readonly string[] {
  const paths = entries.flatMap((entry) => entry.locations.map((location) => location.canonicalPath));
  for (const precondition of plan.preconditions ?? []) {
    if (precondition.identity.kind === "local_file") {
      paths.push(precondition.identity.canonicalPath);
    }
  }
  return [...new Set(
    paths,
  )].sort();
}

function samePreparedEntries(
  left: readonly PreparedEntry[],
  right: readonly PreparedEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined &&
      entry.kind === other.kind &&
      entry.canonicalPath === other.canonicalPath &&
      entry.sourceCanonicalPath === other.sourceCanonicalPath &&
      entry.locations.length === other.locations.length &&
      entry.locations.every((location, locationIndex) => {
        const otherLocation = other.locations[locationIndex];
        return otherLocation !== undefined &&
          location.canonicalPath === otherLocation.canonicalPath &&
          sameSnapshot(location.before, otherLocation.before) &&
          sameSnapshot(location.after, otherLocation.after);
      });
  });
}

function receiptFromEvidence(
  plan: BackendCommitPlan<"desktop">,
  revisionGroupId: string,
  evidence: readonly {
    readonly revisionIds: readonly string[];
    readonly undoRecordIds: readonly string[];
  }[],
): BackendCommitReceipt<"desktop"> {
  return {
    backend: "desktop",
    operationId: plan.operationId,
    revisionGroupId,
    entries: plan.entries.map((entry, entryIndex) => {
      const ids = evidence[entryIndex];
      if (!ids || ids.revisionIds.length === 0 || ids.undoRecordIds.length === 0) {
        throw new Error("durable evidence is missing revision IDs");
      }
      const common = {
        entryIndex,
        revisionIds: ids.revisionIds as [string, ...string[]],
        undoRecordIds: ids.undoRecordIds as [string, ...string[]],
      };
      switch (entry.kind) {
        case "create":
          return {
            ...common,
            kind: "create" as const,
            after: version(entry.after.identity, entry.after.sha256),
          };
        case "update":
          return {
            ...common,
            kind: "update" as const,
            before: entry.before.expectedVersion,
            after: version(entry.after.identity, entry.after.sha256),
          };
        case "move":
          return {
            ...common,
            kind: "move" as const,
            before: entry.source.expectedVersion,
            ...(entry.destinationBefore
              ? { destinationBefore: entry.destinationBefore.expectedVersion }
              : {}),
            after: version(entry.after.identity, entry.after.sha256),
          };
        case "delete":
          return {
            ...common,
            kind: "delete" as const,
            before: entry.before.expectedVersion,
          };
      }
    }),
  };
}

function receiptFromReplay(
  plan: BackendCommitPlan<"desktop">,
  replay: DurableReplay,
): BackendCommitReceipt<"desktop"> {
  return receiptFromEvidence(plan, replay.intent.revisionGroupId, replay.intent.paths);
}

function replayMatchesPlan(
  plan: BackendCommitPlan<"desktop">,
  replay: DurableReplay,
  producer: LocalMutationProducerMetadata,
): boolean {
  const expected = preparedEntries(plan);
  if (
    replay.intent.operationId !== plan.operationId ||
    !exactValueEquals(replay.intent.producer, producer) ||
    !actorEquals(replay.intent.actor, plan.actor) ||
    replay.intent.paths.length !== expected.length ||
    replay.outbox.operationId !== replay.intent.operationId ||
    replay.outbox.revisionGroupId !== replay.intent.revisionGroupId ||
    replay.outbox.batch.operationId !== replay.intent.operationId ||
    replay.outbox.batch.revisionGroupId !== replay.intent.revisionGroupId
  ) return false;
  const ids = new Set<string>();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = replay.intent.paths[index];
    const entry = expected[index];
    if (
      !actual || !entry ||
      actual.kind !== entry.kind ||
      actual.canonicalPath !== entry.canonicalPath ||
      actual.sourceCanonicalPath !== entry.sourceCanonicalPath ||
      actual.locations.length !== entry.locations.length ||
      actual.revisionIds.length === 0 ||
      actual.undoRecordIds.length === 0
    ) return false;
    for (const id of [...actual.revisionIds, ...actual.undoRecordIds]) {
      if (id.trim().length === 0 || ids.has(id)) return false;
      ids.add(id);
    }
    if (!actual.locations.every((location, locationIndex) => {
      const expectedLocation = entry.locations[locationIndex];
      return expectedLocation !== undefined &&
        location.canonicalPath === expectedLocation.canonicalPath &&
        sameStateMetadata(location.before, expectedLocation.before) &&
        sameStateMetadata(location.after, expectedLocation.after);
    })) return false;
  }
  const receipt = receiptFromReplay(plan, replay);
  return validateAtomicDocumentMutationEventBatch({
    backend: "desktop",
    plan,
    receipt,
    revisionGroupId: replay.intent.revisionGroupId,
    outcome: "applied",
    batch: replay.outbox.batch,
  }) || validateAtomicDocumentMutationEventBatch({
    backend: "desktop",
    plan,
    receipt,
    revisionGroupId: replay.intent.revisionGroupId,
    outcome: "rebased",
    batch: replay.outbox.batch,
  });
}

function replayStateIsCommitted(replay: DurableReplay): boolean {
  return replay.intent.state === "committed" &&
    ["pending", "claimed", "delivered"].includes(replay.outbox.state);
}

export class DesktopFileMutationBackend
  implements DesktopFileMutationBackendContract<PreparedDesktopFileMutation> {
  readonly kind = "desktop" as const;
  private readonly newOpaqueId: () => string;

  constructor(
    private readonly dependencies: DesktopFileMutationBackendDependencies,
  ) {
    this.newOpaqueId = dependencies.newOpaqueId ?? randomUUID;
  }

  private async assertAuthority(
    plan: BackendCommitPlan<"desktop">,
  ): Promise<{ relayId: string; entries: readonly PreparedEntry[]; paths: readonly string[] }> {
    const relayId = await this.dependencies.getTrustedRelayId();
    if (typeof relayId !== "string" || relayId.trim().length === 0) {
      throw new Error("configured Desktop relay identity is unavailable");
    }
    for (const entry of plan.entries) {
      for (const identity of entryIdentities(entry)) {
        if (identity.relayId !== relayId) {
          throw new Error("plan relay identity does not match configured Desktop authority");
        }
      }
    }
    for (const precondition of plan.preconditions ?? []) {
      if (precondition.identity.kind !== "local_file" || precondition.identity.relayId !== relayId) {
        throw new Error("plan precondition does not match configured Desktop authority");
      }
    }
    const entries = preparedEntries(plan);
    for (const entry of entries) {
      for (const location of entry.locations) {
        const canonical = await this.dependencies.fileAdapter.resolveTarget(
          location.canonicalPath,
          {
            // Authority is path-based and must remain replayable after a
            // committed delete/move removed its preimage. Exact existence and
            // bytes are validated separately for fresh candidates.
            allowMissing: true,
            rejectFinalSymlink: true,
          },
        );
        if (canonical !== location.canonicalPath) {
          throw new Error("Desktop canonical path changed during authorization");
        }
      }
    }
    for (const precondition of plan.preconditions ?? []) {
      if (precondition.identity.kind !== "local_file") {
        throw new Error("Desktop plan contains a non-local precondition");
      }
      const canonical = await this.dependencies.fileAdapter.resolveTarget(
        precondition.identity.canonicalPath,
        { allowMissing: true, rejectFinalSymlink: true },
      );
      if (canonical !== precondition.identity.canonicalPath) {
        throw new Error("Desktop precondition canonical path changed during authorization");
      }
    }
    return { relayId, entries, paths: canonicalPaths(plan, entries) };
  }

  private async readState(canonicalPath: string): Promise<FileStateSnapshot> {
    const stat = await this.dependencies.fileAdapter.stat(canonicalPath);
    if (!stat) return { kind: "missing" };
    if (!stat.isFile || stat.isSymbolicLink) {
      throw new Error("Desktop mutation target is not a regular file");
    }
    return bytesSnapshot(await this.dependencies.fileAdapter.readFile(canonicalPath));
  }

  private mutationPath(
    plan: BackendCommitPlan<"desktop">,
    entryIndex: number,
  ): DocumentMutationPath {
    const entry = plan.entries[entryIndex]!;
    switch (entry.kind) {
      case "create": return { kind: "create", after: entry.after.identity };
      case "update":
        return {
          kind: "update",
          before: entry.before.identity,
          after: entry.after.identity,
        };
      case "move":
        return entry.destinationBefore
          ? {
              kind: "move",
              overwrite: true,
              before: entry.source.identity,
              destinationBefore: entry.destinationBefore.identity,
              after: entry.after.identity,
            }
          : {
              kind: "move",
              overwrite: false,
              before: entry.source.identity,
              after: entry.after.identity,
            };
      case "delete": return { kind: "delete", before: entry.before.identity };
    }
  }

  private conflict(
    plan: BackendCommitPlan<"desktop">,
    entryIndex: number,
    canonicalPath: string,
    current: ByteSnapshot,
    message: string,
  ): Extract<
    BackendPrepareOutcome<"desktop", PreparedDesktopFileMutation>,
    { kind: "conflict" }
  > {
    const currentVersion = version(
      identityAt(currentIdentityRelay(plan, entryIndex), canonicalPath),
      current.sha256,
    );
    return {
      kind: "conflict",
      code: "stale_version",
      evidence: [{
        path: this.mutationPath(plan, entryIndex),
        currentVersion,
      }],
      currentSnapshots: [{
        identity: currentVersion.identity,
        currentVersion,
        bytes: current.bytes,
      }],
      diagnostics: [{ code: "stale_version", message, entryIndex }],
    };
  }

  private async validatePreimages(
    plan: BackendCommitPlan<"desktop">,
    entries: readonly PreparedEntry[],
  ): Promise<
    | null
    | Extract<
        BackendPrepareOutcome<"desktop", PreparedDesktopFileMutation>,
        { kind: "conflict" | "failed" }
      >
  > {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex]!;
      for (const location of entry.locations) {
        const current = await this.readState(location.canonicalPath);
        if (sameSnapshot(current, location.before)) continue;
        if (current.kind === "bytes") {
          return this.conflict(
            plan,
            entryIndex,
            location.canonicalPath,
            current,
            "local file state no longer matches the exact expected preimage",
          );
        }
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [{
            code: "expected_file_missing",
            message: "an expected local file is missing",
            entryIndex,
          }],
        };
      }
    }
    return null;
  }

  /** Preconditions intentionally have no mutation path, receipt, or event. */
  private async preconditionsMatch(plan: BackendCommitPlan<"desktop">): Promise<boolean> {
    for (const precondition of plan.preconditions ?? []) {
      if (precondition.identity.kind !== "local_file") return false;
      const current = await this.readState(precondition.identity.canonicalPath);
      if (
        current.kind !== "bytes" ||
        !sameSnapshot(current, bytesSnapshot(precondition.bytes))
      ) return false;
    }
    return true;
  }

  async prepare(
    plan: BackendCommitPlan<"desktop">,
  ): Promise<BackendPrepareOutcome<"desktop", PreparedDesktopFileMutation>> {
    const invalid = invalidPlan(plan);
    if (invalid) {
      return {
        kind: "failed",
        code: "backend_failure",
        diagnostics: [{ code: "invalid_plan", message: invalid }],
      };
    }
    try {
      // Authorize before operation lookup: operation IDs are not journal oracles.
      const authority = await this.assertAuthority(plan);
      await this.dependencies.assertTrustedActor(plan.actor, plan.operationId);
      const replay = await this.dependencies.journal.lookupOperation(plan.operationId);
      if (replay) {
        if (!replayMatchesPlan(
          plan,
          replay,
          this.dependencies.producerMetadata(plan),
        )) {
          return {
            kind: "failed",
            code: "backend_failure",
            diagnostics: [{
              code: "operation_mismatch",
              message: "operation ID is bound to different durable mutation evidence",
            }],
          };
        }
        if (!replayStateIsCommitted(replay)) {
          return {
            kind: "failed",
            code: "backend_failure",
            diagnostics: [{
              code: `operation_${replay.intent.state}_${replay.outbox.state}`,
              message: "durable operation requires recovery or a new operation ID",
            }],
          };
        }
        return {
          kind: "prepared",
          revisionGroupIdHint: replay.intent.revisionGroupId,
          prepared: Object.freeze({
            kind: "replay",
            operationId: plan.operationId,
            relayId: authority.relayId,
            canonicalPaths: authority.paths,
            entries: authority.entries,
            replay,
          }),
        };
      }
      if (!await this.preconditionsMatch(plan)) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [{
            code: "stale_precondition",
            message: "a read-only local precondition no longer matches its exact source snapshot",
          }],
        };
      }
      const conflict = await this.validatePreimages(plan, authority.entries);
      if (conflict) return conflict;
      return {
        kind: "prepared",
        prepared: Object.freeze({
          kind: "candidate",
          operationId: plan.operationId,
          relayId: authority.relayId,
          canonicalPaths: authority.paths,
          entries: authority.entries,
        }),
      };
    } catch (error) {
      return {
        kind: "failed",
        code: "backend_unavailable",
        diagnostics: [{
          code: "desktop_authority_unavailable",
          message: error instanceof Error
            ? error.message
            : "Desktop authority could not be verified",
        }],
      };
    }
  }

  private replayCommit(
    input: CommitPreparedInput<"desktop", PreparedDesktopFileMutation>,
    replay: DurableReplay,
  ): BackendCommitOutcome<"desktop", BackendCommitReceipt<"desktop">> {
    if (
      !replayMatchesPlan(
        input.plan,
        replay,
        this.dependencies.producerMetadata(input.plan),
      ) ||
      !replayStateIsCommitted(replay) ||
      replay.intent.revisionGroupId !== input.revisionGroupId
    ) {
      return failed(
        "durable replay no longer matches this plan and revision group",
        "replay_mismatch",
        "inconsistent_outcome",
      );
    }
    const receipt = receiptFromReplay(input.plan, replay);
    let expected: AtomicDocumentMutationEventBatch;
    try {
      expected = input.buildCommittedEventBatch(receipt);
    } catch (error) {
      return failed(
        error instanceof Error ? error.message : "replay event batch rebuild failed",
        "replay_batch_rebuild_failed",
        "inconsistent_outcome",
      );
    }
    if (!exactValueEquals(expected, replay.outbox.batch)) {
      return failed(
        "stored replay batch differs from the exact rebuilt batch",
        "replay_batch_mismatch",
        "inconsistent_outcome",
      );
    }
    return { kind: "committed", receipt, enlistedEventBatch: replay.outbox.batch };
  }

  private allocateIds(count: number): readonly {
    revisionIds: readonly [string];
    undoRecordIds: readonly [string];
  }[] {
    const seen = new Set<string>();
    return Array.from({ length: count }, () => {
      const revisionId = this.newOpaqueId();
      const undoRecordId = this.newOpaqueId();
      if (
        revisionId.trim().length === 0 ||
        undoRecordId.trim().length === 0 ||
        seen.has(revisionId) ||
        seen.has(undoRecordId) ||
        revisionId === undoRecordId
      ) throw new Error("revision and undo IDs must be nonempty and globally distinct");
      seen.add(revisionId);
      seen.add(undoRecordId);
      return { revisionIds: [revisionId], undoRecordIds: [undoRecordId] };
    });
  }

  private async writeState(canonicalPath: string, state: FileStateSnapshot): Promise<void> {
    if (state.kind === "missing") {
      await this.dependencies.fileAdapter.remove(canonicalPath);
      return;
    }
    if (!this.dependencies.fileAdapter.writeFileAtomic) {
      throw new Error("GuardedFileAdapter lacks atomic replacement support");
    }
    await this.dependencies.fileAdapter.writeFileAtomic(canonicalPath, state.bytes);
  }

  private async publishState(
    canonicalPath: string,
    before: FileStateSnapshot,
    after: FileStateSnapshot,
  ): Promise<boolean> {
    const expected = before.kind === "missing"
      ? before
      : { kind: "bytes" as const, bytes: before.bytes };
    if (after.kind === "missing") {
      if (!this.dependencies.fileAdapter.removeConditional) {
        throw new Error("GuardedFileAdapter lacks conditional remove support");
      }
      return (await this.dependencies.fileAdapter.removeConditional(
        canonicalPath,
        expected,
      )).kind === "applied";
    }
    if (!this.dependencies.fileAdapter.writeFileAtomicConditional) {
      throw new Error("GuardedFileAdapter lacks conditional atomic write support");
    }
    return (await this.dependencies.fileAdapter.writeFileAtomicConditional(
      canonicalPath,
      expected,
      after.bytes,
    )).kind === "applied";
  }

  private async applyPostimages(
    plan: BackendCommitPlan<"desktop">,
    entries: readonly PreparedEntry[],
  ): Promise<void> {
    let appliedCount = 0;
    const publish = async (
      entryIndex: number,
      location: PreparedEntry["locations"][number],
    ): Promise<void> => {
      await this.dependencies.assertTrustedActor(plan.actor, plan.operationId);
      if (!await this.publishState(
        location.canonicalPath,
        location.before,
        location.after,
      )) {
        throw new PublishConflictError(
          entryIndex,
          location.canonicalPath,
          appliedCount,
        );
      }
      appliedCount += 1;
    };
    // Materialize all byte postimages before removals. A failure at any point is
    // compensated from the durable all-location preimage set.
    for (const [entryIndex, entry] of entries.entries()) {
      for (const location of entry.locations) {
        if (location.after.kind === "bytes") {
          await publish(entryIndex, location);
        }
      }
    }
    for (const [entryIndex, entry] of entries.entries()) {
      for (const location of entry.locations) {
        if (location.after.kind === "missing") {
          await publish(entryIndex, location);
        }
      }
    }
  }

  private async exactLocationsMatch(
    entries: readonly PreparedEntry[],
    side: "before" | "after",
  ): Promise<boolean> {
    for (const entry of entries) {
      for (const location of entry.locations) {
        if (!sameSnapshot(await this.readState(location.canonicalPath), location[side])) {
          return false;
        }
      }
    }
    return true;
  }

  private restoredEntries(prepared: PreparedDesktopFileMutation) {
    return prepared.entries.map((entry, entryIndex) => {
      const source = entry.locations[0]!;
      switch (entry.kind) {
        case "create":
          return {
            kind: "create" as const,
            entryIndex,
            identity: identityAt(prepared.relayId, entry.canonicalPath),
            absent: true as const,
          };
        case "update":
        case "delete": {
          if (source.before.kind !== "bytes") throw new Error("missing rollback bytes");
          return {
            kind: entry.kind,
            entryIndex,
            restored: version(
              identityAt(prepared.relayId, entry.canonicalPath),
              source.before.sha256,
            ),
          };
        }
        case "move": {
          const destination = entry.locations[1]!;
          if (source.before.kind !== "bytes") throw new Error("missing move source");
          return {
            kind: "move" as const,
            entryIndex,
            sourceRestored: version(
              identityAt(prepared.relayId, source.canonicalPath),
              source.before.sha256,
            ),
            destination: destination.before.kind === "missing"
              ? {
                  kind: "absent" as const,
                  identity: identityAt(prepared.relayId, destination.canonicalPath),
                }
              : {
                  kind: "restored" as const,
                  version: version(
                    identityAt(prepared.relayId, destination.canonicalPath),
                    destination.before.sha256,
                  ),
                },
          };
        }
      }
    });
  }

  private async compensatePending(
    prepared: PreparedDesktopFileMutation,
  ): Promise<BackendCompensationOutcome> {
    const lookup = await this.dependencies.journal.lookupOperation(prepared.operationId);
    if (!lookup) {
      return {
        kind: "failed",
        code: "inconsistent_outcome",
        diagnostics: [{ code: "pending_intent_missing", message: "pending intent disappeared" }],
      };
    }
    if (lookup.intent.state === "aborted" && lookup.outbox.state === "cancelled") {
      return {
        kind: "compensated",
        operationId: prepared.operationId,
        revisionGroupId: lookup.intent.revisionGroupId,
        disposition: "rolled_back",
        entries: this.restoredEntries(prepared),
      };
    }
    if (lookup.intent.state !== "pending" || lookup.outbox.state !== "held") {
      return {
        kind: "failed",
        code: "inconsistent_outcome",
        diagnostics: [{
          code: "operation_not_compensatable",
          message: "durable operation is not pending/held",
        }],
      };
    }
    // Never overwrite foreign bytes. Every location must be one exact image.
    for (const entry of prepared.entries) {
      for (const location of entry.locations) {
        const current = await this.readState(location.canonicalPath);
        if (!sameSnapshot(current, location.before) &&
            !sameSnapshot(current, location.after)) {
          return {
            kind: "failed",
            code: "inconsistent_outcome",
            diagnostics: [{
              code: "foreign_bytes_preserved",
              message: "a local path matches neither exact preimage nor postimage",
            }],
          };
        }
      }
    }
    // Restore bytes before absences for the same recoverable multi-path unit.
    for (const entry of prepared.entries) {
      for (const location of entry.locations) {
        if (
          location.before.kind === "bytes" &&
          !sameSnapshot(
            await this.readState(location.canonicalPath),
            location.before,
          )
        ) {
          await this.writeState(location.canonicalPath, location.before);
        }
      }
    }
    for (const entry of prepared.entries) {
      for (const location of entry.locations) {
        if (
          location.before.kind === "missing" &&
          !sameSnapshot(
            await this.readState(location.canonicalPath),
            location.before,
          )
        ) {
          await this.writeState(location.canonicalPath, location.before);
        }
      }
    }
    if (!await this.exactLocationsMatch(prepared.entries, "before")) {
      return {
        kind: "failed",
        code: "inconsistent_outcome",
        diagnostics: [{
          code: "rollback_proof_failed",
          message: "rollback did not prove every exact preimage",
        }],
      };
    }
    await this.dependencies.journal.abort(prepared.operationId);
    return {
      kind: "compensated",
      operationId: prepared.operationId,
      revisionGroupId: lookup.intent.revisionGroupId,
      disposition: "rolled_back",
      entries: this.restoredEntries(prepared),
    };
  }

  async commitPrepared(
    input: CommitPreparedInput<"desktop", PreparedDesktopFileMutation>,
  ): Promise<BackendCommitOutcome<"desktop", BackendCommitReceipt<"desktop">>> {
    const invalid = invalidPlan(input.plan);
    if (invalid) return failed(invalid, "invalid_plan");
    const expectedEntries = preparedEntries(input.plan);
    const expectedPaths = canonicalPaths(input.plan, expectedEntries);
    if (
      input.prepared.operationId !== input.plan.operationId ||
      !samePreparedEntries(input.prepared.entries, expectedEntries) ||
      !exactValueEquals(input.prepared.canonicalPaths, expectedPaths)
    ) {
      return failed(
        "prepared Desktop mutation does not belong to this plan",
        "prepared_plan_mismatch",
        "inconsistent_outcome",
      );
    }

    return withCanonicalPathLocks(expectedPaths, async () => {
      let durableBeginAttempted = false;
      try {
        const authority = await this.assertAuthority(input.plan);
        if (
          authority.relayId !== input.prepared.relayId ||
          !samePreparedEntries(authority.entries, input.prepared.entries) ||
          !exactValueEquals(authority.paths, input.prepared.canonicalPaths)
        ) return failed("Desktop authority drifted after prepare", "commit_reauthorization_failed");
        await this.dependencies.assertTrustedActor(
          input.plan.actor,
          input.plan.operationId,
        );

        const durable = await this.dependencies.journal.lookupOperation(
          input.plan.operationId,
        );
        if (durable) {
          if (!replayStateIsCommitted(durable)) {
            return failed(
              `durable operation is ${durable.intent.state}/${durable.outbox.state}`,
              "operation_requires_recovery",
              "inconsistent_outcome",
            );
          }
          return this.replayCommit(input, durable);
        }
        if (input.prepared.kind === "replay") {
          return failed("prepared replay disappeared", "replay_disappeared", "inconsistent_outcome");
        }
        const conflict = await this.validatePreimages(input.plan, input.prepared.entries);
        if (conflict) {
          if (conflict.kind === "conflict") return conflict;
          return failed(
            conflict.diagnostics[0]?.message ?? "preimage validation failed",
            conflict.diagnostics[0]?.code ?? "preimage_validation_failed",
          );
        }
        if (!await this.preconditionsMatch(input.plan)) {
          return failed(
            "a read-only local precondition no longer matches its exact source snapshot",
            "stale_precondition",
          );
        }

        let allocated: ReturnType<DesktopFileMutationBackend["allocateIds"]>;
        try {
          allocated = this.allocateIds(input.plan.entries.length);
        } catch (error) {
          return failed(
            error instanceof Error ? error.message : "ID allocation failed",
            "id_allocation_failed",
          );
        }
        const receipt = receiptFromEvidence(
          input.plan,
          input.revisionGroupId,
          allocated,
        );
        let batch: AtomicDocumentMutationEventBatch;
        try {
          batch = input.buildCommittedEventBatch(receipt);
        } catch (error) {
          return failed(
            error instanceof Error ? error.message : "event batch construction failed",
            "event_batch_invalid",
          );
        }
        const paths: BeginLocalMutationIntentInput["paths"] =
          input.prepared.entries.map((entry, index) => ({
            kind: entry.kind,
            canonicalPath: entry.canonicalPath,
            ...(entry.sourceCanonicalPath
              ? { sourceCanonicalPath: entry.sourceCanonicalPath }
              : {}),
            revisionIds: [...allocated[index]!.revisionIds],
            undoRecordIds: [...allocated[index]!.undoRecordIds],
            locations: entry.locations.map((location) => ({ ...location })),
          }));
        try {
          await this.dependencies.assertTrustedActor(
            input.plan.actor,
            input.plan.operationId,
          );
          durableBeginAttempted = true;
          await this.dependencies.journal.begin({
            operationId: input.plan.operationId,
            revisionGroupId: input.revisionGroupId,
            actor: input.plan.actor,
            producer: this.dependencies.producerMetadata(input.plan),
            batch,
            paths,
          });
        } catch (error) {
          let resolved: DurableReplay | null;
          try {
            resolved = await this.dependencies.journal.lookupOperation(
              input.plan.operationId,
            );
          } catch {
            return failed(
              "journal begin may be durable, but lookup is unavailable",
              "journal_begin_lookup_unavailable",
              "inconsistent_outcome",
            );
          }
          if (!resolved) {
            return failed(
              error instanceof Error ? error.message : "journal begin failed",
              "journal_begin_failed",
            );
          }
          if (replayStateIsCommitted(resolved)) return this.replayCommit(input, resolved);
          if (
            replayMatchesPlan(
              input.plan,
              resolved,
              this.dependencies.producerMetadata(input.plan),
            ) &&
            resolved.intent.revisionGroupId === input.revisionGroupId &&
            resolved.intent.state === "pending" &&
            resolved.outbox.state === "held"
          ) {
            const compensation = await this.compensatePending(input.prepared).catch(() => null);
            if (compensation?.kind === "compensated") {
              return failed(
                error instanceof Error ? error.message : "journal begin rolled back",
                "journal_begin_rolled_back",
              );
            }
          }
          return failed(
            "journal begin outcome could not be proven and compensated",
            "journal_begin_recovery_required",
            "inconsistent_outcome",
          );
        }

        try {
          // Hold shared locks and prove every source again immediately before
          // the first authoritative publish. No precondition is journaled as
          // a mutation or emitted as an event.
          if (!await this.preconditionsMatch(input.plan)) {
            throw new Error("a read-only local precondition changed before publish");
          }
          await this.applyPostimages(input.plan, input.prepared.entries);
          await this.dependencies.assertTrustedActor(
            input.plan.actor,
            input.plan.operationId,
          );
          if (!await this.exactLocationsMatch(input.prepared.entries, "after")) {
            throw new Error("authoritative writes did not leave every exact postimage");
          }
          // Authority may expire while exact postimages are being read. Fence
          // durable commit truth once more after proof and immediately before
          // finalize; failure enters the existing compensation/recovery path.
          await this.dependencies.assertTrustedActor(
            input.plan.actor,
            input.plan.operationId,
          );
          await this.dependencies.journal.finalize({ operationId: input.plan.operationId });
          return { kind: "committed", receipt, enlistedEventBatch: batch };
        } catch (error) {
          const resolved = await this.dependencies.journal.lookupOperation(
            input.plan.operationId,
          );
          if (resolved && replayStateIsCommitted(resolved)) {
            return this.replayCommit(input, resolved);
          }
          if (error instanceof PublishConflictError && error.appliedCount === 0) {
            const current = await this.readState(error.canonicalPath);
            // Conditional publication proved that this backend wrote zero
            // locations. Cancel the held intent without treating the foreign
            // bytes that caused the conflict as rollback drift.
            await this.dependencies.journal.cancelUnwritten(input.plan.operationId);
            if (current.kind === "bytes") {
              return this.conflict(
                input.plan,
                error.entryIndex,
                error.canonicalPath,
                current,
                error.message,
              );
            }
            return failed(
              "local file disappeared at the authoritative publish boundary",
              "publish_preimage_missing",
            );
          }
          const compensation = await this.compensatePending(input.prepared).catch(() => null);
          if (compensation?.kind === "compensated") {
            return failed(
              error instanceof Error ? error.message : "Desktop commit rolled back",
              "commit_rolled_back",
            );
          }
          return failed(
            "post-begin failure could not be proven and compensated",
            "recovery_required",
            "inconsistent_outcome",
          );
        }
      } catch (error) {
        return failed(
          error instanceof Error ? error.message : "Desktop commit failed",
          "desktop_commit_failed",
          durableBeginAttempted ? "inconsistent_outcome" : "backend_failure",
        );
      }
    });
  }

  compensate(
    input: CompensateCommitInput<
      "desktop",
      PreparedDesktopFileMutation,
      BackendCommitReceipt<"desktop">
    >,
  ): Promise<BackendCompensationOutcome> {
    return withCanonicalPathLocks(input.prepared.canonicalPaths, async () => {
      try {
        const authority = await this.assertAuthority(input.plan);
        if (
          authority.relayId !== input.prepared.relayId ||
          !samePreparedEntries(authority.entries, input.prepared.entries)
        ) throw new Error("Desktop authority changed before compensation");
        return await this.compensatePending(input.prepared);
      } catch (error) {
        return {
          kind: "failed",
          code: "inconsistent_outcome",
          diagnostics: [{
            code: "compensation_failed",
            message: error instanceof Error ? error.message : "Desktop compensation failed",
          }],
        };
      }
    });
  }

  disposePrepared(_prepared: PreparedDesktopFileMutation): void {
    // Prepared state contains immutable in-memory snapshots only.
  }
}

function currentIdentityRelay(
  plan: BackendCommitPlan<"desktop">,
  entryIndex: number,
): string {
  return entryIdentities(plan.entries[entryIndex]!)[0]!.relayId;
}

export function createDesktopFileMutationBackend(
  dependencies: DesktopFileMutationBackendDependencies,
): DesktopFileMutationBackend {
  return new DesktopFileMutationBackend(dependencies);
}
