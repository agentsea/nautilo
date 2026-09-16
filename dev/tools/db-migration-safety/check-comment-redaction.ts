import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import receipt from "./comment-redactions.json";

/** A closed list of exact privacy edits, not a general comment-edit bypass. */
export function isRecordedCommentRedaction(path: string, beforeSha256: string, afterSha256: string): boolean {
  return receipt.redactions.some((entry) =>
    entry.path === path &&
    entry.beforeSha256 === beforeSha256 &&
    entry.afterSha256 === afterSha256,
  );
}

if (import.meta.main) {
  const path = process.argv[2];
  try {
    if (!path) throw new Error("Missing migration path");
    const before = execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
    const after = execFileSync("git", ["show", `:${path}`], { encoding: "utf8" });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    process.exitCode = isRecordedCommentRedaction(path, hash(before), hash(after)) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
