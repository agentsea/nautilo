/**
 * D079 Phase 4 / G3 commit 6 — `file` command "stat" handler.
 *
 * Returns metadata for a file or directory: size, mtime, type
 * (file/directory/symlink/other). Non-destructive; always safe.
 */

import type { CommandHandler } from "./_shared";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";

export const handleStat: CommandHandler<"stat"> = async (
  _args,
  resolution,
  ctx,
) => {
  try {
    const backend = getFileBackend(ctx);
    // `lstat` (not `stat`) so we report symlinks AS symlinks
    // rather than following them transparently. Security-relevant:
    // an agent asked to `stat` a symlink should see the symlink,
    // not the target's metadata.
    const st = await backend.lstat(resolution.resolved);

    const type = st.isDirectory()
      ? "directory"
      : st.isFile()
        ? "file"
        : st.isSymbolicLink()
          ? "symlink"
          : st.isFIFO()
            ? "fifo"
            : st.isSocket()
              ? "socket"
              : "other";

    return JSON.stringify(
      {
        path: resolution.resolved,
        zone: resolution.resolvedZone,
        type,
        size: st.size,
        modified: st.mtime.toISOString(),
        created: st.birthtime.toISOString(),
        // Mode is useful for the agent to know "is this executable?"
        // without pulling in a full posix-perms library. Decimal
        // mode bits only; the agent can mask to extract what it
        // cares about.
        mode: st.mode,
      },
      null,
      2,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return fileToolError(`Error: file not found: ${resolution.resolved}`);
    }
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied: ${resolution.resolved}`);
    }
    return fileToolError(`Error reading file metadata: ${msg}`);
  }
};
