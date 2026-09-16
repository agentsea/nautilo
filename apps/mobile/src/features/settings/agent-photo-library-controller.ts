import { AgentPhotoLibraryApiError } from "@nautilo/api-client/browser";
import type {
  AgentPhotoLibraryEntryDto,
  AgentPhotoLibraryCurrentStateDto,
  AgentPhotoLibraryErrorCodeDto,
  AgentPhotoLibraryScopeDto,
} from "@nautilo/types";

export const AGENT_PHOTO_PRIMARY_SECTIONS = ["recent", "presets", "upload", "generate"] as const;
export const AGENT_PHOTO_SECONDARY_ACTIONS = ["manage", "deleted"] as const;

/**
 * A failed read is not evidence that an Agent has no saved photos or presets.
 * Keep stale content off-screen until a complete scoped snapshot is available.
 */
export function agentPhotoLibraryCatalogueIsPresentable(input: {
  snapshotReady: boolean;
  hasError: boolean;
}): boolean {
  return input.snapshotReady && !input.hasError;
}

/**
 * A legacy profile can reference custom photo bytes that predate the owned
 * library index. That missing selection must not make independent catalogue
 * reads (Recent, Presets, Upload, and Generate) unusable. A replacement
 * selection repairs the profile through the ordinary canonical mutation.
 */
export function isRecoverableMissingCurrentAgentPhoto(cause: unknown): boolean {
  return cause instanceof AgentPhotoLibraryApiError && cause.code === "photo_not_found";
}

export const MISSING_CURRENT_AGENT_PHOTO_WARNING =
  "Your previous custom Agent photo is unavailable. Choose a preset, upload, or generate a replacement.";

export async function readAgentPhotoLibraryCatalogue<
  TCurrent,
  TRecent extends { scope: AgentPhotoLibraryScopeDto },
  TDeleted,
  TPresets,
  TToken,
>(input: {
  readRecent: () => Promise<TRecent>;
  readCurrent: (scope: AgentPhotoLibraryScopeDto) => Promise<TCurrent>;
  readDeleted: (scope: AgentPhotoLibraryScopeDto) => Promise<TDeleted>;
  readPresets: (scope: AgentPhotoLibraryScopeDto) => Promise<TPresets>;
  readToken: () => Promise<TToken>;
}): Promise<{
  current: TCurrent | null;
  currentWarning: string | null;
  recent: TRecent;
  deleted: TDeleted;
  presets: TPresets;
  token: TToken;
}> {
  const recent = await input.readRecent();
  const [currentResult, deleted, presets, token] = await Promise.all([
    input.readCurrent(recent.scope).then(
      (value) => ({ value, warning: null }),
      (cause: unknown) => {
        if (!isRecoverableMissingCurrentAgentPhoto(cause)) throw cause;
        return { value: null, warning: MISSING_CURRENT_AGENT_PHOTO_WARNING };
      },
    ),
    input.readDeleted(recent.scope),
    input.readPresets(recent.scope),
    input.readToken(),
  ]);
  return {
    current: currentResult.value,
    currentWarning: currentResult.warning,
    recent,
    deleted,
    presets,
    token,
  };
}

export function agentPhotoMutationCompletionDisposition(input: {
  status: AgentPhotoMutationResult<unknown>["status"];
  sameIdentity: boolean;
  sameGeneration: boolean;
}): "apply" | "reconcile" | "handle" | "ignore" {
  if (!input.sameIdentity) return "ignore";
  if (input.status === "applied") return input.sameGeneration ? "apply" : "reconcile";
  return input.sameGeneration ? "handle" : "ignore";
}

const AGENT_PHOTO_LIBRARY_READ_DEADLINE_MS = 15_000;

export class AgentPhotoLibraryReadDeadlineError extends Error {
  constructor() {
    super("Nautilo did not respond. Try again.");
    this.name = "AgentPhotoLibraryReadDeadlineError";
  }
}

