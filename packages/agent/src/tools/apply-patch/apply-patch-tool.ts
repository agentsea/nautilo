/**
 * D448 Phase 2.1 — model-facing apply_patch factory.
 *
 * This tool owns only the model envelope and the hand-off to a trusted
 * execution port. Path resolution, zone selection, relay dispatch, sandbox
 * construction, staging, and filesystem mutation remain outside this module.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  applyPatchRequestSchema,
  type ApplyPatchRequest,
} from "./contract";

export const APPLY_PATCH_TOOL_DESCRIPTION =
  "Core baseline tool: apply one contextual multi-file UTF-8 text patch to the Desktop Current Folder. Workspace artifacts are not supported; use artifact-aware file commands there. " +
  "It needs no activation, but Desktop authority and runtime availability fail closed. Pass exactly one patch string bounded by *** Begin Patch and *** End Patch. The optional target selector is retained for compatibility; target workspace returns an unsupported-target error with safe alternatives. " +
  "Prefer repository-relative paths when they make the patch clearer and portable; existing Current Folder authority decides whether a path form can be reached. " +
  "For a move, begin that operation with *** Update File: <source>, put *** Move to: <destination> immediately after it, and then provide any @@ hunks; never attach *** Move to: to a delete block. " +
  "Keep patches coherent and focused, use about three context lines by default, and add @@ class/function anchors when snippets could be ambiguous. " +
  "Partial outcomes are possible; inspect the result and recover with file history when available.";

/**
 * The only runtime dependency of the model-facing tool. The port receives a
 * validated model patch plus its non-authoritative selector; it owns every
 * execution decision and all filesystem authority.
 */
export interface ApplyPatchExecutionPort {
  execute(input: Readonly<{
    patch: string;
    target?: ApplyPatchRequest["target"];
  }>): Promise<unknown>;
}

/**
 * Opaque catalog context narrowed to the trusted execution port. The model's
 * selector is forwarded only as a preference; the port remains the authority
 * owner and resolves current trusted state immediately before execution.
 */
export interface ApplyPatchToolContext {
  applyPatchExecutionPort?: ApplyPatchExecutionPort | undefined;
}

function errorResult(
  code: "invalid_request" | "missing_context" | "runtime_unavailable",
  message: string,
): string {
  return JSON.stringify({
    ok: false,
    error: { code, message, retryable: code === "runtime_unavailable" },
  });
}

function serializeResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return errorResult("runtime_unavailable", "apply_patch execution returned an unserializable result.");
  }
}

/**
 * Construct the top-level core tool. It intentionally fails closed without a
 * trusted execution port. Target selection and all authority remain deferred
 * to that port.
 */
export function createApplyPatchTool(context?: ApplyPatchToolContext): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "apply_patch",
    description: APPLY_PATCH_TOOL_DESCRIPTION,
    schema: applyPatchRequestSchema,
    func: async (input: unknown) => {
      const request = applyPatchRequestSchema.safeParse(input);
      if (!request.success) {
        return errorResult("invalid_request", "apply_patch accepts one non-empty patch string and an optional target selector.");
      }
      const port = context?.applyPatchExecutionPort;
      if (!port) {
        return errorResult("missing_context", "apply_patch execution is unavailable without a trusted execution port.");
      }
      try {
        return serializeResult(await port.execute({
          patch: request.data.patch,
          ...(request.data.target === undefined ? {} : { target: request.data.target }),
        }));
      } catch {
        return errorResult("runtime_unavailable", "apply_patch execution failed.");
      }
    },
  });
}
