/**
 * D448 Desktop durable mutation intent and atomic committed-event outbox.
 *
 * Persistence only: the Desktop backend owns authority, canonical path locks,
 * and the authoritative filesystem rename.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  type AtomicDocumentMutationEventBatch,
} from "@nautilo/document-mutations";
import {
  documentMutationActorSchema,
  parseDocumentMutationCommittedEvent,
  type DocumentMutationCommittedEvent,
} from "@nautilo/types";

import type { GuardedFileAdapter } from "./file-adapter.ts";
import { metaFromSnapshot, snapshotFromBytes, statesMetaEqual } from "./hash.ts";
import { journalRootLockKey, withJournalRootLock } from "./journal-root-lock.ts";
import { withCanonicalPathLocks } from "./mutation-lock.ts";
import { applyPruneToEntries, pruneManifestEntries } from "./retention.ts";
import { createJournalStorage, type JournalStorage } from "./storage.ts";
import { formatRevisionRef } from "./ids.ts";
import { DEFAULT_RETENTION_CONFIG } from "./types.ts";
import type {
  AnyLocalFileHistoryManifest,
  BeginLocalMutationIntentInput,
  CanonicalLocalHistoryRecord,
  ClaimLocalMutationOutboxInput,
  FileStateMeta,
  FileStateSnapshot,
  FinalizeLocalMutationInput,
  LocalFileHistoryManifestV3,
  LocalMutationDurableState,
  LocalMutationIntentPath,
  LocalMutationIntentV2,
  LocalMutationOutboxBatch,
  LocalMutationRecoveryResult,
  LocalMutationProducerMetadata,
  LocalMutationTerminalReceipt,
} from "./types.ts";

export interface LocalDurableMutationJournalOptions {
  rootDir: string;
  relayId: string;
  fileAdapter: GuardedFileAdapter;
  storage?: JournalStorage;
  journalRootKey?: string;
}

type AuthoredHistoryMetadataRecord = Omit<CanonicalLocalHistoryRecord, "locations"> & {
  readonly locations: readonly {
    readonly canonicalPath: string;
    readonly before: FileStateMeta;
    readonly after: FileStateMeta;
  }[];
  readonly load: () => Promise<CanonicalLocalHistoryRecord>;
};

type LocalHistoryLineageRecord = Pick<CanonicalLocalHistoryRecord, "revisionId" | "history"> & {
  readonly locations: readonly { readonly canonicalPath: string }[];
};

/** One lineage interpretation for both metadata-only receipts and full restores. */
export function deriveLocalHistoryStacks<T extends LocalHistoryLineageRecord>(records: readonly T[]): Map<string, { undo: T[]; redo: T[] }> {
  const byId = new Map(records.map((record) => [record.revisionId, record]));
  const stacks = new Map<string, { undo: T[]; redo: T[] }>();
  const stackFor = (canonicalPath: string) => {
    let stack = stacks.get(canonicalPath);
    if (!stack) { stack = { undo: [], redo: [] }; stacks.set(canonicalPath, stack); }
    return stack;
  };
  for (const record of records) {
    const paths = [...new Set(record.locations.map((location) => location.canonicalPath))];
    if (record.history === undefined) {
      for (const canonicalPath of paths) {
        const stack = stackFor(canonicalPath);
        stack.undo.push(record);
        stack.redo.splice(0);
      }
      continue;
    }
    const sourceRecords = record.history.sourceRevisionIds.map((id) => {
      const source = byId.get(id);
      if (!source) throw new Error(`history lineage references missing revision ${id}`);
      return source;
    });
    for (const canonicalPath of paths) {
      const stack = stackFor(canonicalPath);
      const sources = sourceRecords.filter((source) => source.locations.some((location) => location.canonicalPath === canonicalPath));
      if (sources.length === 0) throw new Error(`history lineage has no source for ${canonicalPath}`);
      if (record.history.action === "undo") {
        const active = stack.undo.slice(-sources.length);
        if (active.length !== sources.length || active.some((row, index) => row.revisionId !== sources[index]!.revisionId)) {
          throw new Error(`undo lineage is not the active stack suffix for ${canonicalPath}`);
        }
        stack.undo.splice(stack.undo.length - sources.length);
        stack.redo.push(record);
      } else {
        const source = sources.at(-1)!;
        if (stack.redo.at(-1)?.revisionId !== source.revisionId) throw new Error(`redo lineage is not the active redo target for ${canonicalPath}`);
        stack.redo.pop();
        stack.undo.push(record);
      }
    }
  }
  return stacks;
}

function requireId(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}

function assertSnapshot(state: FileStateSnapshot): void {
  if (state.kind === "missing") return;
  const actual = snapshotFromBytes(state.bytes);
  if (
    actual.kind !== "bytes" ||
    actual.sha256 !== state.sha256 ||
    actual.size !== state.size
  ) {
    throw new Error("snapshot bytes do not match declared SHA-256 and size");
  }
}

const LOCAL_TERMINAL_ENVELOPE_GRACE_MS = 24 * 60 * 60 * 1_000;
const LOCAL_TERMINAL_ENVELOPE_MIN_COUNT = 10;
const LOCAL_TERMINAL_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCAL_TERMINAL_RECEIPT_MAX_COUNT = 1_000;
const LOCAL_ORPHAN_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1_000;
const LOCAL_MUTATION_HISTORY_TARGET_COUNT = 1_000;

function terminalReceipt(row: LocalMutationOutboxBatch): LocalMutationTerminalReceipt {
  return {
    id: row.id,
    operationId: row.operationId,
    revisionGroupId: row.revisionGroupId,
    state: row.state === "delivered" ? "delivered" : "cancelled",
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.state === "delivered"
      ? row.deliveredAt ?? row.updatedAt
      : row.updatedAt,
  };
}

function mutationPayloadBytes(intent: LocalMutationIntentV2): number {
  const payloads = new Map<string, number>();
  for (const location of intent.paths.flatMap((entry) => entry.locations)) {
    for (const state of [location.before, location.after]) {
      if (state.kind === "bytes") payloads.set(state.payload.path, state.size);
    }
  }
  return [...payloads.values()].reduce((sum, size) => sum + size, 0);
}

function referencedPayloadRoots(manifest: LocalFileHistoryManifestV3): string[] {
  const roots = new Set(manifest.legacyEntries.map((entry) => entry.id));
  for (const intent of manifest.mutations) {
    for (const location of intent.paths.flatMap((entry) => entry.locations)) {
      for (const state of [location.before, location.after]) {
        if (state.kind !== "bytes") continue;
        const segments = state.payload.path.split(/[\\/]/);
        if (segments[0] === "payloads" && segments[1] !== undefined) {
          roots.add(segments[1]);
        }
      }
    }
  }
  return [...roots];
}

