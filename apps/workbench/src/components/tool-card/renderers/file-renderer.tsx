/**
 * D087 Phase 1 §1.5 — renderer for the D079 unified `file` tool.
 *
 * The `file` tool dispatches 12 commands today (10 filesystem + 2
 * staged-patch verbs). This renderer picks sub-behavior by inspecting
 * the tool result:
 *
 *   1. If the `resultText` is a JSON envelope with `staged: true` —
 *      we're looking at a staged patch. Renders a `DiffView` with the
 *      unified diff from the envelope + Accept / Reject buttons
 *      (§1.5a + §1.5b). Applies to content commands (write /
 *      str_replace / insert) AND structural commands (delete / move /
 *      copy) per §1.3.5 — both produce the same envelope shape; the
 *      `structural` field on the envelope tells apply_patch which
 *      syscall to run.
 *
 *   2. If the command is `apply_patch` or `list_patches` — lightweight
 *      status / enumeration display. No DiffView needed; these are
 *      agent-layer verbs over the staged-patch store, not filesystem
 *      writes.
 *
 *   3. Otherwise — the command is a read-only op (list / read / grep /
 *      stat). Fall back to the existing per-command renderers keyed by
 *      command name (read_file / list_directory / search / etc.). This
 *      is a transitional compatibility shim that keeps legacy
 *      rendering working while the mutating commands route through
 *      DiffView.
 *
 * The collapsedSummary shows `file.<command>` with a short extras
 * blurb (path + stats for staging cases, args summary otherwise).
 */

import { useMemo, useCallback, useState, type ReactElement } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { pickPath, pickZonedPath, looksLikeToolError, workspaceLogicalPathLooksHtml } from "./shared";
import { DiffView } from "./diff-view";
import { BlockDiffView } from "../../diff-view/block-diff/BlockDiffView";
import { fileReadRenderer } from "./file-read";
import { fileWriteRenderer, HtmlArtifactOpenInWorkBar } from "./file-write";
import { editFileRenderer } from "./edit-file";
import { fileListRenderer } from "./file-list";
import { searchRenderer } from "./search";
import { deleteRenderer } from "./delete";
import { parseAppliedEnvelope, parseStagedEnvelope } from "../../../lib/staged-envelope";
import { apiClient } from "../../../lib/api";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useToast } from "../../toast";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { requestRevert } from "../../../adapters/tool-invoke-ref";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";

// ---------------------------------------------------------------------------
// D306 Phase 1B — binary workspace artifact affordances
// ---------------------------------------------------------------------------

function logicalBasename(logicalPath: string): string {
  const seg = logicalPath.replace(/\\/g, "/").split("/").pop();
  return seg && seg.length > 0 ? seg : logicalPath;
}

function mimeFromLogicalPath(logicalPath: string): string {
  const lower = logicalPath.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/octet-stream";
}

function WorkspaceBinaryArtifactBar(props: {
  logicalPath: string;
  artifactInternalId?: string;
  externalArtifactId?: string;
  bytes?: number;
}): ReactElement {
  const { logicalPath, artifactInternalId, externalArtifactId, bytes } = props;
  const roomNav = useRoomNavigation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const resolveArtifactId = useCallback(async (): Promise<string | null> => {
    if (artifactInternalId) return artifactInternalId;
    const roomId = roomNav.activeRoomId ?? undefined;
    const list = await apiClient.listWorkspaceArtifacts({
      pathPrefix: "",
      ...(roomId ? { roomId } : {}),
    });
    const byExternal =
      externalArtifactId !== undefined && externalArtifactId.length > 0
        ? list.artifacts.find((a) => a.artifactId === externalArtifactId)
        : undefined;
    const byPath = list.artifacts.find((a) => a.path === logicalPath);
    return (byExternal ?? byPath)?.id ?? null;
  }, [artifactInternalId, externalArtifactId, logicalPath, roomNav.activeRoomId]);

  const onDownload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await resolveArtifactId();
      if (!id) {
        toast.show({
          variant: "info",
          message: "This artifact is not indexed yet — try again after the write completes.",
        });
        return;
      }
      const roomId = roomNav.activeRoomId ?? undefined;
      await apiClient.downloadArtifact(id, logicalBasename(logicalPath), { roomId });
    } catch (e) {
      toast.show({
        variant: "warning",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, logicalPath, resolveArtifactId, roomNav.activeRoomId, toast]);

  const onOpen = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const roomId = roomNav.activeRoomId ?? undefined;
      let id = artifactInternalId;
      let path = logicalPath;
      let mimeType = mimeFromLogicalPath(logicalPath);
      if (!id) {
        const list = await apiClient.listWorkspaceArtifacts({
          pathPrefix: "",
          ...(roomId ? { roomId } : {}),
        });
        const byExternal =
          externalArtifactId !== undefined && externalArtifactId.length > 0
            ? list.artifacts.find((a) => a.artifactId === externalArtifactId)
            : undefined;
        const byPath = list.artifacts.find((a) => a.path === logicalPath);
        const hit = byExternal ?? byPath;
        if (!hit) {
          toast.show({
            variant: "info",
            message: "This artifact is not indexed yet — try again after the write completes.",
          });
          return;
        }
        id = hit.id;
        path = hit.path;
        mimeType = hit.mimeType.length > 0 ? hit.mimeType : mimeType;
      }
      const ok = requestOpenFile(
        artifactOpenFileTarget({
          id,
          path,
          mimeType,
          ...(roomId ? { roomId } : {}),
        }),
      );
      if (!ok) {
        toast.show({
          variant: "warning",
          message: "Could not open the Work surface (not ready). Try Download instead.",
        });
      }
    } catch (e) {
      toast.show({
        variant: "warning",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [artifactInternalId, busy, externalArtifactId, logicalPath, roomNav.activeRoomId, toast]);

  const sizeLabel = typeof bytes === "number" ? `${bytes} bytes` : "binary file";

  return (
    <div
      className="rounded border border-border bg-background px-3 py-2 text-xs space-y-2"
      data-testid="workspace-binary-artifact-bar"
    >
      <div className="font-medium text-foreground">Workspace artifact ({sizeLabel})</div>
      <div className="text-foreground-muted">
        Binary content saved to the artifact store. Text diff preview is unavailable for this format.
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onOpen()}
          className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground"
        >
          Open
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDownload()}
          className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground"
        >
          Download
        </button>
      </div>
    </div>
  );
}

