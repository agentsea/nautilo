import { relativeFromWorkspace } from "../components/browser-column/cited-paths";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import type {
  IssueLiveMiniAppSessionRequest,
  LiveDocumentVersion,
} from "@nautilo/types";

export type LiveReviewBoundTarget =
  | Extract<OpenFileTarget, { kind: "artifact" }>
  | Extract<OpenFileTarget, { kind: "fs" }>;

export function liveReviewBoundTargetKey(target: LiveReviewBoundTarget): string {
  if (target.kind === "artifact") return `artifact:${target.id}`;
  return `fs:${target.rootPath}:${target.path}`;
}

/** Relative display path for iframe payloads; absolute path stays host-only. */
export function fsBoundDisplayPath(target: Extract<OpenFileTarget, { kind: "fs" }>): string {
  return relativeFromWorkspace(target.rootPath, target.path);
}

export function boundDocumentDisplayPath(target: OpenFileTarget): string {
  if (target.kind === "fs") return fsBoundDisplayPath(target);
  return target.path;
}

export function buildIssueLiveSessionRequest(
  target: LiveReviewBoundTarget,
  documentVersion: LiveDocumentVersion,
  relayIdHint: string | null,
): IssueLiveMiniAppSessionRequest | null {
  if (target.kind === "artifact") {
    if (documentVersion.kind !== "artifact_revision") return null;
    return {
      targetKind: "artifact",
      artifactId: target.id,
      documentVersion,
    };
  }
  if (!relayIdHint || documentVersion.kind !== "local_sha") return null;
  const relativePath = fsBoundDisplayPath(target);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.includes("..")
  ) {
    return null;
  }
  return {
    targetKind: "currentFile",
    relayIdHint,
    currentFolder: target.rootPath,
    relativePath,
    documentVersion,
  };
}
