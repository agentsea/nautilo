/**
 * Durable on-disk manifest + payload persistence for the local revision journal.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { payloadByteCount, snapshotFromBytes } from "./hash.ts";
import {
  documentMutationActorSchema,
  parseDocumentMutationCommittedEvent,
} from "@nautilo/types";
import { deriveAtomicDocumentMutationBatchIdempotencyKey } from "@nautilo/document-mutations";
import type {
  AnyLocalFileHistoryManifest,
  FileStateSnapshot,
  LocalMutationDurableState,
} from "./types.ts";

const MANIFEST_FILE = "manifest.json";
const PAYLOADS_DIR = "payloads";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface ManifestRecord extends Record<string, unknown> {
  v?: unknown;
  relayId?: unknown;
  entries?: unknown;
  legacyEntries?: unknown;
  mutations?: unknown;
  outbox?: unknown;
  receipts?: unknown;
  id?: unknown;
  kind?: unknown;
  canonicalPath?: unknown;
  agentId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  pinned?: unknown;
  payloadBytes?: unknown;
  preState?: unknown;
  postState?: unknown;
  before?: unknown;
  after?: unknown;
  sha256?: unknown;
  size?: unknown;
  payload?: unknown;
  path?: unknown;
  operationId?: unknown;
  revisionGroupId?: unknown;
  state?: unknown;
  paths?: unknown;
  locations?: unknown;
  sourceCanonicalPath?: unknown;
  actor?: unknown;
  revisionIds?: unknown;
  undoRecordIds?: unknown;
  batchIdempotencyKey?: unknown;
  idempotencyKey?: unknown;
  sequence?: unknown;
  attempts?: unknown;
  event?: unknown;
  batch?: unknown;
  events?: unknown;
  claimedBy?: unknown;
  claimedAt?: unknown;
  deliveredAt?: unknown;
  completedAt?: unknown;
  recoveryEvidence?: unknown;
  checkedAt?: unknown;
  actual?: unknown;
  producer?: unknown;
  operation?: unknown;
  turnId?: unknown;
  history?: unknown;
  action?: unknown;
  sourceRevisionIds?: unknown;
  targetTurnId?: unknown;
  historySequence?: unknown;
}

function isRecord(value: unknown): value is ManifestRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertFileMeta(value: unknown, context: string): void {
  if (!isRecord(value) || (value.kind !== "missing" && value.kind !== "bytes")) {
    throw new Error(`corrupt local history manifest: invalid ${context}`);
  }
  if (value.kind === "bytes" &&
      (!isNonempty(value.sha256) || !Number.isSafeInteger(value.size) || Number(value.size) < 0)) {
    throw new Error(`corrupt local history manifest: invalid ${context} bytes`);
  }
}

function assertLegacyEntry(value: unknown): void {
  if (!isRecord(value) ||
      !isNonempty(value.id) ||
      !isNonempty(value.canonicalPath) ||
      !isNonempty(value.agentId) ||
      !isNonempty(value.createdAt) ||
      typeof value.pinned !== "boolean" ||
      !Number.isSafeInteger(value.payloadBytes) ||
      Number(value.payloadBytes) < 0 ||
      (value.historySequence !== undefined &&
        (!Number.isSafeInteger(value.historySequence) ||
          Number(value.historySequence) < 0))) {
    throw new Error("corrupt local history manifest: invalid legacy entry");
  }
  assertFileMeta(value.preState, "legacy preState");
  assertFileMeta(value.postState, "legacy postState");
}

function assertDurableState(value: unknown): void {
  assertFileMeta(value, "v2 durable state");
  if (isRecord(value) && value.kind === "bytes") {
    const payload = value.payload;
    if (!isRecord(payload) ||
        !isNonempty(payload.path) ||
        payload.path.includes("\0") ||
        path.isAbsolute(payload.path) ||
        payload.path.split(/[\\/]/).includes("..") ||
        payload.sha256 !== value.sha256 ||
        payload.size !== value.size) {
      throw new Error("corrupt local history manifest: invalid payload ref");
    }
  }
}

function assertStringArray(value: unknown, context: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonempty) ||
      new Set(value).size !== value.length) {
    throw new Error(`corrupt local history manifest: invalid ${context}`);
  }
}

function exactActorEquals(left: unknown, right: unknown): boolean {
  const a = documentMutationActorSchema.safeParse(left);
  const b = documentMutationActorSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}

function durableSha(value: unknown): string | undefined {
  return isRecord(value) && value.kind === "bytes" && isNonempty(value.sha256)
    ? value.sha256
    : undefined;
}

function canonicalLocalPath(identity: {
  kind: string;
  canonicalPath?: string;
}): string | undefined {
  return identity.kind === "local_file" ? identity.canonicalPath : undefined;
}

function decodeManifest(parsed: unknown): AnyLocalFileHistoryManifest {
  if (!isRecord(parsed) || !isNonempty(parsed.relayId)) {
    throw new Error("corrupt local history manifest: invalid root");
  }
  if (parsed.v === 1) {
    if (!Array.isArray(parsed.entries)) {
      throw new Error("corrupt local history manifest: invalid v1 entries");
    }
    parsed.entries.forEach(assertLegacyEntry);
    return parsed as unknown as AnyLocalFileHistoryManifest;
  }
  if ((parsed.v !== 2 && parsed.v !== 3) ||
      !Array.isArray(parsed.legacyEntries) ||
      !Array.isArray(parsed.mutations) ||
      !Array.isArray(parsed.outbox) ||
      (parsed.v === 3 && !Array.isArray(parsed.receipts))) {
    throw new Error("corrupt local history manifest: unsupported manifest version");
  }
  parsed.legacyEntries.forEach(assertLegacyEntry);
  const operations = new Set<string>();
  const mutationsByOperation = new Map<string, ManifestRecord>();
  const legacyIds = new Set(
    parsed.legacyEntries
      .filter(isRecord)
      .map((entry) => String(entry.id)),
  );
  const revisionIds = new Set<string>(legacyIds);
  const undoIds = new Set<string>(legacyIds);
  for (const mutation of parsed.mutations) {
    const claimedLocations = new Set<string>();
    if (!isRecord(mutation) ||
        !isNonempty(mutation.operationId) ||
        operations.has(mutation.operationId) ||
        !isNonempty(mutation.revisionGroupId) ||
        !["pending", "committed", "aborted", "recovery_required"].includes(String(mutation.state)) ||
        !isNonempty(mutation.createdAt) ||
        !isNonempty(mutation.updatedAt) ||
        (mutation.historySequence !== undefined &&
          (!Number.isSafeInteger(mutation.historySequence) ||
            Number(mutation.historySequence) < 0)) ||
        !Array.isArray(mutation.paths) ||
        mutation.paths.length === 0) {
      throw new Error("corrupt local history manifest: invalid v2 mutation");
    }
    documentMutationActorSchema.parse(mutation.actor);
    if (mutation.producer !== undefined) {
      const producer = mutation.producer;
      if (
        !isRecord(producer) ||
        !isNonempty(producer.operation) ||
        (producer.turnId !== undefined && !isNonempty(producer.turnId))
      ) {
        throw new Error("corrupt local history manifest: invalid producer metadata");
      }
      if (producer.history !== undefined) {
        const history = producer.history;
        if (
          !isRecord(history) ||
          (history.action !== "undo" && history.action !== "redo") ||
          history.action !== producer.operation ||
          !Array.isArray(history.sourceRevisionIds) ||
          history.sourceRevisionIds.length === 0 ||
          history.sourceRevisionIds.some((id) => !isNonempty(id)) ||
          (history.targetTurnId !== undefined &&
            !isNonempty(history.targetTurnId))
        ) {
          throw new Error("corrupt local history manifest: invalid history metadata");
        }
      }
    }
    if (mutation.state === "recovery_required") {
      const evidence = mutation.recoveryEvidence;
      if (!isRecord(evidence) ||
          !isNonempty(evidence.checkedAt) ||
          !Array.isArray(evidence.actual) ||
          evidence.actual.length === 0) {
        throw new Error("corrupt local history manifest: recovery evidence missing");
      }
      for (const actual of evidence.actual) {
        if (!isRecord(actual) || !isNonempty(actual.canonicalPath)) {
          throw new Error("corrupt local history manifest: recovery evidence invalid");
        }
        assertFileMeta(actual.state, "recovery actual state");
      }
    }
    operations.add(mutation.operationId);
    mutationsByOperation.set(mutation.operationId, mutation);
    for (const item of mutation.paths) {
      if (!isRecord(item) ||
          !isNonempty(item.canonicalPath) ||
          !["create", "update", "move", "delete"].includes(String(item.kind)) ||
          (item.kind === "move" && !isNonempty(item.sourceCanonicalPath)) ||
          (item.pinned !== undefined && typeof item.pinned !== "boolean") ||
          !Array.isArray(item.locations) ||
          item.locations.length === 0) {
        throw new Error("corrupt local history manifest: invalid v2 mutation path");
      }
      assertStringArray(item.revisionIds, "revisionIds");
      assertStringArray(item.undoRecordIds, "undoRecordIds");
      for (const id of item.revisionIds) {
        if (revisionIds.has(id) || undoIds.has(id)) {
          throw new Error("corrupt local history manifest: duplicate revisionId");
        }
        revisionIds.add(id);
      }
      for (const id of item.undoRecordIds) {
        if (undoIds.has(id) || revisionIds.has(id)) {
          throw new Error("corrupt local history manifest: duplicate undoRecordId");
        }
        undoIds.add(id);
      }
      const locationPaths = new Set<string>();
      for (const location of item.locations) {
        if (!isRecord(location) ||
            !isNonempty(location.canonicalPath) ||
            locationPaths.has(location.canonicalPath)) {
          throw new Error("corrupt local history manifest: invalid mutation location");
        }
        locationPaths.add(location.canonicalPath);
        if (claimedLocations.has(location.canonicalPath)) {
          throw new Error("corrupt local history manifest: duplicate mutation location");
        }
        claimedLocations.add(location.canonicalPath);
        assertDurableState(location.before);
        assertDurableState(location.after);
      }
    }
  }
  const outboxIds = new Set<string>();
  const transportOperations = new Set<string>();
  for (const row of parsed.outbox) {
    if (!isRecord(row) ||
        !isNonempty(row.id) ||
        outboxIds.has(row.id) ||
        !isNonempty(row.operationId) ||
        !isNonempty(row.revisionGroupId) ||
        !["held", "pending", "claimed", "delivered", "cancelled"].includes(String(row.state)) ||
        !Number.isSafeInteger(row.attempts) ||
        Number(row.attempts) < 0 ||
        !isNonempty(row.createdAt) ||
        !isNonempty(row.updatedAt)) {
      throw new Error("corrupt local history manifest: invalid v2 outbox row");
    }
    if (row.state === "claimed" &&
        (!isNonempty(row.claimedBy) ||
          !isNonempty(row.claimedAt) ||
          Number(row.attempts) < 1)) {
      throw new Error("corrupt local history manifest: invalid claimed outbox state");
    }
    if (row.state === "delivered" &&
        (!isNonempty(row.deliveredAt) || Number(row.attempts) < 1)) {
      throw new Error("corrupt local history manifest: invalid delivered outbox state");
    }
    const expectedBatch = deriveAtomicDocumentMutationBatchIdempotencyKey(
      row.operationId,
      row.revisionGroupId,
    );
    if (row.id !== expectedBatch || !isRecord(row.batch) ||
        row.batch.operationId !== row.operationId ||
        row.batch.revisionGroupId !== row.revisionGroupId ||
        row.batch.idempotencyKey !== expectedBatch ||
        !Array.isArray(row.batch.events) ||
        row.batch.events.length === 0) {
      throw new Error("corrupt local history manifest: invalid outbox identity");
    }
    if (Object.keys(row.batch).sort().join("\0") !==
        ["events", "idempotencyKey", "operationId", "revisionGroupId"].join("\0")) {
      throw new Error("corrupt local history manifest: invalid outbox batch fields");
    }
    const parsedEvents = row.batch.events.map((rawEvent, sequence) => {
      const event = parseDocumentMutationCommittedEvent(rawEvent);
      if (event.operationId !== row.operationId ||
          event.revisionGroupId !== row.revisionGroupId ||
          event.sequence !== sequence) {
        throw new Error("corrupt local history manifest: outbox correlation mismatch");
      }
      return event;
    });
    const mutation = mutationsByOperation.get(row.operationId);
    if (!isRecord(mutation) ||
        !Array.isArray(mutation.paths) ||
        mutation.revisionGroupId !== row.revisionGroupId ||
        mutation.paths.length !== row.batch.events.length) {
      throw new Error("corrupt local history manifest: outbox has no exact mutation");
    }
    (mutation.paths as unknown[]).forEach((rawItem, index) => {
      const event = parsedEvents[index]!;
      if (!isRecord(rawItem) ||
          rawItem.kind !== event.mutation ||
          !exactActorEquals(mutation.actor, event.actor)) {
        throw new Error("corrupt local history manifest: event/intent mismatch");
      }
      const locationsByPath = new Map(
        (rawItem.locations as unknown[])
          .filter(isRecord)
          .map((location) => [String(location.canonicalPath), location] as const),
      );
      const identities = [
        "before" in event ? event.before.identity : undefined,
        "after" in event ? event.after.identity : undefined,
        "destinationBefore" in event ? event.destinationBefore.identity : undefined,
      ].filter((identity) => identity !== undefined);
      if (identities.some((identity) =>
        identity.kind !== "local_file" || identity.relayId !== parsed.relayId,
      )) {
        throw new Error("corrupt local history manifest: nonlocal event identity");
      }
      const beforePath = event.mutation === "create"
        ? undefined
        : canonicalLocalPath(event.before.identity);
      const afterPath = event.mutation === "delete"
        ? undefined
        : canonicalLocalPath(event.after.identity);
      const expectedBeforePath = rawItem.kind === "move"
        ? rawItem.sourceCanonicalPath
        : rawItem.canonicalPath;
      if ((beforePath !== undefined && beforePath !== expectedBeforePath) ||
          (afterPath !== undefined && afterPath !== rawItem.canonicalPath)) {
        throw new Error("corrupt local history manifest: event path mismatch");
      }
      if (beforePath !== undefined) {
        const location = locationsByPath.get(beforePath);
        const beforeSha = event.mutation === "create" ? undefined : event.before.sha256;
        if (durableSha(location?.before) !== beforeSha) {
          throw new Error("corrupt local history manifest: before SHA mismatch");
        }
      }
      if (afterPath !== undefined) {
        const location = locationsByPath.get(afterPath);
        const afterSha = event.mutation === "delete" ? undefined : event.after.sha256;
        if (durableSha(location?.after) !== afterSha) {
          throw new Error("corrupt local history manifest: after SHA mismatch");
        }
      }
      if ("destinationBefore" in event) {
        const destinationPath = canonicalLocalPath(event.destinationBefore.identity);
        if (destinationPath === undefined) {
          throw new Error("corrupt local history manifest: displaced path mismatch");
        }
        const destination = locationsByPath.get(destinationPath);
        if (durableSha(destination?.before) !== event.destinationBefore.sha256) {
          throw new Error("corrupt local history manifest: displaced SHA mismatch");
        }
      }
      const target = isNonempty(rawItem.canonicalPath)
        ? locationsByPath.get(rawItem.canonicalPath)
        : undefined;
      if (rawItem.kind === "create") {
        if ((rawItem.locations as unknown[]).length !== 1 ||
            !isRecord(target?.before) || target.before.kind !== "missing" ||
            !isRecord(target?.after) || target.after.kind !== "bytes") {
          throw new Error("corrupt local history manifest: invalid create evidence");
        }
      } else if (rawItem.kind === "update") {
        if ((rawItem.locations as unknown[]).length !== 1 ||
            !isRecord(target?.before) || target.before.kind !== "bytes" ||
            !isRecord(target.after) || target.after.kind !== "bytes") {
          throw new Error("corrupt local history manifest: invalid update evidence");
        }
      } else if (rawItem.kind === "delete") {
        if ((rawItem.locations as unknown[]).length !== 1 ||
            !isRecord(target?.before) || target.before.kind !== "bytes" ||
            !isRecord(target.after) || target.after.kind !== "missing") {
          throw new Error("corrupt local history manifest: invalid delete evidence");
        }
      } else {
        const source = isNonempty(rawItem.sourceCanonicalPath)
          ? locationsByPath.get(rawItem.sourceCanonicalPath)
          : undefined;
        if ((rawItem.locations as unknown[]).length !== 2 ||
            rawItem.sourceCanonicalPath === rawItem.canonicalPath ||
            !isRecord(source?.before) || source.before.kind !== "bytes" ||
            !isRecord(source.after) || source.after.kind !== "missing" ||
            !isRecord(target?.after) || target.after.kind !== "bytes" ||
            !isRecord(target.before) ||
            ("destinationBefore" in event
              ? target.before.kind !== "bytes"
              : target.before.kind !== "missing")) {
          throw new Error("corrupt local history manifest: invalid move evidence");
        }
      }
    });
    if ((mutation.state === "pending" && row.state !== "held") ||
        (mutation.state === "committed" &&
          !["pending", "claimed", "delivered"].includes(String(row.state))) ||
        (mutation.state === "aborted" && row.state !== "cancelled") ||
        (mutation.state === "recovery_required" && row.state !== "held")) {
      throw new Error("corrupt local history manifest: intent/outbox state mismatch");
    }
    outboxIds.add(row.id);
    if (transportOperations.has(row.operationId)) {
      throw new Error("corrupt local history manifest: duplicate operation transport");
    }
    transportOperations.add(row.operationId);
  }
  if (parsed.v === 3) {
    for (const receipt of parsed.receipts as unknown[]) {
      if (!isRecord(receipt) ||
          !isNonempty(receipt.id) ||
          outboxIds.has(receipt.id) ||
          !isNonempty(receipt.operationId) ||
          transportOperations.has(receipt.operationId) ||
          !isNonempty(receipt.revisionGroupId) ||
          (receipt.state !== "delivered" && receipt.state !== "cancelled") ||
          !Number.isSafeInteger(receipt.attempts) ||
          Number(receipt.attempts) < 0 ||
          !isNonempty(receipt.createdAt) ||
          !isNonempty(receipt.updatedAt) ||
          !isNonempty(receipt.completedAt)) {
        throw new Error("corrupt local history manifest: invalid terminal receipt");
      }
      const expected = deriveAtomicDocumentMutationBatchIdempotencyKey(
        receipt.operationId,
        receipt.revisionGroupId,
      );
      if (receipt.id !== expected) {
        throw new Error("corrupt local history manifest: invalid terminal receipt identity");
      }
      const mutation = mutationsByOperation.get(receipt.operationId);
      if (mutation !== undefined &&
          (mutation.revisionGroupId !== receipt.revisionGroupId ||
            (mutation.state === "committed" && receipt.state !== "delivered") ||
            (mutation.state === "aborted" && receipt.state !== "cancelled") ||
            mutation.state === "pending" ||
            mutation.state === "recovery_required")) {
        throw new Error("corrupt local history manifest: terminal receipt mismatch");
      }
      outboxIds.add(receipt.id);
      transportOperations.add(receipt.operationId);
    }
  }
  for (const mutation of parsed.mutations) {
    if (!isRecord(mutation) ||
        ((parsed.v === 2 ||
          mutation.state === "pending" || mutation.state === "recovery_required") &&
          !transportOperations.has(String(mutation.operationId)))) {
      throw new Error("corrupt local history manifest: mutation outbox batch missing");
    }
  }
  return parsed as unknown as AnyLocalFileHistoryManifest;
}

export interface JournalStorage {
  ensureRoot(): Promise<void>;
  readManifest(): Promise<AnyLocalFileHistoryManifest | null>;
  writeManifest(manifest: AnyLocalFileHistoryManifest): Promise<void>;
  writeEntryPayloads(
    entryId: string,
    preState: FileStateSnapshot,
    postState: FileStateSnapshot,
    relatedStates?: { readonly pre: FileStateSnapshot; readonly post: FileStateSnapshot },
  ): Promise<number>;
  readEntryState(entryId: string, kind: "pre" | "post" | "related-pre" | "related-post"): Promise<FileStateSnapshot>;
  /** Reads and rehashes a v2 immutable mutation payload reference. */
  readMutationState(state: LocalMutationDurableState): Promise<FileStateSnapshot>;
  removeEntryPayloads(entryId: string): Promise<void>;
  removeMutationPayloads(operationId: string): Promise<void>;
  cleanupUnreferencedArtifacts(input: {
    readonly referencedPayloadRoots: readonly string[];
    readonly olderThanMs: number;
  }): Promise<{ readonly removedTemps: number; readonly removedPayloadRoots: number }>;
  writeMutationPayloads(
    operationId: string,
    paths: ReadonlyArray<{ before: FileStateSnapshot; after: FileStateSnapshot }>,
  ): Promise<Array<{ before: LocalMutationDurableState; after: LocalMutationDurableState }>>;
}

