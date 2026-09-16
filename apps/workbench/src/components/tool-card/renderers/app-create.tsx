import { useState, type ReactElement } from "react";

import { requestOpenMiniApp } from "../../../adapters/open-mini-app-ref";
import { joinPath } from "../../browser-column/cited-paths";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
  type OpenFileTarget,
} from "../../browser-column/open-file-target";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { Button } from "../../../pages/settings/ui";

type OpenInAppReceipt = {
  appId: string;
  appName: string;
  target:
    | {
        surface: "workspace";
        path: string;
        artifactInternalId: string;
        mimeType: string;
        roomId?: string;
        sizeBytes?: number;
      }
    | {
        surface: "currentFolder";
        relativePath: string;
        currentFolderRoot: string;
      };
};

function generatedPart(value: string): string {
  return value.replace(/[^a-z0-9_]/giu, "_").toLowerCase();
}

function safeRelativeBasename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
}

function exactOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseAppCreateReceipt(
  toolName: string | undefined,
  resultText: string | undefined,
): OpenInAppReceipt | null {
  if (!toolName || !resultText) return null;
  try {
    const value = JSON.parse(resultText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row["ok"] !== true || row["status"] !== "created" || row["opened"] !== false) return null;
    const open = row["openInApp"];
    if (!open || typeof open !== "object" || Array.isArray(open)) return null;
    const receipt = open as Record<string, unknown>;
    if (!hasOnlyKeys(receipt, ["appId", "appName", "target"])) return null;
    if (typeof receipt["appId"] !== "string" || receipt["appId"].length === 0) return null;
    if (typeof receipt["appName"] !== "string" || receipt["appName"].trim().length === 0) return null;
    if (toolName !== `app_${generatedPart(receipt["appId"])}__create_file`) return null;
    const target = receipt["target"];
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
    const t = target as Record<string, unknown>;
    if (t["surface"] === "workspace") {
      if (!hasOnlyKeys(t, ["surface", "path", "artifactInternalId", "mimeType", "roomId", "sizeBytes"])) return null;
      if (!safeRelativeBasename(t["path"]) || typeof t["artifactInternalId"] !== "string" || t["artifactInternalId"].length === 0
        || typeof t["mimeType"] !== "string" || t["mimeType"].length === 0 || !exactOptionalString(t["roomId"])
        || (t["sizeBytes"] !== undefined && (!Number.isSafeInteger(t["sizeBytes"]) || (t["sizeBytes"] as number) < 0))) return null;
      return receipt as OpenInAppReceipt;
    }
    if (t["surface"] === "currentFolder") {
      if (!hasOnlyKeys(t, ["surface", "relativePath", "currentFolderRoot"])) return null;
      if (!safeRelativeBasename(t["relativePath"]) || typeof t["currentFolderRoot"] !== "string" || t["currentFolderRoot"].length === 0) return null;
      return receipt as OpenInAppReceipt;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAppCreatePresentationEnvelope(toolName: string, resultText?: string): boolean {
  return parseAppCreateReceipt(toolName, resultText) !== null;
}

function currentFolderApi(): { getPath(): Promise<string | null> } | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as {
    nautiloDesktop?: { currentFolder?: { getPath?: () => Promise<string | null> } };
  }).nautiloDesktop?.currentFolder;
  return typeof api?.getPath === "function" ? { getPath: api.getPath.bind(api) } : null;
}

function AppCreateBody(props: ToolRendererProps): ReactElement {
  const receipt = props.resultTruncated ? null : parseAppCreateReceipt(props.toolName, props.resultText);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  if (!receipt) return <div className="border-t border-border px-3 py-3 text-xs text-foreground-muted">Created document receipt is unavailable.</div>;

  const open = async (): Promise<void> => {
    if (opening) return;
    setOpening(true);
    setError(null);
    let target: OpenFileTarget;
    if (receipt.target.surface === "workspace") {
      target = artifactOpenFileTarget({
        id: receipt.target.artifactInternalId,
        path: receipt.target.path,
        mimeType: receipt.target.mimeType,
        ...(receipt.target.roomId ? { roomId: receipt.target.roomId } : {}),
        ...(receipt.target.sizeBytes !== undefined ? { sizeBytes: receipt.target.sizeBytes } : {}),
      });
    } else {
      const desktop = currentFolderApi();
      if (!desktop) {
        setError(`Connect Nautilo Desktop and return to the original Current Folder (${receipt.target.currentFolderRoot}) to open this document.`);
        setOpening(false);
        return;
      }
      let currentRoot: string | null;
      try {
        currentRoot = await desktop.getPath();
      } catch {
        setError(`Nautilo Desktop could not confirm the Current Folder. Reconnect it, then return to ${receipt.target.currentFolderRoot}.`);
        setOpening(false);
        return;
      }
      if (currentRoot !== receipt.target.currentFolderRoot) {
        setError(`Return to the original Current Folder (${receipt.target.currentFolderRoot}) to open this document.`);
        setOpening(false);
        return;
      }
      target = fsOpenFileTarget(joinPath(currentRoot, receipt.target.relativePath), currentRoot);
    }
    if (!requestOpenMiniApp(receipt.appId, target, { mode: "edit" })) {
      setError(`Could not open ${receipt.appName}. Try again when the Work surface is ready.`);
    }
    setOpening(false);
  };

  return (
    <div className="space-y-2 border-t border-border px-3 py-3" data-testid="app-create-result">
      <p className="text-xs text-foreground-muted">{receipt.target.surface === "workspace" ? receipt.target.path : receipt.target.relativePath}</p>
      <Button variant="primary" loading={opening} onClick={() => { void open(); }}>
        Open in {receipt.appName}
      </Button>
      {error ? <p role="alert" className="text-xs text-foreground-muted">{error}</p> : null}
    </div>
  );
}

export const appCreateRenderer: ToolRenderer = {
  autoExpandOnResult: true,
  collapsedSummary: ({ state }) => state === "success" ? "Document created" : "Creating document",
  ExpandedBody: AppCreateBody,
};
