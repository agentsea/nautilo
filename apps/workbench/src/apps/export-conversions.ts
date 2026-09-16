import type { MiniAppConversionExportDto } from "@nautilo/api-client/browser";
import type { MiniAppConversionRunRequest } from "@nautilo/api-client/browser";
import { relativeFromWorkspace } from "../components/browser-column/cited-paths";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";

type ConversionSurface = "workspace" | "currentFolder";

export interface MiniAppConversionLocation {
  surface: ConversionSurface;
  path: string;
}

export interface MiniAppExportRequest {
  preparedExport?: MiniAppConversionRunRequest["preparedExport"];
  actionId: string;
  direction: "export";
  source: MiniAppConversionLocation;
  target: MiniAppConversionLocation;
  roomId?: string;
  currentFolder?: string;
  workspaceDestination?: "current" | "source";
  scope?: DesignExportScope;
}

/** Trusted active-Design context passed by the host; never iframe target data. */
export type DesignExportScope = NonNullable<MiniAppConversionRunRequest["scope"]>;

function pathParts(path: string): { directory: string; basename: string; separator: "/" | "\\" } {
  const slash = path.lastIndexOf("/");
  const backslash = path.lastIndexOf("\\");
  const separator: "/" | "\\" = backslash > slash ? "\\" : "/";
  const index = Math.max(slash, backslash);
  if (index < 0) return { directory: "", basename: path, separator };
  return {
    directory: path.slice(0, index),
    basename: path.slice(index + 1),
    separator,
  };
}

function filenameWithExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}${extension}`;
  return `${name.slice(0, dot)}${extension}`;
}

export function replaceExtension(path: string, extension: string): string {
  const parts = pathParts(path);
  const nextName = filenameWithExtension(parts.basename, extension);
  return parts.directory ? `${parts.directory}${parts.separator}${nextName}` : nextName;
}

export function buildExportRequest(
  boundTarget: OpenFileTarget,
  action: MiniAppConversionExportDto,
  scope?: DesignExportScope,
): MiniAppExportRequest {
  if (boundTarget.kind === "artifact") {
    const targetPath = replaceExtension(boundTarget.path, action.to.extension);
    const chooseDestination = action.selectWorkspaceDestination === true;
    return {
      actionId: action.id,
      direction: "export",
      source: { surface: "workspace", path: boundTarget.path },
      target: {
        surface: "workspace",
        path: chooseDestination ? pathParts(targetPath).basename : targetPath,
      },
      ...(chooseDestination ? { workspaceDestination: "current" as const } : {}),
      ...(boundTarget.roomId ? { roomId: boundTarget.roomId } : {}),
      ...(scope ? { scope: { pageHandle: scope.pageHandle, ...(scope.nodeHandles ? { nodeHandles: [...scope.nodeHandles] } : {}) } } : {}),
    };
  }

  const rel = relativeFromWorkspace(boundTarget.rootPath, boundTarget.path);
  return {
    actionId: action.id,
    direction: "export",
    source: { surface: "currentFolder", path: rel },
    target: { surface: "currentFolder", path: replaceExtension(rel, action.to.extension) },
    currentFolder: boundTarget.rootPath,
    ...(scope ? { scope: { pageHandle: scope.pageHandle, ...(scope.nodeHandles ? { nodeHandles: [...scope.nodeHandles] } : {}) } } : {}),
  };
}
