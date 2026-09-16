/**
 * D079 Phase 4 / G3 commit 7 — `file` command "write" handler.
 * D087 Phase 1 §1.3 — staged-patch pipeline.
 *
 * Writes UTF-8 text to a file in one of three modes:
 *   - overwrite (default) — replace the file's contents entirely
 *   - append              — add to end; create if missing
 *   - prepend             — add to beginning; create if missing
 *
 * As of D087 Phase 1, this handler no longer writes directly. It
 * computes the PROPOSED bytes, stages a patch via the turn-scoped
 * staged-patch store, and returns a JSON envelope with the patchId +
 * unified diff. The user approves (or rejects) via the DiffView tool
 * card; the actual disk write happens in `apply_patch.ts` on Accept.
 *
 * Directory target / symlink handling remains at stage time: we
 * refuse to stage a patch that would target a directory-as-file, and
 * we resolve symlinks to check that the target is also not a dir.
 *
 * Parent directory creation is deferred to apply time (handled there)
 * so a staged patch that never gets accepted doesn't leave empty
 * parent dirs behind.
 */

import { applyContentPatch, encodeAppliedResult, looksLikeBinary, readBytesOrEmpty, type CommandHandler } from "./_shared";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";

export const handleWrite: CommandHandler<"write"> = async (args, resolution, ctx) => {
  // Required-field guard — flat wire schema doesn't enforce per-
  // command required fields (see schema.ts header). Handler is the
  // sole line of defense for missing content.
  if (typeof args.content !== "string") {
    return fileToolError("Error: write requires 'content' (string)");
  }

  const mode = args.mode ?? "overwrite";
  const content = args.content;
  const backend = getFileBackend(ctx);

  try {
    // Verify the target isn't an existing directory — staging a patch
    // against a directory is meaningless. Symlink-to-directory falls
    // under the same rejection.
    try {
      const existing = await backend.lstat(resolution.resolved);
      if (existing.isDirectory()) {
        return fileToolError(`Error: ${resolution.resolved} is a directory; cannot write as a file`);
      }
      if (existing.isSymbolicLink()) {
        const target = await backend.stat(resolution.resolved).catch(() => null);
        if (target && target.isDirectory()) {
          return fileToolError(`Error: ${resolution.resolved} is a symlink to a directory; cannot write as a file`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) {
        return fileToolError(`Error stating path before write: ${msg}`);
      }
      // ENOENT is fine — creating a new file.
    }

    // Compute the proposed bytes. For overwrite the bytes ARE the
    // content; for append / prepend we fold in the existing bytes so
    // the diff shows the true net change.
    let finalBytes: Buffer<ArrayBufferLike>;
    let existingBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    if (mode === "overwrite") {
      finalBytes = Buffer.from(content, "utf-8");
      existingBytes = await readBytesOrEmpty(resolution.resolved, backend);
    } else {
      existingBytes = await readBytesOrEmpty(resolution.resolved, backend);
      const existing = existingBytes.toString("utf-8");
      finalBytes = Buffer.from(
        mode === "append" ? existing + content : content + existing,
        "utf-8",
      );
    }

    const deriveAnchoredEdit =
      mode === "overwrite" &&
      (resolution.resolvedZone === "workspace" || resolution.resolvedZone === "current") &&
      existingBytes.length > 0 &&
      !looksLikeBinary(existingBytes) &&
      !looksLikeBinary(finalBytes);

    const bytes = finalBytes.byteLength;
    const summary = `Applied write ${bytes} bytes to ${resolution.resolved} (mode: ${mode}) — revertable.`;
    const envelope = await applyContentPatch({
      resolution,
      ctx,
      command: "write",
      commandArgs: { path: args.path, zone: args.zone, mode },
      newBytes: finalBytes,
      summary,
      ...(deriveAnchoredEdit ? { deriveAnchoredEdit: true } : {}),
    });

    if ("errorText" in envelope) return fileToolError(envelope.errorText);
    return encodeAppliedResult(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied reading ${resolution.resolved}`);
    }
    return fileToolError(`Error applying write: ${msg}`);
  }
};