function compactAndRetain(
  manifest: LocalFileHistoryManifestV3,
  nowMs = Date.now(),
  preserveTerminalIds: ReadonlySet<string> = new Set(),
): LocalFileHistoryManifestV3 {
  const legacyPrune = pruneManifestEntries(
    manifest.legacyEntries,
    DEFAULT_RETENTION_CONFIG,
    nowMs,
  );
  const retainedLegacyEntries = legacyPrune.removedIds.length === 0
    ? manifest.legacyEntries
    : applyPruneToEntries(manifest.legacyEntries, legacyPrune);
  const retainedOutbox: LocalMutationOutboxBatch[] = [];
  const receipts = new Map(manifest.receipts.map((receipt) => [receipt.id, receipt]));
  const newestTerminalIds = new Set(manifest.outbox
    .filter((row) => row.state === "delivered" || row.state === "cancelled")
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
    )
    .slice(0, LOCAL_TERMINAL_ENVELOPE_MIN_COUNT)
    .map((row) => row.id));
  for (const row of manifest.outbox) {
    const completedAt = row.state === "delivered"
      ? row.deliveredAt
      : row.state === "cancelled"
        ? row.updatedAt
        : undefined;
    if (
      !preserveTerminalIds.has(row.id) &&
      !newestTerminalIds.has(row.id) &&
      completedAt !== undefined &&
      nowMs - Date.parse(completedAt) >= LOCAL_TERMINAL_ENVELOPE_GRACE_MS
    ) {
      receipts.set(row.id, terminalReceipt(row));
    } else {
      retainedOutbox.push(row);
    }
  }

  const boundedReceipts = [...receipts.values()]
    .filter((receipt) =>
      nowMs - Date.parse(receipt.completedAt) <= LOCAL_TERMINAL_RECEIPT_MAX_AGE_MS
    )
    .sort((left, right) =>
      right.completedAt.localeCompare(left.completedAt) ||
      right.id.localeCompare(left.id)
    )
    .slice(0, LOCAL_TERMINAL_RECEIPT_MAX_COUNT);

  const protectedOperations = new Set<string>();
  for (const intent of manifest.mutations) {
    if (
      intent.state === "pending" ||
      intent.state === "recovery_required" ||
      intent.paths.some((entry) => entry.pinned === true)
    ) {
      protectedOperations.add(intent.operationId);
    }
  }
  for (const row of retainedOutbox) protectedOperations.add(row.operationId);

  const revisionOwner = new Map<string, string>();
  for (const intent of manifest.mutations) {
    for (const id of intent.paths.flatMap((entry) => entry.revisionIds)) {
      revisionOwner.set(id, intent.operationId);
    }
  }
  let addedDependency = true;
  while (addedDependency) {
    addedDependency = false;
    for (const intent of manifest.mutations) {
      if (!protectedOperations.has(intent.operationId)) continue;
      for (const sourceId of intent.producer?.history?.sourceRevisionIds ?? []) {
        const owner = revisionOwner.get(sourceId);
        if (owner !== undefined && !protectedOperations.has(owner)) {
          protectedOperations.add(owner);
          addedDependency = true;
        }
      }
    }
  }

  const countExpiredByPath = new Map<string, Set<string>>();
  const allPathsByOperation = new Map<string, Set<string>>();
  for (const intent of manifest.mutations) {
    const paths = new Set(intent.paths.flatMap((entry) =>
      entry.locations.map((location) => location.canonicalPath)
    ));
    allPathsByOperation.set(intent.operationId, paths);
    for (const canonicalPath of paths) {
      const expired = countExpiredByPath.get(canonicalPath) ?? new Set<string>();
      countExpiredByPath.set(canonicalPath, expired);
    }
  }
  for (const [canonicalPath, expired] of countExpiredByPath) {
    const rows = manifest.mutations
      .filter((intent) => allPathsByOperation.get(intent.operationId)?.has(canonicalPath))
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.operationId.localeCompare(left.operationId)
      );
    let unpinnedKept = 0;
    for (const intent of rows) {
      if (protectedOperations.has(intent.operationId)) continue;
      if (unpinnedKept < DEFAULT_RETENTION_CONFIG.maxEntriesPerPath) {
        unpinnedKept += 1;
      } else {
        expired.add(intent.operationId);
      }
    }
  }

  const removed = new Set<string>();
  for (const intent of manifest.mutations) {
    if (protectedOperations.has(intent.operationId)) continue;
    const paths = allPathsByOperation.get(intent.operationId) ?? new Set<string>();
    const countExpired = paths.size > 0 && [...paths].every((canonicalPath) =>
      countExpiredByPath.get(canonicalPath)?.has(intent.operationId) === true
    );
    const ageExpired = nowMs - Date.parse(intent.createdAt) >
      DEFAULT_RETENTION_CONFIG.maxAgeMs;
    if (countExpired || ageExpired) removed.add(intent.operationId);
  }

  const countTargetCandidates = manifest.mutations
    .filter((intent) =>
      !removed.has(intent.operationId) &&
      !protectedOperations.has(intent.operationId)
    )
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.operationId.localeCompare(left.operationId)
    );
  for (const intent of countTargetCandidates.slice(LOCAL_MUTATION_HISTORY_TARGET_COUNT)) {
    removed.add(intent.operationId);
  }

  let retainedBytes = manifest.mutations
    .filter((intent) => !removed.has(intent.operationId))
    .reduce((sum, intent) => sum + mutationPayloadBytes(intent), 0);
  if (retainedBytes > DEFAULT_RETENTION_CONFIG.maxTotalBytes) {
    const candidates = manifest.mutations
      .filter((intent) =>
        !removed.has(intent.operationId) &&
        !protectedOperations.has(intent.operationId)
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.operationId.localeCompare(right.operationId)
      );
    for (const intent of candidates) {
      if (retainedBytes <= DEFAULT_RETENTION_CONFIG.maxTotalBytes) break;
      removed.add(intent.operationId);
      retainedBytes -= mutationPayloadBytes(intent);
    }
  }

  // The byte budget is a cleanup target, not an integrity cutoff. If a
  // retained undo/redo operation references an older source revision, restore
  // that complete source operation even when doing so leaves bytes above the
  // target.
  let restoredDependency = true;
  while (restoredDependency) {
    restoredDependency = false;
    for (const intent of manifest.mutations) {
      if (removed.has(intent.operationId)) continue;
      for (const sourceId of intent.producer?.history?.sourceRevisionIds ?? []) {
        const owner = revisionOwner.get(sourceId);
        if (owner !== undefined && removed.delete(owner)) {
          restoredDependency = true;
        }
      }
    }
  }

  const retainedMutations = manifest.mutations.filter((intent) =>
    !removed.has(intent.operationId)
  );
  const arraysUnchanged =
    retainedLegacyEntries.length === manifest.legacyEntries.length &&
    retainedLegacyEntries.every((value, index) => value === manifest.legacyEntries[index]) &&
    retainedMutations.length === manifest.mutations.length &&
    retainedMutations.every((value, index) => value === manifest.mutations[index]) &&
    retainedOutbox.length === manifest.outbox.length &&
    retainedOutbox.every((value, index) => value === manifest.outbox[index]) &&
    boundedReceipts.length === manifest.receipts.length &&
    boundedReceipts.every((value, index) => value === manifest.receipts[index]);
  if (arraysUnchanged) return manifest;
  return {
    ...manifest,
    legacyEntries: retainedLegacyEntries,
    mutations: retainedMutations,
    outbox: retainedOutbox,
    receipts: boundedReceipts,
  };
}

function toCurrent(manifest: AnyLocalFileHistoryManifest): LocalFileHistoryManifestV3 {
  if (manifest.v === 3) return compactAndRetain(manifest);
  if (manifest.v === 2) {
    return compactAndRetain({ ...manifest, v: 3, receipts: [] });
  }
  return {
    v: 3,
    relayId: manifest.relayId,
    legacyEntries: manifest.entries,
    mutations: [],
    outbox: [],
    receipts: [],
  };
}

function nextHistorySequence(manifest: LocalFileHistoryManifestV3): number {
  const explicit = [
    ...manifest.legacyEntries.map((entry) => entry.historySequence),
    ...manifest.mutations.map((intent) => intent.historySequence),
  ].filter((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
  return Math.max(
    manifest.legacyEntries.length + manifest.mutations.length,
    explicit.length === 0 ? 0 : Math.max(...explicit) + 1,
  );
}

function stateMeta(state: LocalMutationDurableState): FileStateMeta {
  return state.kind === "missing"
    ? { kind: "missing" }
    : { kind: "bytes", sha256: state.sha256, size: state.size };
}

function exactValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactValueEquals(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) =>
      key === bKeys[index] && exactValueEquals(a[key], b[key]),
    );
}

