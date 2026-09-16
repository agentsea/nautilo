import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const MAX_RELATIVE_PATH_LENGTH = 1_024;

function isBoundedRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  return !value.split(/[\\/]/).some(
    (segment) => segment.length === 0 || segment === "." || segment === "..",
  );
}

/**
 * D497 — model-facing request only. Electron remains the authority that
 * resolves this bounded, source-root-relative request to a host folder.
 */
export const selectCurrentFolderSchema = z.object({
  sourceRootKind: z.enum(["workspace", "current_folder"]),
  relativePath: z.string().refine(isBoundedRelativePath, {
    message: "relativePath must be a bounded, non-empty relative folder path",
  }),
}).strict();

export type SelectCurrentFolderArgs = z.infer<typeof selectCurrentFolderSchema>;

/** Re-used at the central relay boundary, whose raw dispatch bypasses `func`. */
export function parseSelectCurrentFolderArgs(input: unknown): SelectCurrentFolderArgs | null {
  const parsed = selectCurrentFolderSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function createSelectCurrentFolderTool() {
  return new DynamicStructuredTool({
    name: "select_current_folder",
    description:
      "Request adoption of a folder beneath the existing Workspace or Current Folder. " +
      "Pass only the authorized source root kind and a bounded relative folder path; " +
      "never provide an absolute host path. This changes the Current Folder after explicit approval.",
    schema: selectCurrentFolderSchema,
    func: () => Promise.reject(
      new Error(
        "select_current_folder is a relay tool — execution goes through the approved Electron prepare/commit protocol.",
      ),
    ),
  });
}
