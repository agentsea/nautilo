import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import {
  type ConnectedAppToolReceipt,
} from "@nautilo/types";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { apiClient } from "../../../lib/api";
import { desktopAPI } from "../../../lib/desktop";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { parseConnectedAppReceipt } from "./connected-app-receipt";

type PresentedReceipt = ConnectedAppToolReceipt & {
  presentation: NonNullable<ConnectedAppToolReceipt["presentation"]>;
};

type TransferDirection = "upload" | "download";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function operationToolName(operationId: string): string {
  return operationId.replace(/\./gu, "_");
}

function parseConnectedAppResultReceipt(
  toolName: string,
  raw: string | undefined,
): PresentedReceipt | null {
  const receipt = parseConnectedAppReceipt(toolName, raw);
  return receipt?.presentation ? receipt as PresentedReceipt : null;
}

export function isConnectedAppPresentationEnvelope(
  toolName: string,
  raw: string | undefined,
): boolean {
  if (!raw?.trim()) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value)
      && isRecord(value["presentation"])
      && typeof value["operationId"] === "string"
      && operationToolName(value["operationId"]) === toolName
      && typeof value["providerId"] === "string"
      && value["operationId"].startsWith(`${value["providerId"]}.`);
  } catch {
    return false;
  }
}

function basename(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) || path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function usePrivatePreview(ref: string | null): { url: string | null; failed: boolean } {
  const roomId = useRoomNavigation().activeRoomId;
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!ref || !roomId) {
      setState({ url: null, failed: ref !== null });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ url: null, failed: false });
    void apiClient.getConnectedAppResultMedia(ref, { roomId, signal: controller.signal })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url: null, failed: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ref, roomId]);
  return state;
}

