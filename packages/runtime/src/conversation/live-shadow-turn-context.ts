import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "@nautilo/logger";

import {
  PROTECTED_JOURNAL_MAX_EVENTS,
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  StrictShadowEnforcementError,
  enforceStrictShadowDecision,
  requireStrictShadowConsumer,
  type StrictShadowEnforcementPolicy,
  type DataOperationPolicyBinding,
  type ForegroundMemoryContextItem,
  type ForegroundMemoryRepairSelection,
} from "@nautilo/lattice-bridge";
import {
  type LiveShadowAgentTurnExecutionResult,
  type LiveShadowAgentTurnSession,
  type LiveShadowExecutionCapability,
  type ForegroundLiveShadowSessionExecutionCapability,
} from "@nautilo/lattice-bridge/server";

import type { ForegroundTurnCandidate } from "../foreground-turn-lifecycle";
import type { RoomJournalContext } from "../context/build-transcript-context";
import type { RoomHistoryHit } from "../conductor/history-search";
import type {
  ForegroundRecordContextPort,
  ForegroundRecordSelectionResult,
} from
  "@nautilo/reflection/foreground";
import type {
  RecallRecordFreshness,
  RecallRecordsPort,
} from "@nautilo/agent";

export interface LiveShadowTurnContext {
  readonly operationId: string;
  readonly capability: LiveShadowExecutionCapability;
  readonly session: LiveShadowAgentTurnSession | null;
  readonly enforcementPolicy: StrictShadowEnforcementPolicy;
  readonly dataOperationPolicy?: DataOperationPolicyBinding;
  readonly observeBoundary?: (input: Readonly<{
    boundaryId?:
      | "conversation.write.runtime_persist"
      | "conversation.read.foreground_history"
      | "conversation.read.foreground_journal"
      | "conversation.read.foreground_records"
      | "conversation.read.foreground_memory";
    state: "verified" | "waiting_for_authority" | "failed" | "unsupported";
    reason:
      | "none"
      | "publication_failure"
      | "unsupported_operation"
      | "domain_authority_converging"
      | "missing_protected_sibling"
      | "deadline_expired"
      | "integrity_failure";
    retryable?: boolean;
    provenance?: "existing" | "repaired";
    /** Number of exact product entities represented by this observation. */
    selectedCount?: number;
    /** Selected entities first repaired and then verified by this operation. */
    repairedCount?: number;
  }>) => Promise<void>;
}

/** Binds Runtime operations to the current server policy revision. */
export function createLiveShadowDataOperationPolicyBinding(
  readPolicy: () => Promise<StrictShadowEnforcementPolicy>,
): DataOperationPolicyBinding {
  return Object.freeze({
    async resolve() {
      const current = await readPolicy();
      return {
        policy: {
          mode: current.mode,
          shadowBehavior: current.shadowBehavior,
        },
        revalidationToken: current.revision,
      };
    },
    async revalidate(expectedRevision: number) {
      const current = await readPolicy();
      if (current.revision !== expectedRevision) {
        throw new ClassifiedDataOperationError(
          "stale",
          "Protected Runtime policy changed",
        );
      }
    },
  });
}

const storage = new AsyncLocalStorage<LiveShadowTurnContext>();
const FOREGROUND_TOOL_CONTEXT_FALLBACK_RETRY_WINDOW_MS = 30_000;
const FOREGROUND_TOOL_CONTEXT_RETRY_MAX_DELAY_MS = 1_000;

type BoundaryObservation = Parameters<
  NonNullable<LiveShadowTurnContext["observeBoundary"]>
>[0];

function createInvocationBoundaryObserver(input: Readonly<{
  operationId: string;
  observeBoundary?: LiveShadowTurnContext["observeBoundary"];
}>): Readonly<{
  observe: NonNullable<LiveShadowTurnContext["observeBoundary"]>;
  finish(completed: boolean): void;
}> {
  const startedAt = Date.now();
  let observations = 0;
  let selected = 0;
  let existing = 0;
  let repaired = 0;
  let waiting = 0;
  let unsupported = 0;
  let failed = 0;
  let retries = 0;
  const observe = async (observation: BoundaryObservation): Promise<void> => {
    observations += 1;
    const count = observation.selectedCount
      ?? (observation.boundaryId === undefined ? 1 : 0);
    if (observation.state === "verified") {
      const repairedNow = Math.min(
        count,
        observation.repairedCount
          ?? (observation.provenance === "repaired" ? count : 0),
      );
      selected += count;
      repaired += repairedNow;
      existing += count - repairedNow;
    } else if (observation.state === "waiting_for_authority") {
      waiting += count;
      retries += 1;
    } else if (observation.state === "unsupported") {
      selected += count;
      unsupported += count || 1;
    } else {
      selected += count;
      failed += count || 1;
    }
    await input.observeBoundary?.(observation);
  };
  return Object.freeze({
    observe,
    finish(completed: boolean): void {
      if (observations === 0) return;
      log(
        `[live-shadow] foreground context summary operation=${input.operationId}`
          + ` selected=${selected} existing=${existing} repaired=${repaired}`
          + ` waiting=${waiting} unsupported=${unsupported} failed=${failed}`
          + ` retries=${retries} complete=${completed && unsupported === 0 && failed === 0}`
          + ` duration_ms=${Math.max(0, Date.now() - startedAt)}`,
      );
    },
  });
}

