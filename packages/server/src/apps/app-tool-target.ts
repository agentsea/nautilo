import type { MiniAppManifest } from "./app-manifest";
import type { AppDocumentTarget } from "./app-tool-types";

export type DocumentSurface = "artifact" | "currentFolder";

export type AccessLevel = "none" | "read" | "readwrite";

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function validateBasenameFilename(filename: unknown): { ok: true; filename: string } | { ok: false; reason: string } {
  if (typeof filename !== "string") {
    return { ok: false, reason: "filename must be a string" };
  }
  if (filename.trim().length === 0) {
    return { ok: false, reason: "filename must not be empty" };
  }
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    hasControlChars(filename)
  ) {
    return { ok: false, reason: "filename must be a basename without path separators" };
  }
  return { ok: true, filename };
}

export function validateWorkspaceLogicalPath(rawPath: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "path is required" };
  }
  if (hasControlChars(rawPath)) {
    return { ok: false, reason: "path contains control characters" };
  }
  if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return { ok: false, reason: "path must be relative" };
  }
  const segments = rawPath.split(/[/\\]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ok: false, reason: "path must contain at least one non-empty segment" };
  }
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, reason: "path may not contain '..' segments" };
  }
  return { ok: true, path: segments.join("/") };
}

export function validateCurrentFolderRelativePath(
  rawPath: unknown,
): { ok: true; relativePath: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "relativePath is required" };
  }
  if (hasControlChars(rawPath)) {
    return { ok: false, reason: "relativePath contains control characters" };
  }
  if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return { ok: false, reason: "relativePath must be relative" };
  }
  const segments = rawPath.split(/[/\\]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ok: false, reason: "relativePath must contain at least one non-empty segment" };
  }
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, reason: "relativePath may not contain '..' segments" };
  }
  return { ok: true, relativePath: segments.join("/") };
}

export function validateAppDocumentTarget(raw: unknown): { ok: true; target: AppDocumentTarget } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "target must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj["surface"] === "workspace") {
    const validated = validateWorkspaceLogicalPath(obj["path"]);
    if (!validated.ok) return validated;
    return { ok: true, target: { surface: "workspace", path: validated.path } };
  }
  if (obj["surface"] === "currentFolder") {
    const validated = validateCurrentFolderRelativePath(obj["relativePath"]);
    if (!validated.ok) return validated;
    return { ok: true, target: { surface: "currentFolder", relativePath: validated.relativePath } };
  }
  return { ok: false, reason: 'target.surface must be "workspace" or "currentFolder"' };
}

export function documentSurfaceForTarget(target: AppDocumentTarget): DocumentSurface {
  return target.surface === "workspace" ? "artifact" : "currentFolder";
}

export function documentAccessLevel(
  manifest: MiniAppManifest,
  surface: DocumentSurface,
): AccessLevel | undefined {
  return manifest.capabilities.document?.[surface];
}

export function stateAccessLevel(manifest: MiniAppManifest): AccessLevel | undefined {
  return manifest.capabilities.state;
}

export function accessAllowsRead(level: AccessLevel | undefined): boolean {
  return level === "read" || level === "readwrite";
}

export function accessAllowsWrite(level: AccessLevel | undefined): boolean {
  return level === "readwrite";
}

export function capabilityDeniedMessage(kind: "read" | "write", surface: DocumentSurface | "state"): string {
  if (surface === "state") {
    return `App manifest does not grant state ${kind} capability.`;
  }
  const label = surface === "artifact" ? "workspace artifact" : "current folder";
  return `App manifest does not grant ${label} ${kind} capability.`;
}

const STATE_KEY_MAX_LEN = 128;

export function validateStateKey(key: unknown): { ok: true; key: string } | { ok: false; reason: string } {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, reason: "state key must be a non-empty string" };
  }
  if (key.length > STATE_KEY_MAX_LEN) {
    return { ok: false, reason: `state key must be at most ${STATE_KEY_MAX_LEN} characters` };
  }
  if (key.includes(":")) {
    return { ok: false, reason: "state key must not contain ':'" };
  }
  if (hasControlChars(key)) {
    return { ok: false, reason: "state key contains control characters" };
  }
  return { ok: true, key };
}

export function appStateStorageKey(appId: string, key: string): string {
  return `app:${appId}:${key}`;
}
