/** Existing Workspace artifact API envelope, shared by reference consumers. */
export const WORKSPACE_LOGICAL_PATH_MAX_CHARS = 4096;

/** Workspace artifact names, not filesystem paths. Preserve their exact identity. */
export function validateWorkspaceLogicalPath(p: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof p !== "string") return { ok: false, reason: "path must be a string" };
  if (p.length === 0) return { ok: false, reason: "path is empty" };
  if (p.length > WORKSPACE_LOGICAL_PATH_MAX_CHARS) return { ok: false, reason: `path > ${WORKSPACE_LOGICAL_PATH_MAX_CHARS} chars` };
  if (p.startsWith("/")) return { ok: false, reason: "path must not start with /" };
  if (p.split("/").some((seg) => seg === "..")) return { ok: false, reason: "path must not contain .." };
  // eslint-disable-next-line no-control-regex -- reject control bytes in logical paths
  if (/[\u0000-\u001f]/.test(p)) return { ok: false, reason: "path contains control characters" };
  return { ok: true, path: p };
}
