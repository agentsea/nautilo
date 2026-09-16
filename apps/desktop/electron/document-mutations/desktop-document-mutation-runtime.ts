/**
 * D448 — the process-scoped Desktop document-mutation runtime. Human editor
 * saves and private-staged agent apply_patch batches share one coordinator,
 * backend, durable journal, lock domain, recovery path and outbox.
 */

import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  createDocumentMutationCoordinator,
  createHumanEditAdmission,
  DEFAULT_HUMAN_EDIT_LEASE_TTL_MS,
  deriveDocumentIdentityLockKeys,
  HumanEditLeaseRegistry,
  InMemoryDocumentLockManager,
  type AtomicDocumentMutationEventBatch,
  type DocumentMutationCoordinator,
  type DocumentMutationEventPublisher,
} from "@nautilo/document-mutations";
import {
  applyAnchoredTextPatch,
  anchoredTextPatchSchema,
  registerHumanEditLeaseRequestSchema,
  releaseHumanEditLeaseRequestSchema,
  renewHumanEditLeaseRequestSchema,
  updateHumanEditLeaseRequestSchema,
  parseDocumentMutationCommittedEvent,
  type AnchoredTextPatch,
  type DocumentCommitPlan,
  type HumanEditLeaseCandidateTarget,
  type HumanEditLeaseStoreResult,
  type LocalDocumentIdentity,
} from "@nautilo/types";
import type {
  WorkspaceApplyPatchOperationReconciliation,
  WorkspaceCommitResult,
} from "../../../../packages/agent/src/tools/apply-patch/workspace-executor.ts";

import {
  isPathContained,
  type GuardedFileAdapter,
} from "../local-file-history/file-adapter.ts";
import { sha256Hex } from "../local-file-history/hash.ts";
import { deriveLocalHistoryStacks, LocalDurableMutationJournal } from "../local-file-history/durable-mutations.ts";
import type {
  CanonicalLocalHistoryRecord,
  FileStateSnapshot,
  LocalCanonicalMutationOperation,
  LocalMutationHistoryMetadata,
  LocalMutationProducerMetadata,
} from "../local-file-history/types.ts";
import {
  DesktopDocumentMutationOutboxRunner,
} from "./desktop-document-mutation-outbox.ts";
import { DesktopFileMutationBackend } from "./desktop-file-mutation-backend.ts";

export type DesktopEditorSaveResult =
  | { readonly ok: true; readonly sha256: string; readonly size: number }
  | {
      readonly ok: false;
      readonly code: "conflict" | "forbidden" | "too_large" | "error";
      readonly currentSha256?: string;
      readonly message?: string;
    };

/** Exact V2 receipt returned to a headless OfficeCLI producer after commit. */
export type DesktopOfficeCliCommitResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly revisionGroupId: string;
      readonly revisionId: string;
      readonly sha256: string;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly code: "conflict" | "error";
      readonly message: string;
    };

/** Exact V2 receipt returned to an ordinary agent local-file content command. */
export type DesktopAgentContentCommitResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly revisionGroupId: string;
      readonly revisionId: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly replayed: boolean;
      readonly before: Uint8Array | null;
      readonly after: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly code:
        | "stale_sha256"
        | "human_edit_conflict"
        | "reapply_required"
        | "error";
      readonly message: string;
      readonly expectedSha256?: string;
      readonly actualSha256?: string;
    };

export type DesktopAgentStructuralCommitResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly revisionGroupId: string;
      readonly revisionId: string;
      readonly command: "delete" | "move" | "copy";
      readonly sourceCanonicalPath: string;
      readonly destinationCanonicalPath?: string;
      readonly sha256: string | null;
      readonly byteLength: number;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "destination_exists"
        | "source_missing"
        | "binary_source"
        | "human_edit_conflict"
        | "reapply_required"
        | "error";
      readonly message: string;
    };

export type DesktopHistoryRestoreResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly revisionGroupId: string;
      readonly revisions: readonly {
        readonly revisionId: string;
        readonly canonicalPath: string;
        readonly sha256: string | null;
      }[];
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "no_revisions"
        | "revision_not_found"
        | "no_revisions_for_turn"
        | "nothing_to_redo"
        | "human_edit_conflict"
        | "reapply_required"
        | "error";
      readonly message: string;
      readonly canonicalPath?: string;
    };

export type DesktopAuthoredChangeResult =
  | {
      readonly kind: "ready";
      readonly operationId: string;
      /** Generic product role label; actor kind is journal-authoritative. */
      readonly author: { readonly kind: "agent"; readonly displayName: "Genie" };
      readonly before: { readonly content: string; readonly sha256: string };
      readonly after: { readonly content: string; readonly sha256: string };
      readonly currentSha256: string;
    }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly code: string };

/** Correlation only. None of these values grant filesystem or actor authority. */
export type DesktopEditorSaveCorrelation = {
  readonly checkpoint?: unknown;
  readonly requestId?: unknown;
  readonly clientMutationId?: unknown;
  readonly anchoredPatch?: unknown;
  /** Compatibility validation only; target identity is always reconstructed. */
  readonly baseVersion?: unknown;
};