export type ManifestAtomicWriteBoundary =
  | "temp_opened"
  | "temp_written"
  | "temp_synced"
  | "manifest_renamed"
  | "manifest_mode_restored"
  | "directory_synced";

export interface JournalStorageOptions {
  /** Test-only observation/fault seam; production callers leave this unset. */
  readonly onManifestAtomicWriteBoundary?: (
    boundary: ManifestAtomicWriteBoundary,
  ) => void | Promise<void>;
}

function buildTempPath(targetPath: string): string {
  const suffix = randomBytes(8).toString("hex");
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${suffix}.tmp`,
  );
}

async function writeFileRestricted(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(filePath, "w", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
  options: JournalStorageOptions,
): Promise<void> {
  const tmpPath = buildTempPath(filePath);
  const body = Buffer.from(JSON.stringify(value), "utf8");
  try {
    const handle = await fs.open(tmpPath, "w", FILE_MODE);
    try {
      await options.onManifestAtomicWriteBoundary?.("temp_opened");
      await handle.writeFile(body);
      await options.onManifestAtomicWriteBoundary?.("temp_written");
      await handle.sync();
      await options.onManifestAtomicWriteBoundary?.("temp_synced");
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
    await options.onManifestAtomicWriteBoundary?.("manifest_renamed");
    await fs.chmod(filePath, FILE_MODE);
    await options.onManifestAtomicWriteBoundary?.("manifest_mode_restored");
    await syncDirectory(path.dirname(filePath));
    await options.onManifestAtomicWriteBoundary?.("directory_synced");
  } catch (err) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function createJournalStorage(
  rootDir: string,
  options: JournalStorageOptions = {},
): JournalStorage {
  const manifestPath = path.join(rootDir, MANIFEST_FILE);
  const payloadsRoot = path.join(rootDir, PAYLOADS_DIR);

  async function entryDir(entryId: string): Promise<string> {
    const dir = path.join(payloadsRoot, entryId);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(dir, DIR_MODE);
    return dir;
  }

  return {
    async ensureRoot() {
      await fs.mkdir(rootDir, { recursive: true, mode: DIR_MODE });
      await fs.chmod(rootDir, DIR_MODE);
      await fs.mkdir(payloadsRoot, { recursive: true, mode: DIR_MODE });
      await fs.chmod(payloadsRoot, DIR_MODE);
    },

    async readManifest() {
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        return decodeManifest(JSON.parse(raw));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async writeManifest(manifest) {
      await writeAtomicJson(manifestPath, manifest, options);
    },

    async writeEntryPayloads(entryId, preState, postState, relatedStates) {
      const dir = await entryDir(entryId);
      let total = 0;

      async function writeState(
        kind: "pre" | "post" | "related-pre" | "related-post",
        state: FileStateSnapshot,
      ): Promise<void> {
        const marker = path.join(dir, `${kind}.missing`);
        const dataPath = path.join(dir, `${kind}.bin`);
        await fs.rm(marker, { force: true });
        await fs.rm(dataPath, { force: true });

        if (state.kind === "missing") {
          await writeFileRestricted(marker, new Uint8Array());
          return;
        }
        await writeFileRestricted(dataPath, state.bytes);
        total += payloadByteCount(state);
      }

      await writeState("pre", preState);
      await writeState("post", postState);
      if (relatedStates) {
        await writeState("related-pre", relatedStates.pre);
        await writeState("related-post", relatedStates.post);
      }
      return total;
    },

    async readEntryState(entryId, kind) {
      const dir = path.join(payloadsRoot, entryId);
      const marker = path.join(dir, `${kind}.missing`);
      const dataPath = path.join(dir, `${kind}.bin`);

      try {
        await fs.access(marker);
        return { kind: "missing" };
      } catch {
        /* continue */
      }

      try {
        const buf = await fs.readFile(dataPath);
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const { snapshotFromBytes } = await import("./hash.ts");
        return snapshotFromBytes(bytes);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw Object.assign(new Error(`payload missing for ${entryId}/${kind}`), {
            code: "HISTORY_PRUNED",
          });
        }
        throw err;
      }
    },

    async readMutationState(state) {
      if (state.kind === "missing") return state;
      const relative = state.payload.path;
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error("invalid mutation payload path");
      }
      const bytes = await fs.readFile(path.join(rootDir, relative));
      const snapshot = snapshotFromBytes(bytes);
      if (snapshot.kind !== "bytes" || snapshot.sha256 !== state.sha256 || snapshot.size !== state.size) {
        throw new Error("mutation payload does not match durable hash/size truth");
      }
      return snapshot;
    },

    async removeEntryPayloads(entryId) {
      await fs.rm(path.join(payloadsRoot, entryId), { recursive: true, force: true });
    },

    async removeMutationPayloads(operationId) {
      const contentKey = createHash("sha256")
        .update(operationId, "utf8")
        .digest("hex");
      await fs.rm(path.join(payloadsRoot, `v2-${contentKey}`), {
        recursive: true,
        force: true,
      });
    },

    async cleanupUnreferencedArtifacts(input) {
      const cutoff = Date.now() - Math.max(0, input.olderThanMs);
      const referenced = new Set(input.referencedPayloadRoots);
      let removedTemps = 0;
      let removedPayloadRoots = 0;
      const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (
          !entry.isFile() ||
          !/^\.manifest\.json\.[0-9a-f]{16}\.tmp$/.test(entry.name)
        ) {
          continue;
        }
        const target = path.join(rootDir, entry.name);
        const stat = await fs.lstat(target);
        if (!stat.isSymbolicLink() && stat.mtimeMs <= cutoff) {
          await fs.rm(target, { force: true });
          removedTemps += 1;
        }
      }
      const payloadEntries = await fs.readdir(payloadsRoot, { withFileTypes: true });
      for (const entry of payloadEntries) {
        if (!entry.isDirectory() || referenced.has(entry.name)) continue;
        const target = path.join(payloadsRoot, entry.name);
        const stat = await fs.lstat(target);
        if (!stat.isSymbolicLink() && stat.mtimeMs <= cutoff) {
          await fs.rm(target, { recursive: true, force: true });
          removedPayloadRoots += 1;
        }
      }
      return { removedTemps, removedPayloadRoots };
    },

    async writeMutationPayloads(operationId, states) {
      const contentKey = createHash("sha256")
        .update(operationId, "utf8")
        .digest("hex");
      const operationRoot = await entryDir(`v2-${contentKey}`);
      await syncDirectory(payloadsRoot);
      const persisted: Array<{
        before: LocalMutationDurableState;
        after: LocalMutationDurableState;
      }> = [];
      for (const [index, pair] of states.entries()) {
        const itemRoot = path.join(operationRoot, String(index));
        await fs.mkdir(itemRoot, { recursive: true, mode: DIR_MODE });
        await fs.chmod(itemRoot, DIR_MODE);

        async function persistState(
          label: "before" | "after",
          state: FileStateSnapshot,
        ): Promise<LocalMutationDurableState> {
          if (state.kind === "missing") return { kind: "missing" };
          const relativePath = path.join(
            PAYLOADS_DIR,
            `v2-${contentKey}`,
            String(index),
            `${label}.bin`,
          );
          const absolutePath = path.join(rootDir, relativePath);
          await writeFileRestricted(absolutePath, state.bytes);
          await syncDirectory(itemRoot);
          return {
            kind: "bytes",
            sha256: state.sha256,
            size: state.size,
            payload: {
              path: relativePath,
              sha256: state.sha256,
              size: state.size,
            },
          };
        }

        persisted.push({
          before: await persistState("before", pair.before),
          after: await persistState("after", pair.after),
        });
      }
      await syncDirectory(operationRoot);
      return persisted;
    },
  };
}
