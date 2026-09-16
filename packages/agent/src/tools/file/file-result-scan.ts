/**
 * M206 — per-call result scan policy for local-zone `file` read/grep output.
 *
 * Catalog `resultScanPolicy:"never"` stays unchanged; this resolver overrides
 * at execution time when explicit content-bearing local commands return text.
 */

import type { ToolResultScanPolicy } from "@nautilo/types";
import type { FileToolRawArgs } from "./schema";
import { isLocalFileZone } from "./local-file-routing";

const CONTENT_BEARING_COMMANDS = new Set(["read", "grep"]);

/**
 * Resolve scan policy for a `file` tool invocation. Local-zone read/grep
 * content is scanned before model delivery; metadata-only commands stay never.
 */
export function resolveFileToolResultScanPolicy(
  args: FileToolRawArgs,
  catalogPolicy: ToolResultScanPolicy,
): ToolResultScanPolicy {
  if (isLocalFileZone(args.zone) && CONTENT_BEARING_COMMANDS.has(args.command)) {
    return "on-suspicious";
  }
  return catalogPolicy;
}
