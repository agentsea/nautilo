import { FileText } from "lucide-react";
import { useCallback, useState, type ReactElement } from "react";

import { requestOpenFile } from "../../../adapters/open-file-ref";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { apiClient } from "../../../lib/api";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";
import { useToast } from "../../toast";
import type { ToolRenderer, ToolRendererProps } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OfficeCliCreatedArtifactReceipt {
  readonly artifactInternalId: string;
  readonly artifactId: string;
  readonly path: string;
}

/**
 * Accept only the server-authored receipt emitted after a Workspace OfficeCLI
 * create commit. The receipt is a reference; the click path still resolves it
 * through the authenticated artifact API before opening anything.
 */
export function parseOfficeCliCreatedArtifactReceipt(
  args: Record<string, unknown>,
  resultText: string | undefined,
  resultTruncated = false,
): OfficeCliCreatedArtifactReceipt | null {
  if (args["command"] !== "create" || resultTruncated || !resultText?.trim()) return null;
  try {
    const parsed = JSON.parse(resultText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value["applied"] !== true ||
      value["zone"] !== "workspace" ||
      value["command"] !== "officecli" ||
      value["binary"] !== true ||
      typeof value["artifactInternalId"] !== "string" ||
      !UUID.test(value["artifactInternalId"]) ||
      typeof value["artifactId"] !== "string" ||
      value["artifactId"].length === 0 ||
      typeof value["path"] !== "string" ||
      value["path"].length === 0
    ) {
      return null;
    }
    return {
      artifactInternalId: value["artifactInternalId"],
      artifactId: value["artifactId"],
      path: value["path"],
    };
  } catch {
    return null;
  }
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() || path;
}

export function OfficeCliBody({
  args,
  state,
  resultText,
  resultTruncated,
}: ToolRendererProps): ReactElement {
  const receipt = state === "success"
    ? parseOfficeCliCreatedArtifactReceipt(args, resultText, resultTruncated)
    : null;
  return <CreatedWorkspaceArtifactBody receipt={receipt} resultText={resultText} />;
}

/** Shared authenticated handoff for tools that committed a Workspace document. */
export function CreatedWorkspaceArtifactBody({ receipt, resultText }: {
  receipt: OfficeCliCreatedArtifactReceipt | null;
  resultText: string | undefined;
}): ReactElement {
  const roomNavigation = useRoomNavigation();
  const toast = useToast();
  const [opening, setOpening] = useState(false);

  const openCreatedArtifact = useCallback(async () => {
    if (!receipt || opening) return;
    setOpening(true);
    try {
      const roomId = roomNavigation.activeRoomId ?? undefined;
      const artifact = await apiClient.getWorkspaceArtifact(receipt.artifactInternalId, {
        ...(roomId ? { roomId } : {}),
      });
      if (
        !artifact ||
        artifact.id !== receipt.artifactInternalId ||
        artifact.artifactId !== receipt.artifactId
      ) {
        toast.show({
          variant: "warning",
          message: "This document is not available in the current Room.",
        });
        return;
      }
      const opened = requestOpenFile(
        artifactOpenFileTarget({
          id: artifact.id,
          path: artifact.path,
          mimeType: artifact.mimeType,
          ...(roomId ? { roomId } : {}),
          sizeBytes: artifact.size,
        }),
      );
      if (!opened) {
        toast.show({
          variant: "warning",
          message: "Could not open the Work surface. Try again from Workspace.",
        });
      }
    } catch (error) {
      toast.show({
        variant: "warning",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(false);
    }
  }, [opening, receipt, roomNavigation.activeRoomId, toast]);

  if (receipt) {
    const name = basename(receipt.path);
    return (
      <div className="border-t border-border px-3 py-3">
        <button
          type="button"
          className="flex w-full max-w-md items-center gap-2 rounded-md border border-border bg-background-element px-3 py-2 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 disabled:opacity-60"
          aria-label={`Open ${name}`}
          disabled={opening}
          onClick={() => void openCreatedArtifact()}
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded bg-primary/10 text-primary"
          >
            <FileText className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="mt-0.5 block text-xs text-foreground-muted">
              {opening ? "Opening…" : "Created in Workspace · Open document"}
            </span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2">
      {resultText ? (
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted">
          {resultText}
        </pre>
      ) : (
        <div className="text-xs italic text-foreground-dim">(no result to display)</div>
      )}
    </div>
  );
}

export const officeCliRenderer: ToolRenderer = {
  displayName: "Office document",
  collapsedSummary: ({ args, resultText, resultTruncated, state }) => {
    const receipt = state === "success"
      ? parseOfficeCliCreatedArtifactReceipt(args, resultText, resultTruncated)
      : null;
    if (receipt) return `Created ${basename(receipt.path)}`;
    const command = args["command"];
    return typeof command === "string" && command.length > 0 ? command : "OfficeCLI";
  },
  autoExpandOnResult: true,
  ExpandedBody: OfficeCliBody,
};
