import { basename } from "node:path";
import { invariant, requiredString } from "../core/errors.js";

export function cleanFilename(value) {
  const name = requiredString(value, "filename");
  invariant(name === basename(name) && !name.includes("\\") && !name.includes("\0") && name !== "." && name !== "..", 400, "invalid_filename", "Use a filename without directory components");
  return name;
}
export function stagingKey(ticketId, filename) {
  return `staging/${ticketId}/${cleanFilename(filename)}`;
}
export function documentObjectKey(projectId, documentId) {
  return `projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`;
}
