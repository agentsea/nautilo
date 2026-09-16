/**
 * Per-command renderer for the unified `file` tool's `write` command.
 * (Originally shipped as `write-file.tsx` for the legacy `write_file`
 * tool — M088B removed that tool; the rendering logic stays here for
 * `file({command:"write", ...})`. Imported from `file-renderer.tsx`.)
 *
 * Collapsed: zoned-path + small `(N lines)` hint computed from
 *            the content arg when present.
 * Expanded:  the content being written (from args.content),
 *            rendered in a read-only CodeMirror view. The result field typically
 *            carries a status string like "Saved N bytes" which
 *            is rendered below the content preview.
 *
 * D121-P6 — `HtmlArtifactOpenInWorkBar` is also composed into the
 * staged-write DiffView path via `file-renderer.tsx` for workspace
 * `*.html` / `*.htm` artifacts.
 */

import { FileCode } from "lucide-react";
import { useCallback, useState, type ReactElement } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";
import {
  pickPath,
  pickZonedPath,
  looksLikeToolError,
  workspaceLogicalPathLooksHtml,
} from "./shared";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { apiClient } from "../../../lib/api";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useToast } from "../../toast";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";

import { CodePreview } from "../../../editors/code-editor";

function logicalBasename(logicalPath: string): string {
  const seg = logicalPath.replace(/\\/g, "/").split("/").pop();
  return seg && seg.length > 0 ? seg : logicalPath;
}

export interface HtmlArtifactOpenInWorkBarProps {
  logicalPath: string;
  artifactInternalId?: string;
  externalArtifactId?: string;
}

/**
 * Opens a workspace HTML artifact in the Work surface via the same
 * `requestOpenFile` dispatcher the Files / Workspace tabs use.
 */
