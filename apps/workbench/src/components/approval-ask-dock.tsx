/**
 * ApprovalAskDock — inline approval dock (D061 Phase 2-client / Chunk 5).
 *
 * Hermes / OpenCode / Claude Code all converged on an inline dock over a
 * centered modal for LIGHT approvals (graduated verbs, no PIN). Modals
 * interrupt the session; docks sit above the composer and let the user
 * keep scrolling history while deciding. A modal is correct ONLY when
 * the user MUST respond (PIN / prove_it); ask is always dismissable
 * via deny, so it's a dock.
 *
 * Shape:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ ⚠  <reason line>                          ✕ │
 *   │ <tool preview>                              │
 *   │ [Yes, once] [This room] [Always] [Deny]    │
 *   │ err: <message> (if any)                     │
 *   └─────────────────────────────────────────────┘
 *   ┌─────────────────────────────────────────────┐
 *   │ composer textarea                      [→]  │
 *   └─────────────────────────────────────────────┘
 *
 * Keyboard:
 *   1  → once
 *   2  → room
 *   3  → always
 *   4  → deny
 *   Enter → first enabled verb (typically once)
 *   Escape → deny
 *
 * Renders nothing when `state.show` is false. The dock owns its own
 * keyboard listener (attached on mount, detached on unmount) so the
 * shortcuts work regardless of which element has focus — the user
 * shouldn't have to click the dock first to dismiss it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type {
  ApprovalReplyVerb,
  ApprovalScopeInfo,
  LocalMcpInstallApproval,
  MediaGenerationApproval,
  StructuredSshApproval,
  ProveItToolInfo,
  ShareMemoryApprovalPreview,
} from "@nautilo/types";
import { isMediaGenerationApproval } from "@nautilo/types";
import { useApprovalAsk } from "../adapters/runtime-contexts";
import { MediaGenerationVisualReview, type GenerationReviewPresentation } from "./media-generation-visual-review";
import {
  formatToolPreview,
  redactToolArgsForDisplay,
} from "./tool-argument-preview";

const VERB_LABELS: Record<ApprovalReplyVerb, string> = {
  once: "Yes, once",
  room: "This room",
  always: "Always",
  deny: "Deny",
};

const TOOL_VERB_HINTS: Record<ApprovalReplyVerb, string> = {
  once: "Approve this single invocation (1)",
  room: "Approve matching calls in this room — writes a standing rule (2)",
  always: "Always approve everywhere — writes a standing rule (3)",
  deny: "Reject this invocation (4, Esc)",
};

const CAPABILITY_VERB_HINTS: Record<ApprovalReplyVerb, string> = {
  once: "Approve only this invocation (1)",
  room: "Allow this capability in this room until revoked (2)",
  always: "Allow this capability server-wide until revoked (3)",
  deny: "Reject this invocation (4, Esc)",
};

const MIXED_SCOPE_VERB_HINTS: Record<ApprovalReplyVerb, string> = {
  once: "Approve this single invocation (1)",
  room: "Write a standing approval scoped to this room (2)",
  always: "Write a standing approval server-wide (3)",
  deny: "Reject this invocation (4, Esc)",
};

function isCapabilityScope(scope: ApprovalScopeInfo): boolean {
  return scope.approvalKind === "capability" && scope.capabilitySlug !== undefined;
}

function formatScopeGrain(scope: ApprovalScopeInfo): string {
  if (isCapabilityScope(scope)) {
    return `This room / Always will allow capability: ${scope.capabilitySlug}`;
  }
  if (scope.sameAsOnce) {
    return "This room / Always will allow exactly this command";
  }
  return `This room / Always will allow: ${scope.generalizedDisplay}`;
}

function verbHintsForScopeInfo(
  scopeInfo: readonly (ApprovalScopeInfo | undefined)[],
): Record<ApprovalReplyVerb, string> {
  const relevant = scopeInfo.filter((s): s is ApprovalScopeInfo => s !== undefined);
  if (relevant.length === 0) return TOOL_VERB_HINTS;
  const allCapability = relevant.every(isCapabilityScope);
  if (allCapability) return CAPABILITY_VERB_HINTS;
  if (relevant.some(isCapabilityScope)) return MIXED_SCOPE_VERB_HINTS;
  return TOOL_VERB_HINTS;
}

function ShareMemoryApprovalDockDetail({
  preview,
  now,
}: {
  preview: ShareMemoryApprovalPreview;
  now: number;
}) {
  if (preview.projection) {
    const projection = preview.projection;
    if (projection.expiresAt !== undefined && projection.expiresAt <= now) {
      return (
        <div className="mt-1 rounded border border-border/60 bg-background-element/50 px-2 py-1.5 text-[11px] text-foreground-muted">
          This sharing preview has expired. Deny it and ask for a fresh preview.
        </div>
      );
    }
    return (
      <div
        className="mt-1 space-y-1 rounded border border-border/60 bg-background-element/50 px-2 py-1.5 text-[11px] text-foreground-muted"
        data-testid="share-memory-projection-preview"
      >
        <div className="font-medium text-foreground">
          A NEW Memory copy will be created in the destination Room.
        </div>
        <div>
          <span className="font-medium text-foreground">Destination Room: </span>
          <span>{projection.roomLabel}</span>
          <span className="text-foreground-muted"> · {projection.roomKind.replaceAll("_", " ")} · {projection.memberCount} visible {projection.memberCount === 1 ? "member" : "members"}</span>
        </div>
        <div
          className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background-element px-2 py-1.5 text-foreground"
          aria-label="Exact projected Memory content"
          data-testid="share-memory-projection-content"
        >
          {projection.content}
        </div>
        {projection.audienceWarning ? (
          <div
            className="text-[var(--warning)]"
            aria-label="Destination audience warning"
          >
            {projection.audienceWarning}
          </div>
        ) : null}
      </div>
    );
  }

  const sens =
    preview.sensitivity === "sensitive"
      ? "The agent marked this share as sensitive, so Nautilo needs proof of identity."
      : "The agent marked this share as normal.";
  return (
    <div className="mt-1 space-y-1 rounded border border-border/60 bg-background-element/50 px-2 py-1.5 text-[11px] text-foreground-muted">
      <div>
        <span className="font-medium text-foreground">Memory: </span>
        <span className="text-foreground">{preview.memoryContentSnippet}</span>
        {preview.memoryType ? (
          <span className="ml-1 rounded bg-background-element px-1 text-[10px] uppercase tracking-wide">
            {preview.memoryType}
          </span>
        ) : null}
      </div>
      <div>
        Target: @{preview.targetHandle} ({preview.targetDisplayName})
      </div>
      {preview.wouldCreate ? (
        <div className="text-[var(--warning)]">
          This will create a new room &apos;{preview.roomLabel ?? "…"}&apos;. They will see it
          appear in their sidebar.
        </div>
      ) : (
        <div>
          Will be attached to your existing room &apos;{preview.roomLabel ?? "…"}&apos;.
        </div>
      )}
      <div>{sens}</div>
    </div>
  );
}

function DoInPrivateNamespaceApprovalDockDetail({
  tool,
}: {
  tool: ProveItToolInfo;
}) {
  const safeArgs = redactToolArgsForDisplay(tool.args);
  const brief =
    typeof safeArgs["brief"] === "string" ? safeArgs["brief"] : null;
  const expectedOutput =
    typeof safeArgs["expected_output"] === "string"
      ? safeArgs["expected_output"]
      : null;

  return (
    <div className="mt-1 space-y-1 rounded border border-border/60 bg-background-element/50 px-2 py-1.5 text-[11px] text-foreground-muted">
      {brief ? (
        <div>
          <span className="font-medium text-foreground">Task: </span>
          <span className="text-foreground">{brief}</span>
        </div>
      ) : null}
      {expectedOutput ? (
        <div>
          <span className="font-medium text-foreground">Expected: </span>
          <span className="text-foreground">{expectedOutput}</span>
        </div>
      ) : null}
      <div className="text-[var(--warning)]">
        This runs inside YOUR private 1:1 space with the agent — content found there
        can be surfaced into this room. Only your final answer is relayed; the
        private transcript stays hidden.
      </div>
    </div>
  );
}

function LocalMcpInstallApprovalDetail({ approval }: { approval: LocalMcpInstallApproval }) {
  const preview = approval.preview;
  const launch = preview.transport.kind === "stdio"
    ? [preview.transport.command, ...preview.transport.args]
    : [preview.transport.url];
  return (
    <section
      className="mt-2 rounded-md border border-[var(--warning)]/40 bg-background-element/70 px-2.5 py-2 text-[11px] text-foreground-muted"
      data-testid="local-mcp-install-approval"
    >
      <div className="font-medium text-foreground">Install local MCP: {preview.name}</div>
      <div className="mt-1">Human: {preview.human} · Machine: {preview.machine}</div>
      <div className="mt-1">Relay ID: <span className="font-mono text-foreground">{preview.relayId}</span></div>
      <div className="mt-1">{preview.transport.kind === "stdio" ? "Exact argv (each element quoted)" : "Streamable HTTP URL"}</div>
      <div className="mt-0.5 break-all rounded bg-background px-1.5 py-1 font-mono text-foreground">
        {preview.transport.kind === "stdio"
          ? launch.map((part, index) => <div key={`${part}-${index}`}>argv[{index}]={JSON.stringify(part)}</div>)
          : <div>streamableHttpUrl={JSON.stringify(launch[0])}</div>}
      </div>
      <div className="mt-1">Source: {preview.source.url ? <a className="underline" href={preview.source.url} target="_blank" rel="noreferrer">{preview.source.label}</a> : preview.source.label}</div>
      {preview.package ? <div className="mt-1">Package evidence: {preview.package.name}{preview.package.version ? ` @ ${preview.package.version}` : " (no exact version)"}</div> : null}
      {preview.mayDownloadOnFirstRun ? <div className="mt-1 text-[var(--warning)]">First launch may download executable code.</div> : null}
      {preview.unpinnedPackage ? <div className="mt-1 text-[var(--warning)]">Package version is not pinned.</div> : null}
      <div className="mt-1">Environment: {preview.environment.length === 0 ? "None" : preview.environment.map((env) => `${env.name} (${env.present ? "present" : "missing"})`).join(", ")}</div>
      <div className="mt-1">Availability: {preview.availabilitySummary}</div>
      {preview.subprocessSandboxed === false
        ? <div className="mt-1 text-[var(--warning)]">This MCP subprocess is not sandboxed.</div>
        : <div className="mt-1">No local subprocess is launched for this HTTP MCP.</div>}
      <div className="mt-1 break-all font-mono text-[10px]">Approval digest: {approval.digest}</div>
    </section>
  );
}

function StructuredSshApprovalDetail({ approval }: { approval: StructuredSshApproval }) {
  return (
    <section
      className="mt-2 rounded-md border border-[var(--warning)]/40 bg-background-element/70 px-2.5 py-2 text-[11px] text-foreground-muted"
      data-testid="structured-ssh-approval"
    >
      <div className="font-medium text-foreground">Exact structured SSH approval</div>
      <div className="mt-1">Host: <span className="font-mono text-foreground">{approval.host}:{approval.port}</span></div>
      <div className="mt-1">Remote user: <span className="font-mono text-foreground">{approval.remoteUser}</span></div>
      <div className="mt-1 break-all">Host-key fingerprint: <span className="font-mono text-foreground">{approval.hostKeyFingerprint}</span></div>
      <div className="mt-1">Host trust: {approval.hostTrust === "trusted" ? "Already trusted" : approval.hostTrust === "changed" ? "Host key changed" : "First connection"}</div>
      {approval.previousHostKeyFingerprint ? <div className="mt-1 break-all">Previous host key: <span className="font-mono text-foreground">{approval.previousHostKeyFingerprint}</span></div> : null}
      <div className="mt-1">Operation: {approval.operation}</div>
      {approval.timeoutSeconds !== undefined ? (
        <div className="mt-1">
          Execution budget: {approval.timeoutSeconds} seconds
          {approval.timeoutReason ? ` — ${approval.timeoutReason}` : ""}
        </div>
      ) : null}
      {approval.operation === "exec" ? (
        <div className="mt-1 rounded bg-background px-1.5 py-1 font-mono text-foreground">
          <div>program={JSON.stringify(approval.program)}</div>
          {(approval.argv ?? []).map((arg, index) => <div key={`${arg}-${index}`}>argv[{index}]={JSON.stringify(arg)}</div>)}
        </div>
      ) : approval.operation === "copy-upload" || approval.operation === "copy-download" ? (
        <div className="mt-1 rounded bg-background px-1.5 py-1 font-mono text-foreground">
          <div>localPath={JSON.stringify(approval.localPath)}</div>
          <div>remotePath={JSON.stringify(approval.remotePath)}</div>
        </div>
      ) : <div className="mt-1">Authentication only; no remote command.</div>}
      <div className="mt-1 break-all font-mono text-[10px]">Request digest: {approval.approvedRequestDigest}</div>
    </section>
  );
}

function RunShellTimeoutApprovalDetail({
  timeout,
}: {
  timeout: NonNullable<ProveItToolInfo["runShellTimeout"]>;
}) {
  return (
    <div
      className="mt-1 rounded-md border border-border bg-background-element/70 px-2 py-1.5 text-[11px] text-foreground-muted"
      data-testid="run-shell-timeout-approval"
    >
      <div className="font-medium text-foreground">
        Long command budget: {timeout.timeoutSeconds} seconds
      </div>
      <div className="mt-1 text-foreground">Execution intent</div>
      <div className="whitespace-pre-wrap break-words text-foreground">{timeout.reason}</div>
    </div>
  );
}

const MEDIA_SETTING_LABELS: Record<string, string> = {
  durationSeconds: "Duration",
  aspectRatio: "Aspect ratio",
  resolution: "Resolution",
  audio: "Audio",
  forceInstrumental: "Instrumental",
  referenceImages: "Reference images",
  referenceVideos: "Reference videos",
  referenceVideoSeconds: "Reference video seconds",
  referenceAudios: "Audio references",
  referenceAudioSeconds: "Reference audio seconds",
};

function mediaModelLabel(model: string): string {
  if (model === "seedance-2-5-reference-to-video-basic") return "Seedance 2.5 · Advanced reference";
  if (model === "seedance-2-5-text-to-video-basic") return "Seedance 2.5 · Simple text";
  if (model === "minimax-h3-enhanced-text-to-video") return "MiniMax H3 Enhanced";
  return model;
}

function formatMediaSetting(key: string, value: string | number | boolean): string {
  if (key === "durationSeconds" && typeof value === "number") return `${value} seconds`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function MediaGenerationApprovalDetail({ approval, presentation, roomId }: { approval: MediaGenerationApproval; presentation?: GenerationReviewPresentation; roomId?: string }) {
  return <MediaGenerationVisualReview approval={approval} presentation={presentation} roomId={roomId} technicalDetails={<MediaGenerationTechnicalDetail approval={approval} />} />;
}

function MediaGenerationTechnicalDetail({ approval }: { approval: MediaGenerationApproval }) {
  const { preview } = approval;
  return (
    <section
      className="mt-2 rounded-md border border-[var(--warning)]/40 bg-background-element/70 px-2.5 py-2 text-[11px] text-foreground-muted"
      data-testid="media-generation-technical-details"
      aria-labelledby="media-generation-approval-title"
    >
      <div id="media-generation-approval-title" className="font-medium text-foreground">
        Paid {preview.mediaKind} generation
      </div>
      <dl className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
        <dt>Model</dt>
        <dd className="break-words text-foreground">{mediaModelLabel(preview.model)}</dd>
        {Object.entries(preview.settings).map(([key, value]) => (
          <div key={key} className="contents">
            <dt>{MEDIA_SETTING_LABELS[key] ?? key}</dt>
            <dd className="text-foreground">{formatMediaSetting(key, value)}</dd>
          </div>
        ))}
        {preview.referenceImages ? (
          <>
            <dt>Ordered references</dt>
            <dd>
              <ol className="space-y-1">
                {preview.referenceImages.map((reference) => (
                  <li key={reference.artifactId} className="rounded border border-border/70 bg-background px-2 py-1 text-foreground">
                    <span className="mr-1 font-mono text-foreground-muted">{`<Image ${reference.index}>`}</span>
                    {reference.label}
                  </li>
                ))}
              </ol>
            </dd>
          </>
        ) : null}
        {preview.referenceVideos?.length ? <><dt>Reference videos</dt><dd><ol>{preview.referenceVideos.map(reference =>
          <li key={reference.index}>{`<Video ${reference.index}>`} {reference.label} · {reference.durationSeconds}s</li>)}</ol></dd></> : null}
        {preview.referenceAudios?.length ? <><dt>Audio references</dt><dd><ol>{preview.referenceAudios.map(reference =>
          <li key={reference.index}>{`<Audio ${reference.index}>`} {reference.label} · {reference.durationSeconds}s</li>)}</ol></dd></> : null}
        <dt>Prompt</dt>
        <dd className="min-w-0 break-words text-foreground">
          {preview.prompt.summary}
          {preview.prompt.truncated ? "…" : ""}
          <span className="ml-1 text-foreground-muted">
            ({preview.prompt.characterCount.toLocaleString()} characters{preview.prompt.truncated ? ", summary shown" : ""})
          </span>
        </dd>
        <dt>Exact quote</dt>
        <dd className="font-semibold text-foreground">
          {preview.quote.display}
        </dd>
        <dt>Quote expires</dt>
        <dd>
          <time dateTime={approval.expiresAt}>{new Date(approval.expiresAt).toLocaleString()}</time>
        </dd>
      </dl>
      <p role="alert" className="mt-2 font-semibold text-[var(--warning)]">
        Approving starts paid generation using this exact quote.
      </p>
      {preview.model === "seedance-2-5-reference-to-video-basic" ? (
        <p className="mt-1 text-foreground-muted">
          Ordered Workspace images are bound to this approval. Venice may reject references containing people; Nautilo cannot attest consent for you.
        </p>
      ) : null}
    </section>
  );
}

export function ApprovalAskDock() {
  const { state, submit } = useApprovalAsk();
  const [now, setNow] = useState(() => Date.now());
  const projectionExpiries = state.tools.flatMap((tool) => {
    const expiresAt = tool.shareMemoryPreview?.projection?.expiresAt;
    return expiresAt === undefined ? [] : [expiresAt];
  });
  const projectionExpiryKey = projectionExpiries.join(":");
  useEffect(() => {
    setNow(Date.now());
  }, [projectionExpiryKey]);
  const nextProjectionExpiry = projectionExpiries
    .filter((expiresAt) => expiresAt > now)
    .reduce<number | undefined>(
      (earliest, expiresAt) => earliest === undefined ? expiresAt : Math.min(earliest, expiresAt),
      undefined,
    );
  useEffect(() => {
    if (nextProjectionExpiry === undefined) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextProjectionExpiry - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [nextProjectionExpiry]);
  const hasExpiredProjection = projectionExpiries.some((expiresAt) => expiresAt <= now);
  const mediaGeneration = useMemo(
    () => isMediaGenerationApproval(state.mediaGeneration) ? state.mediaGeneration : null,
    [state.mediaGeneration],
  );
  const malformedMediaGeneration = state.mediaGeneration != null && mediaGeneration === null;
  const allowedVerbs = useMemo<ApprovalReplyVerb[]>(
    () => hasExpiredProjection
      ? state.allowedVerbs.includes("deny") ? ["deny"] : []
      : malformedMediaGeneration
      ? state.allowedVerbs.includes("deny") ? ["deny"] : []
      : mediaGeneration
        ? state.allowedVerbs.filter((verb) => verb === "once" || verb === "deny")
        : state.allowedVerbs,
    [hasExpiredProjection, malformedMediaGeneration, mediaGeneration, state.allowedVerbs],
  );

  // Prefer "once" if offered, else the first allowed verb. The
  // fallback matters because in strict modes the server may omit
  // "once" (e.g. restrict to "deny" only).
  const primaryVerb: ApprovalReplyVerb | null = hasExpiredProjection
    ? null
    : allowedVerbs.includes("once")
    ? "once"
    : (allowedVerbs[0] ?? null);
  const verbHints = verbHintsForScopeInfo(state.scopeInfo);

  const handleSubmit = useCallback(
    (verb: ApprovalReplyVerb) => {
      if (state.submitting) return;
      if (!allowedVerbs.includes(verb)) return;
      void submit(verb);
    },
    [state.submitting, allowedVerbs, submit],
  );

  // Window-level keyboard shortcuts. Only active while the dock is
  // shown. Intentionally NOT attached to the dock's own DOM so the
  // user can trigger a verb without moving focus from the composer.
  useEffect(() => {
    if (!state.show) return;

    const onKey = (e: KeyboardEvent) => {
      // Ignore repeats and modifier-combined keystrokes so we don't
      // clash with app shortcuts (⌘1 etc.) or accidental holds.
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Ignore when focus is in a text input + the key is a digit /
      // letter so the user can still type normal messages. Escape
      // always fires.
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      if (e.key === "Escape") {
        if (allowedVerbs.includes("deny")) {
          e.preventDefault();
          handleSubmit("deny");
        }
        return;
      }

      if (isEditable) return;

      if (e.key === "Enter") {
        if (primaryVerb) {
          e.preventDefault();
          handleSubmit(primaryVerb);
        }
        return;
      }

      // M037 — "Always" is now durable, so all four digits map to a verb.
      const digitToVerb: Record<string, ApprovalReplyVerb> = {
        "1": "once",
        "2": "room",
        "3": "always",
        "4": "deny",
      };
      const verb = digitToVerb[e.key];
      if (verb) {
        e.preventDefault();
        handleSubmit(verb);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.show, allowedVerbs, primaryVerb, handleSubmit]);

  if (!state.show) return null;

  return (
    <div
      data-testid="approval-ask-dock"
      role="dialog"
      aria-live="polite"
      aria-label="Tool approval requested"
      // D087 UX pass — lock the dock to the container's width and
      // clip any overflow at the outer boundary. Without this, a long
      // tool-preview line (e.g. `file.write(content: …)` with ~90
      // chars) was contributing an intrinsic min-width that expanded
      // the whole center column and pushed the composer's send button
      // off-screen. `w-full` + `overflow-hidden` caps the dock width
      // at its grid-column slot; `min-w-0` on the inner flex allows
      // `truncate` further down to actually ellipsize.
      className="w-full overflow-hidden border-t border-[var(--warning)]/40 bg-[var(--warning)]/8 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-foreground">
              Needs your approval
            </span>
            {/* D087 UX pass — the uppercase reasonCode chip (e.g.
                "DESTRUCTIVE-TOOL") felt alarmingly technical next to
                the human-readable reason line. The internal code still
                flows through for telemetry / keyboard-shortcut
                addressing, just not rendered as a scare-chip. */}
          </div>
          <p className="mt-0.5 text-xs text-foreground-muted">{state.reason}</p>

          {state.network ? (
            <div className="mt-2 rounded-md border border-border bg-background-element/70 px-2 py-1.5 text-[11px] text-foreground-muted">
              <div className="font-medium text-foreground">Network destination</div>
              <div className="mt-0.5 font-mono">
                {state.network.host}:{state.network.port}
              </div>
              <div className="mt-0.5">
                {state.network.reason}
              </div>
            </div>
          ) : null}

          {state.localMcpInstall ? (
            <LocalMcpInstallApprovalDetail approval={state.localMcpInstall} />
          ) : null}
          {mediaGeneration ? (
            <MediaGenerationApprovalDetail approval={mediaGeneration} roomId={state.roomId} />
          ) : null}
          {state.structuredSsh ? (
            <StructuredSshApprovalDetail approval={state.structuredSsh} />
          ) : null}
          {state.requiresExplicitReview && !state.localMcpInstall && !mediaGeneration && !state.structuredSsh ? (
            <p role="alert" className="mt-2 text-[11px] text-[var(--error)]">
              Exact review details are unavailable. This action cannot be approved from this client.
            </p>
          ) : null}

          {state.tools.length > 0 && !mediaGeneration ? (
            <ul className="mt-2 min-w-0 space-y-1 text-[11px] text-foreground-muted">
              {state.tools.map((t, i) =>
                t.name === "share_memory" && t.shareMemoryPreview ? (
                  <li key={`${t.name}-${i}`} className="min-w-0">
                    <div className="truncate font-mono">
                      → Share memory with @{t.shareMemoryPreview.targetHandle} (
                      {t.shareMemoryPreview.targetDisplayName})
                    </div>
                    <ShareMemoryApprovalDockDetail preview={t.shareMemoryPreview} now={now} />
                  </li>
                ) : t.name === "in_private_namespace" ? (
                  <li key={`${t.name}-${i}`} className="min-w-0">
                    <div className="truncate font-mono">→ Private-space excursion</div>
                    <DoInPrivateNamespaceApprovalDockDetail tool={t} />
                  </li>
                ) : t.name === "run_shell" && t.runShellTimeout ? (
                  <li key={`${t.name}-${i}`} className="min-w-0">
                    <div className="truncate font-mono" title={formatToolPreview(t)}>
                      → {formatToolPreview(t)}
                    </div>
                    <RunShellTimeoutApprovalDetail timeout={t.runShellTimeout} />
                    {state.scopeInfo[i] ? (
                      <div
                        className="mt-0.5 truncate text-[10px] text-foreground-muted"
                        title={formatScopeGrain(state.scopeInfo[i])}
                        data-testid="approval-grain"
                      >
                        {formatScopeGrain(state.scopeInfo[i])}
                      </div>
                    ) : null}
                  </li>
                ) : (
                  <li key={`${t.name}-${i}`} className="min-w-0">
                    <div className="truncate font-mono" title={formatToolPreview(t)}>
                      → {formatToolPreview(t)}
                    </div>
                    {state.scopeInfo[i] ? (
                      <div
                        className="mt-0.5 truncate text-[10px] text-foreground-muted"
                        title={formatScopeGrain(state.scopeInfo[i])}
                        data-testid="approval-grain"
                      >
                        {formatScopeGrain(state.scopeInfo[i])}
                      </div>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(["once", "room", "always", "deny"] as const).map((verb) => {
              if (!allowedVerbs.includes(verb)) return null;
              const isDeny = verb === "deny";
              const isPrimary = verb === primaryVerb;
              return (
                <button
                  key={verb}
                  type="button"
                  onClick={() => handleSubmit(verb)}
                  disabled={state.submitting}
                  title={verbHints[verb]}
                  data-verb={verb}
                  className={[
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    isDeny
                      ? "border border-border bg-background-element text-foreground-muted hover:border-[var(--error)]/50 hover:text-[var(--error)]"
                      : isPrimary
                        ? "bg-primary text-[var(--on-primary)] hover:bg-primary-hover"
                        : "border border-border bg-background-element text-foreground hover:border-border-strong",
                  ].join(" ")}
                >
                  {VERB_LABELS[verb]}
                </button>
              );
            })}
            {state.submitting ? (
              <span className="text-[11px] text-foreground-muted">Submitting…</span>
            ) : null}
          </div>

          {allowedVerbs.includes("room") ||
          allowedVerbs.includes("always") ? (
            <p
              data-testid="approval-manage-hint"
              className="mt-2 min-w-0 text-[11px] text-foreground-muted"
            >
              Standing rules can be revoked anytime in Approvals (sidebar).
            </p>
          ) : null}

          {state.error ? (
            <p
              role="alert"
              className="mt-2 text-[11px] text-[var(--error)]"
            >
              {state.error}
            </p>
          ) : null}
        </div>

        {/* Dismissable-by-deny marker. Not a real close button — it's
            an X that routes through the same deny path so the graph
            learns the user said no. Distinct from modals where the X
            could mean "cancel" or "deny" ambiguously. */}
        {allowedVerbs.includes("deny") ? (
          <button
            type="button"
            onClick={() => handleSubmit("deny")}
            disabled={state.submitting}
            aria-label="Deny and close"
            title="Deny (Esc)"
            className="flex-shrink-0 rounded-md p-1 text-foreground-muted transition-colors hover:bg-background-element hover:text-foreground disabled:opacity-60"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