function isRetryableForegroundContextError(
  error: unknown,
): error is StrictShadowEnforcementError {
  return error instanceof StrictShadowEnforcementError
    && error.decision.retryable
    && (
      error.decision.state === "waiting_for_authority"
      || error.decision.state === "repairing"
    );
}

async function withForegroundContextCancellation<Value>(input: Readonly<{
  signal?: AbortSignal;
  /** A repair may own product transactions: don't detach them on cancellation. */
  awaitOwnedWorkSettlement?: boolean;
  work(): Promise<Value>;
}>): Promise<Value> {
  const signal = input.signal;
  if (signal === undefined) return input.work();
  signal.throwIfAborted();
  if (input.awaitOwnedWorkSettlement === true) {
    try {
      const value = await input.work();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted();
        reject(new Error("Foreground context preparation was cancelled"));
      } catch (error) {
        reject(error instanceof Error
          ? error
          : new Error("Foreground context preparation was cancelled", {
            cause: error,
          }));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await (signal.aborted
      ? aborted
      : Promise.race([input.work(), aborted]));
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function retryForegroundToolContext<Value>(
  work: () => Promise<Value>,
  authorizationDeadlineAt?: number,
  signal?: AbortSignal,
): Promise<Value> {
  let waitingSince: number | null = null;
  let retryCount = 0;
  while (true) {
    try {
      signal?.throwIfAborted();
      return await withForegroundContextCancellation({
        ...(signal === undefined ? {} : { signal }),
        work,
      });
    } catch (error) {
      if (!isRetryableForegroundContextError(error)) throw error;
      signal?.throwIfAborted();
      const now = Date.now();
      waitingSince ??= now;
      const retryDeadline = authorizationDeadlineAt
        ?? waitingSince + FOREGROUND_TOOL_CONTEXT_FALLBACK_RETRY_WINDOW_MS;
      if (now >= retryDeadline) {
        throw error;
      }
      retryCount += 1;
      const delay = Math.min(
        100 * 2 ** Math.min(retryCount - 1, 4),
        FOREGROUND_TOOL_CONTEXT_RETRY_MAX_DELAY_MS,
        retryDeadline - now,
      );
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timeout = setTimeout(finish, delay);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted === true) finish();
      });
      signal?.throwIfAborted();
    }
  }
}

function requireRuntimeFallbackAllowed(
  policy: StrictShadowEnforcementPolicy,
): void {
  requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
    boundaryId: "conversation.write.foreground",
    family: "message",
    operation: "write",
    actorClass: "agent",
    state: "failed",
    reason: "publication_failure",
    retryable: false,
    policyRevision: policy.revision,
  }));
}

