/**
 * D079 Phase 4 / G3 commit 7 — `file` command "insert" handler.
 * D087 Phase 1 §1.3 — routes through the staged-patch store.
 *
 * Inserts `content` BEFORE the given 1-indexed line. To insert at the
 * end of the file, pass `lineNumber = (last+1)`; the handler tolerates
 * `lineNumber === lines.length + 1` as "append to end" rather than
 * erroring out.
 *
 * The inserted content:
 *   - is prefixed with a trailing newline if it doesn't already end in
 *     one (so multi-line insertions don't collapse into the next line)
 *   - preserves its own internal newlines verbatim
 *
 * Error paths: ENOENT, EISDIR, EACCES, out-of-range lineNumber.
 */

import { applyContentPatch, encodeAppliedResult, type CommandHandler } from "./_shared";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";

export const handleInsert: CommandHandler<"insert"> = async (args, resolution, ctx) => {
  // Required-field guards — flat wire schema leaves these optional; the
  // handler is the sole line of defense for missing args.
  if (typeof args.lineNumber !== "number") {
    return fileToolError("Error: insert requires 'lineNumber' (positive integer)");
  }
  if (typeof args.content !== "string") {
    return fileToolError("Error: insert requires 'content' (string)");
  }

  const lineNumber = args.lineNumber;
  const content = args.content;
  const backend = getFileBackend(ctx);

  let original: string;
  try {
    original = (await backend.readFile(resolution.resolved)).toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return fileToolError(`Error: file not found: ${resolution.resolved}`);
    }
    if (msg.includes("EISDIR")) {
      return fileToolError(`Error: ${resolution.resolved} is a directory`);
    }
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied: ${resolution.resolved}`);
    }
    return fileToolError(`Error reading file: ${msg}`);
  }

  const lines = original.split("\n");
  // `split("\n")` gives a trailing empty string for files ending in
  // `\n` — that's fine for splicing but matters for the "insert at end"
  // range. If the file has 10 lines of text + trailing newline,
  // `lines.length` is 11, and legal lineNumbers are 1..11.
  const maxLegalLine = lines.length + 1;
  if (lineNumber < 1 || lineNumber > maxLegalLine) {
    const contentLineCount = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
    return fileToolError(`Error: lineNumber ${lineNumber} is out of range (file has ${contentLineCount} content lines; legal range 1..${maxLegalLine})`);
  }

  // Normalize the inserted content so it ends with a newline; split on
  // \n then drop the trailing empty entry so the splice maintains clean
  // line numbering.
  const normalizedContent = content.endsWith("\n") ? content : content + "\n";
  const contentLines = normalizedContent.split("\n");
  if (contentLines[contentLines.length - 1] === "") {
    contentLines.pop();
  }

  const insertAt = lineNumber - 1;
  const mutableLines = [...lines];
  mutableLines.splice(insertAt, 0, ...contentLines);
  const updated = mutableLines.join("\n");

  const summary = `Applied insert ${contentLines.length} line(s) at ${resolution.resolved}:${lineNumber} — revertable.`;

  try {
    const envelope = await applyContentPatch({
      resolution,
      ctx,
      command: "insert",
      commandArgs: { path: args.path, zone: args.zone, lineNumber },
      newBytes: Buffer.from(updated, "utf-8"),
      summary,
      deriveAnchoredEdit: true,
    });
    if ("errorText" in envelope) return fileToolError(envelope.errorText);
    return encodeAppliedResult(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fileToolError(`Error applying insert: ${msg}`);
  }
};