function normalizeBatch(batch: AtomicDocumentMutationEventBatch): AtomicDocumentMutationEventBatch {
  requireId("batch operationId", batch.operationId);
  requireId("batch revisionGroupId", batch.revisionGroupId);
  const expectedKey = deriveAtomicDocumentMutationBatchIdempotencyKey(
    batch.operationId,
    batch.revisionGroupId,
  );
  if (batch.idempotencyKey !== expectedKey || batch.events.length === 0) {
    throw new Error("atomic event batch correlation is invalid");
  }
  const keys = Object.keys(batch).sort();
  if (!exactValueEquals(keys, ["events", "idempotencyKey", "operationId", "revisionGroupId"])) {
    throw new Error("atomic event batch contains unsupported fields");
  }
  const events = batch.events.map((event) =>
    parseDocumentMutationCommittedEvent(event),
  );
  events.forEach((event, index) => {
    if (
      event.operationId !== batch.operationId ||
      event.revisionGroupId !== batch.revisionGroupId ||
      event.sequence !== index
    ) {
      throw new Error("atomic event batch sequence or correlation is invalid");
    }
  });
  return { ...batch, events };
}

function eventIdentityPath(
  event: DocumentMutationCommittedEvent,
  side: "before" | "after",
): string | undefined {
  if (side === "before") {
    if (event.mutation === "create") return undefined;
    return event.before.identity.kind === "local_file"
      ? event.before.identity.canonicalPath
      : undefined;
  }
  if (event.mutation === "delete") return undefined;
  return event.after.identity.kind === "local_file"
    ? event.after.identity.canonicalPath
    : undefined;
}

function eventSha(
  event: DocumentMutationCommittedEvent,
  side: "before" | "after",
): string | undefined {
  if (side === "before") return event.mutation === "create" ? undefined : event.before.sha256;
  return event.mutation === "delete" ? undefined : event.after.sha256;
}

function validateEntryAgainstEvent(
  relayId: string,
  actor: BeginLocalMutationIntentInput["actor"],
  entry: BeginLocalMutationIntentInput["paths"][number],
  event: DocumentMutationCommittedEvent,
): void {
  if (event.actor.kind !== actor.kind ||
      !exactValueEquals(event.actor, actor) ||
      event.mutation !== entry.kind) {
    throw new Error("event actor or mutation kind does not match intent");
  }
  const identities = [
    "before" in event ? event.before.identity : undefined,
    "after" in event ? event.after.identity : undefined,
    "destinationBefore" in event ? event.destinationBefore.identity : undefined,
  ].filter((identity) => identity !== undefined);
  if (identities.some((identity) =>
    identity.kind !== "local_file" || identity.relayId !== relayId,
  )) {
    throw new Error("Desktop event must contain only identities for this relay");
  }

  const beforePath = eventIdentityPath(event, "before");
  const afterPath = eventIdentityPath(event, "after");
  if (entry.kind === "move") {
    if (
      entry.sourceCanonicalPath === undefined ||
      beforePath !== entry.sourceCanonicalPath ||
      afterPath !== entry.canonicalPath
    ) {
      throw new Error("move event paths do not match intent");
    }
  } else {
    const eventPath = beforePath ?? afterPath;
    if (eventPath !== entry.canonicalPath) {
      throw new Error("event path does not match intent");
    }
  }

  const beforeLocation = entry.locations.find((location) =>
    location.canonicalPath === (entry.sourceCanonicalPath ?? entry.canonicalPath),
  );
  const afterLocation = entry.locations.find((location) =>
    location.canonicalPath === entry.canonicalPath,
  );
  const beforeSha = eventSha(event, "before");
  const afterSha = eventSha(event, "after");
  if (
    beforeSha !== undefined &&
    (beforeLocation?.before.kind !== "bytes" || beforeLocation.before.sha256 !== beforeSha)
  ) {
    throw new Error("event before SHA does not match intent");
  }
  if (
    afterSha !== undefined &&
    (afterLocation?.after.kind !== "bytes" || afterLocation.after.sha256 !== afterSha)
  ) {
    throw new Error("event after SHA does not match intent");
  }

  if (entry.kind === "create") {
    if (entry.locations.length !== 1 ||
        beforeLocation?.before.kind !== "missing" ||
        beforeLocation.after.kind !== "bytes") {
      throw new Error("create intent must prove missing-to-bytes");
    }
  } else if (entry.kind === "update") {
    if (entry.locations.length !== 1 ||
        beforeLocation?.before.kind !== "bytes" ||
        beforeLocation.after.kind !== "bytes") {
      throw new Error("update intent must prove bytes-to-bytes");
    }
  } else if (entry.kind === "delete") {
    if (entry.locations.length !== 1 ||
        beforeLocation?.before.kind !== "bytes" ||
        beforeLocation.after.kind !== "missing") {
      throw new Error("delete intent must prove bytes-to-missing");
    }
  } else {
    const source = entry.locations.find((location) =>
      location.canonicalPath === entry.sourceCanonicalPath,
    );
    const destination = entry.locations.find((location) =>
      location.canonicalPath === entry.canonicalPath,
    );
    if (entry.locations.length !== 2 ||
        entry.sourceCanonicalPath === entry.canonicalPath ||
        source?.before.kind !== "bytes" ||
        source.after.kind !== "missing" ||
        destination?.after.kind !== "bytes") {
      throw new Error("move intent lacks exact source/destination proof");
    }
    const displaced = "destinationBefore" in event ? event.destinationBefore : undefined;
    if (destination.before.kind === "missing") {
      if (displaced !== undefined || ("overwrite" in event && event.overwrite)) {
        throw new Error("non-overwrite move has displaced destination evidence");
      }
    } else if (
      displaced === undefined ||
      !("overwrite" in event) ||
      !event.overwrite ||
      displaced.identity.kind !== "local_file" ||
      displaced.identity.canonicalPath !== entry.canonicalPath ||
      displaced.sha256 !== destination.before.sha256
    ) {
      throw new Error("overwrite move destination proof does not match intent");
    }
  }
}

function intentMatchesInput(
  intent: LocalMutationIntentV2,
  input: BeginLocalMutationIntentInput,
): boolean {
  return exactValueEquals(intent.producer, input.producer) &&
    intent.paths.length === input.paths.length &&
    intent.paths.every((entry, index) => {
      const candidate = input.paths[index];
      return candidate !== undefined &&
        entry.kind === candidate.kind &&
        entry.canonicalPath === candidate.canonicalPath &&
        entry.sourceCanonicalPath === candidate.sourceCanonicalPath &&
        exactValueEquals(entry.revisionIds, candidate.revisionIds) &&
        exactValueEquals(entry.undoRecordIds, candidate.undoRecordIds) &&
        entry.locations.length === candidate.locations.length &&
        entry.locations.every((location, locationIndex) => {
          const candidateLocation = candidate.locations[locationIndex];
          return candidateLocation !== undefined &&
            location.canonicalPath === candidateLocation.canonicalPath &&
            statesMetaEqual(
              stateMeta(location.before),
              metaFromSnapshot(candidateLocation.before),
            ) &&
            statesMetaEqual(
              stateMeta(location.after),
              metaFromSnapshot(candidateLocation.after),
            );
        });
    });
}