async function openExternal(url: string): Promise<void> {
  if (desktopAPI?.browserControl?.openExternal) {
    await desktopAPI.browserControl.openExternal({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function EntityPresentation({ receipt }: { receipt: PresentedReceipt }): ReactElement {
  const presentation = receipt.presentation.kind === "entity" ? receipt.presentation : null;
  const preview = usePrivatePreview(presentation?.preview?.ref ?? null);
  const [actionError, setActionError] = useState(false);
  if (!presentation) return <UnsafeResult />;
  return (
    <div className="border-t border-border p-3" data-testid="connected-app-entity-result">
      <div className="flex flex-col gap-3 sm:flex-row">
        {presentation.preview ? (
          <div className="flex min-h-32 w-full shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background-element/30 sm:w-52">
            {preview.url ? (
              <img
                src={preview.url}
                alt={presentation.preview.alt}
                className="max-h-52 w-full object-contain"
              />
            ) : (
              <span className="px-3 text-center text-xs text-foreground-dim">
                {preview.failed ? "Preview unavailable" : "Loading preview…"}
              </span>
            )}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-semibold text-foreground">{presentation.title}</h4>
          {presentation.subtitle ? <p className="mt-1 break-words text-xs text-foreground-muted">{presentation.subtitle}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {presentation.links.map((link) => (
              <button
                key={`${link.label}:${link.url}`}
                type="button"
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-accent hover:bg-foreground/5"
                onClick={() => {
                  setActionError(false);
                  void openExternal(link.url).catch(() => setActionError(true));
                }}
              >
                {link.label}
              </button>
            ))}
          </div>
          {actionError ? <p role="status" className="mt-2 text-xs text-tool-error">That link could not be opened.</p> : null}
        </div>
      </div>
    </div>
  );
}

function ArtifactPresentation({ receipt }: { receipt: PresentedReceipt }): ReactElement {
  const presentation = receipt.presentation.kind === "artifact_import" ? receipt.presentation : null;
  const roomId = useRoomNavigation().activeRoomId ?? undefined;
  const [rows, setRows] = useState<readonly ArtifactDto[]>([]);
  const [failed, setFailed] = useState(false);
  const lookupKey = presentation?.artifacts.map((artifact) => artifact.artifactId).join("|") ?? "";
  useEffect(() => {
    if (!lookupKey) return;
    let cancelled = false;
    setFailed(false);
    void apiClient.listWorkspaceArtifacts({ ...(roomId ? { roomId } : {}) })
      .then(({ artifacts }) => { if (!cancelled) setRows(artifacts); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [lookupKey, roomId]);
  const resolved = useMemo(() => presentation?.artifacts.map((artifact) => ({
    ...artifact,
    row: rows.find((candidate) => candidate.artifactId === artifact.artifactId) ?? null,
  })) ?? [], [presentation, rows]);
  const open = useCallback((row: ArtifactDto) => {
    requestOpenFile(artifactOpenFileTarget({
      id: row.id,
      path: row.path,
      mimeType: row.mimeType,
      ...(roomId ? { roomId } : {}),
    }));
  }, [roomId]);
  if (!presentation) return <UnsafeResult />;
  const message = presentation.state === "pending" ? "Export is still being prepared."
    : presentation.state === "failed" ? "The export job failed in the connected app."
    : presentation.state === "import_failed" ? "The export finished, but its file could not be saved to this Room."
    : presentation.state === "partial" ? "Some exported files were saved to this Room."
    : "Export saved to this Room.";
  return (
    <div className="space-y-3 border-t border-border p-3" data-testid="connected-app-artifact-result">
      <p className="text-xs text-foreground-muted">{message}</p>
      {failed ? <p role="status" className="text-xs text-tool-error">Saved files are not ready to open yet.</p> : null}
      {resolved.map((artifact) => (
        <article key={artifact.artifactId} className="rounded border border-border bg-background px-3 py-2">
          <p className="truncate text-xs font-medium text-foreground" title={basename(artifact.path)}>{basename(artifact.path)}</p>
          <p className="mt-0.5 text-[0.65rem] text-foreground-dim">{formatBytes(artifact.bytes)}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!artifact.row}
              onClick={() => artifact.row && open(artifact.row)}
              className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >Open</button>
            <button
              type="button"
              disabled={!artifact.row}
              onClick={() => artifact.row && void apiClient.downloadArtifact(
                artifact.row.id,
                basename(artifact.path),
                { ...(roomId ? { roomId } : {}) },
              ).catch(() => setFailed(true))}
              className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >Download</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function UnsafeResult(): ReactElement {
  return (
    <div role="alert" className="border-t border-border px-3 py-2 text-xs text-foreground-muted">
      This connected-app result could not be displayed safely.
    </div>
  );
}

function transferDirection(toolName: string | undefined): TransferDirection | null {
  if (toolName === "dropbox_upload_file") return "upload";
  if (toolName === "dropbox_download_file") return "download";
  return null;
}

function transferName(direction: TransferDirection, args: Record<string, unknown>): string {
  const candidate = direction === "upload" ? args["artifactPath"] : args["path"];
  return typeof candidate === "string" && candidate.length > 0 ? basename(candidate) : "File";
}

function ConnectedAppTransferActivity({
  direction,
  args,
  elapsedMs,
}: {
  direction: TransferDirection;
  args: Record<string, unknown>;
  elapsedMs?: number | undefined;
}): ReactElement {
  const uploading = direction === "upload";
  const elapsed = elapsedMs === undefined ? null : Math.max(1, Math.round(elapsedMs / 1_000));
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative overflow-hidden border-t border-border bg-gradient-to-br from-background-element/35 via-background to-accent/5 p-4"
      data-testid={`connected-app-${direction}-activity`}
    >
      <div className="relative flex items-center gap-3">
        <div className="min-w-0 rounded-lg border border-border bg-background/80 px-3 py-2 shadow-sm">
          <p className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">
            {uploading ? "Workspace" : "Dropbox"}
          </p>
          <p className="max-w-40 truncate text-xs font-semibold text-foreground" title={transferName(direction, args)}>
            {transferName(direction, args)}
          </p>
        </div>
        <div className="relative h-8 min-w-16 flex-1 overflow-hidden" aria-hidden="true">
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
          <div className={`connected-app-transfer-flow absolute top-1/2 h-1.5 w-1/4 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_14px_var(--color-accent)] ${uploading ? "" : "connected-app-transfer-flow-reverse"}`} />
          {["20%", "50%", "80%"].map((left, index) => (
            <span
              key={left}
              className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-accent/70 motion-safe:animate-ping"
              style={{ left, animationDelay: `${index * 260}ms`, animationDuration: "1.8s" }}
            />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-background/80 px-3 py-2 text-right shadow-sm">
          <p className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">
            {uploading ? "Dropbox" : "Workspace"}
          </p>
          <p className="text-xs font-semibold text-foreground">{uploading ? "Uploading" : "Saving"}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-foreground-muted">
        {uploading ? "Uploading securely" : "Downloading and saving securely"}{elapsed === null ? "…" : ` · ${elapsed}s`}
      </p>
      <p className="mt-1 text-[0.65rem] text-foreground-dim">The transfer remains cancellable. No file bytes enter the chat.</p>
    </div>
  );
}

function uploadMetadata(receipt: ConnectedAppToolReceipt | null): {
  name: string;
  path: string | null;
  sizeBytes: number | null;
} | null {
  if (!receipt || !isRecord(receipt.result)) return null;
  const metadata = receipt.result["metadata"];
  if (!isRecord(metadata) || typeof metadata["name"] !== "string") return null;
  return {
    name: metadata["name"],
    path: typeof metadata["pathDisplay"] === "string" ? metadata["pathDisplay"] : null,
    sizeBytes: typeof metadata["sizeBytes"] === "number" ? metadata["sizeBytes"] : null,
  };
}

function ConnectedAppTransferBody(props: ToolRendererProps): ReactElement {
  const direction = transferDirection(props.toolName);
  if (!direction) return <UnsafeResult />;
  if (props.state === "pending" || props.state === "running") {
    return <ConnectedAppTransferActivity direction={direction} args={props.args} elapsedMs={props.elapsedMs} />;
  }
  const presented = parseConnectedAppResultReceipt(props.toolName ?? "", props.resultText);
  if (presented) {
    return presented.presentation.kind === "entity"
      ? <EntityPresentation receipt={presented} />
      : <ArtifactPresentation receipt={presented} />;
  }
  if (props.state === "error" || props.state === "cancelled" || props.state === "blocked") {
    return (
      <div role="status" className="border-t border-border px-3 py-3 text-xs text-foreground-muted">
        {direction === "upload" ? "Upload" : "Download"} did not complete. No file bytes were shown in chat.
      </div>
    );
  }
  const metadata = direction === "upload"
    ? uploadMetadata(parseConnectedAppReceipt(props.toolName ?? "", props.resultText))
    : null;
  return (
    <div className="border-t border-border px-3 py-3" data-testid={`connected-app-${direction}-complete`}>
      <p className="text-xs font-semibold text-foreground">
        {direction === "upload" ? "Uploaded to Dropbox" : "Saved to this Room"}
      </p>
      <p className="mt-1 truncate text-xs text-foreground-muted" title={metadata?.path ?? metadata?.name ?? transferName(direction, props.args)}>
        {metadata?.path ?? metadata?.name ?? transferName(direction, props.args)}
        {metadata?.sizeBytes === null || metadata?.sizeBytes === undefined ? "" : ` · ${formatBytes(metadata.sizeBytes)}`}
      </p>
    </div>
  );
}

function ExpandedBody({ toolName, resultText }: ToolRendererProps): ReactElement {
  const receipt = parseConnectedAppResultReceipt(toolName ?? "", resultText);
  if (!receipt) return <UnsafeResult />;
  return receipt.presentation.kind === "entity"
    ? <EntityPresentation receipt={receipt} />
    : <ArtifactPresentation receipt={receipt} />;
}

export const connectedAppResultRenderer: ToolRenderer = {
  sealedResultParser: true,
  autoExpandOnResult: true,
  collapsedSummary: ({ resultText }) => {
    if (!resultText) return "Connected app";
    try {
      const value = JSON.parse(resultText) as Record<string, unknown>;
      const presentation = value["presentation"] as Record<string, unknown> | undefined;
      if (presentation?.["kind"] === "entity" && typeof presentation["title"] === "string") {
        return presentation["title"];
      }
      if (presentation?.["kind"] === "artifact_import" && typeof presentation["state"] === "string") {
        return presentation["state"] === "ready" ? "Export saved" : `Export · ${presentation["state"].replace("_", " ")}`;
      }
    } catch {
      // Expanded body fails closed without showing raw source bytes.
    }
    return "Connected app";
  },
  ExpandedBody,
};

export const connectedAppTransferRenderer: ToolRenderer = {
  sealedResultParser: true,
  autoExpandWhileRunning: true,
  autoExpandOnResult: true,
  collapsedSummary: ({ args, state }) => {
    const direction: TransferDirection = typeof args["artifactPath"] === "string" ? "upload" : "download";
    const verb = direction === "upload" ? "Uploading" : "Downloading";
    if (state === "pending" || state === "running") return `${verb} ${transferName(direction, args)}`;
    return `${direction === "upload" ? "Upload" : "Download"} ${state}`;
  },
  ExpandedBody: ConnectedAppTransferBody,
};
