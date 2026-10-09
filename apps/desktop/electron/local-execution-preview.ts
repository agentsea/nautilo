import { verifyOwnedPreviewListener } from "./local-execution-preview-probe";
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
  verifyListener?: (processGroup: number, url: URL) => Promise<boolean>;
}

/** Explicit Human navigation after a fresh, targeted listener ownership check. */
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
  // Resolve localhost deterministically to the same address family we verify.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const readRequest = {
    generation: args["generation"], executionId: args["executionId"], cursor: 0, maxBytes: 4,
  };
  const snapshot = await ports.read(readRequest);
  if (!ports.isCurrent(context, args["generation"])) throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
  if (snapshot.state !== "running" || snapshot.exitCode !== null || snapshot.signal !== null) {
    throw new Error("This execution is no longer running");
  }
  if (snapshot.pid === null || !await (ports.verifyListener ?? verifyOwnedPreviewListener)(snapshot.pid, url)) {
    throw new Error("Preview listener is not ready or is not owned by this execution. Check the command output and port; detached or existing services are unsupported.");
  }
  const current = await ports.read(readRequest);
  if (!ports.isCurrent(context, args["generation"]) || current.state !== "running"
    || current.pid !== snapshot.pid || current.exitCode !== null || current.signal !== null) {
    throw new Error("The preview execution changed while its listener was checked.");
  }
  ports.send(context, url.href);
}