async function withProtectedRecordSelectionDeadline(input: Readonly<{
  signal?: AbortSignal;
  policy: StrictShadowEnforcementPolicy;
  observeBoundary?: LiveShadowTurnContext["observeBoundary"];
  work(): Promise<ForegroundRecordSelectionResult>;
}>): Promise<ForegroundRecordSelectionResult> {
  const signal = input.signal;
  if (signal === undefined) return input.work();
  const deadlineResult = (): ForegroundRecordSelectionResult =>
    Object.freeze({
      status: "unavailable" as const,
      representation: "protected" as const,
      queryEmbeddingStatus: "unavailable" as const,
      reason: "deadline_expired" as const,
    });
  const onDeadline = async (): Promise<ForegroundRecordSelectionResult> => {
    await input.observeBoundary?.({
      boundaryId: "conversation.read.foreground_records",
      state: "failed",
      reason: "deadline_expired",
      retryable: false,
      selectedCount: 0,
    });
    requireStrictShadowConsumer(enforceStrictShadowDecision(input.policy, {
      boundaryId: "conversation.read.foreground_records",
      family: "record",
      operation: "read_repair",
      actorClass: "agent",
      state: "failed",
      reason: "deadline_expired",
      retryable: false,
      policyRevision: input.policy.revision,
    }));
    return deadlineResult();
  };
  if (signal.aborted) {
    if (signal.reason === "foreground_record_context_deadline") {
      return onDeadline();
    }
    signal.throwIfAborted();
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<ForegroundRecordSelectionResult>(
    (resolve, reject) => {
      onAbort = () => {
        if (signal.reason === "foreground_record_context_deadline") {
          void onDeadline().then(resolve, reject);
          return;
        }
        try {
          signal.throwIfAborted();
          reject(new Error("Foreground Record selection was cancelled"));
        } catch (error) {
          reject(error instanceof Error
            ? error
            : new Error("Foreground Record selection was cancelled", {
              cause: error,
            }));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    },
  );
  try {
    const work = input.work().catch((error: unknown) => {
      // An abort owns its typed boundary result, including the asynchronous
      // health write. Late work must not race it with the raw abort reason.
      if (signal.aborted) return aborted;
      throw error;
    });
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
}

function hasForegroundSessionCapability(
  capability: LiveShadowExecutionCapability,
): capability is ForegroundLiveShadowSessionExecutionCapability {
  return "kind" in capability && capability.kind === "foreground_session";
}

/** Exact protected authority of the currently executing live Shadow turn. */
export function getCurrentLiveShadowTurnContext():
  LiveShadowTurnContext | undefined {
  return storage.getStore();
}

function requireCurrentDataOperationPolicy(
  context: LiveShadowTurnContext,
): DataOperationPolicyBinding {
  if (context.dataOperationPolicy === undefined) {
    throw new ClassifiedDataOperationError(
      "authority",
      "Protected Runtime data-operation policy is unavailable",
    );
  }
  const livePolicy = context.dataOperationPolicy;
  return Object.freeze({
    async resolve() {
      const current = await livePolicy.resolve();
      if (
        current.revalidationToken !== context.enforcementPolicy.revision
        || current.policy.mode !== context.enforcementPolicy.mode
        || current.policy.shadowBehavior !== context.enforcementPolicy.shadowBehavior
      ) {
        throw new ClassifiedDataOperationError(
          "stale",
          "Protected foreground Runtime admission policy changed",
        );
      }
      return current;
    },
    revalidate: (token: number) => livePolicy.revalidate(token),
  });
}

/**
 * Re-establish the exact live-Shadow session around a delayed foreground
 * resume. The accepted resume Grant is new, but tools, persistence, and model
 * follow-up must see the same protected Runtime boundary as a fresh turn.
 */
export function runWithLiveShadowTurnSession<Value>(input: Readonly<{
  operationId: string;
  capability: LiveShadowExecutionCapability;
  session: LiveShadowAgentTurnSession;
  enforcementPolicy: StrictShadowEnforcementPolicy;
  dataOperationPolicy?: DataOperationPolicyBinding;
  observeBoundary?: LiveShadowTurnContext["observeBoundary"];
  work(): Promise<Value>;
}>): Promise<Value> {
  return storage.run(Object.freeze({
    operationId: input.operationId,
    capability: input.capability,
    session: input.session,
    enforcementPolicy: input.enforcementPolicy,
    ...(input.dataOperationPolicy === undefined
      ? {} : { dataOperationPolicy: input.dataOperationPolicy }),
    ...(input.observeBoundary === undefined
      ? {}
      : { observeBoundary: input.observeBoundary }),
  }), input.work);
}

/**
 * Gate the legacy plaintext Room-history reader at the actual Runtime
 * consumer. Fallback Shadow records the unsupported protected read and keeps
 * today's single ordinary context build. Strict Shadow records the same fact
 * and fails before transcript, Journal, Record, or model work can consume an
 * ordinary substitute. A foreground repair session satisfies this gate and
 * replaces selected ordinary bytes with verified protected bytes below.
 */
export async function enforceLiveShadowForegroundHistoryBoundary(input: Readonly<{
  roomId: string;
  protectedTurnAvailable: boolean;
}>): Promise<void> {
  const context = storage.getStore();
  if (
    context === undefined
    || input.roomId.length === 0
    || input.protectedTurnAvailable
  ) return;
  const policy = context.enforcementPolicy ?? Object.freeze({
    mode: "shadow_encryption" as const,
    shadowBehavior: "fallback" as const,
    revision: 0,
  });
  await context.observeBoundary?.({
    boundaryId: "conversation.read.foreground_history",
    state: "unsupported",
    reason: "unsupported_operation",
    retryable: false,
    selectedCount: 0,
  });
  requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
    boundaryId: "conversation.read.foreground_history",
    family: "message",
    operation: "read",
    actorClass: "agent",
    state: "unsupported",
    reason: "unsupported_operation",
    retryable: false,
    policyRevision: policy.revision,
  }));
}

/** Replace selected ordinary transcript bytes with verified protected bytes. */
export async function protectLiveShadowForegroundHistory(
  hits: readonly RoomHistoryHit[],
  signal?: AbortSignal,
): Promise<RoomHistoryHit[]> {
  const context = storage.getStore();
  if (context === undefined || hits.length === 0) return [...hits];
  const policy = context.enforcementPolicy;
  const owner = bindEncryptionDataOperationOwner({
    policy: requireCurrentDataOperationPolicy(context),
  });
  let protectedWaiting = false;
  try {
    const read = await owner.read({
      ordinary: () => {
        if (hits.some((hit) => typeof hit.snippet !== "string")) throw new ClassifiedDataOperationError("unsupported", "Ordinary history body is unavailable");
        return Promise.resolve([...hits]);
      },
      protected: async () => {
        if (context.session?.protectForegroundHistory === undefined) {
          protectedWaiting = true;
          await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_history", state: "waiting_for_authority", reason: "domain_authority_converging", retryable: true, selectedCount: hits.length });
          throw new ClassifiedDataOperationError("key_waiting", "Protected history authority is unavailable");
        }
        const outcome = await withForegroundContextCancellation({ ...(signal === undefined ? {} : { signal }), awaitOwnedWorkSettlement: true, work: () => context.session!.protectForegroundHistory!({ messageIds: hits.map((hit) => hit.messageId), ...(signal === undefined ? {} : { signal }) }) });
        if (outcome.status === "verified") {
    const byId = new Map(outcome.messages.map((message) => [
      message.messageId,
      message,
    ]));
    const complete = byId.size === hits.length
      && outcome.messages.length === hits.length
      && hits.every((hit) =>
        byId.get(hit.messageId)?.payload.role === hit.role
      );
    if (complete) {
      const provenance = outcome.messages.some((entry) =>
          entry.provenance === "repaired"
        )
        ? "repaired" as const
        : "existing" as const;
      await context.observeBoundary?.({
        boundaryId: "conversation.read.foreground_history",
        state: "verified",
        reason: "none",
        retryable: false,
        provenance,
        selectedCount: hits.length,
        repairedCount: outcome.messages.filter(
          (entry) => entry.provenance === "repaired",
        ).length,
      });
      return hits.map((hit) => Object.freeze({
        ...hit,
        snippet: byId.get(hit.messageId)!.payload.content,
      }));
    }
        }
  const waiting = outcome.status === "waiting_for_authority";
  protectedWaiting = waiting;
  const outcomeReason = outcome.status === "verified"
    ? "incomplete_verified_selection"
    : outcome.reason;
  log(
    `[live-shadow] foreground history unavailable operation=${context.operationId}`
      + ` status=${outcome.status} reason=${outcomeReason}`,
  );
  await context.observeBoundary?.({
    boundaryId: "conversation.read.foreground_history",
    state: waiting ? "waiting_for_authority" : "failed",
    reason: waiting ? "domain_authority_converging" : "integrity_failure",
    retryable: waiting,
    selectedCount: hits.length,
  });
        throw new ClassifiedDataOperationError(waiting ? "key_waiting" : "integrity", "Protected history failed");
      },
      consumeOrdinary: (value) => value,
      consumeProtected: (value) => value,
    });
    return [...read.value];
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ClassifiedDataOperationError)) throw error;
    if (["stale", "authority", "cancelled"].includes(error.failureClass)) throw error;
    const waiting = protectedWaiting || error.failureClass === "key_waiting";
    const unsupported = error.failureClass === "unsupported";
    requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
      boundaryId: "conversation.read.foreground_history", family: "message", operation: "read_repair", actorClass: "agent",
      state: waiting ? "waiting_for_authority" : unsupported ? "unsupported" : "failed",
      reason: waiting ? "domain_authority_converging" : unsupported ? "unsupported_operation" : "integrity_failure",
      retryable: waiting, policyRevision: policy.revision,
    }));
    throw new StrictShadowEnforcementError({
      boundaryId: "conversation.read.foreground_history", family: "message", operation: "read_repair", actorClass: "agent",
      state: waiting ? "waiting_for_authority" : unsupported ? "unsupported" : "failed",
      reason: waiting ? "domain_authority_converging" : unsupported ? "unsupported_operation" : "integrity_failure",
      retryable: waiting, policyRevision: policy.revision,
    });
  }
}

