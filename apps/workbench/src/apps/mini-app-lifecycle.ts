export type MiniAppCloseReason = "close" | "replace" | "navigate" | "suspend" | "quit";
export type MiniAppLifecycleAction = "prepare-close" | "save-copy";

export type MiniAppPrepareCloseResult = {
  /** No local draft was admitted, for example an initial load failed. */
  noLocalChanges?: boolean;
  documentSaved: boolean;
  recoveryPersisted: boolean;
  recoverableDraftExact: boolean;
  errorMessage?: string | null;
};

export type MiniAppLifecycleOutcome =
  | { status: "ready"; result: MiniAppPrepareCloseResult }
  | { status: "blocked"; message: string }
  | { status: "cancelled" };

let lifecycleRequestSequence = 0;

function nextRequestId(): string {
  lifecycleRequestSequence += 1;
  return `lifecycle-${Date.now()}-${lifecycleRequestSequence}`;
}

function parseResult(value: unknown): MiniAppPrepareCloseResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (
    typeof result["documentSaved"] !== "boolean" ||
    typeof result["recoveryPersisted"] !== "boolean" ||
    typeof result["recoverableDraftExact"] !== "boolean"
  ) return null;
  if (result["errorMessage"] !== undefined && result["errorMessage"] !== null &&
    typeof result["errorMessage"] !== "string") return null;
  if (result["noLocalChanges"] !== undefined && typeof result["noLocalChanges"] !== "boolean") return null;
  return {
    ...(typeof result["noLocalChanges"] === "boolean" ? { noLocalChanges: result["noLocalChanges"] } : {}),
    documentSaved: result["documentSaved"],
    recoveryPersisted: result["recoveryPersisted"],
    recoverableDraftExact: result["recoverableDraftExact"],
    ...(typeof result["errorMessage"] === "string" || result["errorMessage"] === null
      ? { errorMessage: result["errorMessage"] }
      : {}),
  };
}

/**
 * Ask the exact currently-mounted sandbox to prepare for removal. The host
 * derives readiness from concrete persistence or absence-of-local-draft facts; an app cannot assert a
 * generic "ready" bit. There is deliberately no elapsed-time success path.
 */
export function requestMiniAppLifecycle(input: {
  iframe: HTMLIFrameElement;
  reason: MiniAppCloseReason;
  action?: MiniAppLifecycleAction;
  signal?: AbortSignal;
  hostWindow?: Window;
}): Promise<MiniAppLifecycleOutcome> {
  const hostWindow = input.hostWindow ?? window;
  const source = input.iframe.contentWindow;
  if (!source) return Promise.resolve({ status: "blocked", message: "App frame is unavailable." });
  if (input.signal?.aborted) return Promise.resolve({ status: "cancelled" });
  const requestId = nextRequestId();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: MiniAppLifecycleOutcome): void => {
      if (settled) return;
      settled = true;
      hostWindow.removeEventListener("message", onMessage);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ status: "cancelled" });
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== source || input.iframe.contentWindow !== source) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data["type"] !== "nautilo.app.lifecycle.prepare-close.result" ||
        data["requestId"] !== requestId) return;
      if (data["ok"] !== true) {
        finish({
          status: "blocked",
          message: typeof data["error"] === "string" ? data["error"] : "The app could not save its draft.",
        });
        return;
      }
      const result = parseResult(data["result"]);
      if (!result) {
        finish({ status: "blocked", message: "The app returned an invalid close result." });
        return;
      }
      if (result.noLocalChanges === true || result.documentSaved || (result.recoveryPersisted && result.recoverableDraftExact)) {
        finish({ status: "ready", result });
      } else {
        finish({
          status: "blocked",
          message: result.errorMessage?.trim() || "The draft has not been saved or recovered exactly.",
        });
      }
    };
    hostWindow.addEventListener("message", onMessage);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    source.postMessage({
      type: "nautilo.app.lifecycle.prepare-close",
      requestId,
      reason: input.reason,
      action: input.action ?? "prepare-close",
    }, "*");
  });
}