function WorkspaceBinaryArtifactView(props: {
  envelope: {
    path: string;
    zone?: "workspace" | "current" | "absolute";
    command?: string;
    summary?: string;
    revisionId?: string;
    artifactId?: string;
    artifactInternalId?: string;
    bytes?: number;
  };
  args: Record<string, unknown>;
  mode: "applied" | "historical";
}): ReactElement {
  const { envelope, args, mode } = props;
  const logicalPath = envelope.path || pickPath(args);

  const handleRevert = useCallback(() => {
    requestRevert({
      revisionId: envelope.revisionId,
      path: envelope.path,
      zone: envelope.zone,
      command: envelope.command,
    });
  }, [envelope.command, envelope.path, envelope.revisionId, envelope.zone]);

  return (
    <div className="border-t border-border px-3 py-2 space-y-2" data-testid="workspace-binary-artifact-view">
      <header className="flex items-baseline justify-between gap-3 text-[0.65rem]">
        <span className="truncate font-mono text-foreground-muted" title={logicalPath}>
          {logicalPath}
        </span>
        <span className="flex-shrink-0 font-semibold text-foreground-muted">
          {typeof envelope.bytes === "number" ? `${envelope.bytes} bytes` : "binary"}
        </span>
      </header>
      {envelope.summary ? (
        <div className="text-xs italic text-foreground-muted">{envelope.summary}</div>
      ) : null}
      <WorkspaceBinaryArtifactBar
        logicalPath={logicalPath}
        artifactInternalId={envelope.artifactInternalId}
        externalArtifactId={envelope.artifactId}
        bytes={envelope.bytes}
      />
      {(mode === "applied" && envelope.path.length > 0) || mode === "historical" ? (
        <div className="flex items-center justify-end gap-2 pt-1" data-testid="diff-view-actions">
          {mode === "historical" ? (
            <span
              className="text-[0.7rem] italic text-foreground-muted"
              data-testid="diff-view-historical-badge"
            >
              Historical edit
            </span>
          ) : (
            <button
              type="button"
              onClick={handleRevert}
              className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-tool-error/40 hover:text-tool-error"
              data-testid="diff-view-revert"
            >
              Revert
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy command → legacy renderer table (compatibility shim)
// ---------------------------------------------------------------------------

const LEGACY_BY_COMMAND: Record<string, ToolRenderer> = {
  // Read-shaped
  read: fileReadRenderer,
  // Write-shaped (when not staging — i.e. the pre-staging callsites or
  // a command that hasn't been routed through staging yet).
  write: fileWriteRenderer,
  insert: editFileRenderer,
  str_replace: editFileRenderer,
  // List-shaped
  list: fileListRenderer,
  // Search-shaped
  grep: searchRenderer,
  // Structural (pending §1.3.5)
  delete: deleteRenderer,
  move: deleteRenderer,
  copy: deleteRenderer,
};

// ---------------------------------------------------------------------------
// Expanded body — branches on result shape + command
// ---------------------------------------------------------------------------

function FileExpanded(props: ToolRendererProps): React.ReactElement {
  const { args, resultText } = props;
  const command = typeof args["command"] === "string" ? args["command"] : "";

  const appliedEnvelope = useMemo(() => parseAppliedEnvelope(resultText), [resultText]);
  const stagedEnvelope = useMemo(
    () => (appliedEnvelope ? null : parseStagedEnvelope(resultText)),
    [appliedEnvelope, resultText],
  );

  if (appliedEnvelope) {
    if (appliedEnvelope.blockOps && appliedEnvelope.blockOps.length > 0) {
      return <BlockDiffView envelope={appliedEnvelope} mode="applied" />;
    }
    if (appliedEnvelope.binary && appliedEnvelope.zone === "workspace") {
      return <WorkspaceBinaryArtifactView envelope={appliedEnvelope} args={args} mode="applied" />;
    }
    return (
      <DiffView
        unifiedDiff={appliedEnvelope.unifiedDiff}
        path={appliedEnvelope.path}
        stats={appliedEnvelope.stats}
        binary={appliedEnvelope.binary}
        bytes={appliedEnvelope.bytes}
        warnings={appliedEnvelope.warnings}
        summary={appliedEnvelope.summary}
        revisionId={appliedEnvelope.revisionId}
        zone={appliedEnvelope.zone}
        command={appliedEnvelope.command}
        mode="applied"
        openInWorkSlot={
          command === "write" && appliedEnvelope.zone === "workspace" && workspaceLogicalPathLooksHtml(args) ? (
            <HtmlArtifactOpenInWorkBar
              logicalPath={pickPath(args)}
              artifactInternalId={appliedEnvelope.artifactInternalId}
              externalArtifactId={appliedEnvelope.artifactId}
            />
          ) : undefined
        }
      />
    );
  }

  if (stagedEnvelope) {
    if (stagedEnvelope.blockOps && stagedEnvelope.blockOps.length > 0) {
      return <BlockDiffView envelope={stagedEnvelope} mode="historical" />;
    }
    if (stagedEnvelope.binary && stagedEnvelope.zone === "workspace") {
      return <WorkspaceBinaryArtifactView envelope={stagedEnvelope} args={args} mode="historical" />;
    }
    return (
      <DiffView
        unifiedDiff={stagedEnvelope.unifiedDiff}
        path={stagedEnvelope.path}
        stats={stagedEnvelope.stats}
        binary={stagedEnvelope.binary}
        bytes={stagedEnvelope.bytes}
        warnings={stagedEnvelope.warnings}
        summary={stagedEnvelope.summary}
        mode="historical"
        openInWorkSlot={
          command === "write" && stagedEnvelope.zone === "workspace" && workspaceLogicalPathLooksHtml(args) ? (
            <HtmlArtifactOpenInWorkBar
              logicalPath={pickPath(args)}
              artifactInternalId={stagedEnvelope.artifactInternalId}
              externalArtifactId={stagedEnvelope.artifactId}
            />
          ) : undefined
        }
      />
    );
  }

  // Error envelope or plain error string
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;

  // Fall through to the legacy command-specific renderer.
  const legacy = LEGACY_BY_COMMAND[command];
  if (legacy) {
    const LegacyBody = legacy.ExpandedBody;
    return <LegacyBody {...props} />;
  }

  // Unknown / unmapped — minimal fallback.
  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      {toolError ? (
        <section aria-label="tool error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Tool error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {toolError}
          </pre>
        </section>
      ) : resultText ? (
        <pre className="whitespace-pre-wrap break-words text-xs text-foreground-muted">
          {resultText}
        </pre>
      ) : (
        <div className="text-xs italic text-foreground-dim">(no result)</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Renderer surface
// ---------------------------------------------------------------------------

function collapsedSummary({ args, resultText }: {
  args: Record<string, unknown>;
  result: unknown;
  state: ToolRendererProps["state"];
  resultText: string | undefined;
}): string {
  const command = typeof args["command"] === "string" ? args["command"] : "?";

  // Staged envelope: use the envelope's path (the handler-supplied
  // resolved path, which is usually more informative than the raw args).
  const env = parseAppliedEnvelope(resultText) ?? parseStagedEnvelope(resultText);
  if (env) return `file.${env.command} ${env.path}`;

  // Otherwise, fall through to the default zoned-path format.
  const zonedPath = pickZonedPath(args);
  return `file.${command} ${zonedPath}`;
}

function collapsedExtras({
  args,
  resultText,
}: {
  args: Record<string, unknown>;
  result: unknown;
  state: ToolRendererProps["state"];
  resultText: string | undefined;
}): string | null {
  const env = parseAppliedEnvelope(resultText) ?? parseStagedEnvelope(resultText);
  if (env?.binary) {
    return typeof env.bytes === "number" ? `${env.bytes} bytes` : "binary";
  }
  if (env) return `+${env.stats.additions}/-${env.stats.deletions}`;

  // Fall back to the legacy renderer's collapsedExtras if it has one.
  const command = typeof args["command"] === "string" ? args["command"] : "";
  const legacy = LEGACY_BY_COMMAND[command];
  if (legacy?.collapsedExtras) {
    return legacy.collapsedExtras({ args, result: undefined, state: "success", resultText });
  }
  return null;
}

export const fileRenderer: ToolRenderer = {
  collapsedSummary,
  collapsedExtras,
  ExpandedBody: FileExpanded,
};