/** Build Journal context from verified protected bytes, loading ordinary only as fallback. */
export async function protectLiveShadowForegroundJournal(
  ordinary: () => Promise<RoomJournalContext>,
  signal?: AbortSignal,
): Promise<RoomJournalContext> {
  const context = storage.getStore();
  if (context === undefined) return ordinary();
  const policy = context.enforcementPolicy;
  const owner = bindEncryptionDataOperationOwner({
    policy: requireCurrentDataOperationPolicy(context),
  });
  let protectedRepresentationMissing = false;
  try {
    const result = await owner.read({
      ordinary,
      protected: async () => {
        if (context.session?.protectForegroundJournal === undefined) {
          await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_journal", state: "unsupported", reason: "unsupported_operation", retryable: false, selectedCount: 0 });
          throw new ClassifiedDataOperationError("unsupported", "Protected Journal access is unavailable");
        }
        const protectJournal = context.session.protectForegroundJournal.bind(
          context.session,
        );
        const outcome = await withForegroundContextCancellation({ ...(signal === undefined ? {} : { signal }), work: () => protectJournal({ maximumEvents: PROTECTED_JOURNAL_MAX_EVENTS, ...(signal === undefined ? {} : { signal }) }) });
        if (outcome.status === "verified") {
          const selectedCount = outcome.journal.events.length + (outcome.journal.rollup === null ? 0 : 1);
          const eventIds = new Set(outcome.journal.events.map((event) => event.id));
          if (eventIds.size === outcome.journal.events.length && outcome.repairedCount >= 0 && outcome.repairedCount <= selectedCount) {
            await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_journal", state: "verified", reason: "none", retryable: false, provenance: outcome.provenance, selectedCount, repairedCount: outcome.repairedCount });
            return { rollup: outcome.journal.rollup, events: [...outcome.journal.events] };
          }
        }
        const waiting = outcome.status === "waiting_for_authority";
        const unsupported = outcome.status === "unsupported";
        const missing = outcome.status !== "verified" && outcome.reason === "protected_representation_missing";
        protectedRepresentationMissing = missing;
        const selectedCount = outcome.status === "verified" ? outcome.journal.events.length + (outcome.journal.rollup === null ? 0 : 1) : outcome.selectedCount ?? 0;
        await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_journal", state: waiting ? "waiting_for_authority" : unsupported || missing ? "unsupported" : "failed", reason: waiting ? "domain_authority_converging" : missing ? "missing_protected_sibling" : unsupported ? "unsupported_operation" : "integrity_failure", retryable: waiting, selectedCount });
        throw new ClassifiedDataOperationError(waiting ? "key_waiting" : unsupported || missing ? "unsupported" : "integrity", "Protected Journal access failed");
      },
      consumeOrdinary: (value) => value,
      consumeProtected: (value) => value,
    });
    return result.value;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ClassifiedDataOperationError)) throw error;
    if (["stale", "authority", "cancelled"].includes(error.failureClass)) throw error;
    const waiting = error.failureClass === "key_waiting";
    const unsupported = error.failureClass === "unsupported";
    requireStrictShadowConsumer(enforceStrictShadowDecision(policy, { boundaryId: "conversation.read.foreground_journal", family: "record", operation: "read_repair", actorClass: "agent", state: waiting ? "waiting_for_authority" : unsupported ? "unsupported" : "failed", reason: waiting ? "domain_authority_converging" : protectedRepresentationMissing ? "missing_protected_sibling" : unsupported ? "unsupported_operation" : "integrity_failure", retryable: waiting, policyRevision: policy.revision }));
    throw error;
  }
}

