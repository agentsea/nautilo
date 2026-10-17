import { isAbsolute, posix, win32 } from "node:path";

/** Storage pointers use raw native paths, including literal spaces and percent signs. */
export function physicalPathFromStorageUri(storageUri: string | null | undefined): string | null {
  if (typeof storageUri !== "string" || !storageUri.startsWith("file://")) return null;
  const path = storageUri.slice("file://".length);
  return isAbsolute(path) ? path : null;
}

/** Physical replay pointers, never logical document identity or content hashes. */
export const PHYSICAL_FILE_URI_COLUMNS = [
  ["artifacts", "storage_uri"],
  ["message_attachments", "storage_uri"],
  ["workspace_document_mutation_entries", "before_storage_uri"],
  ["workspace_document_mutation_entries", "after_storage_uri"],
  ["workspace_document_mutation_entries", "destination_before_storage_uri"],
] as const;

export function physicalFileUriBase(root: string, style: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix"): string {
  const path = style === "win32" ? win32 : posix;
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root || /[\0\r\n]/.test(root)) {
    throw new Error("Unsafe file-URI root");
  }
  return `file://${root}`;
}

export function rebindPhysicalFileUri(uri: string, sourceRoot: string, targetRoot: string, style: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix"): string {
  if (sourceRoot === targetRoot) throw new Error("File-URI roots must differ");
  const source = physicalFileUriBase(sourceRoot, style);
  const target = physicalFileUriBase(targetRoot, style);
  const { sep } = style === "win32" ? win32 : posix;
  if (uri === source) return target;
  return uri.startsWith(`${source}${sep}`) ? `${target}${uri.slice(source.length)}` : uri;
}
