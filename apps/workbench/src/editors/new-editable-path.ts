import { joinPath, separatorFor } from "../components/browser-column/cited-paths";
import { basename } from "../lib/file-preview";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".docx",
  ".xlsx",
  ".zip",
  ".dmg",
  ".exe",
  ".bin",
]);

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
}

function hasTraversalSegment(path: string): boolean {
  const sep = separatorFor(path);
  return path.split(sep).some((segment) => segment === ".." || segment === ".");
}

export function buildNewEditablePath(input: {
  parentPath: string;
  name: string;
  existingNames: readonly string[];
}): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmedName = input.name.trim();
  const trimmedParent = input.parentPath.trim();

  if (trimmedName.length === 0) {
    return { ok: false, reason: "File name is required." };
  }
  if (isAbsolutePath(trimmedName)) {
    return { ok: false, reason: "File name must not be an absolute path." };
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    return { ok: false, reason: "File name must not contain path separators." };
  }
  if (trimmedName === "." || trimmedName === "..") {
    return { ok: false, reason: "File name is not allowed." };
  }
  if (hasTraversalSegment(trimmedName)) {
    return { ok: false, reason: "Path is not allowed." };
  }

  const ext = extensionOf(trimmedName);
  if (ext !== null && BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "That file type cannot be edited." };
  }

  const lowerName = trimmedName.toLowerCase();
  if (input.existingNames.some((existing) => existing.toLowerCase() === lowerName)) {
    return { ok: false, reason: "A file with that name already exists." };
  }

  if (trimmedParent.length === 0) {
    return { ok: true, path: trimmedName };
  }

  if (hasTraversalSegment(trimmedParent)) {
    return { ok: false, reason: "Path is not allowed." };
  }

  return { ok: true, path: joinPath(trimmedParent, trimmedName) };
}

export function inferEditableMimeType(path: string): string {
  const ext = extensionOf(basename(path));
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".xml":
      return "application/xml";
    case ".css":
    case ".scss":
      return "text/css";
    default:
      return "text/plain";
  }
}