/** Replace selected Reflection statements before they reach prompt assembly. */
export function protectLiveShadowForegroundRecordContext(
  ordinary: ForegroundRecordContextPort,
): ForegroundRecordContextPort {
  const context = storage.getStore();
  if (context === undefined) return ordinary;
  const policy = context.enforcementPolicy;
  return Object.freeze({
    representation: "protected" as const,
    select: async (
      request: Parameters<ForegroundRecordContextPort["select"]>[0],
    ) => withProtectedRecordSelectionDeadline({
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      policy,
      ...(context.observeBoundary === undefined
        ? {}
        : { observeBoundary: context.observeBoundary }),
      work: async () => {
      const owner = bindEncryptionDataOperationOwner({
        policy: requireCurrentDataOperationPolicy(context),
      });
      try {
        const read = await owner.read({
          ordinary: () => ordinary.select(request),
          protected: async () => {
      if (context.session?.protectForegroundRecords === undefined) {
        await context.observeBoundary?.({
          boundaryId: "conversation.read.foreground_records",
          state: "unsupported",
          reason: "unsupported_operation",
          retryable: false,
          selectedCount: 0,
        });
        throw new ClassifiedDataOperationError("unsupported", "Protected Record context is unavailable");
      }
      const selected = ordinary.selectStructural === undefined
          ? {
            status: "unavailable" as const,
            representation: "protected" as const,
            queryEmbeddingStatus: "unavailable" as const,
            reason: "incompatible_projection" as const,
          }
          : await ordinary.selectStructural(request);
      request.signal?.throwIfAborted();
      if (selected.status !== "available") {
        return Object.freeze({ ...selected, representation: "protected" });
      }
      if (selected.records.length === 0) return Object.freeze({
        status: "available" as const,
        representation: "protected" as const,
        queryEmbeddingStatus: selected.queryEmbeddingStatus,
        candidateCount: selected.candidateCount,
        records: [] as const,
      });
      const outcome = await context.session.protectForegroundRecords({
        records: selected.records,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      // The deadline race already owns the terminal observation. A late
      // cancellation/verification must not replace it with authority health.
      request.signal?.throwIfAborted();
      if (outcome.status === "verified") {
        const byId = new Map(outcome.records.map((record) => [
          record.recordRef,
          record,
        ]));
        if (
          byId.size === selected.records.length
          && outcome.records.length === selected.records.length
          && outcome.repairedCount >= 0
          && outcome.repairedCount <= selected.records.length
          && selected.records.every((record) =>
            byId.get(record.recordRef)?.structuralHeight
              === record.structuralHeight
          )
        ) {
          await context.observeBoundary?.({
            boundaryId: "conversation.read.foreground_records",
            state: "verified",
            reason: "none",
            retryable: false,
            provenance: outcome.provenance,
            selectedCount: selected.records.length,
            repairedCount: outcome.repairedCount,
          });
          return Object.freeze({
            ...selected,
            representation: "protected" as const,
            records: selected.records.map((record) =>
              byId.get(record.recordRef)!
            ),
          });
        }
      }
      const waiting = outcome.status === "waiting_for_authority";
      await context.observeBoundary?.({
        boundaryId: "conversation.read.foreground_records",
        state: waiting ? "waiting_for_authority" : "failed",
        reason: waiting ? "domain_authority_converging" : "integrity_failure",
        retryable: waiting,
        selectedCount: selected.records.length,
      });
      throw new ClassifiedDataOperationError(waiting ? "key_waiting" : "integrity", "Protected Record context failed");
          },
          consumeOrdinary: (value) => value,
          consumeProtected: (value) => value,
        });
        return read.value;
      } catch (error) {
        request.signal?.throwIfAborted();
        if (!(error instanceof ClassifiedDataOperationError)) throw error;
        if (["stale", "authority", "cancelled"].includes(error.failureClass)) throw error;
        const waiting = error.failureClass === "key_waiting";
        const unsupported = error.failureClass === "unsupported";
        requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
          boundaryId: "conversation.read.foreground_records", family: "record", operation: "read_repair", actorClass: "agent",
          state: waiting ? "waiting_for_authority" : unsupported ? "unsupported" : "failed",
          reason: waiting ? "domain_authority_converging" : unsupported ? "unsupported_operation" : "integrity_failure",
          retryable: waiting, policyRevision: policy.revision,
        }));
        throw error;
      }
      },
    }),
  });
}

function recordFreshness(
  lifecycle: "current" | "stale" | "superseded" | "resolved",
): RecallRecordFreshness {
  return lifecycle === "current"
    ? "current"
    : lifecycle === "stale"
      ? "stale"
      : "dirty";
}

