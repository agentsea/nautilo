/**
 * File-reference payload helpers for composer attachments.
 *
 * The renderer only queues file references. It no longer reads files into
 * fenced markdown; D066 routes every attachment through the server-side gate.
 */

import type { DragEvent } from "react";
import { isUnderRoot, relativeFromWorkspace } from "../components/browser-column/cited-paths";
import { addAttachment, newAttachmentId } from "../adapters/composer-attachments-ref";
import {
  preflightComposerChatAttachment,
  type ComposerChatAttachmentSkip,
} from "./composer-attachment-preflight";

export type ComposerAttachmentZone = "workspace" | "current" | "absolute";

/**
 * Local filesystem refs give the Agent turn-scoped context; they are not
 * portable peer-openable documents. Keep that boundary visible in both the
 * composer chip and projected Room message until a Share-a-copy flow promotes
 * the bytes into a Workspace artifact.
 */
export function localFileFocusedResourceLabel(name: string): string {
  return `@${name} · Agent context only`;
}

/**
 * Classify an absolute file path for chat attachments. Matches server
 * `resolveZone`: workspace (Genie drawer) first, then current folder,
 * otherwise `absolute` so native-picker files outside those trees still
 * send (user explicitly chose them).
 */
export function classifyComposerPathForChat(
  absolutePath: string,
  workspacePath: string | null,
  currentFolder: string | null,
): {
  zone: ComposerAttachmentZone;
  /** Chip label root — equals `absolutePath` when zone is `absolute`. */
  rootPath: string;
  /** Wire path: relative for workspace/current, full absolute for `absolute`. */
  requestPath: string;
} {
  if (workspacePath && isUnderRoot(workspacePath, absolutePath)) {
    return {
      zone: "workspace",
      rootPath: workspacePath,
      requestPath: relativeFromWorkspace(workspacePath, absolutePath),
    };
  }
  if (currentFolder && isUnderRoot(currentFolder, absolutePath)) {
    return {
      zone: "current",
      rootPath: currentFolder,
      requestPath: relativeFromWorkspace(currentFolder, absolutePath),
    };
  }
  return {
    zone: "absolute",
    rootPath: absolutePath,
    requestPath: absolutePath,
  };
}

export const NAUTILO_FILE_REF_MIME = "application/x-nautilo-file-ref" as const;

export type NautiloSingleFileRefPayload = {
  path: string;
  rootPath: string;
};

export type NautiloMultiFileRefPayload = {
  files: NautiloSingleFileRefPayload[];
};

export type NautiloFileRefPayload =
  | NautiloSingleFileRefPayload
  | NautiloMultiFileRefPayload;

export function flattenNautiloFileRefs(
  payload: NautiloFileRefPayload,
): NautiloSingleFileRefPayload[] {
  if ("files" in payload) return payload.files;
  return [payload];
}

function parseSingleFileRef(value: unknown): NautiloSingleFileRefPayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as { path?: unknown; rootPath?: unknown };
  if (typeof p.path !== "string" || typeof p.rootPath !== "string") return null;
  if (p.path.length === 0 || p.rootPath.length === 0) return null;
  if (!isUnderRoot(p.rootPath, p.path)) return null;
  return { path: p.path, rootPath: p.rootPath };
}

export function parseNautiloFileRefDataTransfer(
  dt: DataTransfer,
): NautiloFileRefPayload | null {
  const raw = dt.getData(NAUTILO_FILE_REF_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const multi = v as { files?: unknown };
    if (Array.isArray(multi.files)) {
      const files = multi.files
        .map(parseSingleFileRef)
        .filter((f): f is NautiloSingleFileRefPayload => f !== null);
      return files.length > 0 ? { files } : null;
    }
    return parseSingleFileRef(v);
  } catch {
    return null;
  }
}

/**
 * Set DataTransfer for a file row drag; composer accepts this MIME type
 * to queue a path-backed attachment. Always pair with a tree root the UI is
 * showing so labels stay correct.
 */
export function setNautiloFileRefOnDragData(
  e: DragEvent,
  args: NautiloFileRefPayload,
): void {
  e.dataTransfer.setData(NAUTILO_FILE_REF_MIME, JSON.stringify(args));
  const files = flattenNautiloFileRefs(args);
  e.dataTransfer.setData("text/plain", files.map((f) => f.path).join("\n"));
  e.dataTransfer.effectAllowed = "copy";
}

