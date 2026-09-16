/**
 * D421 Phase 4.2/4.3 — one-hop agent redirect trusted seam.
 *
 * A target-bearing `skip` invocation (Phase 6.4) records one immutable request
 * on the source agent's per-bot `AgentTurnContext`. This module is the runtime
 * half of the seam: it owns only the runtime-internal completion hook the
 * foreground executor invokes on terminal status.
 *
 * Privacy contract (Phase 0 §0.2.4): the raw `AgentRedirectRequest.reason`,
 * actorIds, jobIds, and trace NEVER ride the room-scoped `eventBus`. The
 * completion hook is invoked IN-MEMORY (a direct function call from the
 * executor, not a bus event). Pending wake context is dispatch-owned and
 * lives in `packages/server/src/messaging/agent-redirect-handler.ts`.
 * The server-side hook (registered via {@link setRedirectCompletionHook})
 * performs canonical roster revalidation, target enqueue, focus transfer,
 * and the requester-private `conductor.decision` receipt.
 *
 * Lifecycle: the executor consumes the recorded request exactly once on the
 * SUCCESS path (before turn-context cleanup) and notifies the hook with
 * `kind: "fulfilled"`. On a no-request success it notifies
 * `completed_no_request`; on error/abort it notifies `error`/`aborted`. In
 * every terminal case the server hook clears its pending context.
 */
import { log } from "@nautilo/logger";

export type RedirectCompletionKind =
  | "fulfilled"
  | "completed_no_request"
  | "error"
  | "aborted";

/**
 * D421 Phase 4.2 — the notification the executor sends the completion hook on
 * terminal status. `request` is present ONLY on `fulfilled` and contains only
 * the target handle + one-hop depth. The tool's raw internal reason is
 * discarded by the executor and never crosses into runtime.
 */
export interface RedirectCompletionNotification {
  readonly kind: RedirectCompletionKind;
  readonly turnContextId: string;
  readonly humanTurnId: string;
  readonly sourceAgentId: string;
  readonly request?: RedirectRequestView;
  /** Server defense-in-depth; true if source emitted visible assistant text. */
  readonly sourceAssistantVisibleOutput?: boolean;
}

/**
 * D421 Phase 4.2 — structural view of `AgentRedirectRequest` from
 * `@nautilo/agent`. Declared locally (rather than importing the type) so this
 * runtime module does not add a runtime dependency on the agent package's
 * internal request shape; the executor builds this privacy-minimized view.
 */
export interface RedirectRequestView {
  readonly targetHandle: string;
  readonly depth: 1;
}

export type RedirectCompletionHook = (
  notification: RedirectCompletionNotification,
) => Promise<void>;

let completionHook: RedirectCompletionHook | null = null;

/**
 * D421 Phase 4.2 — install the server-owned completion hook. Called once at
 * server boot (dispatch wires the real handler). Pass `null` to release.
 * The hook is invoked in-memory from the executor's terminal path; it must
 * never be reached via the room `eventBus` (raw reason must not leak).
 */
export function setRedirectCompletionHook(
  hook: RedirectCompletionHook | null,
): void {
  completionHook = hook;
}

/** D421 Phase 4.2 — read the installed completion hook (null if unset). */
export function getRedirectCompletionHook(): RedirectCompletionHook | null {
  return completionHook;
}

/**
 * D421 Phase 4.2 — invoke the registered completion hook in-memory. Called
 * from the foreground executor's terminal path. NEVER emit this notification
 * on the room `eventBus`. A missing hook is a no-op (the server is not yet
 * booted, or this is a unit test).
 */
export async function notifyRedirectCompletion(
  notification: RedirectCompletionNotification,
): Promise<void> {
  const hook = completionHook;
  if (!hook) return;
  try {
    await hook(notification);
  } catch {
    log(
      `[agent-redirect] completion_hook_failed kind=${notification.kind}`,
    );
  }
}

/** Test-only — reset the registered hook. */
export function _resetRedirectCompletionForTests(): void {
  completionHook = null;
}