/** Protect supported organized-recall results before the tool can format them. */
export function protectLiveShadowForegroundRecordRecall(
  ordinary: RecallRecordsPort,
): RecallRecordsPort {
  const context = storage.getStore();
  if (context === undefined) return ordinary;
  const policy = context.enforcementPolicy;
  const enforceUnsupported = async (): Promise<void> => {
    await context.observeBoundary?.({
      boundaryId: "conversation.read.foreground_records",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      selectedCount: 0,
    });
    requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
      boundaryId: "conversation.read.foreground_records",
      family: "record",
      operation: "read_repair",
      actorClass: "agent",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      policyRevision: policy.revision,
    }));
  };
  return Object.freeze({
    search: (request: Parameters<RecallRecordsPort["search"]>[0]) =>
      retryForegroundToolContext(async () => {
      let selected: Awaited<ReturnType<NonNullable<RecallRecordsPort["searchStructural"]>>> | undefined;
      const owner = bindEncryptionDataOperationOwner({
        policy: requireCurrentDataOperationPolicy(context),
      });
      try {
        const read = await owner.read({
          ordinary: async () => {
            const fallback = await ordinary.search(request);
            if (selected?.status !== "ok" || fallback.status !== "ok") return fallback;
            const byId = new Map(fallback.records.map((record) => [record.recordRef, record]));
            if (
              fallback.continuation !== selected.continuation
              || fallback.records.length !== selected.records.length
              || selected.records.some((record) =>
                byId.get(record.recordRef)?.structuralHeight !== record.structuralHeight
              )
            ) {
              return { status: "unavailable" as const, reason: "changed" as const };
            }
            return Object.freeze({ ...fallback, records: Object.freeze(selected.records.map((record) => byId.get(record.recordRef)!)) });
          },
          protected: async () => {
      if (context.session?.protectForegroundRecords === undefined) {
        await enforceUnsupported();
        throw new ClassifiedDataOperationError("unsupported", "Protected Record recall is unavailable");
      }
      selected = ordinary.searchStructural === undefined
        ? { status: "unavailable" as const, reason: "temporarily_unavailable" as const }
        : await ordinary.searchStructural(request);
      if (selected.status !== "ok") return selected;
      if (selected.records.length === 0) {
        return {
          status: "ok" as const,
          records: [] as const,
          ...(selected.continuation === undefined
            ? {}
            : { continuation: selected.continuation }),
        };
      }
      const outcome = await context.session.protectForegroundRecords({
        records: selected.records,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (outcome.status === "verified") {
        const byId = new Map(outcome.records.map((record) => [
          record.recordRef,
          record,
        ]));
        if (
          byId.size === selected.records.length
          && outcome.records.length === selected.records.length
          && outcome.repairedCount >= 0
          && outcome.repairedCount <= selected.records.length
          && selected.records.every((record) =>
            byId.get(record.recordRef)?.structuralHeight
              === record.structuralHeight
          )
        ) {
          await context.observeBoundary?.({
            boundaryId: "conversation.read.foreground_records",
            state: "verified",
            reason: "none",
            retryable: false,
            provenance: outcome.provenance,
            selectedCount: selected.records.length,
            repairedCount: outcome.repairedCount,
          });
          return Object.freeze({
            status: "ok" as const,
            records: Object.freeze(selected.records.map((selectedRecord) => {
              const record = byId.get(selectedRecord.recordRef)!;
              return Object.freeze({
                recordRef: record.recordRef,
                statement: record.statement,
                structuralHeight: record.structuralHeight,
                freshness: recordFreshness(record.lifecycle),
              });
            })),
            ...(selected.continuation === undefined
              ? {}
              : { continuation: selected.continuation }),
          });
        }
      }
      const waiting = outcome.status === "waiting_for_authority";
      await context.observeBoundary?.({
        boundaryId: "conversation.read.foreground_records",
        state: waiting ? "waiting_for_authority" : "failed",
        reason: waiting ? "domain_authority_converging" : "integrity_failure",
        retryable: waiting,
        selectedCount: selected.records.length,
      });
      throw new ClassifiedDataOperationError(waiting ? "key_waiting" : "integrity", "Protected Record recall failed");
          },
          consumeOrdinary: (value) => value,
          consumeProtected: (value) => value,
        });
        return read.value;
      } catch (error) {
        request.signal?.throwIfAborted();
        if (!(error instanceof ClassifiedDataOperationError)) throw error;
        if (["stale", "authority", "cancelled"].includes(error.failureClass)) throw error;
        const waiting = error.failureClass === "key_waiting";
        const unsupported = error.failureClass === "unsupported";
        requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
          boundaryId: "conversation.read.foreground_records", family: "record", operation: "read_repair", actorClass: "agent",
          state: waiting ? "waiting_for_authority" : unsupported ? "unsupported" : "failed",
          reason: waiting ? "domain_authority_converging" : unsupported ? "unsupported_operation" : "integrity_failure",
          retryable: waiting, policyRevision: policy.revision,
        }));
        throw error;
      }
      }, context.session?.authorizationDeadlineAt, request.signal),
    expand: async (request: Parameters<RecallRecordsPort["expand"]>[0]) => {
      // Expansion includes heterogeneous source bodies. Until each source
      // family is protected, Strict must not open the ordinary traversal.
      await enforceUnsupported();
      return ordinary.expand(request);
    },
  });
}

