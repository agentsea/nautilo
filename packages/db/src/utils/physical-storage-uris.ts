import { isAbsolute, resolve } from "node:path";

/** Physical replay pointers, never logical document identity or content hashes. */
export const PHYSICAL_FILE_URI_COLUMNS = [
  ["artifacts", "storage_uri"],
  ["message_attachments", "storage_uri"],
  ["workspace_document_mutation_entries", "before_storage_uri"],
  ["workspace_document_mutation_entries", "after_storage_uri"],
  ["workspace_document_mutation_entries", "destination_before_storage_uri"],
] as const;

export function physicalFileUriBase(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || /[\0\r\n]/.test(root)) {
    throw new Error("Unsafe file-URI root");
  }
  return `file://${root}`;
}

export function rebindPhysicalFileUri(uri: string, sourceRoot: string, targetRoot: string): string {
  if (sourceRoot === targetRoot) throw new Error("File-URI roots must differ");
  const source = physicalFileUriBase(sourceRoot);
  const target = physicalFileUriBase(targetRoot);
  if (uri === source) return target;
  return uri.startsWith(`${source}/`) ? `${target}${uri.slice(source.length)}` : uri;
}