export function HtmlArtifactOpenInWorkBar(props: HtmlArtifactOpenInWorkBarProps): ReactElement {
  const { logicalPath, artifactInternalId, externalArtifactId } = props;
  const roomNav = useRoomNavigation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const hideSaveForPendingStagedReview =
    Boolean(artifactInternalId?.length) && Boolean(externalArtifactId?.length);
  const showSaveToDisk = !hideSaveForPendingStagedReview;

  const openResolved = useCallback(
    (id: string, path: string, mimeType: string) => {
      const roomId = roomNav.activeRoomId ?? undefined;
      const ok = requestOpenFile(
        artifactOpenFileTarget({
          id,
          path,
          mimeType: mimeType.length > 0 ? mimeType : "text/html",
          ...(roomId ? { roomId } : {}),
        }),
      );
      if (!ok) {
        toast.show({
          variant: "warning",
          message: "Could not open the Work surface (not ready). Try again from the Workspace tab.",
        });
      }
    },
    [roomNav.activeRoomId, toast],
  );

  const onOpenInWork = useCallback(async () => {
    if (busy || saveBusy) return;
    const roomId = roomNav.activeRoomId ?? undefined;
    if (artifactInternalId) {
      openResolved(artifactInternalId, logicalPath, "text/html");
      return;
    }
    setBusy(true);
    try {
      const list = await apiClient.listWorkspaceArtifacts({
        pathPrefix: "artifacts/",
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
          message:
            "This HTML artifact is not indexed yet — accept the staged write first, then try Open in Work again.",
        });
        return;
      }
      openResolved(hit.id, hit.path, hit.mimeType);
    } catch (e) {
      toast.show({
        variant: "warning",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [artifactInternalId, busy, externalArtifactId, logicalPath, openResolved, roomNav.activeRoomId, saveBusy, toast]);

  const onSaveToDisk = useCallback(async () => {
    if (busy || saveBusy) return;
    const roomId = roomNav.activeRoomId ?? undefined;
    const filename = logicalBasename(logicalPath);
    if (artifactInternalId) {
      setSaveBusy(true);
      try {
        await apiClient.downloadArtifact(artifactInternalId, filename, { roomId });
      } catch (e) {
        toast.show({
          variant: "warning",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setSaveBusy(false);
      }
      return;
    }
    setSaveBusy(true);
    try {
      const list = await apiClient.listWorkspaceArtifacts({
        pathPrefix: "artifacts/",
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
          message:
            "This HTML artifact is not indexed yet — accept the staged write first, then try Save to disk again.",
        });
        return;
      }
      await apiClient.downloadArtifact(hit.id, logicalBasename(hit.path), { roomId });
    } catch (e) {
      toast.show({
        variant: "warning",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaveBusy(false);
    }
  }, [
    artifactInternalId,
    busy,
    externalArtifactId,
    logicalPath,
    roomNav.activeRoomId,
    saveBusy,
    toast,
  ]);

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded border border-border bg-background-panel px-2 py-1.5"
      data-testid="html-artifact-open-in-work"
    >
      <FileCode className="h-4 w-4 shrink-0 text-foreground-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground-muted" title={logicalPath}>
        {logicalPath}
      </span>
      <button
        type="button"
        onClick={() => void onOpenInWork()}
        disabled={busy || saveBusy}
        className="shrink-0 rounded border border-border px-2 py-0.5 text-[0.7rem] font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Opening…" : "Open in Work"}
      </button>
      {showSaveToDisk ? (
        <button
          type="button"
          data-testid="html-artifact-save-to-disk"
          onClick={() => void onSaveToDisk()}
          disabled={busy || saveBusy}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-[0.7rem] font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveBusy ? "Saving…" : "Save to disk…"}
        </button>
      ) : null}
    </div>
  );
}

function pickContent(args: Record<string, unknown>): string | undefined {
  const v = args["content"];
  return typeof v === "string" ? v : undefined;
}

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  return pickZonedPath(args);
}

function collapsedExtras({
  args,
}: {
  args: Record<string, unknown>;
}): string | null {
  const content = pickContent(args);
  if (content === undefined) return null;
  const lineCount = content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
  return `+${Math.max(lineCount, 0)} line${lineCount === 1 ? "" : "s"}`;
}

function parseStagedWriteEnvelopeFields(resultText: string | undefined): {
  artifactInternalId?: string;
  externalArtifactId?: string;
} {
  if (!resultText) return {};
  const t = resultText.trimStart();
  if (!t.startsWith("{")) return {};
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (j["staged"] !== true || j["command"] !== "write") return {};
    return {
      artifactInternalId:
        typeof j["artifactInternalId"] === "string" && j["artifactInternalId"].length > 0
          ? j["artifactInternalId"]
          : undefined,
      externalArtifactId:
        typeof j["artifactId"] === "string" && j["artifactId"].length > 0 ? j["artifactId"] : undefined,
    };
  } catch {
    return {};
  }
}

function WriteFileExpanded(props: ToolRendererProps): ReactElement {
  const { args, resultText, state, event } = props;
  const content = pickContent(args);

  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const status = !toolError && resultText ? resultText : undefined;
  const rawError = event?.error;

  const logicalPath = pickPath(args);
  const showOpenBar =
    state !== "error" &&
    !toolError &&
    workspaceLogicalPathLooksHtml(args) &&
    logicalPath.length > 0;
  const stagedIds = showOpenBar ? parseStagedWriteEnvelopeFields(resultText) : {};

  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      {showOpenBar && (
        <HtmlArtifactOpenInWorkBar
          logicalPath={logicalPath}
          artifactInternalId={stagedIds.artifactInternalId}
          externalArtifactId={stagedIds.externalArtifactId}
        />
      )}

      {content !== undefined && content.length > 0 && (
        <section aria-label="new content">
          <div className="mb-1 flex items-baseline gap-2 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-success">
            <span>+ new content</span>
            <span className="font-normal normal-case text-foreground-dim">
              ({content.split("\n").length} lines)
            </span>
          </div>
          <CodePreview value={content} path={logicalPath} />
        </section>
      )}

      {toolError && (
        <section aria-label="tool error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Tool error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{toolError}</pre>
        </section>
      )}

      {status && <div className="text-xs text-foreground-muted">{status}</div>}

      {state === "error" && rawError && rawError !== resultText && (
        <section aria-label="error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">Error</div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{rawError}</pre>
        </section>
      )}

      {!content && !status && !toolError && state !== "error" && (
        <div className="text-xs italic text-foreground-dim">(no content to preview)</div>
      )}
    </div>
  );
}

export const fileWriteRenderer: ToolRenderer = {
  collapsedSummary,
  collapsedExtras,
  ExpandedBody: WriteFileExpanded,
};
