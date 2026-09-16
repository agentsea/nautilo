/**
 * Stack 208 P3 — file-tool-owned explicit result status.
 *
 * The cloud `file` tool handlers intentionally return documented error
 * STRINGS (and structured JSON envelopes) instead of throwing — e.g. a
 * `read` of a missing workspace file catches ENOENT and returns
 * `Error: file not found: <path>`. The cloud invocation in `nodes/tools.ts`
 * succeeds (no throw), so without an explicit signal every cloud `file`
 * result is stamped `nautilo_tool_status: "success"` and the no-progress
 * breaker — which keys on an EXPLICIT error status — never fires for
 * repeated missing-file reads.
 *
 * This module closes that gap with an OUT-OF-BAND explicit marker instead
 * of content guessing:
 *
 *   - `captureFileToolResult(invoke)` wraps a `file` tool invocation in an
 *     `AsyncLocalStorage` context. It returns `{ result, status }` where
 *     `status` defaults to `"success"` and is flipped to `"error"` only
 *     when a handler calls `fileToolError(content)` on the return path.
 *   - `fileToolError(content)` is called by `file` command paths
 *     immediately before returning documented error content. Inside a
 *     capture context it flips the captured status to `"error"` and
 *     returns the identical string. OUTSIDE a capture context (direct
 *     handler unit tests, workspace dispatch helpers exercised without
 *     the tools node) it is a NO-OP that returns the identical string —
 *     so direct handler tests keep seeing the exact bytes they always
 *     saw, with no status side-effect.
 *
 * What this deliberately does NOT do:
 *   - No content parsing. No `Error:` prefix sniffing, no JSON envelope
 *     inference, no heuristic anywhere. The status is carried
 *     out-of-band, so a workspace artifact whose body literally starts
 *     with `Error: file not found: <p>` is byte-identical to a
 *     handler-emitted error AND stays `success` (because the read
 *     handler never calls `fileToolError` on the success-content path).
 *     Explicit handler marking removes that content ambiguity.
 *   - No global `Error:` heuristic. The capture is invoked by `tools.ts`
 *     only when `tc.name === "file"`, and `fileToolError` is only called
 *     on documented top-level error return paths inside the `file`
 *     command handlers.
 *
 * Marking discipline (see the per-handler edits):
 *   - Only TOP-LEVEL error returns that become the unified `file` tool
 *     result are marked. Internal helper errors that may be recovered
 *     before the final return (e.g. per-file errors nested inside an
 *     `undo_turn` partial-success envelope) are NOT marked, so a
 *     partial-success result stays `success`.
 *   - A successful `read` whose actual file contents begin with `Error:`
 *     stays `success`: the read handler returns the body verbatim
 *     WITHOUT calling `fileToolError`, so no marker flips the captured
 *     status. This is pinned by unit + integration tests.
 *
 * Pure and side-effect-free aside from the AsyncLocalStorage write; the
 * write is scoped to the capture's async context and never escapes it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type FileResultStatus = "success" | "error";

/**
 * Per-capture mutable status cell. Default `success`; flipped to `error`
 * by {@link fileToolError} when a `file` command path returns documented
 * error content. Lives only inside the {@link captureFileToolResult}
 * async context.
 */
interface CaptureCell {
  status: FileResultStatus;
}

const captureStorage = new AsyncLocalStorage<CaptureCell>();

/**
 * Mark a `file` tool result as an error. Call this immediately before
 * returning documented error content from a top-level `file` command
 * path.
 *
 * Inside a {@link captureFileToolResult} context (the production tools
 * node path) this flips the captured status to `"error"` and returns the
 * identical string unchanged — the model-facing content is preserved
 * byte-for-byte; only the out-of-band status changes.
 *
 * Outside any capture context (direct handler unit tests, helpers
 * exercised without the tools node) this is a NO-OP that returns the
 * identical string. Direct handler tests therefore keep observing the
 * exact error bytes they always did, with no status side-effect to
 * reason about.
 *
 * @param content The documented error string (or `JSON.stringify`'d
 *                error envelope) the handler is about to return.
 * @returns The identical `content` string, unchanged.
 */
export function fileToolError(content: string): string {
  const cell = captureStorage.getStore();
  if (cell !== undefined) {
    cell.status = "error";
  }
  return content;
}

/**
 * Wrap a `file` tool invocation so an explicit {@link fileToolError}
 * marker inside the handler carries the error status out-of-band to the
 * tools node. Returns the raw result plus the captured status (default
 * `"success"` when no marker fired).
 *
 * The capture is a single async context: any `await` inside `invoke`
 * preserves the cell, so markers in deeply-nested handlers (workspace
 * dispatch, local-file dispatch, staged-patch helpers) reach the same
 * cell as long as they are on the call chain that produces the final
 * `file` tool result.
 *
 * @param invoke The cloud `tool.invoke` thunk for `tc.name === "file"`.
 *                May return a `string` (the common case) or a
 *                `ToolMessage` (multimodal image/PDF read — never an
 *                error string, so its status stays `success`).
 */
export async function captureFileToolResult<T>(
  invoke: () => Promise<T>,
): Promise<{ result: T; status: FileResultStatus }> {
  const cell: CaptureCell = { status: "success" };
  const result = await captureStorage.run(cell, invoke);
  return { result, status: cell.status };
}
