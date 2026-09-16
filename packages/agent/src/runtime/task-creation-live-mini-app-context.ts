import type {
  ActiveMiniAppRequestContext,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import type { NautiloState } from "../agent/state";
import {
  getTaskCreationAmbientContext,
  runWithTaskCreationContexts,
  type TaskCreationBackgroundTaskProvenance,
  type TaskCreationLiveMiniAppContext,
} from "./task-creation-return-context";

export type {
  TaskCreationBackgroundTaskProvenance,
  TaskCreationLiveMiniAppContext,
} from "./task-creation-return-context";

function cloneActiveMiniApp(
  active: ActiveMiniAppRequestContext,
): ActiveMiniAppRequestContext {
  const absoluteDocumentPath =
    typeof active.documentPath === "string" &&
    (/^[\\/]/.test(active.documentPath) || /^[A-Za-z]:[\\/]/.test(active.documentPath));
  const { documentPath, ...withoutDocumentPath } = active;
  return Object.freeze({
    ...withoutDocumentPath,
    // Current Folder identity remains owned by the live session registry. An
    // absolute host path is neither needed by the child nor safe to checkpoint.
    ...(!absoluteDocumentPath && documentPath ? { documentPath } : {}),
    ...(active.selection === undefined
      ? {}
      : { selection: structuredClone(active.selection) }),
    ...(active.summary === undefined
      ? {}
      : { summary: structuredClone(active.summary) }),
  });
}

function cloneLiveMiniAppSession(
  session: TrustedLiveMiniAppSessionContext,
): TrustedLiveMiniAppSessionContext {
  return Object.freeze({
    ...session,
    documentVersion: Object.freeze({ ...session.documentVersion }),
  });
}

/**
 * Capture only a direct Human foreground turn with one matching active live
 * app session, including its independent fork when the main turn is busy.
 * Task report-backs and background/checkpoint state cannot
 * manufacture this context; the server extension registry later decides
 * whether this app's exact live operations are delegable.
 */
export function taskCreationLiveMiniAppContextForState(
  state: NautiloState,
): TaskCreationLiveMiniAppContext | null {
  const active = state.activeMiniApp;
  const session = state.liveMiniAppSession;
  if (
    (state.trustedExecutionEntrypoint !== "foreground.main"
      && state.trustedExecutionEntrypoint !== "foreground.fork") ||
    !state.userId ||
    state.causalHumanUserId !== state.userId ||
    !active ||
    !session ||
    active.appId !== session.appId
  ) return null;
  return Object.freeze({
    ownerId: state.userId,
    activeMiniApp: cloneActiveMiniApp(active),
    liveMiniAppSession: cloneLiveMiniAppSession(session),
  });
}

/** Trusted background Task identity, carried only through this existing ALS. */
export function taskCreationBackgroundTaskProvenanceForState(
  state: NautiloState,
): TaskCreationBackgroundTaskProvenance | null {
  if (
    state.trustedExecutionEntrypoint !== "background.task"
    || !state.userId
    || !state.currentTaskId
    || !state.currentTaskRunId
  ) return null;
  return Object.freeze({
    ownerId: state.userId,
    taskId: state.currentTaskId,
    taskRunId: state.currentTaskRunId,
  });
}

export function runWithTaskCreationLiveMiniAppContext<T>(
  context: TaskCreationLiveMiniAppContext | null,
  fn: () => T,
): T {
  return runWithTaskCreationAmbientContext(context, null, fn);
}

export function getTaskCreationLiveMiniAppContext(): TaskCreationLiveMiniAppContext | null {
  return getTaskCreationAmbientContext()?.liveMiniAppContext ?? null;
}

/** Bind both live task-creation facts to the shared task-creation ALS. */
export function runWithTaskCreationAmbientContext<T>(
  liveMiniAppContext: TaskCreationLiveMiniAppContext | null,
  backgroundTaskProvenance: TaskCreationBackgroundTaskProvenance | null,
  fn: () => T,
): T {
  return runWithTaskCreationContexts(
    getTaskCreationAmbientContext()?.returnContext ?? null,
    liveMiniAppContext,
    backgroundTaskProvenance,
    fn,
  );
}

export function getTaskCreationBackgroundTaskProvenance(): TaskCreationBackgroundTaskProvenance | null {
  return getTaskCreationAmbientContext()?.backgroundTaskProvenance ?? null;
}
