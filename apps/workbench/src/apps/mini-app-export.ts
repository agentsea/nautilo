export type PreparedAppExport = {
  content: string;
  encoding: "base64";
  mimeType: string;
  byteLength: number;
  sourceSha256: string;
  warnings: string[];
};

let exportRequestSequence = 0;

function nextRequestId(): string {
  exportRequestSequence += 1;
  return `export-${Date.now()}-${exportRequestSequence}`;
}

function parsePreparedExport(value: unknown, mimeType: string): PreparedAppExport | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record["content"] !== "string" ||
    record["encoding"] !== "base64" ||
    record["mimeType"] !== mimeType ||
    !Number.isSafeInteger(record["byteLength"]) ||
    (record["byteLength"] as number) < 0 ||
    typeof record["sourceSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(record["sourceSha256"]) ||
    !Array.isArray(record["warnings"]) ||
    !record["warnings"].every((warning) => typeof warning === "string")
  ) return null;
  try {
    const binary = atob(record["content"]);
    if (btoa(binary) !== record["content"] || binary.length !== record["byteLength"]) return null;
  } catch {
    return null;
  }
  return record as PreparedAppExport;
}

/** Request export bytes from the exact currently-mounted mini-app frame. */
export function requestMiniAppExport(input: {
  iframe: HTMLIFrameElement;
  actionId: string;
  mimeType: string;
  signal?: AbortSignal;
  hostWindow?: Window;
}): Promise<PreparedAppExport> {
  const hostWindow = input.hostWindow ?? window;
  const source = input.iframe.contentWindow;
  if (!source) return Promise.reject(new Error("App frame is unavailable."));
  if (input.signal?.aborted) return Promise.reject(new Error("Export request was aborted."));
  const requestId = nextRequestId();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: PreparedAppExport): void => {
      if (settled) return;
      settled = true;
      hostWindow.removeEventListener("message", onMessage);
      input.iframe.removeEventListener("load", onLoad);
      input.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value!);
    };
    const onAbort = (): void => finish(new Error("Export request was aborted."));
    const onLoad = (): void => finish(new Error("App frame reloaded before preparing the export."));
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== source || input.iframe.contentWindow !== source) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data["type"] !== "nautilo.app.export.prepare.result" || data["requestId"] !== requestId) return;
      if (data["ok"] !== true) {
        finish(new Error(typeof data["error"] === "string" ? data["error"] : "The app could not prepare this export."));
        return;
      }
      const prepared = parsePreparedExport(data["result"], input.mimeType);
      if (!prepared) {
        finish(new Error("The app returned an invalid export payload."));
        return;
      }
      finish(null, prepared);
    };
    hostWindow.addEventListener("message", onMessage);
    input.iframe.addEventListener("load", onLoad, { once: true });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    source.postMessage({
      type: "nautilo.app.export.prepare",
      requestId,
      actionId: input.actionId,
      mimeType: input.mimeType,
    }, "*");
  });
}
