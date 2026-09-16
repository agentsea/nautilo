/**
 * ISSUE-M206 — device-local plaintext revision journal.
 *
 * Electron-free: caller supplies journal root, relayId, and a guarded file adapter.
 */

import type { GuardedFileAdapter } from "./file-adapter.ts";
import * as path from "node:path";
import { metaFromSnapshot, snapshotFromBytes } from "./hash.ts";
import { formatRevisionRef, newRevisionId, validateRevisionRefForRelay } from "./ids.ts";
import {
  applyPruneToEntries,
  pruneManifestEntries,
  type RetentionPruneResult,
} from "./retention.ts";
import { createJournalStorage, type JournalStorage } from "./storage.ts";
import { journalRootLockKey, withJournalRootLock } from "./journal-root-lock.ts";
import type {
  AnyLocalFileHistoryManifest,
  FileStateSnapshot,
  ListRevisionsInput,
  ListRevisionsOutput,
  LocalFileHistoryErrorCode,
  LocalFileHistoryResult,
  LocalRevisionEntry,
  LocalRevisionSummary,
  LocalRevisionZone,
  PinRevisionInput,
  PinRevisionOutput,
  RecordSuccessfulMutationInput,
  RecordSuccessfulMutationOutput,
  RetentionConfig,
} from "./types.ts";
import { DEFAULT_RETENTION_CONFIG as DEFAULT_RETENTION } from "./types.ts";

export interface LocalFileHistoryJournalOptions {
  rootDir: string;
  relayId: string;
  fileAdapter: GuardedFileAdapter;
  retention?: RetentionConfig;
  storage?: JournalStorage;
  /** Stable canonical root identity for storage doubles that have no real directory. */
  journalRootKey?: string;
}

function entryZone(entry: LocalRevisionEntry): LocalRevisionZone {
  return entry.zone ?? "absolute";
}

function summarizeEntry(entry: LocalRevisionEntry, relayId: string): LocalRevisionSummary {
  return {
    revisionRef: formatRevisionRef(relayId, entry.id),
    revisionId: entry.id,
    ownerId: entry.ownerId,
    agentId: entry.agentId,
    turnId: entry.turnId,
    requestedPath: entry.requestedPath,
    canonicalPath: entry.canonicalPath,
    zone: entryZone(entry),
    operation: entry.operation,
    createdAt: entry.createdAt,
    preState: entry.preState,
    postState: entry.postState,
    pinned: entry.pinned,
    ...(entry.restoreFromRevisionId
      ? { restoreFromRevisionId: entry.restoreFromRevisionId }
      : {}),
    ...(entry.relatedCanonicalPath ? { relatedCanonicalPath: entry.relatedCanonicalPath } : {}),
  };
}