/** Protect and reopen the exact bounded Memory selection for this invocation. */
export async function protectLiveShadowForegroundMemories(
  ordinary: () => Promise<readonly ForegroundMemoryRepairSelection[]>,
  signal?: AbortSignal,
  loadOrdinaryFallback?: (
    selected: readonly ForegroundMemoryRepairSelection[],
  ) => Promise<readonly ForegroundMemoryContextItem[]>,
): Promise<readonly ForegroundMemoryContextItem[]> {
  const context = storage.getStore();
  if (context === undefined) return (await ordinary()).filter(
    (memory): memory is ForegroundMemoryContextItem => "content" in memory,
  );
  const policy = context.enforcementPolicy;
  let selected: readonly ForegroundMemoryRepairSelection[] = [];
  const owner = bindEncryptionDataOperationOwner({
    policy: requireCurrentDataOperationPolicy(context),
  });
  try {
    const result = await owner.read({
      ordinary: async () => {
        if (selected.length > 0 && loadOrdinaryFallback !== undefined) {
          return loadOrdinaryFallback(selected);
        }
        return (await ordinary()).filter(
          (memory): memory is ForegroundMemoryContextItem => "content" in memory,
        );
      },
      protected: async () => {
        if (context.session?.protectForegroundMemories === undefined) {
          await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_memory", state: "unsupported", reason: "unsupported_operation", retryable: false, selectedCount: 0 });
          throw new ClassifiedDataOperationError("unsupported", "Protected Memory access is unavailable");
        }
        selected = await withForegroundContextCancellation({ ...(signal === undefined ? {} : { signal }), work: ordinary });
        if (selected.length === 0) return [];
        const protectMemories = context.session.protectForegroundMemories.bind(
          context.session,
        );
        const outcome = await withForegroundContextCancellation({
          ...(signal === undefined ? {} : { signal }),
          work: () => protectMemories({ memories: selected, ...(signal === undefined ? {} : { signal }) }),
        });
        if (outcome.status === "verified") {
          const byId = new Map(outcome.memories.map((memory) => [memory.id, memory]));
          if (byId.size === selected.length && outcome.memories.length === selected.length && selected.every((memory) => byId.has(memory.id))) {
            await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_memory", state: "verified", reason: "none", retryable: false, provenance: outcome.provenance, selectedCount: selected.length, repairedCount: outcome.repairedCount });
            return selected.map((memory) => byId.get(memory.id)!);
          }
        }
        const waiting = outcome.status === "waiting_for_authority";
        await context.observeBoundary?.({ boundaryId: "conversation.read.foreground_memory", state: waiting ? "waiting_for_authority" : "failed", reason: waiting ? "domain_authority_converging" : "integrity_failure", retryable: waiting, selectedCount: selected.length });
        throw new ClassifiedDataOperationError(waiting ? "key_waiting" : "integrity", waiting ? "Memory authority is converging" : "Memory verification failed");
      },
      consumeOrdinary: (value) => value,
      consumeProtected: (value) => value,
    });
    return result.value;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ClassifiedDataOperationError)) throw error;
    if (["stale", "authority", "cancelled"].includes(error.failureClass)) throw error;
    const waiting = error.failureClass === "key_waiting";
    requireStrictShadowConsumer(enforceStrictShadowDecision(policy, {
      boundaryId: "conversation.read.foreground_memory", family: "memory", operation: "read_repair", actorClass: "agent",
      state: waiting ? "waiting_for_authority" : error.failureClass === "unsupported" ? "unsupported" : "failed",
      reason: waiting ? "domain_authority_converging" : error.failureClass === "unsupported" ? "unsupported_operation" : "integrity_failure",
      retryable: waiting, policyRevision: policy.revision,
    }));
    throw error;
  }
}

/**
 * Own one opaque capability from admission through exactly one Job execution.
 * It never enters the Job input, event bus, transcript, or database.
 */