interface AgentPhotoLibraryReadDeadlineOptions<T> {
  controller: AbortController;
  read(signal: AbortSignal): Promise<T>;
  deadlineMs?: number;
  scheduleDeadline?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearDeadline?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Bounds only catalogue reads. Photo mutations keep their ordinary
 * idempotency/uncertain-outcome contract and are never declared failed by a
 * client timer. Cancelling the caller's controller settles immediately, while
 * a late native/network completion remains inert.
 */
export async function readAgentPhotoLibraryWithDeadline<T>(
  options: AgentPhotoLibraryReadDeadlineOptions<T>,
): Promise<T> {
  if (options.controller.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const deadlineMs = Number.isFinite(options.deadlineMs) && (options.deadlineMs ?? 0) > 0
    ? options.deadlineMs!
    : AGENT_PHOTO_LIBRARY_READ_DEADLINE_MS;
  const scheduleDeadline = options.scheduleDeadline
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearDeadline = options.clearDeadline
    ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settleCancellation!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    settleCancellation = () => reject(
      timedOut
        ? new AgentPhotoLibraryReadDeadlineError()
        : new DOMException("Aborted", "AbortError"),
    );
  });
  const onAbort = (): void => settleCancellation();
  options.controller.signal.addEventListener("abort", onAbort, { once: true });
  timer = scheduleDeadline(() => {
    timedOut = true;
    options.controller.abort();
  }, deadlineMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => options.read(options.controller.signal)),
      cancellation,
    ]);
  } finally {
    options.controller.signal.removeEventListener("abort", onAbort);
    if (timer !== null) clearDeadline(timer);
  }
}

export function createAgentPhotoIdentityKey(input: {
  serverId: string | null | undefined;
  viewerId: string | null | undefined;
  viewerState: string;
}): string {
  return `${input.serverId ?? "none"}:${input.viewerId ?? "none"}:${input.viewerState}`;
}

export function agentPhotoMediaSource(input: {
  serverUrl: string;
  path: string;
  identityKey: string;
  token: { identityKey: string; value: string } | null;
}): { uri: string; headers?: { Authorization: string } } {
  return {
    uri: `${input.serverUrl.replace(/\/$/, "")}${input.path}`,
    ...(input.token?.identityKey === input.identityKey
      ? { headers: { Authorization: `Bearer ${input.token.value}` } }
      : {}),
  };
}

function mergeAgentPhotoPage(
  rows: AgentPhotoLibraryEntryDto[],
  page: AgentPhotoLibraryEntryDto[],
): AgentPhotoLibraryEntryDto[] {
  return [...new Map([...rows, ...page].map((entry) => [entry.id, entry])).values()];
}

export type AgentPhotoProjectionState = Record<"recent" | "deleted", {
  entries: AgentPhotoLibraryEntryDto[];
  nextCursor: string | null;
}>;

export function applyAgentPhotoProjectionPage(
  state: AgentPhotoProjectionState,
  projection: "recent" | "deleted",
  page: { entries: AgentPhotoLibraryEntryDto[]; nextCursor: string | null },
): AgentPhotoProjectionState {
  return {
    ...state,
    [projection]: {
      entries: mergeAgentPhotoPage(state[projection].entries, page.entries),
      nextCursor: page.nextCursor,
    },
  };
}

export function agentPhotoLibraryLayout(input: {
  selected: boolean;
  snapshotReady: boolean;
  busy: boolean;
  safeAreaBottom: number;
  minimumBottomSpacing: number;
}) {
  return {
    scroll: true as const,
    primarySections: AGENT_PHOTO_PRIMARY_SECTIONS,
    secondaryActions: AGENT_PHOTO_SECONDARY_ACTIONS,
    stickyActions: {
      visible: input.selected && input.snapshotReady,
      disabled: input.busy,
      paddingBottom: Math.max(input.safeAreaBottom, input.minimumBottomSpacing),
    },
  };
}

export type PendingAgentPhotoSelection = {
  target: { kind: "entry"; entryId: string } | { kind: "preset"; presetId: string };
  imagePath: string;
};

export type AgentPhotoMutationResult<T = unknown> =
  | { status: "applied"; operationId: string; value: T }
  | { status: "retry"; operationId: string; message: string }
  | {
      status: "refresh";
      operationId: string;
      message: string;
      scope?: AgentPhotoLibraryScopeDto;
      current?: AgentPhotoLibraryCurrentStateDto;
    }
  | { status: "auth"; operationId: string; message: string }
  | { status: "failed"; operationId: string; message: string }
  | { status: "busy" };

type MutationError = Error & {
  code?: AgentPhotoLibraryErrorCodeDto;
  retryable?: boolean;
  scope?: AgentPhotoLibraryScopeDto;
  current?: AgentPhotoLibraryCurrentStateDto;
};

