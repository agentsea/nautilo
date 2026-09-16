/**
 * D502 Stack 1 — focused Desktop `run_shell` ToolCard rendering.
 *
 * Live pipe observations are intentionally read-only and provisional. Once a
 * DesktopShellResult arrives, it replaces them wholesale so stdout/stderr are
 * shown once from the canonical final receipt rather than duplicated.
 */

import { useEffect, useRef } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";

function pickCommand(args: Record<string, unknown>): string {
  if (typeof args["command"] === "string") return args["command"];
  if (typeof args["cmd"] === "string") return args["cmd"];
  if (typeof args["script"] === "string") return args["script"];
  return "";
}

function isOutputArtifactRequest(args: Record<string, unknown>): boolean {
  return typeof args["output_artifact"] === "object" && args["output_artifact"] !== null;
}

function isOutputArtifactSearchRequest(args: Record<string, unknown>): boolean {
  if (!isOutputArtifactRequest(args)) return false;
  const artifact = args["output_artifact"] as Record<string, unknown>;
  return artifact["operation"] === "search";
}

function commandFromHarnessResult(resultText: string | undefined): string {
  if (!resultText) return "";
  const lines = resultText.split("\n");
  return /^Command (?:started|completed|failed|output)$/.test(lines[0]?.trim() ?? "")
    ? (lines[1]?.trim() ?? "")
    : "";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function retainedCaptureCopy({
  capturedBytes,
  totalBytes,
  truncated,
}: Pick<ShellOutputArtifactReference, "capturedBytes" | "totalBytes" | "truncated">): string {
  if (!truncated && capturedBytes === totalBytes) {
    return `Retained capture is complete: ${formatBytes(capturedBytes)} available after redaction and UTF-8 normalization.`;
  }
  if (!truncated) {
    return `Retained capture is incomplete: ${formatBytes(capturedBytes)} of ${formatBytes(totalBytes)} sanitized output retained.`;
  }
  return `Retained capture is partial: capture limit reached; ${formatBytes(capturedBytes)} of ${formatBytes(totalBytes)} sanitized output retained.`;
}

function formatDuration(milliseconds: number | undefined): string | null {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  if (milliseconds < 1000) return `${Math.floor(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

/** Only render a cwd label when the raw arg is a safe contained relative path. */
function containedCwd(args: Record<string, unknown>): string | null {
  const cwd = args["cwd"];
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 512) return null;
  if ([...cwd].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return null;
  if (cwd.startsWith("/") || cwd.includes("\\") || cwd.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    return null;
  }
  return cwd;
}

export function runShellContextLabel(
  args: Record<string, unknown>,
  canonicalExecution?: ParsedShellOutput["execution"],
): string {
  if (isOutputArtifactRequest(args)) return "Desktop-local continuation";
  const place = containedCwd(args);
  const resultOnlyWorkstation = canonicalExecution === "workstation" && args["execution"] !== "workstation";
  const location = place
    ? `Current Folder / ${place}`
    : resultOnlyWorkstation
      ? "Local workspace"
      : "Current Folder";
  const mode = canonicalExecution === "workstation" || args["execution"] === "workstation"
    ? "explicit workstation"
    : "sandboxed";
  return `${location} · ${mode}`;
}

function collapsedSummary({
  args,
  resultText,
}: {
  args: Record<string, unknown>;
  resultText: string | undefined;
}): string {
  if (isOutputArtifactSearchRequest(args)) return "Search retained shell output";
  if (isOutputArtifactRequest(args)) return "Retrieve retained shell output";
  const cmd = pickCommand(args) || commandFromHarnessResult(resultText);
  return truncate(cmd, 60);
}

interface ShellOutputArtifactReference {
  expiresAt: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

interface ShellOutputArtifactPage {
  offsetBytes: number;
  nextOffsetBytes: number | null;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  expiresAt: string;
  deleted: boolean;
}

interface ShellOutputArtifactSearchMatch {
  stream: "stdout" | "stderr";
  matchOffsetBytes: number;
  artifactOffsetBytes: number;
  matchBytes: number;
  contextOffsetBytes: number;
  context: string;
}

interface ShellOutputArtifactSearch {
  matches: ShellOutputArtifactSearchMatch[];
  totalMatches: number;
  matchesTruncated: boolean;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  expiresAt: string;
}

export interface ParsedShellOutput {
  execution?: "sandboxed" | "workstation";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  durationMs?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  sideEffectsMayHaveStarted?: boolean;
  outputArtifact?: ShellOutputArtifactReference;
  outputArtifactPage?: ShellOutputArtifactPage;
  outputArtifactSearch?: ShellOutputArtifactSearch;
  raw?: string;
}

function parseArtifactReference(value: unknown): ShellOutputArtifactReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact["expiresAt"] !== "string" ||
    typeof artifact["capturedBytes"] !== "number" ||
    typeof artifact["totalBytes"] !== "number" ||
    typeof artifact["truncated"] !== "boolean"
  ) return undefined;
  return {
    expiresAt: artifact["expiresAt"],
    capturedBytes: artifact["capturedBytes"],
    totalBytes: artifact["totalBytes"],
    truncated: artifact["truncated"],
  };
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseArtifactSearch(value: Record<string, unknown>): ShellOutputArtifactSearch | undefined {
  if (
    value["version"] !== 1 ||
    value["operation"] !== "search" ||
    typeof value["reference"] !== "string" ||
    value["reference"].length < 32 ||
    !Array.isArray(value["matches"]) ||
    !isNonnegativeSafeInteger(value["totalMatches"]) ||
    typeof value["matchesTruncated"] !== "boolean" ||
    !isNonnegativeSafeInteger(value["capturedBytes"]) ||
    !isNonnegativeSafeInteger(value["totalBytes"]) ||
    value["capturedBytes"] > value["totalBytes"] ||
    typeof value["truncated"] !== "boolean" ||
    typeof value["expiresAt"] !== "string"
  ) return undefined;

  const matches: ShellOutputArtifactSearchMatch[] = [];
  for (const candidate of value["matches"]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const match = candidate as Record<string, unknown>;
    if (
      (match["stream"] !== "stdout" && match["stream"] !== "stderr") ||
      !isNonnegativeSafeInteger(match["matchOffsetBytes"]) ||
      !isNonnegativeSafeInteger(match["artifactOffsetBytes"]) ||
      !isNonnegativeSafeInteger(match["matchBytes"]) || match["matchBytes"] === 0 ||
      !isNonnegativeSafeInteger(match["contextOffsetBytes"]) ||
      match["contextOffsetBytes"] > match["matchOffsetBytes"] ||
      match["artifactOffsetBytes"] + match["matchBytes"] > value["capturedBytes"] ||
      typeof match["context"] !== "string"
    ) return undefined;
    matches.push({
      stream: match["stream"],
      matchOffsetBytes: match["matchOffsetBytes"],
      artifactOffsetBytes: match["artifactOffsetBytes"],
      matchBytes: match["matchBytes"],
      contextOffsetBytes: match["contextOffsetBytes"],
      context: match["context"],
    });
  }

  if (
    matches.length > 20 ||
    value["totalMatches"] < matches.length ||
    (!value["matchesTruncated"] && value["totalMatches"] !== matches.length)
  ) return undefined;
  return {
    matches,
    totalMatches: value["totalMatches"],
    matchesTruncated: value["matchesTruncated"],
    capturedBytes: value["capturedBytes"],
    totalBytes: value["totalBytes"],
    truncated: value["truncated"],
    expiresAt: value["expiresAt"],
  };
}

/** Parse both legacy `{stdout, stderr}` results and the D502 DesktopShellResult. */
export function parseShellResult(resultText: string | undefined): ParsedShellOutput {
  if (resultText === undefined) return {};
  const trimmed = resultText.trim();
  if (!trimmed.startsWith("{")) return { raw: resultText };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const hasOutField = typeof obj.stdout === "string" || typeof obj.stderr === "string";
      const outputArtifactSearch = parseArtifactSearch(obj);
      if (hasOutField || outputArtifactSearch) {
        const out: ParsedShellOutput = {};
        if (obj.execution === "sandboxed" || obj.execution === "workstation") {
          out.execution = obj.execution;
        }
        if (typeof obj.stdout === "string") out.stdout = obj.stdout;
        if (typeof obj.stderr === "string") out.stderr = obj.stderr;
        if (typeof obj.exitCode === "number") out.exitCode = obj.exitCode;
        if (typeof obj.signal === "string") out.signal = obj.signal;
        if (typeof obj.timedOut === "boolean") out.timedOut = obj.timedOut;
        if (typeof obj.cancelled === "boolean") out.cancelled = obj.cancelled;
        if (typeof obj.durationMs === "number") out.durationMs = obj.durationMs;
        if (typeof obj.stdoutTruncated === "boolean") out.stdoutTruncated = obj.stdoutTruncated;
        if (typeof obj.stderrTruncated === "boolean") out.stderrTruncated = obj.stderrTruncated;
        if (typeof obj.sideEffectsMayHaveStarted === "boolean") {
          out.sideEffectsMayHaveStarted = obj.sideEffectsMayHaveStarted;
        }
        const outputArtifact = parseArtifactReference(obj["outputArtifact"]);
        if (outputArtifact) out.outputArtifact = outputArtifact;
        if (
          typeof obj["offsetBytes"] === "number" &&
          (typeof obj["nextOffsetBytes"] === "number" || obj["nextOffsetBytes"] === null) &&
          typeof obj["capturedBytes"] === "number" &&
          typeof obj["totalBytes"] === "number" &&
          typeof obj["truncated"] === "boolean" &&
          typeof obj["expiresAt"] === "string" &&
          typeof obj["deleted"] === "boolean"
        ) {
          out.outputArtifactPage = {
            offsetBytes: obj["offsetBytes"],
            nextOffsetBytes: obj["nextOffsetBytes"],
            capturedBytes: obj["capturedBytes"],
            totalBytes: obj["totalBytes"],
            truncated: obj["truncated"],
            expiresAt: obj["expiresAt"],
            deleted: obj["deleted"],
          };
        }
        if (outputArtifactSearch) out.outputArtifactSearch = outputArtifactSearch;
        return out;
      }
    }
  } catch {
    // Bad JSON — render legacy output verbatim.
  }
  return { raw: resultText };
}

function Output({
  stream,
  text,
  observation,
  truncated,
  errorTone = stream === "stderr",
}: {
  stream: "stdout" | "stderr" | "output";
  text: string;
  observation?: "live" | "last observed";
  truncated?: boolean;
  errorTone?: boolean;
}): React.ReactElement {
  const outputRef = useRef<HTMLPreElement>(null);
  const followsTailRef = useRef(true);

  useEffect(() => {
    const element = outputRef.current;
    if (observation !== "live" || !element || !followsTailRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [observation, text]);

  const onScroll = () => {
    const element = outputRef.current;
    if (!element) return;
    // A small tolerance avoids turning harmless sub-pixel/rounding drift into
    // an opt-out. Once away, only a deliberate scroll back to the tail resumes
    // following this stream.
    followsTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
  };

  const heading = `${stream}${observation ? ` (${observation})` : ""}${truncated ? " (truncated)" : ""}`;
  const tone = errorTone ? "text-tool-error" : "text-foreground-dim";

  return (
    <section aria-label={stream}>
      <div className={`mb-1 text-[0.65rem] font-semibold uppercase tracking-wide ${tone}`}>
        {heading}
      </div>
      <pre
        ref={outputRef}
        data-testid={`run-shell-${stream}`}
        onScroll={onScroll}
        className={`max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed ${errorTone ? "text-tool-error" : "text-foreground"}`}
      >
        {text}
      </pre>
    </section>
  );
}

function RunShellExpanded(props: ToolRendererProps): React.ReactElement {
  const {
    args,
    state,
    event,
    resultText,
    runShellProgress,
    runShellContinuity,
    elapsedMs,
  } = props;
  const command = pickCommand(args) || commandFromHarnessResult(resultText);
  const retrievesArtifact = isOutputArtifactRequest(args);
  const searchesArtifact = isOutputArtifactSearchRequest(args);
  const error = event?.error;
  const isDesktopRunShell = props.toolName === "run_shell";
  const hasProvisionalObservation =
    isDesktopRunShell && state === "running" && runShellProgress !== undefined;
  const isLive =
    hasProvisionalObservation &&
    runShellContinuity !== "disconnected" &&
    runShellContinuity !== "outcome_unknown";
  // The final result is canonical. Never retain/show provisional pipe text
  // beside it after completion, even if an old progress snapshot remains.
  const parsed = hasProvisionalObservation
    ? { stdout: runShellProgress.stdout, stderr: runShellProgress.stderr }
    : parseShellResult(resultText);
  const shownElapsed = hasProvisionalObservation
    ? runShellProgress.elapsedMs
    : (parsed.durationMs ?? elapsedMs);
  const elapsed = formatDuration(shownElapsed);
  const hasStdout = typeof parsed.stdout === "string" && (parsed.stdout.length > 0 || parsed.stdoutTruncated === true);
  const hasStderr = typeof parsed.stderr === "string" && (parsed.stderr.length > 0 || parsed.stderrTruncated === true);
  const hasRaw = typeof parsed.raw === "string" && parsed.raw.length > 0;
  const hasAnyOutput = hasStdout || hasStderr || hasRaw || parsed.outputArtifact !== undefined || parsed.outputArtifactPage !== undefined || parsed.outputArtifactSearch !== undefined;
  // stderr is a byte stream, not an outcome. Bun intentionally writes install
  // progress and test reporters there even when the process exits 0. Reserve
  // the error treatment for a failed/abnormal canonical outcome.
  const stderrIsError = state === "error" ||
    (!isLive && (
      (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) ||
      parsed.signal !== undefined ||
      parsed.timedOut === true
    ));

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      <section aria-label="command">
        <pre className="rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">
          <span className="select-none text-foreground-dim">$ </span>
          {searchesArtifact ? "Search retained shell output" : retrievesArtifact ? "Retrieve retained shell output" : (command || "(no command)")}
        </pre>
      </section>

      {isDesktopRunShell && (
        <div aria-label="execution context" className="text-xs text-foreground-muted">
          {runShellContextLabel(args, parsed.execution)}
          {(state === "running" || elapsed) && (
            <span className="ml-2 tabular-nums">
              {runShellContinuity === "disconnected"
                ? "disconnected · command may still be running"
                : runShellContinuity === "outcome_unknown"
                  ? "outcome unknown"
                  : isLive
                    ? runShellProgress.phase
                    : (state === "running" ? "running" : "completed")}{elapsed ? ` · ${elapsed}` : ""}
            </span>
          )}
        </div>
      )}

      {hasStdout && (
        <Output
          stream="stdout"
          text={parsed.stdout!}
          observation={hasProvisionalObservation ? (isLive ? "live" : "last observed") : undefined}
          truncated={parsed.stdoutTruncated}
        />
      )}
      {hasStderr && (
        <Output
          stream="stderr"
          text={parsed.stderr!}
          observation={hasProvisionalObservation ? (isLive ? "live" : "last observed") : undefined}
          truncated={parsed.stderrTruncated}
          errorTone={stderrIsError}
        />
      )}
      {hasRaw && <Output stream="output" text={parsed.raw!} truncated={props.resultTruncated} />}

      {parsed.outputArtifact && (
        <div role="status" className="text-xs text-foreground-muted">
          Preview is truncated. {retainedCaptureCopy(parsed.outputArtifact)} Expires <time dateTime={parsed.outputArtifact.expiresAt}>{parsed.outputArtifact.expiresAt}</time>.
        </div>
      )}

      {parsed.outputArtifactPage && (
        <div role="status" className="text-xs text-foreground-muted">
          Retained output page from byte {parsed.outputArtifactPage.offsetBytes}.
          {parsed.outputArtifactPage.nextOffsetBytes === null
            ? ` Final page${parsed.outputArtifactPage.deleted ? "; continuation deleted" : ""}.`
            : ` Continue at byte ${parsed.outputArtifactPage.nextOffsetBytes}.`}
        </div>
      )}

      {parsed.outputArtifactSearch && (
        <section aria-label="retained output search" className="space-y-2">
          <div role="status" className="text-xs text-foreground-muted">
            Literal search returned {parsed.outputArtifactSearch.matches.length} of {parsed.outputArtifactSearch.totalMatches} match{parsed.outputArtifactSearch.totalMatches === 1 ? "" : "es"}.
            {parsed.outputArtifactSearch.matchesTruncated ? " Match results are bounded." : ""} {retainedCaptureCopy(parsed.outputArtifactSearch)} Expires <time dateTime={parsed.outputArtifactSearch.expiresAt}>{parsed.outputArtifactSearch.expiresAt}</time>.
          </div>
          {parsed.outputArtifactSearch.matches.map((match, index) => (
            <section key={`${match.stream}:${match.matchOffsetBytes}:${index}`} aria-label={`${match.stream} search match ${index + 1}`}>
              <div className={`mb-1 text-[0.65rem] font-semibold uppercase tracking-wide ${match.stream === "stderr" ? "text-tool-error" : "text-foreground-dim"}`}>
                {match.stream} · stream match at byte {match.matchOffsetBytes} · artifact byte {match.artifactOffsetBytes} · context begins at stream byte {match.contextOffsetBytes}
              </div>
              <pre className={`max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed ${match.stream === "stderr" ? "text-tool-error" : "text-foreground"}`}>
                {match.context}
              </pre>
            </section>
          ))}
        </section>
      )}

      {hasProvisionalObservation && runShellProgress.droppedBytes > 0 && (
        <div role="status" className="text-xs text-[var(--warning,#b58900)]">
          Live output dropped {formatBytes(runShellProgress.droppedBytes)}; final result may contain bounded head/tail evidence.
        </div>
      )}

      {runShellContinuity === "disconnected" && (
        <div role="status" className="text-xs text-[var(--warning,#b58900)]">
          Connection lost. This one-shot command may still be running; waiting for progress or its final result.
        </div>
      )}

      {runShellContinuity === "outcome_unknown" && (
        <div role="status" className="text-xs text-[var(--warning,#b58900)]">
          Command outcome unknown. No completion or cancellation is being assumed.
        </div>
      )}

      {!isLive && typeof parsed.exitCode === "number" && (
        <div className={parsed.exitCode === 0 ? "text-xs text-foreground-muted" : "text-xs text-tool-error"}>
          exit code: <span className="font-mono">{parsed.exitCode}</span>
        </div>
      )}
      {!isLive && parsed.signal && <div className="text-xs text-tool-error">signal: <span className="font-mono">{parsed.signal}</span></div>}
      {!isLive && parsed.timedOut && <div className="text-xs text-tool-error">timed out</div>}
      {!isLive && parsed.cancelled && <div className="text-xs text-foreground-muted">cancelled</div>}
      {!isLive && parsed.sideEffectsMayHaveStarted && (state === "error" || parsed.timedOut || parsed.cancelled || parsed.signal) && (
        <div className="text-xs text-foreground-muted">Side effects may have started before completion.</div>
      )}

      {state === "error" && error && error !== resultText && (
        <section aria-label="error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">Error</div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{error}</pre>
        </section>
      )}

      {!hasAnyOutput && state !== "error" && (
        <div className="text-xs italic text-foreground-dim">(no output)</div>
      )}
    </div>
  );
}

export const runShellRenderer: ToolRenderer = {
  collapsedSummary,
  autoExpandOnResult: true,
  ExpandedBody: RunShellExpanded,
};