function err<T>(
  code: LocalFileHistoryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): LocalFileHistoryResult<T> {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

function nextHistorySequence(manifest: AnyLocalFileHistoryManifest): number {
  const legacy = manifest.v === 1 ? manifest.entries : manifest.legacyEntries;
  const mutations = manifest.v === 1 ? [] : manifest.mutations;
  const explicit = [
    ...legacy.map((entry) => entry.historySequence),
    ...mutations.map((intent) => intent.historySequence),
  ].filter((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
  return Math.max(
    legacy.length + mutations.length,
    explicit.length === 0 ? 0 : Math.max(...explicit) + 1,
  );
}

async function readCurrentState(
  adapter: GuardedFileAdapter,
  canonicalPath: string,
): Promise<FileStateSnapshot> {
  const st = await adapter.stat(canonicalPath);
  if (!st || st.isSymbolicLink) {
    return { kind: "missing" };
  }
  if (!st.isFile) {
    return { kind: "missing" };
  }
  const bytes = await adapter.readFile(canonicalPath);
  return snapshotFromBytes(bytes);
}

/** Explicit pre/post snapshot read — missing paths are `{ kind: "missing" }`, never zero-byte. */
export async function readState(
  adapter: GuardedFileAdapter,
  filePath: string,
): Promise<FileStateSnapshot> {
  const canonical = await adapter.canonicalize(filePath);
  return readCurrentState(adapter, canonical);
}

export class LocalFileHistoryJournal {
  private readonly rootDir: string;
  private readonly explicitRootKey: string | undefined;
  private rootKeyPromise: Promise<string> | undefined;
  private readonly relayId: string;
  private readonly fileAdapter: GuardedFileAdapter;
  private readonly retention: RetentionConfig;
  private readonly storage: JournalStorage;
  private manifest: AnyLocalFileHistoryManifest | null = null;

  constructor(options: LocalFileHistoryJournalOptions) {
    this.relayId = options.relayId;
    this.rootDir = path.resolve(options.rootDir);
    this.explicitRootKey = options.journalRootKey;
    this.fileAdapter = options.fileAdapter;
    this.retention = options.retention ?? DEFAULT_RETENTION;
    this.storage = options.storage ?? createJournalStorage(options.rootDir);
  }

  async init(): Promise<void> {
    await this.storage.ensureRoot();
    await withJournalRootLock(await this.rootKey(), async () => {
      this.manifest = await this.readManifestOrEmpty();
    });
  }

  private rootKey(): Promise<string> {
    this.rootKeyPromise ??= this.explicitRootKey !== undefined
      ? Promise.resolve(journalRootLockKey(this.explicitRootKey))
      : import("node:fs/promises").then(async (fs) =>
          journalRootLockKey(await fs.realpath(this.rootDir)),
        );
    return this.rootKeyPromise;
  }

  private async readManifestOrEmpty(): Promise<AnyLocalFileHistoryManifest> {
    const existing = await this.storage.readManifest();
    if (existing && existing.relayId !== this.relayId) {
      throw new Error(
        `local file history relay mismatch: manifest has ${existing.relayId}, journal expects ${this.relayId}`,
      );
    }
    return existing ?? {
      v: 1,
      relayId: this.relayId,
      entries: [],
    };
  }

  private entries(): LocalRevisionEntry[] {
    if (!this.manifest) return [];
    return this.manifest.v === 1
      ? this.manifest.entries
      : this.manifest.legacyEntries;
  }

  private runRetention(
    entries: LocalRevisionEntry[],
  ): { entries: LocalRevisionEntry[]; prune: RetentionPruneResult | null } {
    const prune = pruneManifestEntries(entries, this.retention);
    if (prune.removedIds.length === 0) {
      return { entries, prune: null };
    }
    return { entries: applyPruneToEntries(entries, prune), prune };
  }

  private withLegacyEntries(
    manifest: AnyLocalFileHistoryManifest,
    entries: LocalRevisionEntry[],
  ): AnyLocalFileHistoryManifest {
    return manifest.v === 1
      ? { ...manifest, entries }
      : { ...manifest, legacyEntries: entries };
  }

  /**
   * Reload and mutate under the one process-wide journal-root boundary.
   * Callers may already hold canonical path locks; this function never
   * acquires them, preserving path-lock -> journal-root-lock order.
   */
  private async mutateLegacyEntries<T>(
    mutate: (
      entries: LocalRevisionEntry[],
      manifest: AnyLocalFileHistoryManifest,
    ) => { entries: LocalRevisionEntry[]; result: T } |
      Promise<{ entries: LocalRevisionEntry[]; result: T }>,
  ): Promise<T> {
    return withJournalRootLock(await this.rootKey(), async () => {
      const current = await this.readManifestOrEmpty();
      this.manifest = current;
      const priorEntries = current.v === 1 ? current.entries : current.legacyEntries;
      const changed = await mutate(priorEntries, current);
      const next = this.withLegacyEntries(current, changed.entries);
      await this.storage.writeManifest(next);
      this.manifest = next;
      const retainedIds = new Set(changed.entries.map((entry) => entry.id));
      for (const removed of priorEntries) {
        if (!retainedIds.has(removed.id)) {
          try {
            await this.storage.removeEntryPayloads(removed.id);
          } catch {
            // Manifest truth is committed. Orphan cleanup can be retried later.
          }
        }
      }
      return changed.result;
    });
  }

  async recordSuccessfulMutation(
    input: RecordSuccessfulMutationInput,
  ): Promise<LocalFileHistoryResult<RecordSuccessfulMutationOutput>> {
    await this.init();
    let canonicalPath: string;
    try {
      canonicalPath = await this.fileAdapter.canonicalize(input.requestedPath);
    } catch {
      return err("path_guard_rejected", `requested path rejected by guard: ${input.requestedPath}`);
    }

    const id = newRevisionId();
    const payloadBytes = await this.storage.writeEntryPayloads(
      id,
      input.preState,
      input.postState,
      input.relatedPreState === undefined || input.relatedPostState === undefined
        ? undefined
        : { pre: input.relatedPreState, post: input.relatedPostState },
    );

    const entry: LocalRevisionEntry = {
      id,
      ownerId: input.ownerId,
      agentId: input.agentId,
      turnId: input.turnId,
      requestedPath: input.requestedPath,
      canonicalPath,
      zone: input.zone,
      operation: input.operation,
      createdAt: new Date().toISOString(),
      preState: metaFromSnapshot(input.preState),
      postState: metaFromSnapshot(input.postState),
      pinned: false,
      payloadBytes,
      ...(input.relatedCanonicalPath ? { relatedCanonicalPath: input.relatedCanonicalPath } : {}),
      ...(input.relatedPreState ? { relatedPreState: metaFromSnapshot(input.relatedPreState) } : {}),
      ...(input.relatedPostState ? { relatedPostState: metaFromSnapshot(input.relatedPostState) } : {}),
    };

    try {
      const prune = await this.mutateLegacyEntries((currentEntries, manifest) => {
        const retained = this.runRetention([
          ...currentEntries,
          { ...entry, historySequence: nextHistorySequence(manifest) },
        ]);
        return { entries: retained.entries, result: retained.prune };
      });
      return {
        ok: true,
        data: {
          revisionRef: formatRevisionRef(this.relayId, id),
          revisionId: id,
          canonicalPath,
          ...(prune
            ? { pruned: { count: prune.removedIds.length, revisionIds: prune.removedIds } }
            : {}),
        },
      };
    } catch (e) {
      // Manifest persistence can fail after atomic rename. Never delete the
      // candidate payload here: it may already be referenced by durable truth.
      // Unreferenced payloads are safe orphans for later cleanup.
      const msg = e instanceof Error ? e.message : String(e);
      return err("path_guard_rejected", `failed to persist journal: ${msg}`);
    }
  }

  async list(input: ListRevisionsInput): Promise<LocalFileHistoryResult<ListRevisionsOutput>> {
    await this.init();
    const hardCap = 200;
    const limit = Math.min(input.limit ?? 20, hardCap);

    const manifest = await withJournalRootLock(await this.rootKey(), async () =>
      this.readManifestOrEmpty()
    );
    this.manifest = manifest;
    let rows: LocalRevisionSummary[] = (
      manifest.v !== 1 ? manifest.legacyEntries : manifest.entries
    ).map((entry) => summarizeEntry(entry, this.relayId));
    if (manifest.v !== 1) {
      for (const intent of manifest.mutations) {
        if (
          intent.state !== "committed" ||
          intent.actor.kind !== "agent" ||
          intent.producer?.turnId === undefined
        ) {
          continue;
        }
        for (const mutationPath of intent.paths) {
          const canonicalPath = mutationPath.kind === "move"
            ? mutationPath.sourceCanonicalPath
            : mutationPath.canonicalPath;
          const location = mutationPath.locations.find((candidate) =>
            candidate.canonicalPath === canonicalPath
          );
          const revisionId = mutationPath.revisionIds[0];
          if (
            canonicalPath === undefined ||
            location === undefined ||
            revisionId === undefined
          ) continue;
          rows.push({
            revisionRef: formatRevisionRef(this.relayId, revisionId),
            revisionId,
            ownerId: "",
            agentId: intent.actor.agentId,
            turnId: intent.producer.turnId,
            requestedPath: canonicalPath,
            canonicalPath,
            zone: "absolute",
            operation: intent.producer.operation,
            createdAt: intent.createdAt,
            preState: location.before.kind === "missing"
              ? { kind: "missing" }
              : {
                  kind: "bytes",
                  sha256: location.before.sha256,
                  size: location.before.size,
                },
            postState: location.after.kind === "missing"
              ? { kind: "missing" }
              : {
                  kind: "bytes",
                  sha256: location.after.sha256,
                  size: location.after.size,
                },
            pinned: mutationPath.pinned === true,
            ...(mutationPath.kind !== "move"
              ? {}
              : {
                  relatedCanonicalPath: mutationPath.canonicalPath,
                }),
          });
        }
      }
    }
    rows = rows.filter((e) => e.agentId === input.agentId);
    if (input.canonicalPath) {
      rows = rows.filter((e) => e.canonicalPath === input.canonicalPath);
    }
    if (input.turnId) {
      rows = rows.filter((e) => e.turnId === input.turnId);
    }
    if (input.since) {
      const sinceMs = Date.parse(input.since);
      rows = rows.filter((e) => Date.parse(e.createdAt) >= sinceMs);
    }
    if (input.until) {
      const untilMs = Date.parse(input.until);
      rows = rows.filter((e) => Date.parse(e.createdAt) <= untilMs);
    }
    if (input.includePinnedOnly) {
      rows = rows.filter((e) => e.pinned);
    }

    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const truncated = rows.length > limit;
    const revisions = rows.slice(0, limit);

    return { ok: true, data: { revisions, truncated } };
  }

  private async setPinned(
    input: PinRevisionInput,
    pinned: boolean,
  ): Promise<LocalFileHistoryResult<PinRevisionOutput>> {
    await this.init();
    const validated = validateRevisionRefForRelay(input.revisionRef, this.relayId);
    if (!validated.ok) {
      if (validated.code === "relay_ownership_mismatch") {
        return err(
          "history_unavailable_on_this_relay",
          `revision belongs to another relay: ${input.revisionRef}`,
        );
      }
      return err(validated.code, `revision ref rejected: ${input.revisionRef}`);
    }

    return withJournalRootLock(await this.rootKey(), async () => {
      const manifest = await this.readManifestOrEmpty();
      const legacy = manifest.v === 1 ? manifest.entries : manifest.legacyEntries;
      const entry = legacy.find((candidate) =>
        candidate.id === validated.revisionId &&
        candidate.agentId === input.agentId
      );
      if (entry !== undefined) {
        const changed = legacy.map((candidate) =>
          candidate.id === entry.id ? { ...candidate, pinned } : candidate
        );
        const retained = pinned
          ? changed
          : this.runRetention(changed).entries;
        const next = this.withLegacyEntries(manifest, retained);
        await this.storage.writeManifest(next);
        this.manifest = next;
        const retainedIds = new Set(retained.map((candidate) => candidate.id));
        for (const removed of legacy) {
          if (!retainedIds.has(removed.id)) {
            try {
              await this.storage.removeEntryPayloads(removed.id);
            } catch {
              // Manifest truth is committed. Orphan cleanup can retry later.
            }
          }
        }
        return {
          ok: true,
          data: { revisionRef: input.revisionRef, pinned },
        };
      }

      if (manifest.v !== 1) {
        let found = false;
        const mutations = manifest.mutations.map((intent) => ({
          ...intent,
          paths: intent.paths.map((mutationPath) => {
            if (
              intent.actor.kind === "agent" &&
              intent.actor.agentId === input.agentId &&
              mutationPath.revisionIds.includes(validated.revisionId)
            ) {
              found = true;
              return { ...mutationPath, pinned };
            }
            return mutationPath;
          }),
        }));
        if (found) {
          const next = { ...manifest, mutations };
          await this.storage.writeManifest(next);
          this.manifest = next;
          return {
            ok: true,
            data: { revisionRef: input.revisionRef, pinned },
          };
        }
      }
      return err(
        "revision_not_found",
        `revision not found for agent: ${input.revisionRef}`,
      );
    });
  }

  async pin(input: PinRevisionInput): Promise<LocalFileHistoryResult<PinRevisionOutput>> {
    return this.setPinned(input, true);
  }

  async unpin(input: PinRevisionInput): Promise<LocalFileHistoryResult<PinRevisionOutput>> {
    return this.setPinned(input, false);
  }

  /** Test and diagnostics helper — reads manifest entry count. */
  entryCount(): number {
    return this.entries().length;
  }
}

export async function snapshotPath(
  adapter: GuardedFileAdapter,
  filePath: string,
): Promise<FileStateSnapshot> {
  const canonical = await adapter.canonicalize(filePath);
  return readCurrentState(adapter, canonical);
}
