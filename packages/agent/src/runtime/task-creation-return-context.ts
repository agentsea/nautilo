import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ActiveMiniAppRequestContext,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import type { NautiloState, TrustedExecutionEntrypoint } from "../agent/state";

/**
 * Process-local creation facts for an immediate Task started by one direct
 * Human Desktop turn.  This object never enters Task input, metadata,
 * checkpoints, or transcripts; server composition may inspect it only after
 * the canonical Task id exists.
 */
export interface TaskCreationReturnContext {
  readonly ownerId: string;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly currentFolder: string;
  readonly workspacePath: string;
  readonly browserSessionId?: string;
}

/**
 * Process-local live-app authority captured while creating an immediate Task.
 * The value is intentionally never serialized into a Task or TaskRun.
 */
export interface TaskCreationLiveMiniAppContext {
  readonly ownerId: string;
  /** Advisory, already-sanitized projection which may enter child graph state. */
  readonly activeMiniApp: ActiveMiniAppRequestContext;
  /** Process-local authority only. Never serialize this value. */
  readonly liveMiniAppSession: TrustedLiveMiniAppSessionContext;
}

/** Trusted background Task identity, also process-local task-creation context. */
export interface TaskCreationBackgroundTaskProvenance {
  readonly ownerId: string;
  readonly taskId: string;
  readonly taskRunId: string;
}

/**
 * Positive, server-stamped origin for a Task creation attempt.  Unlike the
 * legacy background-only slot, this never treats missing context as a
 * foreground root.  It stays process-local and is not part of model input.
 */
export interface TaskCreationInvocationProvenance {
  readonly ownerId: string;
  readonly roomId: string | null;
  readonly entrypoint: TrustedExecutionEntrypoint;
  readonly taskId?: string;
  readonly taskRunId?: string;
}

interface TaskCreationAmbientContext {
  readonly returnContext: TaskCreationReturnContext | null;
  readonly liveMiniAppContext: TaskCreationLiveMiniAppContext | null;
  readonly backgroundTaskProvenance: TaskCreationBackgroundTaskProvenance | null;
}

/**
 * Return, live-app, and background facts share one ALS scope. Each public
 * typed helper below owns a distinct slot, so no authority crosses a
 * serialization boundary. Positive invocation provenance has its own scope.
 */
const taskCreationAmbientContextStorage =
  new AsyncLocalStorage<TaskCreationAmbientContext | null>();
const taskCreationInvocationProvenanceStorage =
  new AsyncLocalStorage<TaskCreationInvocationProvenance | null>();

export function getTaskCreationAmbientContext(): TaskCreationAmbientContext | null {
  return taskCreationAmbientContextStorage.getStore() ?? null;
}

export function taskCreationInvocationProvenanceForState(
  state: NautiloState,
): TaskCreationInvocationProvenance | null {
  const entrypoint = state.trustedExecutionEntrypoint;
  if (!entrypoint || !state.userId) return null;
  if (entrypoint === "background.task") {
    if (!state.currentTaskId || !state.currentTaskRunId) return null;
    return Object.freeze({
      ownerId: state.userId,
      roomId: state.roomId || null,
      entrypoint,
      taskId: state.currentTaskId,
      taskRunId: state.currentTaskRunId,
    });
  }
  return Object.freeze({
    ownerId: state.userId,
    roomId: state.roomId || null,
    entrypoint,
  });
}

export function runWithTaskCreationInvocationProvenance<T>(
  provenance: TaskCreationInvocationProvenance | null,
  fn: () => T,
): T {
  return taskCreationInvocationProvenanceStorage.run(provenance, fn);
}

export function getTaskCreationInvocationProvenance():
  TaskCreationInvocationProvenance | null {
  return taskCreationInvocationProvenanceStorage.getStore() ?? null;
}

export function runWithTaskCreationContexts<T>(
  returnContext: TaskCreationReturnContext | null,
  liveMiniAppContext: TaskCreationLiveMiniAppContext | null,
  backgroundTaskProvenance: TaskCreationBackgroundTaskProvenance | null,
  fn: () => T,
): T {
  return taskCreationAmbientContextStorage.run(
    Object.freeze({ returnContext, liveMiniAppContext, backgroundTaskProvenance }),
    fn,
  );
}

export function taskCreationReturnContextForState(
  state: NautiloState,
  relaySessionId: string | null | undefined,
  browserSessionId?: string | null,
): TaskCreationReturnContext | null {
  const origin = state.verifiedOrdinaryOrigin;
  if (
    (state.trustedExecutionEntrypoint !== "foreground.main"
      && state.trustedExecutionEntrypoint !== "foreground.fork") ||
    origin?.kind !== "local_electron" ||
    !state.userId ||
    origin.userId !== state.userId ||
    !state.currentFolder ||
    !state.currentFolderRelayId ||
    state.currentFolderRelayId !== origin.relayId ||
    !relaySessionId
  ) {
    return null;
  }
  return Object.freeze({
    ownerId: state.userId,
    relayId: origin.relayId,
    relaySessionId,
    desktopSessionId: origin.desktopSessionId,
    pairingGeneration: origin.pairingGeneration,
    currentFolder: state.currentFolder,
    workspacePath: state.workspacePath ?? "",
    ...(browserSessionId ? { browserSessionId } : {}),
  });
}

export function runWithTaskCreationReturnContext<T>(
  context: TaskCreationReturnContext | null,
  fn: () => T,
): T {
  const current = getTaskCreationAmbientContext();
  return runWithTaskCreationContexts(
    context,
    current?.liveMiniAppContext ?? null,
    current?.backgroundTaskProvenance ?? null,
    fn,
  );
}

export function getTaskCreationReturnContext(): TaskCreationReturnContext | null {
  return getTaskCreationAmbientContext()?.returnContext ?? null;
}
