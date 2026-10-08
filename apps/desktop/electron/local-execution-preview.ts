import type { LocalExecutionDispatch, LocalExecutionView, LocalExecutionViewRequest } from "./relay-dispatch/local-execution";

interface LocalExecutionReadOwner {
  readonly closed: boolean;
  readonly localExecution: Pick<LocalExecutionDispatch, "humanRead">;
}

/** Keep a Human receipt read bound to the same active Desktop owner across awaits. */
export async function readFromCurrentLocalExecutionOwner(
  getOwner: () => LocalExecutionReadOwner | null,
  request: LocalExecutionViewRequest,
  cancel = false,
): Promise<LocalExecutionView> {
  const owner = getOwner();
  if (owner === null || owner.closed) throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
  const snapshot = await owner.localExecution.humanRead(request, cancel);
  if (getOwner() !== owner || owner.closed) throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
  return snapshot;
}

export interface LocalExecutionPreviewPorts<Context> {
  /** Resolves the active IPC sender before reading any execution state. */
  capture: () => Context;
  read: (request: LocalExecutionViewRequest) => Promise<LocalExecutionView>;
  /** Synchronous final owner/sender check; no asynchronous gap before delivery. */
  isCurrent: (context: Context, generation: string) => boolean;
  send: (context: Context, url: string) => void;
}

/** Explicit Human Browser navigation; output URLs do not establish readiness or port ownership. */
export async function openLocalExecutionPreview<Context>(
  request: unknown,
  ports: LocalExecutionPreviewPorts<Context>,
): Promise<void> {
  const context = ports.capture();
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Invalid execution preview");
  }
  const args = request as Record<string, unknown>;
  if (typeof args["url"] !== "string" || typeof args["generation"] !== "string" ||
      typeof args["executionId"] !== "string") throw new Error("Invalid execution preview");
  let url: URL;
  try { url = new URL(args["url"]); } catch { throw new Error("Invalid execution preview"); }
  if (url.protocol !== "http:" || url.username || url.password ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Execution previews require a local HTTP URL");
  }
  const snapshot = await ports.read({
    generation: args["generation"], executionId: args["executionId"], cursor: 0, maxBytes: 4,
  });
  if (!ports.isCurrent(context, args["generation"])) throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
  if (snapshot.state !== "running" || snapshot.exitCode !== null || snapshot.signal !== null) {
    throw new Error("This execution is no longer running");
  }
  ports.send(context, url.href);
}