export type DesktopDocumentMutationRuntimeDependencies = {
  readonly getTrustedRelayId: () => string | Promise<string | null> | null;
  readonly getTrustedHumanId: () => string | Promise<string | null> | null;
  readonly fileAdapter: GuardedFileAdapter;
  /** One process-scoped journal rooted at localFileHistoryDirPath(). */
  readonly journal: LocalDurableMutationJournal;
  /** Sends the entire typed atomic batch to the renderer. */
  readonly publishToRenderer: (batch: AtomicDocumentMutationEventBatch) => Promise<
    "published" | "not_published" | "unknown"
  >;
  readonly newOperationId?: () => string;
  readonly newRevisionGroupId?: () => string;
  /** Test seam for transient runner errors; persisted retry deadlines win. */
  readonly outboxWakeIntervalMs?: number;
  /**
   * Process-owned generation fence. Relay/root replacement invalidates an
   * already admitted save and its outbox runner before either can commit or
   * publish under stale authority.
   */
  readonly isCurrent?: () => boolean;
};

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validSha(value: string | null): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function looksLikeBinaryBytes(bytes: Uint8Array, window = 8192): boolean {
  const end = Math.min(bytes.byteLength, window);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function parseCorrelation(input: DesktopEditorSaveCorrelation):
  | { readonly ok: true; readonly value: {
      readonly checkpoint: boolean;
      readonly requestId?: string;
      readonly clientMutationId?: string;
      readonly anchoredPatch?: AnchoredTextPatch;
    } }
  | { readonly ok: false; readonly message: string } {
  if (input.checkpoint !== undefined && typeof input.checkpoint !== "boolean") {
    return { ok: false, message: "editor checkpoint must be boolean" };
  }
  if (input.requestId !== undefined && nonemptyString(input.requestId) === undefined) {
    return { ok: false, message: "editor requestId must be nonempty" };
  }
  if (
    input.clientMutationId !== undefined &&
    nonemptyString(input.clientMutationId) === undefined
  ) {
    return { ok: false, message: "editor clientMutationId must be nonempty" };
  }
  const parsedPatch = input.anchoredPatch === undefined
    ? undefined
    : anchoredTextPatchSchema.safeParse(input.anchoredPatch);
  if (parsedPatch !== undefined && !parsedPatch.success) {
    return { ok: false, message: "editor anchoredPatch is invalid" };
  }
  const value: {
    checkpoint: boolean;
    requestId?: string;
    clientMutationId?: string;
    anchoredPatch?: AnchoredTextPatch;
  } = { checkpoint: input.checkpoint === undefined ? false : input.checkpoint };
  const requestId = nonemptyString(input.requestId);
  const clientMutationId = nonemptyString(input.clientMutationId);
  if (requestId !== undefined) value.requestId = requestId;
  if (clientMutationId !== undefined) value.clientMutationId = clientMutationId;
  if (parsedPatch !== undefined) value.anchoredPatch = parsedPatch.data;
  return { ok: true, value };
}

function trustedId(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}

function currentVersion(identity: { kind: "local_file"; relayId: string; canonicalPath: string }, sha256: string) {
  return {
    identity,
    backendVersion: { kind: "local_sha" as const, sha256 },
    sha256,
  };
}

function stableOperationId(input: {
  relayId: string; humanId: string; canonicalPath: string; correlation: DesktopEditorSaveCorrelation;
}): string | undefined {
  const client = nonemptyString(input.correlation.clientMutationId);
  const request = nonemptyString(input.correlation.requestId);
  if (client === undefined && request === undefined) return undefined;
  return `desktop-editor-save:${createHash("sha256").update(JSON.stringify({
    lane: "editor_save", relayId: input.relayId, humanId: input.humanId,
    canonicalPath: input.canonicalPath, client, request,
  })).digest("hex")}`;
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

function sameFileState(
  left: FileStateSnapshot,
  right: FileStateSnapshot,
): boolean {
  return left.kind === right.kind &&
    (left.kind === "missing" ||
      (right.kind === "bytes" &&
        left.sha256 === right.sha256 &&
        left.size === right.size));
}

/**
 * The renderer editor facade remains existing-file-update only. Structural
 * plans are admitted solely through the trusted private-staging apply_patch
 * method; editor saves never fall back to create.
 */
export class DesktopDocumentMutationRuntime {
  private readonly coordinator: DocumentMutationCoordinator;
  private readonly outbox: DesktopDocumentMutationOutboxRunner;
  /**
   * One local lease registry and lock domain per live Desktop runtime. The
   * coordinator and every local lease lifecycle operation use this exact
   * manager, so a local presence update cannot race a local mutation plan.
   */
  private readonly lockManager = new InMemoryDocumentLockManager();
  private readonly humanEditLeases = new HumanEditLeaseRegistry({
    ttlMs: DEFAULT_HUMAN_EDIT_LEASE_TTL_MS,
    now: Date.now,
    newLeaseId: randomUUID,
  });
  private readonly newOperationId: () => string;
  private readonly newRevisionGroupId: () => string;
  private recoveryStarted = false;
  private outboxPumpTimer: NodeJS.Timeout | undefined;
  private outboxPumpTimerAt: number | undefined;
  private outboxPumpRunning: Promise<void> | undefined;
  private outboxPumpRequested = false;
  private outboxPumpStopped = false;

  constructor(private readonly dependencies: DesktopDocumentMutationRuntimeDependencies) {
    this.coordinator = this.createCoordinator(undefined, {
      operation: "editor_save",
    });
    this.outbox = new DesktopDocumentMutationOutboxRunner({
      journal: dependencies.journal,
      workerId: "desktop-document-mutations-main",
      publisher: {
        publishAtomic: async (batch) => {
          if (!this.isCurrent()) return { kind: "not_published" as const };
          const kind = await dependencies.publishToRenderer(batch);
          return { kind: this.isCurrent() ? kind : "unknown" as const };
        },
      },
    });
    this.newOperationId = dependencies.newOperationId ?? randomUUID;
    this.newRevisionGroupId = dependencies.newRevisionGroupId ?? randomUUID;
  }

  /**
   * Agent authority is execution-local. A short-lived coordinator binds the
   * exact dispatch reauthorization callback while still sharing this
   * process-scoped lock manager, lease registry, journal, and outbox.
   */
  private createCoordinator(
    agentReauthorize?: () => Promise<void>,
    producerBase: Omit<LocalMutationProducerMetadata, "turnId"> = {
      operation: "editor_save",
    },
  ): DocumentMutationCoordinator {
    const backend = new DesktopFileMutationBackend({
      getTrustedRelayId: async () => trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      ),
      assertTrustedActor: async (actor) => {
        this.assertCurrent();
        if (actor.kind === "agent") {
          trustedId(actor.agentId, "trusted Desktop agent identity");
          if (!agentReauthorize) {
            throw new Error("Desktop agent mutation reauthorization is unavailable");
          }
          await agentReauthorize();
          this.assertCurrent();
          return;
        }
        const humanId = trustedId(
          await this.dependencies.getTrustedHumanId(),
          "trusted Desktop human identity",
        );
        if (actor.kind !== "human" || actor.humanId !== humanId) {
          throw new Error("Desktop human mutation actor no longer matches trusted identity");
        }
      },
      fileAdapter: this.dependencies.fileAdapter,
      journal: this.dependencies.journal,
      producerMetadata: (plan) => ({
        ...producerBase,
        ...(plan.turnId === undefined ? {} : { turnId: plan.turnId }),
      }),
    });
    const publisher: DocumentMutationEventPublisher = {
      // Durable outbox delivery is the sole acknowledgement authority. The
      // coordinator records the exact batch first; the runner sends/acks it.
      publishAtomic: () => Promise.resolve({ kind: "not_published" as const }),
    };
    return createDocumentMutationCoordinator({
      backend,
      hashBytes: sha256Hex,
      lockManager: this.lockManager,
      allocateRevisionGroupId: () => this.newRevisionGroupId(),
      eventPublisher: publisher,
      humanEditAdmission: createHumanEditAdmission(this.humanEditLeases),
    });
  }

  private isCurrent(): boolean {
    return !this.outboxPumpStopped &&
      (this.dependencies.isCurrent?.() ?? true);
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new Error("Desktop editor-save runtime authority generation is stale");
    }
  }

  /** Recovery/retry does not alter a committed save result. Safe to call once. */
  async recoverAtStartup(): Promise<void> {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.assertCurrent();
    await this.dependencies.journal.assertRelayBinding();
    await this.outbox.recoverAtStartup();
    // The runner's startup drain intentionally preserves its historical return
    // type. One final write-free claim discovers a persisted future deadline;
    // an actually empty outbox leaves no timer behind.
    await this.pumpOutbox();
  }

  /**
   * The journal owns due-time admission; this is only an unref'd wakeup so a
   * failed/unknown renderer delivery retries while the Desktop remains up.
   * There is no batch-count ceiling and no loss of the durable startup path.
   */
  private scheduleOutboxPump(nextWakeAt: string): void {
    if (this.outboxPumpStopped) return;
    const parsed = Date.parse(nextWakeAt);
    const wakeAt = Number.isFinite(parsed) ? parsed : Date.now();
    if (
      this.outboxPumpTimer !== undefined &&
      this.outboxPumpTimerAt !== undefined &&
      this.outboxPumpTimerAt <= wakeAt
    ) {
      return;
    }
    if (this.outboxPumpTimer !== undefined) clearTimeout(this.outboxPumpTimer);
    this.outboxPumpTimerAt = wakeAt;
    this.outboxPumpTimer = setTimeout(() => {
      this.outboxPumpTimer = undefined;
      this.outboxPumpTimerAt = undefined;
      this.requestOutboxPump();
    }, Math.max(0, wakeAt - Date.now()));
    this.outboxPumpTimer.unref?.();
  }

  private requestOutboxPump(): void {
    if (this.outboxPumpStopped) return;
    if (this.outboxPumpTimer !== undefined) {
      clearTimeout(this.outboxPumpTimer);
      this.outboxPumpTimer = undefined;
      this.outboxPumpTimerAt = undefined;
    }
    if (this.outboxPumpRunning !== undefined) {
      this.outboxPumpRequested = true;
      return;
    }
    void this.pumpOutbox();
  }

  private pumpOutbox(): Promise<void> {
    if (this.outboxPumpRunning !== undefined) {
      this.outboxPumpRequested = true;
      return this.outboxPumpRunning;
    }
    const running = this.runOutboxPump().finally(() => {
      this.outboxPumpRunning = undefined;
      if (this.outboxPumpRequested && this.isCurrent()) {
        this.outboxPumpRequested = false;
        this.requestOutboxPump();
      }
    });
    this.outboxPumpRunning = running;
    return running;
  }

  private async runOutboxPump(): Promise<void> {
    try {
      // One wake drains every currently dispatchable batch. Stop on idle,
      // retry, invalid, or finalization-unknown: those outcomes need a later
      // due time/reconciliation and must not make a hot loop.
      for (;;) {
        if (!this.isCurrent()) break;
        const outcome = await this.outbox.runOnce();
        if (!this.isCurrent()) break;
        if (outcome.kind === "dispatched") continue;
        if (outcome.nextWakeAt !== undefined) {
          this.scheduleOutboxPump(outcome.nextWakeAt);
        }
        break;
      }
    } catch {
      // A transient read/runner failure has no persisted deadline result. Use
      // a bounded error retry, never the former successful-idle poll loop.
      this.scheduleOutboxPump(new Date(
        Date.now() + (this.dependencies.outboxWakeIntervalMs ?? 30_000),
      ).toISOString());
    }
  }

  /** Main-process shutdown/test seam; durable pending batches remain intact. */
  stopOutboxPump(): void {
    this.outboxPumpStopped = true;
    if (this.outboxPumpTimer !== undefined) {
      clearTimeout(this.outboxPumpTimer);
      this.outboxPumpTimer = undefined;
      this.outboxPumpTimerAt = undefined;
    }
    this.outboxPumpRequested = false;
  }

  /**
   * Read the newest still-active, existing-file agent update for one trusted
   * path. This is a receipt only: it never writes the document or journal.
   */
  async readAuthoredChange(input: {
    readonly path: string;
    readonly expectedSha256: string;
  }): Promise<DesktopAuthoredChangeResult> {
    try {
      this.assertCurrent();
      if (!validSha(input.expectedSha256)) {
        return { kind: "unavailable", code: "invalid_expected_sha256" };
      }
      const [relayId, humanId] = await Promise.all([
        this.dependencies.getTrustedRelayId(),
        this.dependencies.getTrustedHumanId(),
      ]);
      trustedId(relayId, "configured Desktop relay identity");
      trustedId(humanId, "trusted Desktop human identity");
      const assertTrustedAuthority = async (): Promise<void> => {
        const [currentRelayId, currentHumanId] = await Promise.all([
          this.dependencies.getTrustedRelayId(),
          this.dependencies.getTrustedHumanId(),
        ]);
        if (currentRelayId !== relayId || currentHumanId !== humanId) {
          throw new Error("Desktop authored-change authority changed during read");
        }
        this.assertCurrent();
      };
      this.assertCurrent();

      const canonicalPath = await this.dependencies.fileAdapter.resolveTarget(
        input.path,
        { allowMissing: false, rejectFinalSymlink: true },
      );
      const stat = await this.dependencies.fileAdapter.stat(canonicalPath);
      if (stat === null || !stat.isFile || stat.isSymbolicLink) {
        return { kind: "unavailable", code: "file_unavailable" };
      }
      const currentBytes = new Uint8Array(
        await this.dependencies.fileAdapter.readFile(canonicalPath),
      );
      const currentSha256 = sha256Hex(currentBytes);
      if (currentSha256 !== input.expectedSha256) {
        return { kind: "unavailable", code: "expected_sha256_mismatch" };
      }
      await assertTrustedAuthority();

      let authored: Awaited<ReturnType<LocalDurableMutationJournal["readAuthoredChangeCandidate"]>>;
      try {
        authored = await this.dependencies.journal
          .readAuthoredChangeCandidate(canonicalPath);
      } catch {
        return { kind: "unavailable", code: "history_unavailable" };
      }
      await assertTrustedAuthority();
      if (authored.candidate === null) return { kind: "none" };
      const candidate = authored.candidate;
      if (authored.latestSha256 !== currentSha256) {
        return { kind: "unavailable", code: "history_drift" };
      }

      const confirmedBytes = new Uint8Array(
        await this.dependencies.fileAdapter.readFile(canonicalPath),
      );
      if (sha256Hex(confirmedBytes) !== currentSha256) {
        return { kind: "unavailable", code: "authority_drift" };
      }
      await assertTrustedAuthority();

      const before = candidate.locations[0]!.before;
      const after = candidate.locations[0]!.after;
      if (before.kind !== "bytes" || after.kind !== "bytes") {
        return { kind: "unavailable", code: "history_shape_unsupported" };
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      return {
        kind: "ready",
        operationId: candidate.operationId,
        author: { kind: "agent", displayName: "Genie" },
        before: { content: decoder.decode(before.bytes), sha256: before.sha256 },
        after: { content: decoder.decode(after.bytes), sha256: after.sha256 },
        currentSha256,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "file_unavailable"
        : "history_unavailable";
      return { kind: "unavailable", code };
    }
  }

  /**
   * Resolve only a trusted local-file lease target. Renderer relay/path values
   * are correlation hints: main derives the active relay, canonicalizes via
   * the existing allowed-root adapter, and snapshots the real bytes.
   */
  private async resolveLocalLeaseTarget(
    candidate: Extract<HumanEditLeaseCandidateTarget, { kind: "local_file" }>,
  ): Promise<
    | { readonly ok: true; readonly humanId: string; readonly identity: LocalDocumentIdentity; readonly bytes: Uint8Array }
    | { readonly ok: false; readonly result: HumanEditLeaseStoreResult }
  > {
    try {
      this.assertCurrent();
      const [relayId, humanId] = await Promise.all([
        this.dependencies.getTrustedRelayId(),
        this.dependencies.getTrustedHumanId(),
      ]);
      this.assertCurrent();
      const trustedRelayId = trustedId(relayId, "configured Desktop relay identity");
      const trustedHumanId = trustedId(humanId, "trusted Desktop human identity");
      if (candidate.relayId !== trustedRelayId) {
        return { ok: false, result: { status: "invalid", reason: "local lease relay does not match the active Desktop relay" } };
      }
      const canonicalPath = await this.dependencies.fileAdapter.resolveTarget(
        candidate.candidatePath,
        { allowMissing: false, rejectFinalSymlink: true },
      );
      const stat = await this.dependencies.fileAdapter.stat(canonicalPath);
      if (stat === null || !stat.isFile || stat.isSymbolicLink) {
        return { ok: false, result: { status: "invalid", reason: "local lease target is not a regular allowed file" } };
      }
      const bytes = new Uint8Array(await this.dependencies.fileAdapter.readFile(canonicalPath));
      this.assertCurrent();
      return {
        ok: true,
        humanId: trustedHumanId,
        identity: { kind: "local_file", relayId: trustedRelayId, canonicalPath },
        bytes,
      };
    } catch (error) {
      return {
        ok: false,
        result: {
          status: "invalid",
          reason: error instanceof Error ? error.message : "local lease target is unavailable",
        },
      };
    }
  }

  private static leaseVersion(target: { readonly identity: LocalDocumentIdentity; readonly bytes: Uint8Array }) {
    return currentVersion(target.identity, sha256Hex(target.bytes));
  }

  private static leaseDraftFailure(input: {
    readonly bytes: Uint8Array;
    readonly state: "clean" | "dirty" | "saving" | "conflict";
    readonly draftPatch?: AnchoredTextPatch;
  }): HumanEditLeaseStoreResult | null {
    if (input.draftPatch === undefined || input.state === "conflict") return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      return { status: "invalid", reason: "draft patch requires a UTF-8 document snapshot" };
    }
    const applied = applyAnchoredTextPatch(text, input.draftPatch);
    return applied.ok ? null : { status: "invalid", reason: `draft patch cannot rebase: ${applied.reason}` };
  }

  private hasBoundLocalLease(input: {
    readonly identity: LocalDocumentIdentity;
    readonly leaseId: string;
    readonly humanId: string;
    readonly sessionId: string;
  }): boolean {
    return this.humanEditLeases.getForIdentity(input.identity).some((record) =>
      record.lease.leaseId === input.leaseId &&
      record.lease.humanId === input.humanId &&
      record.lease.sessionId === input.sessionId,
    );
  }

  async registerHumanEditLease(input: unknown): Promise<HumanEditLeaseStoreResult> {
    const parsed = registerHumanEditLeaseRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.target.kind !== "local_file") {
      return { status: "invalid", reason: "Desktop local lease registration requires a local-file target" };
    }
    const initial = await this.resolveLocalLeaseTarget(parsed.data.target);
    if (!initial.ok) return initial.result;
    const lock = await this.lockManager.acquire(deriveDocumentIdentityLockKeys(initial.identity));
    try {
      const target = await this.resolveLocalLeaseTarget(parsed.data.target);
      if (!target.ok) return target.result;
      if (target.identity.canonicalPath !== initial.identity.canonicalPath) {
        return { status: "invalid", reason: "local lease target changed while acquiring its lock" };
      }
      const draftFailure = DesktopDocumentMutationRuntime.leaseDraftFailure({
        bytes: target.bytes,
        state: parsed.data.state,
        ...(parsed.data.draftPatch === undefined ? {} : { draftPatch: parsed.data.draftPatch }),
      });
      if (draftFailure) return draftFailure;
      return this.humanEditLeases.register({
        sessionId: parsed.data.sessionId,
        humanId: target.humanId,
        identity: target.identity,
        baseVersion: DesktopDocumentMutationRuntime.leaseVersion(target),
        state: parsed.data.state,
        ...(parsed.data.draftPatch === undefined ? {} : { draftPatch: parsed.data.draftPatch }),
      });
    } finally {
      await lock.release();
    }
  }

  async updateHumanEditLease(leaseId: string, input: unknown): Promise<HumanEditLeaseStoreResult> {
    const parsed = updateHumanEditLeaseRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.target.kind !== "local_file" || leaseId.trim().length === 0) {
      return { status: "invalid", reason: "Desktop local lease update is invalid" };
    }
    const initial = await this.resolveLocalLeaseTarget(parsed.data.target);
    if (!initial.ok) return initial.result;
    const lock = await this.lockManager.acquire(deriveDocumentIdentityLockKeys(initial.identity));
    try {
      const target = await this.resolveLocalLeaseTarget(parsed.data.target);
      if (!target.ok) return target.result;
      if (target.identity.canonicalPath !== initial.identity.canonicalPath) {
        return { status: "invalid", reason: "local lease target changed while acquiring its lock" };
      }
      if (!this.hasBoundLocalLease({
        identity: target.identity, leaseId, humanId: target.humanId, sessionId: parsed.data.sessionId,
      })) return { status: "not_found" };
      const draftFailure = DesktopDocumentMutationRuntime.leaseDraftFailure({
        bytes: target.bytes,
        state: parsed.data.state,
        ...(parsed.data.draftPatch === undefined ? {} : { draftPatch: parsed.data.draftPatch }),
      });
      if (draftFailure) return draftFailure;
      return this.humanEditLeases.update({
        leaseId,
        sessionId: parsed.data.sessionId,
        humanId: target.humanId,
        expectedGeneration: parsed.data.expectedGeneration,
        baseVersion: DesktopDocumentMutationRuntime.leaseVersion(target),
        state: parsed.data.state,
        ...(parsed.data.draftPatch === undefined ? {} : { draftPatch: parsed.data.draftPatch }),
      });
    } finally {
      await lock.release();
    }
  }

  async renewHumanEditLease(leaseId: string, input: unknown): Promise<HumanEditLeaseStoreResult> {
    const parsed = renewHumanEditLeaseRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.target.kind !== "local_file" || leaseId.trim().length === 0) {
      return { status: "invalid", reason: "Desktop local lease renewal is invalid" };
    }
    const target = await this.resolveLocalLeaseTarget(parsed.data.target);
    if (!target.ok) return target.result;
    const lock = await this.lockManager.acquire(deriveDocumentIdentityLockKeys(target.identity));
    try {
      const current = await this.resolveLocalLeaseTarget(parsed.data.target);
      if (!current.ok) return current.result;
      if (current.identity.canonicalPath !== target.identity.canonicalPath) {
        return { status: "invalid", reason: "local lease target changed while acquiring its lock" };
      }
      if (!this.hasBoundLocalLease({
        identity: current.identity, leaseId, humanId: current.humanId, sessionId: parsed.data.sessionId,
      })) return { status: "not_found" };
      return this.humanEditLeases.renew({
        leaseId,
        sessionId: parsed.data.sessionId,
        humanId: current.humanId,
        expectedGeneration: parsed.data.expectedGeneration,
      });
    } finally {
      await lock.release();
    }
  }

  async releaseHumanEditLease(leaseId: string, input: unknown): Promise<HumanEditLeaseStoreResult> {
    const parsed = releaseHumanEditLeaseRequestSchema.safeParse(input);
    if (!parsed.success || leaseId.trim().length === 0) {
      return { status: "invalid", reason: "Desktop local lease release is invalid" };
    }
    let humanId: string;
    try {
      humanId = trustedId(await this.dependencies.getTrustedHumanId(), "trusted Desktop human identity");
      this.assertCurrent();
    } catch (error) {
      return { status: "invalid", reason: error instanceof Error ? error.message : "Desktop lease authority is unavailable" };
    }
    const held = this.humanEditLeases.getByLeaseId(leaseId);
    if (held === null || held.lease.identity.kind !== "local_file") return { status: "not_found" };
    if (held.lease.humanId !== humanId || held.lease.sessionId !== parsed.data.sessionId) return { status: "not_found" };
    const lock = await this.lockManager.acquire(deriveDocumentIdentityLockKeys(held.lease.identity));
    try {
      return this.humanEditLeases.release({
        leaseId,
        sessionId: parsed.data.sessionId,
        humanId,
        expectedGeneration: parsed.data.expectedGeneration,
      });
    } finally {
      await lock.release();
    }
  }

  /**
   * Commit exact private-tree apply_patch effects through the same coordinator,
   * backend, durable journal and outbox used by human editor saves.
   */
  async commitApplyPatch(input: {
    readonly root: string;
    readonly agentId: string;
    readonly turnId: string;
    readonly operations: readonly WorkspaceApplyPatchOperationReconciliation[];
    readonly reauthorize: () => Promise<void>;
  }): Promise<WorkspaceCommitResult> {
    try {
      this.assertCurrent();
      const relayId = trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      );
      const agentId = trustedId(input.agentId, "trusted Desktop agent identity");
      const turnId = trustedId(input.turnId, "trusted Desktop turn identity");
      const root = await this.dependencies.fileAdapter.canonicalize(input.root);
      const identity = async (
        logicalPath: string,
      ): Promise<LocalDocumentIdentity> => {
        const canonicalPath = await this.dependencies.fileAdapter.canonicalize(
          path.resolve(root, logicalPath),
        );
        const relative = path.relative(root, canonicalPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("apply_patch coordinator path escaped its authorized root");
        }
        return { kind: "local_file", relayId, canonicalPath };
      };
      const expected = async (
        logicalPath: string,
        bytes: Uint8Array,
      ) => {
        const target = await identity(logicalPath);
        return {
          identity: target,
          expectedVersion: currentVersion(target, sha256Hex(bytes)),
          bytes: new Uint8Array(bytes),
        };
      };
      const postimage = async (
        logicalPath: string,
        bytes: Uint8Array,
      ) => {
        const target = await identity(logicalPath);
        return {
          identity: target,
          sha256: sha256Hex(bytes),
          bytes: new Uint8Array(bytes),
        };
      };

      const entries: DocumentCommitPlan["entries"][number][] = [];
      for (const operation of input.operations) {
        if (operation.operation === "delete") {
          const before = operation.destination.before;
          if (before === null) throw new Error("delete staging preimage is missing");
          entries.push({
            kind: "delete",
            before: await expected(operation.path, before.bytes),
          });
        } else if (operation.operation === "move") {
          const sourceBefore = operation.source.before;
          const after = operation.destination.after;
          if (sourceBefore === null || after === null) {
            throw new Error("move staging image is incomplete");
          }
          entries.push({
            kind: "move",
            source: await expected(operation.fromPath, sourceBefore.bytes),
            ...(operation.destination.before === null
              ? {}
              : {
                  destinationBefore: await expected(
                    operation.path,
                    operation.destination.before.bytes,
                  ),
                }),
            after: await postimage(operation.path, after),
          });
        } else {
          const after = operation.destination.after;
          if (after === null) throw new Error("staged postimage is missing");
          const before = operation.destination.before;
          entries.push(before === null
            ? { kind: "create", after: await postimage(operation.path, after) }
            : {
                kind: "update",
                before: await expected(operation.path, before.bytes),
                after: await postimage(operation.path, after),
              });
        }
      }
      const operationId = `desktop-apply-patch:${createHash("sha256")
        .update(JSON.stringify({
          relayId,
          agentId,
          turnId,
          root,
          operations: input.operations.map((operation) => ({
            operation: operation.operation,
            path: operation.path,
            ...(operation.operation === "move"
              ? { fromPath: operation.fromPath }
              : {}),
            before: operation.operation === "move"
              ? {
                  source: operation.source.before === null
                    ? null
                    : sha256Hex(operation.source.before.bytes),
                  destination: operation.destination.before === null
                    ? null
                    : sha256Hex(operation.destination.before.bytes),
                }
              : operation.destination.before === null
                ? null
                : sha256Hex(operation.destination.before.bytes),
            afterSha: operation.destination.after === null
              ? null
              : sha256Hex(operation.destination.after),
          })),
        }))
        .digest("hex")}`;
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "agent", agentId },
        turnId,
        entries,
      };
      const outcome = await this.createCoordinator(input.reauthorize, {
        operation: "apply_patch",
      }).execute({
        operationId,
        plan,
        lane: "apply_patch",
      });
      if (outcome.kind === "completed") {
        const durable = await this.dependencies.journal.lookupOperation(operationId);
        if (
          durable === null ||
          durable.intent.state !== "committed" ||
          durable.intent.paths.length !== input.operations.length
        ) {
          throw new Error("committed apply_patch durable receipt is unavailable");
        }
        this.requestOutboxPump();
        return {
          ...(outcome.result.kind === "rebased" ? { rebased: true as const } : {}),
          operations: input.operations.map((operation, index) => {
            const revisionIds = durable.intent.paths[index]?.revisionIds;
            if (!revisionIds || revisionIds.length === 0) {
              throw new Error("committed apply_patch revision receipt is incomplete");
            }
            return operation.operation === "move"
              ? {
                  operation: "move" as const,
                  fromPath: operation.fromPath,
                  path: operation.path,
                  state: "committed" as const,
                  revisionIds,
                }
              : {
                  operation: operation.operation,
                  path: operation.path,
                  state: "committed" as const,
                  revisionIds,
                };
          }),
        };
      }
      if (
        outcome.kind === "rejected" &&
        outcome.result.kind === "conflict"
      ) {
        const code = outcome.result.code === "stale_version"
          ? "reapply_required"
          : outcome.result.code;
        return {
          rejected: true,
          operations: [],
          error: {
            code,
            message: code === "human_edit_conflict"
              ? "A local file has an active human edit. Reread the current document and construct a new patch; do not resend this patch."
              : "A local file changed after apply_patch staging. Reread the current document and construct a new patch; do not resend this patch.",
            retryable: false,
          },
        };
      }
      return {
        rejected: true,
        operations: [],
        error: {
          code: "partial_execution",
          message: "The Desktop mutation coordinator could not prove an atomic apply_patch commit.",
          retryable: false,
        },
      };
    } catch (error) {
      return {
        rejected: true,
        operations: [],
        error: {
          code: "runtime_unavailable",
          message: error instanceof Error
            ? error.message
            : "Desktop apply_patch coordinator is unavailable.",
          retryable: true,
        },
      };
    }
  }

  /**
   * OfficeCLI has already generated a validated whole-document binary in its
   * private scratch tree. This is its only authoritative local commit seam:
   * exact target CAS, plus an exact read-only source precondition when output
   * differs from input. OOXML is deliberately never routed through text merge.
   */
  async commitOfficeCli(input: {
    readonly targetPath: string;
    readonly targetBefore: Uint8Array | null;
    readonly after: Uint8Array;
    readonly source?: {
      readonly path: string;
      readonly before: Uint8Array;
    } | undefined;
    readonly agentId: string;
    readonly turnId: string;
    readonly reauthorize: () => Promise<void>;
  }): Promise<DesktopOfficeCliCommitResult> {
    try {
      this.assertCurrent();
      const relayId = trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      );
      const agentId = trustedId(input.agentId, "trusted Desktop agent identity");
      const turnId = trustedId(input.turnId, "trusted Desktop turn identity");
      const targetPath = await this.dependencies.fileAdapter.canonicalize(input.targetPath);
      this.assertCurrent();
      const target: LocalDocumentIdentity = {
        kind: "local_file",
        relayId,
        canonicalPath: targetPath,
      };
      const targetBefore = input.targetBefore === null
        ? null
        : new Uint8Array(input.targetBefore);
      const after = new Uint8Array(input.after);
      const source = input.source === undefined
        ? undefined
        : {
            path: await this.dependencies.fileAdapter.canonicalize(input.source.path),
            before: new Uint8Array(input.source.before),
      };
      this.assertCurrent();
      const sourceIsDistinct = source !== undefined && source.path !== targetPath;
      const operationId = `desktop-officecli:${createHash("sha256")
        .update(JSON.stringify({
          relayId,
          agentId,
          turnId,
          targetPath,
          targetBeforeSha256: targetBefore === null ? null : sha256Hex(targetBefore),
          afterSha256: sha256Hex(after),
          source: source === undefined ? null : {
            path: source.path,
            beforeSha256: sha256Hex(source.before),
          },
        }))
        .digest("hex")}`;
      const afterSnapshot = {
        identity: target,
        sha256: sha256Hex(after),
        bytes: after,
      };
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "agent", agentId },
        turnId,
        ...(sourceIsDistinct
          ? {
              preconditions: [{
                identity: {
                  kind: "local_file" as const,
                  relayId,
                  canonicalPath: source.path,
                },
                expectedVersion: currentVersion(
                  {
                    kind: "local_file",
                    relayId,
                    canonicalPath: source.path,
                  },
                  sha256Hex(source.before),
                ),
                bytes: source.before,
              }],
            }
          : {}),
        entries: [targetBefore === null
          ? { kind: "create", after: afterSnapshot }
          : {
              kind: "update",
              before: {
                identity: target,
                expectedVersion: currentVersion(target, sha256Hex(targetBefore)),
                bytes: targetBefore,
              },
              after: afterSnapshot,
            }],
      };
      const outcome = await this.createCoordinator(input.reauthorize, {
        operation: "officecli",
      }).execute({
        operationId,
        plan,
        lane: "officecli",
      });
      if (outcome.kind === "completed") {
        const durable = await this.dependencies.journal.lookupOperation(operationId);
        const receipt = durable?.intent.paths[0];
        if (
          durable === null ||
          durable.intent.state !== "committed" ||
          durable.intent.paths.length !== 1 ||
          receipt === undefined ||
          receipt.revisionIds.length !== 1
        ) {
          throw new Error("committed OfficeCLI durable V2 receipt is unavailable");
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: durable.intent.revisionGroupId,
          revisionId: receipt.revisionIds[0]!,
          sha256: sha256Hex(after),
          byteLength: after.byteLength,
        };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
        return {
          ok: false,
          code: "conflict",
          message: "A local Office document changed after OfficeCLI staging; reread and regenerate the document.",
        };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "failed") {
        return {
          ok: false,
          code: "error",
          message: "The staged OfficeCLI source or output is no longer current; reread and regenerate the document.",
        };
      }
      return {
        ok: false,
        code: "error",
        message: "Desktop OfficeCLI coordinator could not prove an atomic commit.",
      };
    } catch (error) {
      return {
        ok: false,
        code: "error",
        message: error instanceof Error ? error.message : "Desktop OfficeCLI coordinator is unavailable.",
      };
    }
  }

  /**
   * Ordinary agent file.write/insert/str_replace and chunked-document commits
   * arrive here only after the relay has resolved its locally authorized
   * canonical path and computed exact pre/postimages. The coordinator remains
   * the sole live-file writer and the V2 journal/outbox the sole commit truth.
   */
  async commitAgentContent(input: {
    readonly targetPath: string;
    readonly authorizedRoots?: readonly string[] | undefined;
    readonly before: Uint8Array | null;
    readonly after: Uint8Array;
    readonly agentId: string;
    readonly turnId: string;
    readonly command: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly replayOnly?: boolean | undefined;
    readonly clientMutationId?: string | undefined;
    readonly reauthorize: () => Promise<void>;
  }): Promise<DesktopAgentContentCommitResult> {
    try {
      this.assertCurrent();
      const relayId = trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      );
      const agentId = trustedId(input.agentId, "trusted Desktop agent identity");
      const turnId = trustedId(input.turnId, "trusted Desktop turn identity");
      const command = trustedId(
        input.command,
        "local file content command",
      ) as LocalCanonicalMutationOperation;
      const mutationRequestId = trustedId(
        input.mutationRequestId,
        "trusted file-tool mutation request identity",
      );
      const semanticDigest = trustedId(
        input.semanticDigest,
        "file-tool mutation semantic digest",
      );
      const operationPrefix = `desktop-file-tool:${createHash("sha256")
        .update(JSON.stringify({
          relayId,
          agentId,
          turnId,
          mutationRequestId,
        }))
        .digest("hex")}:`;
      const operationId = `${operationPrefix}${semanticDigest}`;
      await input.reauthorize();
      this.assertCurrent();
      const prior =
        await this.dependencies.journal.lookupOperationWithPayloads(operationId);
      const alteredPrior = prior ??
        await this.dependencies.journal.lookupOperationWithPayloadsByPrefix(
          operationPrefix,
        );
      if (alteredPrior && alteredPrior.intent.operationId !== operationId) {
        return {
          ok: false,
          code: "error",
          message:
            "stable file-tool mutation request identity is already bound to different command semantics",
        };
      }
      if (prior) {
        const location = prior.locations[0];
        const receipt = prior.intent.paths[0];
        const requestedPath = path.resolve(input.targetPath);
        const authorizedRoots = input.authorizedRoots?.map((root) =>
          path.resolve(root)
        ) ?? [];
        const authorizedRoot = authorizedRoots.find((root) =>
          isPathContained(requestedPath, root)
        );
        const requestedRelative = authorizedRoot === undefined
          ? null
          : path.relative(authorizedRoot, requestedPath);
        const durablePathMatchesRequest = (candidate: string): boolean => {
          if (requestedRelative === null || requestedRelative.length === 0) {
            return false;
          }
          return path.resolve(candidate).endsWith(
            `${path.sep}${requestedRelative}`,
          );
        };
        if (
          authorizedRoots.length === 0 ||
          authorizedRoot === undefined ||
          prior.intent.state !== "committed" ||
          prior.intent.actor.kind !== "agent" ||
          prior.intent.actor.agentId !== agentId ||
          prior.intent.paths.length !== 1 ||
          prior.locations.length !== 1 ||
          !location ||
          !receipt ||
          receipt.canonicalPath !== location.canonicalPath ||
          !durablePathMatchesRequest(receipt.canonicalPath) ||
          location.after.kind !== "bytes" ||
          receipt.revisionIds.length !== 1
        ) {
          throw new Error(
            "durable local file-tool replay does not match its trusted request identity",
          );
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: prior.intent.revisionGroupId,
          revisionId: receipt.revisionIds[0]!,
          sha256: location.after.sha256,
          byteLength: location.after.size,
          replayed: true,
          before: location.before.kind === "bytes"
            ? new Uint8Array(location.before.bytes)
            : null,
          after: new Uint8Array(location.after.bytes),
        };
      }
      if (input.replayOnly) {
        return {
          ok: false,
          code: "reapply_required",
          message:
            "No committed result exists for this exact file-tool retry identity. Reread the current file and construct a new edit.",
        };
      }
      const canonicalPath = await this.dependencies.fileAdapter.canonicalize(
        input.targetPath,
      );
      this.assertCurrent();
      const identity: LocalDocumentIdentity = {
        kind: "local_file",
        relayId,
        canonicalPath,
      };
      const before = input.before === null
        ? null
        : new Uint8Array(input.before);
      const after = new Uint8Array(input.after);
      const beforeSha256 = before === null ? null : sha256Hex(before);
      const afterSha256 = sha256Hex(after);
      const afterSnapshot = {
        identity,
        sha256: afterSha256,
        bytes: after,
      };
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "agent", agentId },
        turnId,
        entries: [before === null
          ? { kind: "create", after: afterSnapshot }
          : {
              kind: "update",
              before: {
                identity,
                expectedVersion: currentVersion(identity, beforeSha256!),
                bytes: before,
              },
              after: afterSnapshot,
            }],
      };
      const outcome = await this.createCoordinator(input.reauthorize, {
        operation: command,
      }).execute({
        operationId,
        plan,
        lane: "file_tool",
      });
      if (outcome.kind === "completed") {
        const durable = await this.dependencies.journal.lookupOperation(operationId);
        const receipt = durable?.intent.paths[0];
        if (
          durable === null ||
          durable.intent.state !== "committed" ||
          durable.intent.paths.length !== 1 ||
          receipt === undefined ||
          receipt.revisionIds.length !== 1
        ) {
          throw new Error("committed local file-tool durable V2 receipt is unavailable");
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: durable.intent.revisionGroupId,
          revisionId: receipt.revisionIds[0]!,
          sha256: afterSha256,
          byteLength: after.byteLength,
          replayed: false,
          before,
          after,
        };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
        if (
          outcome.result.code === "human_edit_conflict" ||
          outcome.result.code === "reapply_required"
        ) {
          return {
            ok: false,
            code: outcome.result.code,
            message: outcome.result.code === "human_edit_conflict"
              ? "A local file has an overlapping active human edit. Reread the current file and construct a new edit; do not blindly retry."
              : "The local file changed while the file-tool mutation was being admitted. Reread the current file and construct a new edit; do not blindly retry.",
          };
        }
        const actualSha256 = outcome.result.evidence[0]?.currentVersion.sha256;
        return {
          ok: false,
          code: "stale_sha256",
          message: "canonical file sha256 does not match the exact local file-tool preimage",
          ...(beforeSha256 === null ? {} : { expectedSha256: beforeSha256 }),
          ...(actualSha256 === undefined ? {} : { actualSha256 }),
        };
      }
      return {
        ok: false,
        code: "error",
        message: "Desktop local file-tool coordinator could not prove an atomic commit.",
      };
    } catch (error) {
      return {
        ok: false,
        code: "error",
        message: error instanceof Error
          ? error.message
          : "Desktop local file-tool coordinator is unavailable.",
      };
    }
  }

  /**
   * Canonical structural file-tool producer. Replay is resolved from durable
   * V2 truth before any source or destination filesystem observation.
   */
  async commitAgentStructural(input: {
    readonly command: "delete" | "move" | "copy";
    readonly sourcePath: string;
    readonly destinationPath?: string | undefined;
    readonly authorizedRoots: readonly string[];
    readonly agentId: string;
    readonly turnId: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly replayOnly?: boolean | undefined;
    readonly reauthorize: () => Promise<void>;
  }): Promise<DesktopAgentStructuralCommitResult> {
    try {
      this.assertCurrent();
      const relayId = trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      );
      const agentId = trustedId(input.agentId, "trusted Desktop agent identity");
      const turnId = trustedId(input.turnId, "trusted Desktop turn identity");
      const mutationRequestId = trustedId(
        input.mutationRequestId,
        "trusted file-tool mutation request identity",
      );
      const semanticDigest = trustedId(
        input.semanticDigest,
        "file-tool mutation semantic digest",
      );
      const sourceRequestPath = path.resolve(input.sourcePath);
      const destinationRequestPath = input.destinationPath === undefined
        ? undefined
        : path.resolve(input.destinationPath);
      if (
        (input.command === "delete" && destinationRequestPath !== undefined) ||
        (input.command !== "delete" && destinationRequestPath === undefined)
      ) {
        throw new Error("structural file-tool command has invalid destination semantics");
      }
      const requestedRoots = input.authorizedRoots.map((root) => path.resolve(root));
      if (
        requestedRoots.length === 0 ||
        !requestedRoots.some((root) => isPathContained(sourceRequestPath, root)) ||
        (
          destinationRequestPath !== undefined &&
          !requestedRoots.some((root) => isPathContained(destinationRequestPath, root))
        )
      ) {
        throw new Error("structural file-tool request is outside authorized roots");
      }
      const operationPrefix = `desktop-file-tool:${createHash("sha256")
        .update(JSON.stringify({ relayId, agentId, turnId, mutationRequestId }))
        .digest("hex")}:`;
      const operationId = `${operationPrefix}${semanticDigest}`;
      await input.reauthorize();
      this.assertCurrent();
      const prior =
        await this.dependencies.journal.lookupOperationWithPayloads(operationId);
      const alteredPrior = prior ??
        await this.dependencies.journal.lookupOperationWithPayloadsByPrefix(
          operationPrefix,
        );
      if (alteredPrior && alteredPrior.intent.operationId !== operationId) {
        return {
          ok: false,
          code: "error",
          message:
            "stable file-tool mutation request identity is already bound to different command semantics",
        };
      }

      const canonicalRoots = async (): Promise<string[]> =>
        Promise.all(requestedRoots.map((root) =>
          this.dependencies.fileAdapter.resolveTarget(root, {
            allowMissing: false,
            rejectFinalSymlink: false,
          })
        ));
      if (prior) {
        const structural = prior.intent.producer?.structural;
        const receipt = prior.intent.paths[0];
        const location = prior.locations[0];
        const roots = await canonicalRoots();
        const durablePaths = [
          structural?.sourceCanonicalPath,
          structural?.destinationCanonicalPath,
          receipt?.canonicalPath,
          receipt?.sourceCanonicalPath,
          ...prior.locations.map((candidate) => candidate.canonicalPath),
        ].filter((candidate): candidate is string => candidate !== undefined);
        if (
          prior.intent.state !== "committed" ||
          prior.intent.actor.kind !== "agent" ||
          prior.intent.actor.agentId !== agentId ||
          prior.intent.producer?.operation !== input.command ||
          prior.intent.producer.turnId !== turnId ||
          structural?.command !== input.command ||
          structural.sourceRequestPath !== sourceRequestPath ||
          structural.destinationRequestPath !== destinationRequestPath ||
          prior.intent.paths.length !== 1 ||
          prior.locations.length === 0 ||
          receipt === undefined ||
          receipt.revisionIds.length !== 1 ||
          location === undefined ||
          durablePaths.some((candidate) =>
            !roots.some((root) => isPathContained(candidate, root))
          )
        ) {
          throw new Error(
            "durable structural file-tool replay does not match its trusted request identity",
          );
        }
        let replaySha256: string | null = null;
        let replayByteLength = 0;
        if (input.command !== "delete") {
          const postLocation = prior.locations.find((candidate) =>
            candidate.canonicalPath === structural.destinationCanonicalPath &&
            candidate.after.kind === "bytes"
          );
          if (postLocation?.after.kind !== "bytes") {
            throw new Error("durable structural file-tool replay postimage is unavailable");
          }
          replaySha256 = postLocation.after.sha256;
          replayByteLength = postLocation.after.size;
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: prior.intent.revisionGroupId,
          revisionId: receipt.revisionIds[0]!,
          command: input.command,
          sourceCanonicalPath: structural.sourceCanonicalPath,
          ...(structural.destinationCanonicalPath === undefined
            ? {}
            : { destinationCanonicalPath: structural.destinationCanonicalPath }),
          sha256: replaySha256,
          byteLength: replayByteLength,
          replayed: true,
        };
      }
      if (input.replayOnly) {
        return {
          ok: false,
          code: "reapply_required",
          message:
            "No committed result exists for this exact structural retry identity. Reread current filesystem state and issue a new edit.",
        };
      }

      const roots = await canonicalRoots();
      const sourceCanonicalPath = await this.dependencies.fileAdapter.resolveTarget(
        sourceRequestPath,
        { allowMissing: false, rejectFinalSymlink: true },
      );
      const sourceStat = await this.dependencies.fileAdapter.stat(sourceCanonicalPath);
      if (!sourceStat?.isFile || sourceStat.isSymbolicLink) {
        return {
          ok: false,
          code: "source_missing",
          message: "structural source must be an existing regular file",
        };
      }
      const sourceBytes = await this.dependencies.fileAdapter.readFile(
        sourceCanonicalPath,
      );
      let destinationCanonicalPath: string | undefined;
      if (destinationRequestPath !== undefined) {
        const initialDestination =
          await this.dependencies.fileAdapter.resolveTarget(destinationRequestPath, {
            allowMissing: true,
            rejectFinalSymlink: true,
          });
        const initialStat = await this.dependencies.fileAdapter.stat(initialDestination);
        if (initialStat?.isDirectory) {
          destinationCanonicalPath =
            await this.dependencies.fileAdapter.resolveTarget(
              path.join(destinationRequestPath, path.basename(sourceRequestPath)),
              { allowMissing: true, rejectFinalSymlink: true },
            );
        } else if (initialStat !== null) {
          return {
            ok: false,
            code: "destination_exists",
            message: "structural destination already exists",
          };
        } else {
          destinationCanonicalPath = initialDestination;
        }
        if (await this.dependencies.fileAdapter.stat(destinationCanonicalPath)) {
          return {
            ok: false,
            code: "destination_exists",
            message: "structural destination already exists",
          };
        }
      }
      if (
        !roots.some((root) => isPathContained(sourceCanonicalPath, root)) ||
        (
          destinationCanonicalPath !== undefined &&
          !roots.some((root) => isPathContained(destinationCanonicalPath, root))
        )
      ) {
        throw new Error("canonical structural file-tool path escaped authorized roots");
      }
      if (input.command === "copy" && looksLikeBinaryBytes(sourceBytes)) {
        return {
          ok: false,
          code: "binary_source",
          message: "local file copy only supports text files",
        };
      }
      const sourceIdentity: LocalDocumentIdentity = {
        kind: "local_file",
        relayId,
        canonicalPath: sourceCanonicalPath,
      };
      const sourceExpected = {
        identity: sourceIdentity,
        expectedVersion: currentVersion(sourceIdentity, sha256Hex(sourceBytes)),
        bytes: new Uint8Array(sourceBytes),
      };
      const destinationIdentity: LocalDocumentIdentity | undefined =
        destinationCanonicalPath === undefined
          ? undefined
          : {
              kind: "local_file",
              relayId,
              canonicalPath: destinationCanonicalPath,
            };
      const destinationAfter = destinationIdentity === undefined
        ? undefined
        : {
            identity: destinationIdentity,
            sha256: sha256Hex(sourceBytes),
            bytes: new Uint8Array(sourceBytes),
          };
      const entries: DocumentCommitPlan["entries"] = input.command === "delete"
        ? [{ kind: "delete", before: sourceExpected }]
        : input.command === "move"
        ? [{ kind: "move", source: sourceExpected, after: destinationAfter! }]
        : [{ kind: "create", after: destinationAfter! }];
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "agent", agentId },
        turnId,
        ...(input.command === "copy" ? { preconditions: [sourceExpected] } : {}),
        entries,
      };
      const outcome = await this.createCoordinator(input.reauthorize, {
        operation: input.command,
        structural: {
          command: input.command,
          sourceRequestPath,
          sourceCanonicalPath,
          ...(destinationRequestPath === undefined
            ? {}
            : { destinationRequestPath }),
          ...(destinationCanonicalPath === undefined
            ? {}
            : { destinationCanonicalPath }),
        },
      }).execute({ operationId, plan, lane: "file_tool" });
      if (outcome.kind === "completed") {
        const durable = await this.dependencies.journal.lookupOperation(operationId);
        const receipt = durable?.intent.paths[0];
        if (
          durable === null ||
          durable.intent.state !== "committed" ||
          durable.intent.paths.length !== 1 ||
          receipt === undefined ||
          receipt.revisionIds.length !== 1
        ) {
          throw new Error("committed structural file-tool V2 receipt is unavailable");
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: durable.intent.revisionGroupId,
          revisionId: receipt.revisionIds[0]!,
          command: input.command,
          sourceCanonicalPath,
          ...(destinationCanonicalPath === undefined
            ? {}
            : { destinationCanonicalPath }),
          sha256: input.command === "delete" ? null : sha256Hex(sourceBytes),
          byteLength: input.command === "delete" ? 0 : sourceBytes.byteLength,
          replayed: false,
        };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
        if (
          outcome.result.code === "human_edit_conflict" ||
          outcome.result.code === "reapply_required"
        ) {
          return {
            ok: false,
            code: outcome.result.code,
            message:
              "A local human edit changed while the structural mutation was admitted. Reread current filesystem state and issue a new edit.",
          };
        }
        return {
          ok: false,
          code: "reapply_required",
          message:
            "Structural source or destination changed before commit. Reread current filesystem state and issue a new edit.",
        };
      }
      return {
        ok: false,
        code: "error",
        message: "Desktop structural file-tool coordinator could not prove an atomic commit.",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        code: code === "ENOENT" ? "source_missing" : "error",
        message: error instanceof Error
          ? error.message
          : "Desktop structural file-tool coordinator is unavailable.",
      };
    }
  }

  /**
   * Canonical undo/redo producer. Selection reads immutable V1/V2 history,
   * while every restore is one new V2 coordinator commit.
   */
  async commitHistoryRestore(input: {
    readonly action: "undo" | "redo" | "undo_turn";
    readonly targetPath?: string | undefined;
    readonly revisionId?: string | undefined;
    readonly targetTurnId?: string | undefined;
    readonly agentId: string;
    readonly turnId: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly authorizedRoots: readonly string[];
    readonly replayOnly?: boolean | undefined;
    readonly reauthorize: () => Promise<void>;
  }): Promise<DesktopHistoryRestoreResult> {
    try {
      this.assertCurrent();
      const relayId = trustedId(
        await this.dependencies.getTrustedRelayId(),
        "configured Desktop relay identity",
      );
      const agentId = trustedId(input.agentId, "trusted Desktop agent identity");
      const turnId = trustedId(input.turnId, "trusted Desktop turn identity");
      const mutationRequestId = trustedId(
        input.mutationRequestId,
        "trusted file-tool mutation request identity",
      );
      const semanticDigest = trustedId(
        input.semanticDigest,
        "history mutation semantic digest",
      );
      if (input.authorizedRoots.length === 0) {
        throw new Error("history mutation has no authorized roots");
      }
      const operationPrefix = `desktop-history:${createHash("sha256")
        .update(JSON.stringify({
          relayId,
          agentId,
          turnId,
          mutationRequestId,
        }))
        .digest("hex")}:`;
      const operationId = `${operationPrefix}${semanticDigest}`;
      await input.reauthorize();
      this.assertCurrent();
      const replay =
        await this.dependencies.journal.lookupOperationWithPayloads(operationId);
      const alteredReplay = replay ??
        await this.dependencies.journal.lookupOperationWithPayloadsByPrefix(
          operationPrefix,
        );
      if (alteredReplay && alteredReplay.intent.operationId !== operationId) {
        return {
          ok: false,
          code: "error",
          message:
            "stable history mutation request identity is already bound to different command semantics",
          };
      }
      const authorizedRoots = await Promise.all(
        input.authorizedRoots.map((root) =>
          this.dependencies.fileAdapter.resolveTarget(root, {
            allowMissing: false,
            rejectFinalSymlink: true,
          })
        ),
      );
      const isAuthorized = (canonicalPath: string) =>
        authorizedRoots.some((root) => isPathContained(canonicalPath, root));
      if (replay) {
        const producer = replay.intent.producer;
        if (
          replay.intent.state !== "committed" ||
          replay.intent.actor.kind !== "agent" ||
          replay.intent.actor.agentId !== agentId ||
          producer?.history === undefined ||
          producer.history.action !==
            (input.action === "undo_turn" ? "undo" : input.action) ||
          (input.targetTurnId !== undefined &&
            producer.history.targetTurnId !== input.targetTurnId)
        ) {
          throw new Error(
            "durable history replay does not match its trusted request identity",
          );
        }
        if (
          replay.intent.paths.some((entry) =>
            entry.locations.some((location) =>
              !isAuthorized(location.canonicalPath)
            )
          )
        ) {
          throw new Error(
            "durable history replay contains a path outside the current authorized roots",
          );
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: replay.intent.revisionGroupId,
          revisions: replay.intent.paths.map((entry) => {
            const location = entry.locations[0]!;
            return {
              revisionId: entry.revisionIds[0]!,
              canonicalPath: location.canonicalPath,
              sha256: location.after.kind === "bytes"
                ? location.after.sha256
                : null,
            };
          }),
          replayed: true,
        };
      }
      if (input.replayOnly) {
        return {
          ok: false,
          code: "reapply_required",
          message:
            "No committed result exists for this exact history retry identity. Reread history and construct a new request.",
        };
      }

      const records = await this.dependencies.journal
        .readCanonicalHistoryRecords();
      const stacks = deriveLocalHistoryStacks(records);
      let selected: CanonicalLocalHistoryRecord[];
      if (input.action === "undo_turn") {
        const targetTurnId = trustedId(
          input.targetTurnId,
          "history target turn identity",
        );
        const selectedById = new Map<string, CanonicalLocalHistoryRecord>();
        for (const [canonicalPath, stack] of stacks) {
          const firstTargetIndex = stack.undo.findIndex((record) =>
            record.actor.kind === "agent" &&
            record.actor.agentId === agentId &&
            record.turnId === targetTurnId
          );
          if (firstTargetIndex < 0) continue;
          const suffix = stack.undo.slice(firstTargetIndex);
          if (
            suffix.some((record) =>
              record.actor.kind !== "agent" ||
              record.actor.agentId !== agentId ||
              record.turnId !== targetTurnId
            )
          ) {
            return {
              ok: false,
              code: "reapply_required",
              message:
                "a later or interleaved mutation exists on a target-turn path; current work wins",
              canonicalPath,
            };
          }
          suffix.forEach((record) =>
            selectedById.set(record.revisionId, record)
          );
        }
        selected = [...selectedById.values()];
        if (selected.length === 0) {
          return {
            ok: false,
            code: "no_revisions_for_turn",
            message: "no revisions for target turn",
          };
        }
      } else {
        const targetPath = trustedId(input.targetPath, "history target path");
        const canonicalPath = await this.dependencies.fileAdapter.resolveTarget(
          targetPath,
          { allowMissing: true, rejectFinalSymlink: true },
        );
        const stack = stacks.get(canonicalPath);
        if (!stack || (stack.undo.length === 0 && stack.redo.length === 0)) {
          return {
            ok: false,
            code: "no_revisions",
            message: "no revisions recorded for this file",
            canonicalPath,
          };
        }
        if (input.action === "redo") {
          const latest = stack.redo.at(-1);
          if (
            !latest ||
            latest.actor.kind !== "agent" ||
            latest.actor.agentId !== agentId
          ) {
            return {
              ok: false,
              code: "nothing_to_redo",
              message: "no redo-eligible revisions for this file",
              canonicalPath,
            };
          }
          selected = [latest];
        } else if (input.revisionId !== undefined) {
          const match = stack.undo.find((record) =>
            record.revisionId === input.revisionId ||
            record.revisionRef === input.revisionId
          );
          if (!match) {
            return {
              ok: false,
              code: "revision_not_found",
              message: "target revision not found",
              canonicalPath,
            };
          }
          if (stack.undo.at(-1)?.revisionId !== match.revisionId) {
            return {
              ok: false,
              code: "reapply_required",
              message:
                "a later active mutation exists on the selected history path; current work wins",
              canonicalPath,
            };
          }
          selected = [match];
        } else if (input.targetTurnId !== undefined) {
          const match = stack.undo.at(-1);
          if (
            !match ||
            match.actor.kind !== "agent" ||
            match.actor.agentId !== agentId ||
            match.turnId !== input.targetTurnId
          ) {
            return {
              ok: false,
              code: "revision_not_found",
              message: "target turn revision not found",
              canonicalPath,
            };
          }
          selected = [match];
        } else {
          const match = stack.undo.at(-1);
          if (
            !match ||
            match.actor.kind !== "agent" ||
            match.actor.agentId !== agentId
          ) {
            return {
              ok: false,
              code: "no_revisions",
              message: "no active revisions recorded for this agent and file",
              canonicalPath,
            };
          }
          selected = [match];
        }
      }

      if (selected.length === 1 && selected[0]?.history !== undefined) {
        const restoreOperationId = selected[0].operationId;
        selected = records.filter((record) =>
          record.operationId === restoreOperationId
        );
      }
      selected.sort((left, right) =>
        left.historySequence - right.historySequence ||
        left.operationId.localeCompare(right.operationId) ||
        left.revisionId.localeCompare(right.revisionId)
      );
      const byPath = new Map<string, Array<{
        record: CanonicalLocalHistoryRecord;
        location: CanonicalLocalHistoryRecord["locations"][number];
      }>>();
      for (const record of selected) {
        for (const location of record.locations) {
          const pathRecords = byPath.get(location.canonicalPath) ?? [];
          pathRecords.push({ record, location });
          byPath.set(location.canonicalPath, pathRecords);
        }
      }

      const planEntries: DocumentCommitPlan["entries"][number][] = [];
      for (const [canonicalPath, pathRecords] of [...byPath.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        if (!isAuthorized(canonicalPath)) {
          return {
            ok: false,
            code: "reapply_required",
            message:
              "selected history includes a path outside the current authorized roots",
            canonicalPath,
          };
        }
        for (let index = 1; index < pathRecords.length; index += 1) {
          if (!sameFileState(
            pathRecords[index - 1]!.location.after,
            pathRecords[index]!.location.before,
          )) {
            return {
              ok: false,
              code: "reapply_required",
              message:
                "selected history contains a non-contiguous same-path mutation chain",
              canonicalPath,
            };
          }
        }
        const first = pathRecords[0]!;
        const last = pathRecords.at(-1)!;
        const activeStack = stacks.get(canonicalPath);
        const activeSource = input.action === "redo"
          ? activeStack?.redo.at(-1)
          : activeStack?.undo.at(-1);
        if (activeSource?.revisionId !== last.record.revisionId) {
          return {
            ok: false,
            code: "reapply_required",
            message:
              "selected history is no longer the active stack target; current work wins",
            canonicalPath,
          };
        }
        const target = first.location.before;
        const current = last.location.after;
        if (sameFileState(target, current)) continue;
        const identity: LocalDocumentIdentity = {
          kind: "local_file",
          relayId,
          canonicalPath,
        };
        if (current.kind === "missing") {
          if (target.kind !== "bytes") continue;
          planEntries.push({
            kind: "create",
            after: {
              identity,
              sha256: target.sha256,
              bytes: new Uint8Array(target.bytes),
            },
          });
        } else if (target.kind === "missing") {
          planEntries.push({
            kind: "delete",
            before: {
              identity,
              expectedVersion: currentVersion(identity, current.sha256),
              bytes: new Uint8Array(current.bytes),
            },
          });
        } else {
          planEntries.push({
            kind: "update",
            before: {
              identity,
              expectedVersion: currentVersion(identity, current.sha256),
              bytes: new Uint8Array(current.bytes),
            },
            after: {
              identity,
              sha256: target.sha256,
              bytes: new Uint8Array(target.bytes),
            },
          });
        }
      }
      if (planEntries.length === 0) {
        return {
          ok: false,
          code: "reapply_required",
          message: "selected history is already at its target state",
        };
      }

      const history: LocalMutationHistoryMetadata = {
        action: input.action === "redo" ? "redo" : "undo",
        sourceRevisionIds: selected.map((record) => record.revisionId),
        ...(input.targetTurnId === undefined
          ? {}
          : { targetTurnId: input.targetTurnId }),
      };
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "agent", agentId },
        turnId,
        entries: planEntries,
      };
      const outcome = await this.createCoordinator(input.reauthorize, {
        operation: history.action,
        history,
      }).execute({
        operationId,
        plan,
        lane: "file_tool",
      });
      if (outcome.kind === "completed") {
        const durable = await this.dependencies.journal.lookupOperation(
          operationId,
        );
        if (
          durable === null ||
          durable.intent.state !== "committed" ||
          durable.intent.paths.length !== planEntries.length
        ) {
          throw new Error("committed history durable V2 receipt is unavailable");
        }
        this.requestOutboxPump();
        return {
          ok: true,
          operationId,
          revisionGroupId: durable.intent.revisionGroupId,
          revisions: durable.intent.paths.map((entry) => {
            const location = entry.locations[0]!;
            return {
              revisionId: entry.revisionIds[0]!,
              canonicalPath: location.canonicalPath,
              sha256: location.after.kind === "bytes"
                ? location.after.sha256
                : null,
            };
          }),
          replayed: false,
        };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
        if (
          outcome.result.code === "human_edit_conflict" ||
          outcome.result.code === "reapply_required"
        ) {
          return {
            ok: false,
            code: outcome.result.code,
            message:
              "A local human or later edit changed while history restore was admitted. Current work wins; reread and construct a new request.",
          };
        }
        return {
          ok: false,
          code: "reapply_required",
          message:
            "Canonical file state no longer matches the selected history postimage. Current work wins.",
        };
      }
      return {
        ok: false,
        code: "error",
        message: "Desktop history coordinator could not prove an atomic commit",
      };
    } catch (error) {
      return {
        ok: false,
        code: "error",
        message: error instanceof Error
          ? error.message
          : "Desktop history coordinator is unavailable",
      };
    }
  }

  async saveExistingFile(input: {
    readonly path: string;
    readonly content: string;
    readonly baseSha256: string | null;
    readonly correlation?: DesktopEditorSaveCorrelation;
  }): Promise<DesktopEditorSaveResult> {
    if (!this.isCurrent()) {
      return { ok: false, code: "error", message: "Desktop editor-save runtime authority generation is stale" };
    }
    if (!validSha(input.baseSha256)) {
      return { ok: false, code: "error", message: "existing-file editor saves require a base SHA-256" };
    }
    const correlation = parseCorrelation(input.correlation ?? {});
    if (!correlation.ok) return { ok: false, code: "error", message: correlation.message };

    try {
      await this.dependencies.journal.assertRelayBinding();
      this.assertCurrent();
      const [relayId, humanId] = await Promise.all([
        this.dependencies.getTrustedRelayId(),
        this.dependencies.getTrustedHumanId(),
      ]);
      this.assertCurrent();
      const trustedRelayId = trustedId(relayId, "configured Desktop relay identity");
      const trustedHumanId = trustedId(humanId, "trusted Desktop human identity");
      const canonicalPath = await this.dependencies.fileAdapter.canonicalize(input.path);
      this.assertCurrent();
      const identity = { kind: "local_file" as const, relayId: trustedRelayId, canonicalPath };
      const operationId = stableOperationId({
        relayId: trustedRelayId, humanId: trustedHumanId, canonicalPath,
        correlation: input.correlation ?? {},
      }) ?? this.newOperationId();
      const replay = await this.dependencies.journal.lookupOperationWithPayloads(operationId) ??
        await this.dependencies.journal.lookupEditorSaveWithPayloadsByCorrelation({
          humanId: trustedHumanId,
          canonicalPath,
          ...(correlation.value.requestId === undefined
            ? {}
            : { requestId: correlation.value.requestId }),
          ...(correlation.value.clientMutationId === undefined
            ? {}
            : { clientMutationId: correlation.value.clientMutationId }),
        });
      this.assertCurrent();
      if (replay) {
        const location = replay.locations[0];
        const pathTruth = replay.intent.paths[0];
        const event = replay.outbox.batch.events.length === 1
          ? parseDocumentMutationCommittedEvent(replay.outbox.batch.events[0])
          : null;
        const expectedEditorSave = {
          checkpoint: correlation.value.checkpoint,
          ...(correlation.value.requestId === undefined
            ? {}
            : { requestId: correlation.value.requestId }),
          ...(correlation.value.clientMutationId === undefined
            ? {}
            : { clientMutationId: correlation.value.clientMutationId }),
          ...(correlation.value.anchoredPatch === undefined
            ? {}
            : { anchoredPatch: correlation.value.anchoredPatch }),
        };
        const expectedBaseVersion = currentVersion(identity, input.baseSha256);
        if (!location || !pathTruth || replay.intent.actor.kind !== "human" ||
          replay.intent.actor.humanId !== trustedHumanId ||
          replay.intent.operationId !== operationId ||
          replay.outbox.operationId !== operationId ||
          replay.outbox.batch.operationId !== operationId ||
          replay.outbox.revisionGroupId !== replay.intent.revisionGroupId ||
          replay.outbox.batch.revisionGroupId !== replay.intent.revisionGroupId ||
          replay.intent.paths.length !== 1 || replay.locations.length !== 1 ||
          pathTruth.kind !== "update" ||
          pathTruth.canonicalPath !== canonicalPath ||
          location.canonicalPath !== canonicalPath || location.before.kind !== "bytes" || location.after.kind !== "bytes" ||
          input.baseSha256 !== location.before.sha256 ||
          sha256Hex(new TextEncoder().encode(input.content)) !== location.after.sha256 ||
          event === null || event.mutation !== "update" ||
          event.editorSave === undefined ||
          !exactValueEquals(event.before, expectedBaseVersion) ||
          !exactValueEquals(event.editorSave, expectedEditorSave) ||
          (input.correlation?.baseVersion !== undefined &&
            !exactValueEquals(input.correlation.baseVersion, expectedBaseVersion))) {
          return { ok: false, code: "error", message: "stable editor-save identity is already bound to a different request" };
        }
        const beforeVersion = currentVersion(identity, location.before.sha256);
        const replayPlan: DocumentCommitPlan = {
          operationId,
          actor: replay.intent.actor,
          editorSave: {
            kind: "editor_save",
            baseVersion: beforeVersion,
            checkpoint: event.editorSave.checkpoint,
            ...(event.editorSave.requestId === undefined
              ? {}
              : { requestId: event.editorSave.requestId }),
            ...(event.editorSave.clientMutationId === undefined
              ? {}
              : { clientMutationId: event.editorSave.clientMutationId }),
            ...(event.editorSave.anchoredPatch === undefined
              ? {}
              : { anchoredPatch: event.editorSave.anchoredPatch }),
          },
          entries: [{ kind: "update", before: { identity, expectedVersion: beforeVersion, bytes: new Uint8Array(location.before.bytes) }, after: { identity, sha256: location.after.sha256, bytes: new Uint8Array(location.after.bytes) } }],
        };
        this.assertCurrent();
        const outcome = await this.coordinator.execute({ operationId, plan: replayPlan, lane: "editor_save" });
        if (outcome.kind === "completed") {
          this.requestOutboxPump();
          return { ok: true, sha256: location.after.sha256, size: location.after.size };
        }
        return { ok: false, code: "error", message: "durable editor-save replay could not be proven" };
      }
      const stat = await this.dependencies.fileAdapter.stat(canonicalPath);
      this.assertCurrent();
      if (!stat || !stat.isFile || stat.isSymbolicLink) {
        return { ok: false, code: "error", message: "editor update target is not an existing regular file" };
      }
      const before = await this.dependencies.fileAdapter.readFile(canonicalPath);
      this.assertCurrent();
      const beforeSha256 = sha256Hex(before);
      if (beforeSha256 !== input.baseSha256) {
        return { ok: false, code: "conflict", currentSha256: beforeSha256 };
      }
      const baseVersion = currentVersion(identity, input.baseSha256);
      const rawBaseVersion = input.correlation?.baseVersion;
      if (rawBaseVersion !== undefined && !exactValueEquals(rawBaseVersion, baseVersion)) {
        return { ok: false, code: "error", message: "renderer baseVersion does not match trusted local save identity" };
      }
      const after = new TextEncoder().encode(input.content);
      const entry = {
        kind: "update" as const,
        before: { identity, expectedVersion: baseVersion, bytes: new Uint8Array(before) },
        after: { identity, sha256: sha256Hex(after), bytes: after },
      };
      const plan: DocumentCommitPlan = {
        operationId,
        actor: { kind: "human", humanId: trustedHumanId },
        editorSave: {
          kind: "editor_save",
          baseVersion,
          ...correlation.value,
        },
        entries: [entry],
      };
      this.assertCurrent();
      const outcome = await this.coordinator.execute({
        operationId: plan.operationId,
        plan,
        lane: "editor_save",
      });
      if (outcome.kind === "completed") {
        // Best-effort immediate drain. A failure/unknown result leaves the
        // committed batch durable and does not turn a successful save into a
        // false failure; startup recovery will reclaim it.
        this.requestOutboxPump();
        return { ok: true, sha256: entry.after.sha256, size: after.byteLength };
      }
      if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
        const current = outcome.result.evidence[0]?.currentVersion.sha256;
        return { ok: false, code: "conflict", ...(current === undefined ? {} : { currentSha256: current }) };
      }
      return { ok: false, code: "error", message: "Desktop editor save could not be committed" };
    } catch (error) {
      return {
        ok: false,
        code: "error",
        message: error instanceof Error ? error.message : "Desktop editor save failed",
      };
    }
  }
}
