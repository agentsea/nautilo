import type {
  MiniAppConversionImportDto,
  MiniAppConversionRunRequest,
  PublicMiniAppDto,
} from "@nautilo/api-client/browser";
import { requestOpenFile } from "../adapters/open-file-ref";
import { requestOpenMiniApp } from "../adapters/open-mini-app-ref";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
  type OpenFileTarget,
} from "../components/browser-column/open-file-target";
import { relativeFromWorkspace } from "../components/browser-column/cited-paths";
import { apiClient } from "../lib/api";

function displayAppName(app: PublicMiniAppDto): string {
  const name = app.name?.trim();
  return name && name.length > 0 ? name : app.id;
}

export function importActionLabel(app: PublicMiniAppDto): string {
  return `Import to ${displayAppName(app)}`;
}

function conversionSourceForOpenFileTarget(
  file: OpenFileTarget,
): Pick<MiniAppConversionRunRequest, "source" | "currentFolder" | "roomId"> {
  if (file.kind === "artifact") {
    return {
      source: { surface: "workspace", path: file.path },
      ...(file.roomId ? { roomId: file.roomId } : {}),
    };
  }
  return {
    source: {
      surface: "currentFolder",
      path: relativeFromWorkspace(file.rootPath, file.path),
    },
    currentFolder: file.rootPath,
  };
}

/**
 * Build the base conversion request for importing `file` via `action`. The
 * conflict loop (overwrite / rename) is owned by `useConversionRunner`; this is
 * just the initial request. No `target` — the server derives the imported
 * artifact path from the source stem + the manifest target extension.
 */
export function buildImportRequest(
  action: MiniAppConversionImportDto,
  file: OpenFileTarget,
): MiniAppConversionRunRequest {
  return {
    actionId: action.id,
    direction: "import",
    ...conversionSourceForOpenFileTarget(file),
  };
}

export type ImportToolResult = {
  ok?: boolean;
  status?: string;
  artifactPath?: string;
  message?: string;
  error?: string;
};

export type OpenImportedResult = { opened: boolean; artifactPath?: string };

export type ExportToolResult = {
  ok?: boolean;
  status?: string;
  /** Canonical workspace path when an export host returns one. */
  artifactPath?: string;
  /** Human-facing path returned by the conversion tool. */
  displayPath?: string;
  message?: string;
  error?: string;
};

export type OpenExportedResult = { opened: boolean; artifactPath: string };

function isSafeCurrentFolderRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Open the artifact/file produced by a successful import. The import mirrors
 * the source surface: a current-folder source produced a current-folder file;
 * a workspace source produced a workspace artifact.
 */
export async function openImportedResult(
  app: PublicMiniAppDto,
  action: MiniAppConversionImportDto,
  file: OpenFileTarget,
  result: ImportToolResult,
  roomId?: string,
): Promise<OpenImportedResult> {
  const artifactPath = result.artifactPath;
  if (action.openAfterImport === false || !artifactPath) {
    return { opened: false, ...(artifactPath ? { artifactPath } : {}) };
  }

  if (file.kind === "fs") {
    const abs = `${file.rootPath.replace(/[/\\]+$/, "")}/${artifactPath.replace(/^[/\\]+/, "")}`;
    const opened = requestOpenMiniApp(app.id, fsOpenFileTarget(abs, file.rootPath));
    return { opened, artifactPath };
  }

  try {
    const { artifacts } = await apiClient.listWorkspaceArtifacts({
      roomId: roomId ?? undefined,
    });
    const row = artifacts.find((artifact) => artifact.path === artifactPath);
    if (!row) return { opened: false, artifactPath };
    const opened = requestOpenMiniApp(
      app.id,
      artifactOpenFileTarget({
        id: row.id,
        path: artifactPath,
        mimeType: "text/html",
        ...(roomId ? { roomId } : {}),
      }),
    );
    return { opened, artifactPath };
  } catch {
    return { opened: false, artifactPath };
  }
}

/**
 * Reveal a successfully exported result in the normal reader surface. Unlike
 * imports, exports stay in the current work surface rather than launching a
 * mini-app. The conversion host's artifact path (or returned display path) is
 * authoritative after a rename conflict; `canonicalOutputPath` is the safe
 * request-derived fallback when the host omits both.
 *
 * Failing to reveal is deliberately non-fatal: conversion persistence has
 * already succeeded. `shouldOpen` lets a caller suppress a late dispatch when
 * its bound app/document has changed or unmounted while artifact lookup ran.
 */
export async function openExportedResult(
  file: OpenFileTarget,
  result: ExportToolResult,
  canonicalOutputPath: string,
  shouldOpen: () => boolean = () => true,
): Promise<OpenExportedResult> {
  const artifactPath = result.artifactPath ?? result.displayPath ?? canonicalOutputPath;
  if (!artifactPath || !shouldOpen()) return { opened: false, artifactPath };

  if (file.kind === "fs") {
    if (!isSafeCurrentFolderRelativePath(artifactPath)) {
      return { opened: false, artifactPath };
    }
    const abs = `${file.rootPath.replace(/[/\\]+$/, "")}/${artifactPath.replace(/^[/\\]+/, "")}`;
    return {
      opened: shouldOpen() && requestOpenFile(fsOpenFileTarget(abs, file.rootPath)),
      artifactPath,
    };
  }

  try {
    const { artifacts } = await apiClient.listWorkspaceArtifacts({
      roomId: file.roomId ?? undefined,
    });
    const row = artifacts.find((artifact) => artifact.path === artifactPath);
    if (!row || !shouldOpen()) return { opened: false, artifactPath };
    return {
      opened: requestOpenFile(
        artifactOpenFileTarget({
          id: row.id,
          path: row.path,
          mimeType: row.mimeType,
          ...(file.roomId ? { roomId: file.roomId } : {}),
        }),
      ),
      artifactPath,
    };
  } catch {
    return { opened: false, artifactPath };
  }
}