export const NAUTILO_ARTIFACT_REF_MIME =
  "application/x-nautilo-artifact-ref" as const;

/**
 * D356 — drag payload for an artifact row. Metadata-only "focus on this"
 * reference: the artifact already lives server-side, so NO bytes move. Carries
 * the EXTERNAL agent-facing `artifactId` (matches the agent/tool contract and
 * `ChatArtifactRef`), NOT the internal row uuid used in REST URLs /
 * `OpenFileTarget.artifact.id`.
 */
export type NautiloArtifactRefPayload = {
  kind: "artifact";
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
};

export function setArtifactRefOnDragData(e: DragEvent, payload: NautiloArtifactRefPayload): void {
  e.dataTransfer.setData(NAUTILO_ARTIFACT_REF_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", payload.path || payload.artifactId);
  e.dataTransfer.effectAllowed = "copy";
}

/**
 * Recognize an artifact-ref drop. Returns the full payload when the drag event
 * carries `application/x-nautilo-artifact-ref`, otherwise `null`.
 */
export function parseNautiloArtifactRefDataTransfer(
  dt: DataTransfer | null,
): NautiloArtifactRefPayload | null {
  if (!dt) return null;
  if (!Array.from(dt.types ?? []).includes(NAUTILO_ARTIFACT_REF_MIME)) {
    return null;
  }
  const raw = dt.getData(NAUTILO_ARTIFACT_REF_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed != null &&
      typeof parsed === "object" &&
      (parsed as { kind?: unknown }).kind === "artifact" &&
      typeof (parsed as { artifactId?: unknown }).artifactId === "string" &&
      ((parsed as { artifactId: string }).artifactId.length > 0)
    ) {
      const p = parsed as {
        artifactId: string;
        path?: unknown;
        mimeType?: unknown;
        size?: unknown;
      };
      return {
        kind: "artifact",
        artifactId: p.artifactId,
        path: typeof p.path === "string" ? p.path : "",
        mimeType: typeof p.mimeType === "string" && p.mimeType ? p.mimeType : "application/octet-stream",
        size: typeof p.size === "number" && Number.isFinite(p.size) && p.size >= 0 ? p.size : 0,
      };
    }
  } catch {
    /* malformed payload — treat as no match */
  }
  return null;
}

/**
 * Pure precedence helper for the composer drop handler. Returns the
 * dispatch decision so the React handler can act + the unit tests can
 * pin the contract without rendering. Artifact-ref takes priority over
 * file-ref (when both MIMEs are present, artifact wins).
 */
export type ComposerDropDispatch =
  | { kind: "artifact-ref"; payload: NautiloArtifactRefPayload }
  | { kind: "file-ref"; payload: NautiloFileRefPayload }
  | { kind: "ignore" };

export function classifyComposerDrop(dt: DataTransfer | null): ComposerDropDispatch {
  if (!dt) return { kind: "ignore" };
  const artifact = parseNautiloArtifactRefDataTransfer(dt);
  if (artifact) return { kind: "artifact-ref", payload: artifact };
  const file = parseNautiloFileRefDataTransfer(dt);
  if (file) return { kind: "file-ref", payload: file };
  return { kind: "ignore" };
}

export type QueueFileAttachmentResult =
  | { ok: true }
  | { ok: false; message: string }
  | {
      ok: false;
      code: "unsupported";
      skip: ComposerChatAttachmentSkip;
    };

/**
 * Queue `path` if it is under `rootPath`. Historical call sites used this
 * function to paste fenced file contents into the textarea; D066 makes it a
 * metadata-only attachment queue path instead.
 */
export function queueFileAttachmentFromPath(
  path: string,
  rootPath: string,
): QueueFileAttachmentResult {
  if (!isUnderRoot(rootPath, path)) {
    return { ok: false, message: "Path is not under the expected folder." };
  }
  const pf = preflightComposerChatAttachment(path);
  if (!pf.ok) {
    return { ok: false, code: "unsupported", skip: pf.skip };
  }
  const name = path.split(/[/\\]/).pop() ?? path;
  const added = addAttachment({
    id: newAttachmentId(),
    path,
    rootPath,
    name,
  });
  if (!added) {
    return { ok: false, message: "Attachment limit reached. Send or remove files before adding more." };
  }
  return { ok: true };
}