export function createLiveShadowForegroundTurnCandidate(input: Readonly<{
  operationId: string;
  /** Scheduler correlation id; distinct from operationId for shared-Agent turns. */
  turnId?: string;
  capability: LiveShadowExecutionCapability;
  enforcementPolicy?: StrictShadowEnforcementPolicy;
  dataOperationPolicy: DataOperationPolicyBinding;
  observeBoundary?: LiveShadowTurnContext["observeBoundary"];
  runAgentTurn?<Value>(input: Readonly<{
    operationId: string;
    capability: LiveShadowExecutionCapability;
    entrypointId?: "foreground.main" | "foreground.fork";
    work(
      session: LiveShadowAgentTurnSession,
      openedHumanContent?: string,
      authorizationSignal?: AbortSignal,
    ): Promise<Value>;
  }>): Promise<LiveShadowAgentTurnExecutionResult<Value>>;
}>): ForegroundTurnCandidate {
  const enforcementPolicy = input.enforcementPolicy ?? Object.freeze({
    mode: "shadow_encryption" as const,
    shadowBehavior: "fallback" as const,
    revision: 0,
  });
  let capability: LiveShadowExecutionCapability | null = input.capability;
  let armed: "foreground.main" | "foreground.fork" | null = null;
  const destroy = (): void => {
    if (capability === null) return;
    capability.authorizationDigest.fill(0);
    capability.scope.domainAuthoritySetDigest.fill(0);
    capability = null;
  };
  const expectedTurnId = input.turnId ?? input.operationId;
  const durableJobInputReference = enforcementPolicy.mode === "encrypted_only"
    ? Object.freeze({
      kind: "full_encryption_foreground_operation_v1" as const,
      operationId: input.operationId,
      policyRevision: input.capability.scope.policyRevision,
      // Runtime grants authorize a top-level Room, not one Agent Session.
      // The exact durable operation already owns its Session/Message mapping;
      // never substitute the Browser session or omit Full sink policy because
      // this grant intentionally has no Agent-specific sessionId.
      roomId: "recipientKind" in input.capability.scope
        ? input.capability.scope.topLevelRoomId
        : input.capability.scope.roomId,
    })
    : undefined;
  const canArm = (turnId: string): boolean => capability !== null
    && turnId === expectedTurnId
    && hasForegroundSessionCapability(capability);
  const arm = (
    entrypointId: "foreground.main" | "foreground.fork",
    turnId: string,
  ): void => {
    if (armed !== null || !canArm(turnId)) {
      throw new Error("live Shadow turn capability mismatch");
    }
    armed = entrypointId;
  };
  const run = async <T>(
    entrypointId: "foreground.main" | "foreground.fork",
    turnId: string,
    work: (
      inputOverride?: Readonly<{ message: string }>,
      authorizationSignal?: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> => {
    if (
      armed !== entrypointId
      || turnId !== expectedTurnId
      || capability === null
    ) {
      destroy();
      throw new Error("live Shadow turn capability was not armed");
    }
    const owned = capability;
    const boundaryObserver = createInvocationBoundaryObserver({
      operationId: input.operationId,
      ...(input.observeBoundary === undefined
        ? {}
        : { observeBoundary: input.observeBoundary }),
    });
    let completed = false;
    try {
      if (input.runAgentTurn === undefined) {
        await boundaryObserver.observe({
          state: "failed",
          reason: "publication_failure",
        });
        requireRuntimeFallbackAllowed(enforcementPolicy);
        const value = await storage.run(
          Object.freeze({
            operationId: input.operationId,
            capability: owned,
            session: null,
            enforcementPolicy,
            dataOperationPolicy: input.dataOperationPolicy,
            ...(input.observeBoundary === undefined
              ? {}
              : { observeBoundary: boundaryObserver.observe }),
          }),
          work,
        );
        completed = true;
        return value;
      }
      const executionState: { startedWork: Promise<T> | null } = {
        startedWork: null,
      };
      const result = await input.runAgentTurn({
        operationId: input.operationId,
        capability: owned,
        entrypointId,
        work: (session, openedHumanContent, authorizationSignal) => {
          const startedWork = storage.run(
            Object.freeze({
              operationId: input.operationId,
              capability: owned,
              session,
              enforcementPolicy,
              dataOperationPolicy: input.dataOperationPolicy,
              ...(input.observeBoundary === undefined
                ? {}
                : { observeBoundary: boundaryObserver.observe }),
            }),
            () => work(
              openedHumanContent === undefined
                ? undefined
                : Object.freeze({ message: openedHumanContent }),
              authorizationSignal,
            ),
          );
          executionState.startedWork = startedWork;
          // `runAgentTurn` can return an authorization failure before this
          // cooperative callback settles. Retain the original Promise for the
          // no-double-run path below, while also observing a rejection if a
          // policy observer aborts this candidate before it can await it.
          void startedWork.catch(() => undefined);
          return startedWork;
        },
      });
      if (result.status === "executed") {
        completed = true;
        return result.value;
      }
      await boundaryObserver.observe({
        state: "failed",
        reason: "publication_failure",
      });
      const startedWork = executionState.startedWork;
      if (startedWork !== null) {
        const value = await startedWork;
        // The authorization owner may end the operation after the callback
        // started (expiry, cancellation, or authority invalidation). Avoid a
        // second ordinary execution, but do not let an eventual late value
        // bypass the policy decision that rejected the protected operation.
        // Fallback may retain that already-started result; Strict must still
        // fail closed.
        requireRuntimeFallbackAllowed(enforcementPolicy);
        completed = true;
        return value;
      }
      requireRuntimeFallbackAllowed(enforcementPolicy);
      const value = await storage.run(
        Object.freeze({
          operationId: input.operationId,
          capability: owned,
          session: null,
          enforcementPolicy,
          dataOperationPolicy: input.dataOperationPolicy,
          ...(input.observeBoundary === undefined
            ? {}
            : { observeBoundary: boundaryObserver.observe }),
        }),
        work,
      );
      completed = true;
      return value;
    } finally {
      boundaryObserver.finish(completed);
      destroy();
    }
  };
  return Object.freeze({
    ...(durableJobInputReference === undefined
      ? {}
      : { durableJobInputDisposition: "full" as const, durableJobInputReference }),
    onMainTurn: (turnId: string) => arm("foreground.main", turnId),
    onForkTurn: (turnId: string) => arm("foreground.fork", turnId),
    onIneligible: destroy,
    runMainTurn: <T>(
      turnId: string,
      work: (
        inputOverride?: Readonly<{ message: string }>,
        authorizationSignal?: AbortSignal,
      ) => Promise<T>,
    ) => run("foreground.main", turnId, work),
    runForkTurn: <T>(
      turnId: string,
      work: (
        inputOverride?: Readonly<{ message: string }>,
        authorizationSignal?: AbortSignal,
      ) => Promise<T>,
    ) => run("foreground.fork", turnId, work),
  });
}