/**
 * Serializes writes and retains an operation id only for an ambiguous/offline
 * result. A retry of the same semantic action therefore reaches the server
 * with the exact idempotency key from the first attempt.
 */
export function createAgentPhotoMutationCoordinator(randomUuid: () => string) {
  const pending = new Map<string, { operationId: string; action: (operationId: string, signal: AbortSignal) => Promise<unknown> }>();
  let inFlight = false;
  let activeController: AbortController | null = null;

  return {
    async run<T>(key: string, action: (operationId: string, signal: AbortSignal) => Promise<T>): Promise<AgentPhotoMutationResult<T>> {
      if (inFlight) return { status: "busy" };
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      const retained = pending.get(key);
      const operationId = retained?.operationId ?? randomUuid();
      const exactAction = (retained?.action ?? action) as (operationId: string, signal: AbortSignal) => Promise<T>;
      pending.set(key, { operationId, action: exactAction });
      try {
        const value = await exactAction(operationId, controller.signal);
        pending.delete(key);
        return { status: "applied", operationId, value };
      } catch (cause) {
        const error = asMutationError(cause);
        const message = agentPhotoMutationErrorMessage(error);
        if (error.code === "offline" || error.code === "operation_incomplete" || error.retryable === true) {
          return { status: "retry", operationId, message };
        }
        pending.delete(key);
        if (error.code === "authentication_required") return { status: "auth", operationId, message };
        if (error.code === "stale_library_revision" || error.code === "stale_viewer_scope" || error.code === "selection_conflict" || error.code === "undo_conflict") {
          return {
            status: "refresh",
            operationId,
            message,
            ...(error.scope ? { scope: error.scope } : {}),
            ...(error.current ? { current: error.current } : {}),
          };
        }
        return { status: "failed", operationId, message };
      } finally {
        inFlight = false;
        if (activeController === controller) activeController = null;
      }
    },
    discard(key: string): void { pending.delete(key); },
    abortAndReset(): void {
      activeController?.abort();
      activeController = null;
      pending.clear();
    },
  };
}

function agentPhotoMutationErrorMessage(error: MutationError): string {
  switch (error.code) {
    case "authentication_required": return "Your session has expired. Sign in again before changing Agent photos.";
    case "deleted_library_capacity_reached": return "Recently deleted is full. Restore a photo or wait for an older deletion to expire before deleting another.";
    case "library_capacity_reached": return "Your Agent photo library is full. Delete a saved photo before adding another.";
    case "photo_blob_missing":
    case "photo_deleted":
    case "photo_not_found": return "That photo is no longer available. Refresh the library and choose another.";
    case "selection_conflict":
    case "undo_conflict": return "Your current Agent photo changed elsewhere. The library will refresh before you try again.";
    case "stale_library_revision":
    case "stale_viewer_scope": return "This Agent photo library changed. Refreshing the current server state.";
    case "offline":
    case "operation_incomplete":
    case "photo_library_unavailable": return "Nautilo could not confirm the change. Retry will safely resume the same operation.";
    default: return error.message || "The photo change failed.";
  }
}

function asMutationError(cause: unknown): MutationError {
  if (cause instanceof AgentPhotoLibraryApiError) return cause;
  return cause instanceof Error ? cause as MutationError : new Error("The photo change failed.");
}

/** Tile taps only stage a preview; selection happens through the explicit action. */
export function stageAgentPhotoSelection(
  current: PendingAgentPhotoSelection | null,
  next: PendingAgentPhotoSelection | null,
): PendingAgentPhotoSelection | null {
  return next ?? current;
}

export function cancelAgentPhotoSelection(): null {
  return null;
}

/** A failed server mutation leaves the staged preview available for retry. */
export function finishAgentPhotoSelection(
  current: PendingAgentPhotoSelection | null,
  applied: boolean,
): PendingAgentPhotoSelection | null {
  return applied ? null : current;
}

/** Current entries never enter the destructive confirmation state. */
export function requestAgentPhotoDelete(entry: { id: string; isCurrent: boolean }): string | null {
  return entry.isCurrent ? null : entry.id;
}

export function confirmAgentPhotoDelete(pendingEntryId: string | null, entryId: string): boolean {
  return pendingEntryId === entryId;
}