function validateProducerMetadata(
  actor: BeginLocalMutationIntentInput["actor"],
  producer: LocalMutationProducerMetadata,
): void {
  requireId("producer operation", producer.operation);
  if (actor.kind === "agent") {
    requireId("producer turnId", producer.turnId ?? "");
  } else if (producer.turnId !== undefined) {
    requireId("producer turnId", producer.turnId);
  }
  if (producer.history !== undefined) {
    if (producer.operation !== producer.history.action) {
      throw new Error("history producer operation and action must agree");
    }
    if (producer.history.sourceRevisionIds.length === 0) {
      throw new Error("history producer requires source revision ids");
    }
    producer.history.sourceRevisionIds.forEach((id) =>
      requireId("history source revision id", id)
    );
    if (producer.history.targetTurnId !== undefined) {
      requireId("history target turnId", producer.history.targetTurnId);
    }
  }
  if (producer.structural !== undefined) {
    const structural = producer.structural;
    if (producer.operation !== structural.command) {
      throw new Error("structural producer operation and command must agree");
    }
    requireId("structural source request path", structural.sourceRequestPath);
    requireId("structural source canonical path", structural.sourceCanonicalPath);
    if (structural.command === "delete") {
      if (
        structural.destinationRequestPath !== undefined ||
        structural.destinationCanonicalPath !== undefined
      ) {
        throw new Error("delete structural producer cannot have a destination");
      }
    } else {
      requireId(
        "structural destination request path",
        structural.destinationRequestPath ?? "",
      );
      requireId(
        "structural destination canonical path",
        structural.destinationCanonicalPath ?? "",
      );
    }
  }
}

export class LocalDurableMutationJournal {
  private readonly relayId: string;
  private readonly fileAdapter: GuardedFileAdapter;
  private readonly storage: JournalStorage;
  private readonly rootDir: string;
  private readonly explicitRootKey: string | undefined;
  private lockKeyPromise: Promise<string> | undefined;
  private cleanupAttempted = false;

  constructor(options: LocalDurableMutationJournalOptions) {
    this.relayId = options.relayId;
    this.fileAdapter = options.fileAdapter;
    this.storage = options.storage ?? createJournalStorage(options.rootDir);
    this.rootDir = path.resolve(options.rootDir);
    this.explicitRootKey = options.journalRootKey;
  }

  private lockKey(): Promise<string> {
    this.lockKeyPromise ??= this.explicitRootKey !== undefined
      ? Promise.resolve(journalRootLockKey(this.explicitRootKey))
      : this.storage.ensureRoot().then(async () =>
          journalRootLockKey(await fs.realpath(this.rootDir)),
        );
    return this.lockKeyPromise;
  }

  private async readOrEmpty(): Promise<AnyLocalFileHistoryManifest> {
    await this.storage.ensureRoot();
    const manifest = await this.storage.readManifest();
    if (manifest && manifest.relayId !== this.relayId) {
      throw new Error(
        `local file history relay mismatch: manifest has ${manifest.relayId}, journal expects ${this.relayId}`,
      );
    }
    return manifest ?? { v: 1, relayId: this.relayId, entries: [] };
  }

