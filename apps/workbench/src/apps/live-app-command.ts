import type { LiveDocumentVersion } from "@nautilo/types";

/** One transferred reply port, owned by this exact iframe attempt. No replay. */
export function sendLiveAppCommand(
  iframe: HTMLIFrameElement,
  sessionId: string,
  request: { documentVersion: LiveDocumentVersion; deadline: number; command: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  const unavailable = { status: "rejected", code: "session_closed", stateChanged: false, retrySafe: false };
  if (signal.aborted || request.deadline <= Date.now() || !iframe.contentWindow) return Promise.resolve(unavailable);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (value: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      channel.port1.close();
      channel.port2.close();
      resolve(value);
    };
    const abort = () => finish({ status: "unknown", stateChanged: "unknown", retrySafe: false });
    const timer = setTimeout(abort, Math.max(0, request.deadline - Date.now()));
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = (event) => finish(event.data);
    try {
      iframe.contentWindow!.postMessage({ type: "nautilo.app.live-command", sessionId, ...request }, "*", [channel.port2]);
    } catch { abort(); }
  });
}
