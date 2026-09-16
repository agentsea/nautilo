/** D500 v15 — compact, secret-free Structured SSH activity projection. */

import type { ToolRenderer, ToolRendererProps } from "./types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function label(toolName: string | undefined): string {
  if (toolName === "structured_ssh_copy_upload") return "Upload files";
  if (toolName === "structured_ssh_copy_download") return "Download files";
  return "Run remote command";
}

function collapsedSummary({ state, resultText }: {
  state: string;
  resultText: string | undefined;
}): string {
  return state === "running" ? "Working securely" : resultText ? "Completed" : "Preparing";
}

function Output({
  stream,
  text,
  live = false,
}: {
  stream: "stdout" | "stderr";
  text: string;
  live?: boolean;
}): React.ReactElement | null {
  if (text.length === 0) return null;
  return (
    <section aria-label={stream}>
      <div className={`mb-1 text-[0.65rem] font-semibold uppercase tracking-wide ${stream === "stderr" ? "text-tool-error" : "text-foreground-dim"}`}>
        {stream}{live ? " (live)" : ""}
      </div>
      <pre className={`max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed ${stream === "stderr" ? "text-tool-error" : "text-foreground"}`}>
        {text}
      </pre>
    </section>
  );
}

function canonicalResult(resultText: string | undefined): {
  stdout?: string;
  stderr?: string;
  bytes?: number;
  authenticated?: boolean;
} {
  if (!resultText) return {};
  try {
    const value: unknown = JSON.parse(resultText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = value as Record<string, unknown>;
    return {
      ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}),
      ...(typeof result.stderr === "string" ? { stderr: result.stderr } : {}),
      ...(typeof result.bytes === "number" && Number.isSafeInteger(result.bytes) && result.bytes >= 0 ? { bytes: result.bytes } : {}),
      ...(result.authenticated === true ? { authenticated: true } : {}),
    };
  } catch {
    return {};
  }
}

function StructuredSshExpanded({ toolName, state, resultText, structuredSshProgress }: ToolRendererProps): React.ReactElement {
  const live = state === "running" ? structuredSshProgress : undefined;
  const final = live ? {} : canonicalResult(resultText);
  const activityLabel = label(toolName);

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      <div className="text-xs text-foreground-muted">{activityLabel}</div>
      {live?.operation === "exec" && (
        <>
          <Output stream="stdout" text={live.stdout} live />
          <Output stream="stderr" text={live.stderr} live />
          {live.droppedBytes > 0 && (
            <div role="status" className="text-xs text-[var(--warning,#b58900)]">
              Live observation was incomplete; final result is canonical.
            </div>
          )}
          {live.stdout.length === 0 && live.stderr.length === 0 && (
            <div className="text-xs italic text-foreground-dim">Waiting for output…</div>
          )}
        </>
      )}
      {live && live.operation !== "exec" && (
        <div role="status" className="text-xs text-foreground-muted">
          {live.phase === "starting" ? "Starting transfer" : "Transferring"}: {formatBytes(live.transferredBytes)}
          {live.totalBytes !== undefined ? ` of ${formatBytes(live.totalBytes)}` : " transferred"}.
        </div>
      )}
      {!live && state === "success" && final.authenticated && (
        <div role="status" className="text-xs text-foreground-muted">Authentication completed.</div>
      )}
      {!live && state === "success" && final.bytes !== undefined && (
        <div role="status" className="text-xs text-foreground-muted">Transferred {formatBytes(final.bytes)}.</div>
      )}
      {!live && state === "success" && <Output stream="stdout" text={final.stdout ?? ""} />}
      {!live && state === "success" && <Output stream="stderr" text={final.stderr ?? ""} />}
      {!live && state === "success" && !final.authenticated && final.bytes === undefined && !final.stdout && !final.stderr && (
        <div role="status" className="text-xs text-foreground-muted">Completed.</div>
      )}
      {state === "error" && (
        <div role="status" className="text-xs text-tool-error">SSH operation did not complete. Its final result is canonical.</div>
      )}
    </div>
  );
}

export const structuredSshRenderer: ToolRenderer = {
  displayName: "SSH",
  collapsedSummary,
  ExpandedBody: StructuredSshExpanded,
};