  /**
   * Explicit startup/runtime binding gate. Relay replacement must migrate the
   * whole journal and outbox; it may not silently reinterpret or split them.
   */
  async assertRelayBinding(): Promise<void> {
    try {
      await withJournalRootLock(await this.lockKey(), async () => {
        await this.readOrEmpty();
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("local file history relay mismatch:")
      ) {
        throw new Error(
          `${error.message}; an explicit local-history relay rebind is required`,
        );
      }
      throw error;
    }
  }

  /**
   * Metadata-first, path-scoped authored receipt lookup. The journal lock
   * covers selection and loading; only the selected candidate's two payloads
   * are read and verified.
   */
  async readAuthoredChangeCandidate(canonicalPath: string): Promise<{
    readonly candidate: CanonicalLocalHistoryRecord | null;
    readonly latestSha256: string | null;
  }> {
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = toCurrent(await this.readOrEmpty());
      const records: AuthoredHistoryMetadataRecord[] = [];

      for (const [legacyIndex, legacy] of manifest.legacyEntries.entries()) {
        if (legacy.canonicalPath !== canonicalPath && legacy.relatedCanonicalPath !== canonicalPath) continue;
        if (legacy.relatedCanonicalPath !== undefined) throw new Error("path-scoped history contains a structural legacy mutation");
        const selectedPath = await this.fileAdapter.resolveTarget(legacy.canonicalPath, { allowMissing: true, rejectFinalSymlink: true });
        if (selectedPath !== canonicalPath) continue;
        const base = {
          source: "v1" as const,
          revisionRef: formatRevisionRef(this.relayId, legacy.id),
          revisionId: legacy.id,
          operationId: `legacy:${legacy.id}`,
          revisionGroupId: `legacy:${legacy.id}`,
          actor: { kind: "agent" as const, agentId: legacy.agentId },
          turnId: legacy.turnId,
          operation: legacy.operation,
          createdAt: legacy.createdAt,
          historySequence: legacy.historySequence ?? legacyIndex,
          ...(legacy.restoreFromRevisionId === undefined ? {} : { history: { action: legacy.operation === "redo" ? "redo" as const : "undo" as const, sourceRevisionIds: [legacy.restoreFromRevisionId] } }),
        };
        records.push({
          ...base,
          locations: [{ canonicalPath, before: legacy.preState, after: legacy.postState }],
          load: async () => ({
            ...base,
            locations: [{
              canonicalPath,
              before: await this.storage.readEntryState(legacy.id, "pre"),
              after: await this.storage.readEntryState(legacy.id, "post"),
            }],
          }),
        });
      }

      for (const [intentIndex, intent] of manifest.mutations.entries()) {
        if (intent.state !== "committed") continue;
        for (const mutationPath of intent.paths) {
          const location = mutationPath.locations.find((item) => item.canonicalPath === canonicalPath);
          if (!location) continue;
          if (intent.paths.length !== 1 || mutationPath.locations.length !== 1 || mutationPath.revisionIds.length !== 1) {
            throw new Error("path-scoped history contains a multi-path mutation");
          }
          const revisionId = mutationPath.revisionIds[0]!;
          const fallbackOperation = mutationPath.kind === "update" ? "write" as const : mutationPath.kind;
          const base = {
            source: "v2" as const,
            revisionRef: formatRevisionRef(this.relayId, revisionId),
            revisionId,
            operationId: intent.operationId,
            revisionGroupId: intent.revisionGroupId,
            actor: intent.actor,
            ...(intent.producer?.turnId === undefined ? {} : { turnId: intent.producer.turnId }),
            operation: intent.producer?.operation ?? fallbackOperation,
            createdAt: intent.createdAt,
            historySequence: intent.historySequence ?? manifest.legacyEntries.length + intentIndex,
            ...(intent.producer?.history === undefined ? {} : { history: intent.producer.history }),
          };
          records.push({
            ...base,
            locations: [{ canonicalPath, before: location.before, after: location.after }],
            load: async () => ({
              ...base,
              locations: [{
                canonicalPath,
                before: await this.storage.readMutationState(location.before),
                after: await this.storage.readMutationState(location.after),
              }],
            }),
          });
        }
      }

      records.sort((left, right) => left.historySequence - right.historySequence || left.operationId.localeCompare(right.operationId) || left.revisionId.localeCompare(right.revisionId));
      const active = deriveLocalHistoryStacks(records).get(canonicalPath)?.undo ?? [];
      let candidateIndex = -1;
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const record = active[index]!;
        const location = record.locations[0];
        if (record.history === undefined && record.actor.kind === "agent" && location?.before.kind === "bytes" && location.after.kind === "bytes") {
          candidateIndex = index;
          break;
        }
      }
      if (candidateIndex < 0) {
        const latestState = active.at(-1)?.locations[0]?.after;
        return {
          candidate: null,
          latestSha256: latestState?.kind === "bytes" ? latestState.sha256 : null,
        };
      }
      let latest = active[candidateIndex]!.locations[0]!.after;
      for (const record of active.slice(candidateIndex + 1)) {
        const location = record.locations[0];
        if (record.history !== undefined || location?.before.kind !== "bytes" || location.after.kind !== "bytes" || latest.kind !== "bytes" || location.before.sha256 !== latest.sha256) {
          throw new Error("path-scoped history continuity is unavailable");
        }
        latest = location.after;
      }
      return {
        candidate: await active[candidateIndex]!.load(),
        latestSha256: latest.kind === "bytes" ? latest.sha256 : null,
      };
    });
  }

  /**
   * One read/migration view over canonical V2 truth plus retained V1 rows.
   * It never mutates the manifest or live files. V1 payloads are translated
   * into the same immutable location shape consumed by coordinator restores.
   */
  async readCanonicalHistoryRecords(): Promise<readonly CanonicalLocalHistoryRecord[]> {
    return withJournalRootLock(await this.lockKey(), async () => {
      const raw = await this.readOrEmpty();
      const manifest = toCurrent(raw);
      const records: CanonicalLocalHistoryRecord[] = [];

      for (const [legacyIndex, legacy] of manifest.legacyEntries.entries()) {
        const before = await this.storage.readEntryState(legacy.id, "pre");
        const after = await this.storage.readEntryState(legacy.id, "post");
        const locations: Array<{
          canonicalPath: string;
          before: FileStateSnapshot;
          after: FileStateSnapshot;
        }> = [{
          canonicalPath: await this.fileAdapter.resolveTarget(
            legacy.canonicalPath,
            { allowMissing: true, rejectFinalSymlink: true },
          ),
          before,
          after,
        }];
        if (legacy.relatedCanonicalPath !== undefined) {
          locations.push({
            canonicalPath: await this.fileAdapter.resolveTarget(
              legacy.relatedCanonicalPath,
              { allowMissing: true, rejectFinalSymlink: true },
            ),
            before: legacy.relatedPreState === undefined
              ? { kind: "missing" }
              : await this.storage.readEntryState(legacy.id, "related-pre"),
            after: legacy.relatedPostState === undefined
              ? { kind: "missing" }
              : await this.storage.readEntryState(legacy.id, "related-post"),
          });
        }
        records.push({
          source: "v1",
          revisionRef: formatRevisionRef(this.relayId, legacy.id),
          revisionId: legacy.id,
          operationId: `legacy:${legacy.id}`,
          revisionGroupId: `legacy:${legacy.id}`,
          actor: { kind: "agent", agentId: legacy.agentId },
          turnId: legacy.turnId,
          operation: legacy.operation,
          createdAt: legacy.createdAt,
          historySequence: legacy.historySequence ?? legacyIndex,
          ...(legacy.restoreFromRevisionId === undefined
            ? {}
            : {
                history: {
                  action: legacy.operation === "redo" ? "redo" as const : "undo" as const,
                  sourceRevisionIds: [legacy.restoreFromRevisionId],
                },
              }),
          locations,
        });
      }

      for (const [intentIndex, intent] of manifest.mutations.entries()) {
        if (intent.state !== "committed") continue;
        for (const mutationPath of intent.paths) {
          if (mutationPath.revisionIds.length !== 1) {
            throw new Error(
              `canonical mutation ${intent.operationId} has unsupported revision cardinality`,
            );
          }
          const locations = await Promise.all(
            mutationPath.locations.map(async (location) => ({
              canonicalPath: location.canonicalPath,
              before: await this.storage.readMutationState(location.before),
              after: await this.storage.readMutationState(location.after),
            })),
          );
          const fallbackOperation = mutationPath.kind === "update"
            ? "write" as const
            : mutationPath.kind;
          const revisionId = mutationPath.revisionIds[0]!;
          records.push({
            source: "v2",
            revisionRef: formatRevisionRef(this.relayId, revisionId),
            revisionId,
            operationId: intent.operationId,
            revisionGroupId: intent.revisionGroupId,
            actor: intent.actor,
            ...(intent.producer?.turnId === undefined
              ? {}
              : { turnId: intent.producer.turnId }),
            operation: intent.producer?.operation ?? fallbackOperation,
            createdAt: intent.createdAt,
            historySequence: intent.historySequence ??
              manifest.legacyEntries.length + intentIndex,
            ...(intent.producer?.history === undefined
              ? {}
              : { history: intent.producer.history }),
            locations,
          });
        }
      }

      records.sort((left, right) =>
        left.historySequence - right.historySequence ||
        left.operationId.localeCompare(right.operationId) ||
        left.revisionId.localeCompare(right.revisionId)
      );
      return structuredClone(records);
    });
  }

  private async mutate<T>(
    fn: (manifest: LocalFileHistoryManifestV3) =>
      { manifest: LocalFileHistoryManifestV3; result: T } |
      Promise<{ manifest: LocalFileHistoryManifestV3; result: T }>,
  ): Promise<T> {
    return withJournalRootLock(await this.lockKey(), async () => {
      const persisted = await this.readOrEmpty();
      const current = toCurrent(persisted);
      const changed = await fn(current);
      const currentOutbox = new Map(current.outbox.map((row) => [row.id, row]));
      const newlyTerminal = new Set(changed.manifest.outbox
        .filter((row) =>
          (row.state === "delivered" || row.state === "cancelled") &&
          currentOutbox.get(row.id)?.state !== row.state
        )
        .map((row) => row.id));
      const retained = compactAndRetain(changed.manifest, Date.now(), newlyTerminal);
      // Mutation callbacks use immutable replacements for durable changes and
      // return the exact input object for a no-op. Preserve one-time schema
      // migration/retention, but never rewrite unchanged current state.
      if (persisted.v !== 3 || current !== persisted || retained !== current) {
        await this.storage.writeManifest(retained);
        const retainedLegacyIds = new Set(
          retained.legacyEntries.map((entry) => entry.id),
        );
        const persistedLegacy = persisted.v === 1
          ? persisted.entries
          : persisted.legacyEntries;
        for (const entry of persistedLegacy) {
          if (!retainedLegacyIds.has(entry.id)) {
            try {
              await this.storage.removeEntryPayloads(entry.id);
            } catch {
              // Durable manifest truth wins; guarded cleanup can retry later.
            }
          }
        }
        const retainedOperations = new Set(
          retained.mutations.map((intent) => intent.operationId),
        );
        if (persisted.v !== 1) {
          for (const intent of persisted.mutations) {
            if (!retainedOperations.has(intent.operationId)) {
              try {
                await this.storage.removeMutationPayloads(intent.operationId);
              } catch {
                // Manifest truth is durable; a later guarded cleanup may retry.
              }
            }
          }
        }
      }
      if (!this.cleanupAttempted) {
        try {
          await this.storage.cleanupUnreferencedArtifacts({
            referencedPayloadRoots: referencedPayloadRoots(retained),
            olderThanMs: LOCAL_ORPHAN_CLEANUP_GRACE_MS,
          });
          this.cleanupAttempted = true;
        } catch {
          // Valid manifest truth remains authoritative. Cleanup is optional
          // and retries on a later real journal mutation in this process.
        }
      }
      return changed.result;
    });
  }

  /**
   * Read-only replay lookup for an already durable operation.
   *
   * The exact journal-root lock makes this snapshot coherent with concurrent
   * writers. It deliberately does not upgrade v1, recover intents, touch
   * payloads, or accept any authority-bearing input.
   */
  async lookupOperation(operationId: string): Promise<{
    readonly intent: LocalMutationIntentV2;
    readonly outbox: LocalMutationOutboxBatch;
  } | null> {
    requireId("operationId", operationId);
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = await this.readOrEmpty();
      if (manifest.v === 1) return null;

      const intents = manifest.mutations.filter((intent) =>
        intent.operationId === operationId,
      );
      if (intents.length === 0) return null;
      const outbox = manifest.outbox.filter((batch) =>
        batch.operationId === operationId,
      );
      if (intents.length === 1 && outbox.length === 0 && manifest.v === 3) {
        return null;
      }
      if (intents.length !== 1 || outbox.length !== 1) {
        throw new Error(`corrupt local history manifest: ambiguous operation ${operationId}`);
      }
      return structuredClone({
        intent: intents[0]!,
        outbox: outbox[0]!,
      });
    });
  }

  /**
   * Trusted replay reconstruction. Payload bytes come only from immutable
   * journal refs and are rehashed by storage; callers never supply a preimage.
   */
  async lookupOperationWithPayloads(operationId: string): Promise<{
    readonly intent: LocalMutationIntentV2;
    readonly outbox: LocalMutationOutboxBatch;
    readonly locations: readonly {
      readonly canonicalPath: string;
      readonly before: FileStateSnapshot;
      readonly after: FileStateSnapshot;
    }[];
  } | null> {
    requireId("operationId", operationId);
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = await this.readOrEmpty();
      if (manifest.v === 1) return null;
      const intent = manifest.mutations.filter((item) => item.operationId === operationId);
      const outbox = manifest.outbox.filter((item) => item.operationId === operationId);
      if (intent.length === 0) return null;
      if (intent.length === 1 && outbox.length === 0 && manifest.v === 3) return null;
      if (intent.length !== 1 || outbox.length !== 1) throw new Error(`corrupt local history manifest: ambiguous operation ${operationId}`);
      const locations = await Promise.all(intent[0]!.paths.flatMap((entry) => entry.locations).map(async (location) => ({
        canonicalPath: location.canonicalPath,
        before: await this.storage.readMutationState(location.before),
        after: await this.storage.readMutationState(location.after),
      })));
      return structuredClone({ intent: intent[0]!, outbox: outbox[0]!, locations });
    });
  }

  /** Exact request-identity lookup used to reject altered file-tool retries. */
  async lookupOperationWithPayloadsByPrefix(operationIdPrefix: string): Promise<{
    readonly intent: LocalMutationIntentV2;
    readonly outbox: LocalMutationOutboxBatch;
    readonly locations: readonly {
      readonly canonicalPath: string;
      readonly before: FileStateSnapshot;
      readonly after: FileStateSnapshot;
    }[];
  } | null> {
    requireId("operationIdPrefix", operationIdPrefix);
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = await this.readOrEmpty();
      if (manifest.v === 1) return null;
      const intents = manifest.mutations.filter((item) =>
        item.operationId.startsWith(operationIdPrefix)
      );
      if (intents.length === 0) return null;
      if (intents.length !== 1) {
        throw new Error(
          `corrupt local history manifest: ambiguous request identity ${operationIdPrefix}`,
        );
      }
      const intent = intents[0]!;
      const outbox = manifest.outbox.filter((item) =>
        item.operationId === intent.operationId
      );
      if (outbox.length === 0 && manifest.v === 3) return null;
      if (outbox.length !== 1) {
        throw new Error(
          `corrupt local history manifest: ambiguous operation ${intent.operationId}`,
        );
      }
      const locations = await Promise.all(
        intent.paths.flatMap((entry) => entry.locations).map(async (location) => ({
          canonicalPath: location.canonicalPath,
          before: await this.storage.readMutationState(location.before),
          after: await this.storage.readMutationState(location.after),
        })),
      );
      return structuredClone({ intent, outbox: outbox[0]!, locations });
    });
  }

  /**
   * Detects an altered retry where one durable editor correlation ID remains
   * stable but the other was changed. This is scoped by trusted actor/path;
   * correlation never grants authority or discovers another document.
   */
  async lookupEditorSaveWithPayloadsByCorrelation(input: {
    readonly humanId: string;
    readonly canonicalPath: string;
    readonly requestId?: string;
    readonly clientMutationId?: string;
  }): Promise<{
    readonly intent: LocalMutationIntentV2;
    readonly outbox: LocalMutationOutboxBatch;
    readonly locations: readonly {
      readonly canonicalPath: string;
      readonly before: FileStateSnapshot;
      readonly after: FileStateSnapshot;
    }[];
  } | null> {
    requireId("humanId", input.humanId);
    requireId("canonicalPath", input.canonicalPath);
    if (input.requestId === undefined && input.clientMutationId === undefined) {
      return null;
    }
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = await this.readOrEmpty();
      if (manifest.v === 1) return null;
      const matches = manifest.mutations.flatMap((intent) => {
        if (
          intent.actor.kind !== "human" ||
          intent.actor.humanId !== input.humanId ||
          intent.paths.length !== 1 ||
          intent.paths[0]?.kind !== "update" ||
          intent.paths[0].canonicalPath !== input.canonicalPath
        ) {
          return [];
        }
        const outbox = manifest.outbox.find((item) =>
          item.operationId === intent.operationId
        );
        if (!outbox || outbox.batch.events.length !== 1) return [];
        const event = parseDocumentMutationCommittedEvent(outbox.batch.events[0]);
        const requestMatches =
          input.requestId !== undefined &&
          event.mutation === "update" &&
          event.editorSave?.requestId === input.requestId;
        const clientMutationMatches =
          input.clientMutationId !== undefined &&
          event.mutation === "update" &&
          event.editorSave?.clientMutationId === input.clientMutationId;
        if (
          event.mutation !== "update" ||
          event.editorSave === undefined ||
          (!requestMatches && !clientMutationMatches)
        ) {
          return [];
        }
        return [{ intent, outbox }];
      });
      if (matches.length === 0) return null;
      if (matches.length !== 1) {
        throw new Error("corrupt local history manifest: ambiguous editor-save correlation");
      }
      const match = matches[0]!;
      const locations = await Promise.all(
        match.intent.paths.flatMap((entry) => entry.locations).map(async (location) => ({
          canonicalPath: location.canonicalPath,
          before: await this.storage.readMutationState(location.before),
          after: await this.storage.readMutationState(location.after),
        })),
      );
      return structuredClone({ ...match, locations });
    });
  }

  async begin(input: BeginLocalMutationIntentInput): Promise<LocalMutationIntentV2> {
    requireId("operationId", input.operationId);
    requireId("revisionGroupId", input.revisionGroupId);
    documentMutationActorSchema.parse(input.actor);
    validateProducerMetadata(input.actor, input.producer);
    const batch = normalizeBatch(input.batch);
    if (
      batch.operationId !== input.operationId ||
      batch.revisionGroupId !== input.revisionGroupId ||
      batch.events.length !== input.paths.length ||
      input.paths.length === 0
    ) {
      throw new Error("event batch does not exactly cover intent paths");
    }

    const revisionIds = input.paths.flatMap((entry) => entry.revisionIds);
    const undoIds = input.paths.flatMap((entry) => entry.undoRecordIds);
    const claimedLocations = input.paths.flatMap((entry) =>
      entry.locations.map((location) => location.canonicalPath),
    );
    if (new Set(claimedLocations).size !== claimedLocations.length) {
      throw new Error("mutation entries must not claim the same canonical location");
    }
    for (const [index, entry] of input.paths.entries()) {
      requireId("canonicalPath", entry.canonicalPath);
      if (entry.kind === "move") requireId("sourceCanonicalPath", entry.sourceCanonicalPath ?? "");
      if (entry.revisionIds.length === 0 || entry.undoRecordIds.length === 0) {
        throw new Error("each entry needs revisionIds and undoRecordIds");
      }
      entry.revisionIds.forEach((id) => requireId("revisionId", id));
      entry.undoRecordIds.forEach((id) => requireId("undoRecordId", id));
      if (entry.locations.length === 0 ||
          new Set(entry.locations.map((location) => location.canonicalPath)).size !==
            entry.locations.length) {
        throw new Error("entry locations must be nonempty and distinct");
      }
      entry.locations.forEach((location) => {
        requireId("location canonicalPath", location.canonicalPath);
        assertSnapshot(location.before);
        assertSnapshot(location.after);
      });
      for (const location of entry.locations) {
        if (await this.fileAdapter.canonicalize(location.canonicalPath) !==
            location.canonicalPath) {
          throw new Error(`mutation location is not canonical: ${location.canonicalPath}`);
        }
      }
      validateEntryAgainstEvent(this.relayId, input.actor, entry, batch.events[index]!);
    }
    if (new Set([...revisionIds, ...undoIds]).size !== revisionIds.length + undoIds.length) {
      throw new Error("revisionIds and undoRecordIds must be globally distinct");
    }

    return this.mutate(async (manifest) => {
      const terminal = manifest.receipts.find((item) =>
        item.operationId === input.operationId,
      );
      if (terminal !== undefined) {
        throw new Error(
          `operationId ${input.operationId} is inside the terminal replay-retention window`,
        );
      }
      const existing = manifest.mutations.find((item) =>
        item.operationId === input.operationId,
      );
      if (existing) {
        const outbox = manifest.outbox.find((item) => item.operationId === input.operationId);
        if (
          outbox === undefined ||
          !exactValueEquals(outbox.batch, batch) ||
          existing.revisionGroupId !== input.revisionGroupId ||
          !exactValueEquals(existing.actor, input.actor) ||
          !intentMatchesInput(existing, input)
        ) {
          throw new Error(`operationId ${input.operationId} was reused with different input`);
        }
        return { manifest, result: existing };
      }

      const usedRevisionIds = new Set(manifest.mutations.flatMap((mutation) =>
        mutation.paths.flatMap((entry) => entry.revisionIds),
      ));
      const usedUndoIds = new Set(manifest.mutations.flatMap((mutation) =>
        mutation.paths.flatMap((entry) => entry.undoRecordIds),
      ));
      for (const legacy of manifest.legacyEntries) {
        usedRevisionIds.add(legacy.id);
        usedUndoIds.add(legacy.id);
      }
      revisionIds.forEach((id) => {
        if (usedRevisionIds.has(id) || usedUndoIds.has(id)) {
          throw new Error(`revisionId already exists: ${id}`);
        }
      });
      undoIds.forEach((id) => {
        if (usedUndoIds.has(id) || usedRevisionIds.has(id)) {
          throw new Error(`undoRecordId already exists: ${id}`);
        }
      });

      const flatLocations = input.paths.flatMap((entry) => entry.locations);
      const payloads = await this.storage.writeMutationPayloads(
        input.operationId,
        flatLocations,
      );
      let payloadIndex = 0;
      const paths: LocalMutationIntentPath[] = input.paths.map((entry) => ({
        kind: entry.kind,
        canonicalPath: entry.canonicalPath,
        ...(entry.sourceCanonicalPath === undefined
          ? {}
          : { sourceCanonicalPath: entry.sourceCanonicalPath }),
        revisionIds: [...entry.revisionIds],
        undoRecordIds: [...entry.undoRecordIds],
        pinned: false,
        locations: entry.locations.map((location) => {
          const persisted = payloads[payloadIndex++]!;
          return {
            canonicalPath: location.canonicalPath,
            before: persisted.before,
            after: persisted.after,
          };
        }),
      }));
      const now = new Date().toISOString();
      const intent: LocalMutationIntentV2 = {
        operationId: input.operationId,
        revisionGroupId: input.revisionGroupId,
        actor: input.actor,
        state: "pending",
        createdAt: now,
        updatedAt: now,
        historySequence: nextHistorySequence(manifest),
        producer: structuredClone(input.producer),
        paths,
      };
      const outbox: LocalMutationOutboxBatch = {
        id: batch.idempotencyKey,
        operationId: input.operationId,
        revisionGroupId: input.revisionGroupId,
        batch,
        state: "held",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      return {
        manifest: {
          ...manifest,
          mutations: [...manifest.mutations, intent],
          outbox: [...manifest.outbox, outbox],
        },
        result: intent,
      };
    });
  }

  private async diskStates(intent: LocalMutationIntentV2): Promise<Array<{
    canonicalPath: string;
    snapshot: FileStateSnapshot;
  }>> {
    const locations = intent.paths.flatMap((entry) => entry.locations);
    const actual = [];
    for (const location of locations) {
      const canonical = await this.fileAdapter.canonicalize(location.canonicalPath);
      if (canonical !== location.canonicalPath) {
        throw new Error(`canonical mutation path changed: ${location.canonicalPath}`);
      }
      const stat = await this.fileAdapter.stat(canonical);
      actual.push({
        canonicalPath: canonical,
        snapshot: !stat || stat.isSymbolicLink || !stat.isFile
          ? { kind: "missing" } as const
          : snapshotFromBytes(await this.fileAdapter.readFile(canonical)),
      });
    }
    return actual;
  }

  private matches(
    actual: ReadonlyArray<{ snapshot: FileStateSnapshot }>,
    intent: LocalMutationIntentV2,
    side: "before" | "after",
  ): boolean {
    const locations = intent.paths.flatMap((entry) => entry.locations);
    return actual.every((item, index) =>
      statesMetaEqual(metaFromSnapshot(item.snapshot), stateMeta(locations[index]![side])),
    );
  }

  private transition(
    manifest: LocalFileHistoryManifestV3,
    operationId: string,
    intentState: "committed" | "aborted",
    outboxState: "pending" | "cancelled",
  ): { manifest: LocalFileHistoryManifestV3; intent: LocalMutationIntentV2 } {
    const mutationIndex = manifest.mutations.findIndex((item) =>
      item.operationId === operationId,
    );
    const outboxIndex = manifest.outbox.findIndex((item) =>
      item.operationId === operationId,
    );
    if (mutationIndex < 0 || outboxIndex < 0) {
      throw new Error(`pending mutation not found: ${operationId}`);
    }
    const intent = manifest.mutations[mutationIndex]!;
    if (intent.state !== "pending") {
      if (intent.state === intentState) return { manifest, intent };
      throw new Error(`mutation ${operationId} cannot transition from ${intent.state}`);
    }
    const now = new Date().toISOString();
    const transitioned = { ...intent, state: intentState, updatedAt: now };
    const mutations = [...manifest.mutations];
    mutations[mutationIndex] = transitioned;
    const outbox = [...manifest.outbox];
    outbox[outboxIndex] = { ...outbox[outboxIndex]!, state: outboxState, updatedAt: now };
    return { manifest: { ...manifest, mutations, outbox }, intent: transitioned };
  }

  async finalize(input: FinalizeLocalMutationInput): Promise<LocalMutationIntentV2> {
    requireId("operationId", input.operationId);
    return this.mutate(async (manifest) => {
      const intent = manifest.mutations.find((item) =>
        item.operationId === input.operationId,
      );
      if (!intent) throw new Error(`pending mutation not found: ${input.operationId}`);
      if (intent.state === "committed") return { manifest, result: intent };
      if (intent.state !== "pending" ||
          !this.matches(await this.diskStates(intent), intent, "after")) {
        throw new Error(`mutation ${input.operationId} disk does not equal exact postimage`);
      }
      const changed = this.transition(manifest, input.operationId, "committed", "pending");
      return { manifest: changed.manifest, result: changed.intent };
    });
  }

  async abort(operationId: string): Promise<LocalMutationIntentV2> {
    requireId("operationId", operationId);
    return this.mutate(async (manifest) => {
      const intent = manifest.mutations.find((item) => item.operationId === operationId);
      if (!intent) throw new Error(`pending mutation not found: ${operationId}`);
      if (intent.state === "aborted") return { manifest, result: intent };
      if (intent.state !== "pending" ||
          !this.matches(await this.diskStates(intent), intent, "before")) {
        throw new Error(`mutation ${operationId} disk does not equal exact preimage`);
      }
      const changed = this.transition(manifest, operationId, "aborted", "cancelled");
      return { manifest: changed.manifest, result: changed.intent };
    });
  }

  /**
   * Cancels a pending intent when the authoritative backend proves that none
   * of its conditional publish primitives applied. Unlike ordinary abort,
   * foreign disk bytes are expected here: they are the publish conflict that
   * prevented the first write.
   */
  async cancelUnwritten(operationId: string): Promise<LocalMutationIntentV2> {
    requireId("operationId", operationId);
    return this.mutate((manifest) => {
      const intent = manifest.mutations.find((item) => item.operationId === operationId);
      const outbox = manifest.outbox.find((item) => item.operationId === operationId);
      if (!intent || !outbox) {
        throw new Error(`pending mutation not found: ${operationId}`);
      }
      if (intent.state === "aborted" && outbox.state === "cancelled") {
        return { manifest, result: intent };
      }
      if (intent.state !== "pending" || outbox.state !== "held") {
        throw new Error(
          `unwritten mutation ${operationId} is not pending with a held outbox`,
        );
      }
      const changed = this.transition(manifest, operationId, "aborted", "cancelled");
      return { manifest: changed.manifest, result: changed.intent };
    });
  }

  async recover(): Promise<LocalMutationRecoveryResult[]> {
    const captured = await withJournalRootLock(await this.lockKey(), async () => {
      const manifest = toCurrent(await this.readOrEmpty());
      return manifest.mutations
        .filter((intent) => intent.state === "pending")
        .map((intent) => ({
          operationId: intent.operationId,
          locations: intent.paths.flatMap((entry) =>
            entry.locations.map((location) => location.canonicalPath),
          ),
        }));
    });
    const capturedByOperation = new Map(
      captured.map((item) => [item.operationId, item.locations] as const),
    );
    const lockPaths = captured.flatMap((item) => item.locations);
    return withCanonicalPathLocks(lockPaths, () =>
      this.mutate(async (manifest) => {
        let current = manifest;
        const results: LocalMutationRecoveryResult[] = [];
        for (const intent of manifest.mutations) {
          if (intent.state !== "pending") continue;
          const capturedLocations = capturedByOperation.get(intent.operationId);
          const currentLocations = intent.paths.flatMap((entry) =>
            entry.locations.map((location) => location.canonicalPath),
          );
          if (
            capturedLocations === undefined ||
            !exactValueEquals(capturedLocations, currentLocations)
          ) {
            continue;
          }
          const actual = await this.diskStates(intent);
          if (this.matches(actual, intent, "after")) {
            const changed = this.transition(current, intent.operationId, "committed", "pending");
            current = changed.manifest;
            results.push({ operationId: intent.operationId, state: "committed" });
          } else if (this.matches(actual, intent, "before")) {
            const changed = this.transition(current, intent.operationId, "aborted", "cancelled");
            current = changed.manifest;
            results.push({ operationId: intent.operationId, state: "aborted" });
          } else {
            const now = new Date().toISOString();
            const mutations = current.mutations.map((item) =>
              item.operationId === intent.operationId
                ? {
                    ...item,
                    state: "recovery_required" as const,
                    updatedAt: now,
                    recoveryEvidence: {
                      checkedAt: now,
                      actual: actual.map((item) => ({
                        canonicalPath: item.canonicalPath,
                        state: metaFromSnapshot(item.snapshot),
                      })),
                    },
                  }
                : item,
            );
            current = { ...current, mutations };
            results.push({ operationId: intent.operationId, state: "recovery_required" });
          }
        }
        return { manifest: current, result: results };
      }),
    );
  }

  async claimOutbox(
    input: ClaimLocalMutationOutboxInput,
  ): Promise<LocalMutationOutboxBatch | null> {
    requireId("claimantId", input.claimantId);
    return this.mutate((manifest) => {
      const now = input.now ?? new Date().toISOString();
      const candidates = manifest.outbox
        .map((batch, index) => ({ batch, index }))
        .filter(({ batch }) => batch.state === "pending" || batch.state === "claimed")
        .sort((a, b) =>
          a.batch.createdAt.localeCompare(b.batch.createdAt) ||
          a.batch.id.localeCompare(b.batch.id),
        );
      const first = candidates.find(({ batch }) => {
        const due = batch.nextAttemptAt === undefined ||
          batch.nextAttemptAt <= now;
        const stale = batch.state === "claimed" &&
          input.staleClaimBefore !== undefined &&
          (batch.claimedAt ?? "") <= input.staleClaimBefore;
        return (batch.state === "pending" && due) ||
          (batch.state === "claimed" && stale);
      });
      if (!first) return { manifest, result: null };
      const claimed: LocalMutationOutboxBatch = {
        ...first.batch,
        state: "claimed",
        attempts: first.batch.attempts + 1,
        claimedBy: input.claimantId,
        claimedAt: now,
        updatedAt: now,
      };
      const outbox = [...manifest.outbox];
      outbox[first.index] = claimed;
      return { manifest: { ...manifest, outbox }, result: claimed };
    });
  }

  /** Earliest persisted retry or stale-claim deadline; terminal rows are idle. */
  async nextOutboxWakeAt(input: {
    readonly now: string;
    readonly staleClaimAfterMs: number;
  }): Promise<string | undefined> {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new Error("outbox wake current time must be a valid timestamp");
    }
    if (!Number.isFinite(input.staleClaimAfterMs) || input.staleClaimAfterMs < 0) {
      throw new Error("outbox stale claim age must be nonnegative");
    }
    return withJournalRootLock(await this.lockKey(), async () => {
      const manifest = await this.readOrEmpty();
      if (manifest.v === 1) return undefined;
      let earliestMs: number | undefined;
      for (const batch of manifest.outbox) {
        let wakeMs: number | undefined;
        if (batch.state === "pending") {
          wakeMs = batch.nextAttemptAt === undefined
            ? nowMs
            : Date.parse(batch.nextAttemptAt);
        } else if (batch.state === "claimed") {
          const claimedAtMs = Date.parse(batch.claimedAt ?? batch.updatedAt);
          wakeMs = claimedAtMs + input.staleClaimAfterMs;
        }
        if (wakeMs !== undefined && Number.isFinite(wakeMs)) {
          earliestMs = earliestMs === undefined
            ? wakeMs
            : Math.min(earliestMs, wakeMs);
        }
      }
      return earliestMs === undefined ? undefined : new Date(earliestMs).toISOString();
    });
  }

  async ackOutbox(id: string, claimantId: string, now = new Date().toISOString()): Promise<void> {
    await this.updateClaim(id, claimantId, (batch) => ({
      ...batch,
      state: "delivered",
      deliveredAt: now,
      updatedAt: now,
    }));
  }

  async retryOutbox(
    id: string,
    claimantId: string,
    error: string,
    nextAttemptAt: string,
  ): Promise<void> {
    await this.updateClaim(id, claimantId, (batch) => {
      const { claimedBy: _claimedBy, claimedAt: _claimedAt, ...unclaimed } = batch;
      return {
        ...unclaimed,
        state: "pending",
        updatedAt: new Date().toISOString(),
        nextAttemptAt,
        lastError: error,
      };
    });
  }

  private async updateClaim(
    id: string,
    claimantId: string,
    update: (batch: LocalMutationOutboxBatch) => LocalMutationOutboxBatch,
  ): Promise<void> {
    requireId("outbox id", id);
    requireId("claimantId", claimantId);
    await this.mutate((manifest) => {
      const index = manifest.outbox.findIndex((batch) => batch.id === id);
      if (index < 0) throw new Error(`outbox batch not found: ${id}`);
      const batch = manifest.outbox[index]!;
      if (batch.state !== "claimed" || batch.claimedBy !== claimantId) {
        throw new Error(`outbox batch ${id} is not claimed by ${claimantId}`);
      }
      const outbox = [...manifest.outbox];
      outbox[index] = update(batch);
      return { manifest: { ...manifest, outbox }, result: undefined };
    });
  }
}
