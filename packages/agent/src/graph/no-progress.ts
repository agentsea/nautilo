import { localToolControlReceiptSchema, localToolRequestedOperation, securityResearchContextReceiptSchema, securityScanToolResultSchema } from "@nautilo/types";
import { DEFAULT_REPEATED_FAILURE_LIMIT } from "./execution-policy";
export { DEFAULT_REPEATED_FAILURE_LIMIT } from "./execution-policy";

/**
 * Stack 208 P2 — no-progress breaker (pure normalization + state-transition).
 *
 * The graph loop `pre_model → agent → post_model → tools → pre_model` lets a
 * stuck agent repeat the same failing tool call indefinitely once the
 * recursion ceiling is raised (R1). This module fingerprints repeated
 * *failures* and transitions a checkpointed streak state so the runtime can:
 *
 *   - reset the streak on any success for the same key (R4),
 *   - never block successful repeated reads (R4),
 *   - after the same normalized failure occurs {@link DEFAULT_REPEATED_FAILURE_LIMIT}
 *     times, cause exactly ONE corrective model turn with a clear internal
 *     instruction (R4), and
 *   - if the corrected turn returns the same failure once more, throw/map a
 *     typed `no_progress` outcome and do NOT execute that tool a fifth time.
 *
 * A different normalized error resets the prior streak for the same
 * `{toolName, operationDiscriminator}` pair; parallel calls for different
 * tool/operation pairs are counted
 * independently but a single batch advances a key's streak by at most one
 * step (so deterministic ordering cannot manufacture a false positive).
 *
 * This file is PURE: it takes the current streak state + the just-executed
 * tool results and returns the next streak state plus an action. It does not
 * touch the graph, the logger, or any external tool output. Integration lives
 * at the tools→pre_model boundary (see `nodes/tools.ts` end-of-node and
 * `nodes/pre-model.ts` start-of-node).
 *
 * SECURITY (R9 / spec): the streak key carries NO raw tool args.
 * `operationDiscriminator` is a coarse, allowlisted enum label for known
 * command-dispatch tools only (`file` / `officecli` / `security_scan`); unknown tools, including
 * `run_shell`, always use the empty discriminator. `normalizedError` is a
 * length-capped, prefix-stripped,
 * whitespace-collapsed token derived ONLY from the explicit error string the
 * execution seam already produced (never from arbitrary successful content).
 * The normalized error is checkpoint-only and is NEVER logged.
 */

/**
 * Cap for the normalized error token. Long error strings are truncated so a
 * pathological tool cannot bloat the checkpointed streak state or the log
 * line. The cap is on the *normalized* token (after prefix stripping +
 * whitespace collapse), so it is well below any realistic secret-bearing
 * payload length.
 */
const NORMALIZED_ERROR_MAX_CHARS = 240;

/** Maximum checkpointed streak entries; oldest insertion is evicted first. */
export const MAX_NO_PROGRESS_STREAKS = 64;

const FILE_OPERATIONS = new Set([
  "list", "read", "grep", "stat", "write", "insert", "str_replace",
  "move", "copy", "delete", "undo", "undo_turn", "redo",
  "list_revisions", "pin_revision", "unpin_revision", "list_blocks",
  "read_block", "replace_block", "insert_block", "move_block", "rewrite_block",
]);

const OFFICECLI_OPERATIONS = new Set([
  "create", "view", "get", "query", "set", "add", "remove", "move",
  "swap", "validate", "dump", "merge", "batch", "raw", "raw_set",
  "add_part", "open", "save", "close", "refresh", "help",
]);

/**
 * The triple that identifies one failure streak. All three fields are safe
 * (no raw args, no raw output) and deterministic.
 */
export interface NoProgressKey {
  readonly toolName: string;
  readonly operationDiscriminator: string;
  readonly normalizedError: string;
}

/**
 * One streak entry, checkpointed in `NautiloStateAnnotation.noProgressStreaks`.
 *
 * `count` is the number of consecutive identical failures observed for this
 * key. `correctiveTurnIssued` flips to `true` the first time `count` reaches
 * the limit; it stays true so the next identical failure (count = limit + 1)
 * maps to a typed `no_progress` stop rather than re-issuing another
 * corrective turn.
 */
export interface NoProgressStreakEntry {
  readonly count: number;
  readonly correctiveTurnIssued: boolean;
}

/**
 * Checkpointed failure-streak state. Keyed by the serialized
 * {@link NoProgressKey} (see {@link serializeNoProgressKey}). A missing entry
 * means "no current streak for this key".
 */
export type NoProgressStreaks = ReadonlyMap<string, NoProgressStreakEntry>;

/**
 * The action the seam wants the graph to take after processing one tools-node
 * batch. Returned by {@link applyToolResultsToStreaks}.
 */
export type NoProgressAction =
  | { readonly kind: "continue" }
  | { readonly kind: "inject_corrective"; readonly key: NoProgressKey }
  | { readonly kind: "stop_no_progress"; readonly key: NoProgressKey };

/**
 * Result of transitioning the streak state for one tools-node batch.
 */
export interface NoProgressTransition {
  readonly streaks: NoProgressStreaks;
  readonly action: NoProgressAction;
}

/**
 * One tool result observed at the execution seam. The seam supplies an
 * explicit `status` ("success" | "error") — never inferred from arbitrary
 * content (see `nodes/tools.ts` `nautilo_tool_status` marker). `errorContent`
 * is the raw error string the tool produced; it is normalized internally and
 * never checkpointed verbatim and never logged in normalized form either.
 */
export interface NoProgressToolResult {
  readonly toolName: string;
  readonly args: Record<string, unknown> | null | undefined;
  readonly status: "success" | "error";
  readonly errorContent?: string;
}

// ---------------------------------------------------------------------------
// Pure normalization (no logging; no raw args; bounded error fingerprint)
// ---------------------------------------------------------------------------

/**
 * Coarse, safe operation label for a tool call. Only `file` and `officecli`
 * may contribute their `command`, and only when it is one of their grounded
 * schema enum values. Unknown tools — especially `run_shell`, whose command
 * is an arbitrary shell payload — always return the empty string.
 */
export function operationDiscriminator(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  if (toolName === "security_scan") {
    const operation = args["operation"];
    return typeof operation === "string" && ["start", "status", "results", "record", "finding", "cancel", "context"].includes(operation)
      ? operation : "";
  }
  const raw = args["command"];
  if (typeof raw !== "string") return "";
  if (toolName === "file" && FILE_OPERATIONS.has(raw)) return raw;
  if (toolName === "officecli" && OFFICECLI_OPERATIONS.has(raw)) return raw;
  return "";
}

/**
 * Normalize an explicit error string into a stable, bounded fingerprint.
 * This is checkpoint-only and is not safe to log: it may still contain paths,
 * user content, or secrets after normalization. Strips the
 * server-side prefixes the tools node prepends (`Error executing <tool>: `,
 * `Error from relay: `, `Error dispatching <tool> to relay: `, `Error: `,
 * `Security: `), collapses whitespace, lowercases, and caps length. Returns
 * the empty string for empty / non-string input (treated as a generic
 * "unknown error" token so the streak still keys on something stable).
 *
 * The token is derived ONLY from the error string the execution seam already
 * produced — never from arbitrary successful tool content.
 */
export function normalizeToolError(errorContent: string | null | undefined): string {
  if (typeof errorContent !== "string" || errorContent.length === 0) return "";
  let s = errorContent;
  // Strip the leading server-side error prefixes the tools node prepends, so
  // "Error executing run_shell: permission denied" and
  // "Error from relay: permission denied" collapse to the same token.
  s = s.replace(
    /^Error (?:executing|dispatching)\s+[A-Za-z0-9_]+\s*to\s+relay\s*:\s*/i,
    "",
  );
  s = s.replace(/^Error (?:executing|dispatching)\s+[A-Za-z0-9_]+\s*:\s*/i, "");
  s = s.replace(/^Error from relay\s*:\s*/i, "");
  s = s.replace(/^Error\s*:\s*/i, "");
  s = s.replace(/^Security\s*:\s*/i, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  if (s.length === 0) return "";
  if (s.length > NORMALIZED_ERROR_MAX_CHARS) {
    s = s.slice(0, NORMALIZED_ERROR_MAX_CHARS);
  }
  return s;
}

/** Fingerprint the validated failure, not changing execution-snapshot fields.
 * Keep code/message/continuation and verified progress in the error itself.
 * Unknown contracts retain their original error text; successful content is
 * never inspected to infer a failure. */
function stableFailureContent(result: NoProgressToolResult): string | undefined {
  if (result.status !== "error" || !result.errorContent) return result.errorContent;
  try {
    const value: unknown = JSON.parse(result.errorContent);
    const local = localToolControlReceiptSchema.safeParse(value);
    if (local.success && local.data.toolName === result.toolName
      && local.data.requestedOperation === localToolRequestedOperation(result.toolName, result.args)) {
      return JSON.stringify(local.data.error);
    }
    if (result.toolName !== "security_scan") return result.errorContent;
    const parsed = result.args?.["operation"] === "context"
      ? securityResearchContextReceiptSchema.safeParse(value) : securityScanToolResultSchema.safeParse(value);
    if (parsed.success && !parsed.data.ok && parsed.data.operation === result.args?.["operation"]) {
      return JSON.stringify(parsed.data.error);
    }
  } catch { /* Preserve ordinary text and malformed receipts exactly. */ }
  return result.errorContent;
}

/**
 * Build the streak key for one tool result. Pure and checkpointable; the
 * normalized error component must never be logged.
 */
export function buildNoProgressKey(result: NoProgressToolResult): NoProgressKey {
  return {
    toolName: result.toolName,
    operationDiscriminator: operationDiscriminator(result.toolName, result.args),
    normalizedError: normalizeToolError(stableFailureContent(result)),
  };
}

/**
 * Deterministically serialize a {@link NoProgressKey} for use as a `Map` key.
 * Field order is fixed so the same key always serializes the same way
 * (deterministic ordering — no false positives across runs).
 */
export function serializeNoProgressKey(key: NoProgressKey): string {
  return JSON.stringify({
    t: key.toolName,
    o: key.operationDiscriminator,
    e: key.normalizedError,
  });
}

/**
 * Inverse of {@link serializeNoProgressKey}. Returns `null` for a malformed
 * string. Used internally to scan the streak map for entries matching a
 * `{toolName, operationDiscriminator}` pair on a success-driven reset.
 */
function deserializeNoProgressKey(serialized: string): NoProgressKey | null {
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    if (
      typeof parsed["t"] === "string" &&
      typeof parsed["o"] === "string" &&
      typeof parsed["e"] === "string"
    ) {
      return {
        toolName: parsed["t"],
        operationDiscriminator: parsed["o"],
        normalizedError: parsed["e"],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize just the `{toolName, operationDiscriminator}` pair (no error) —
 * used as the success-reset key. A success on a pair resets EVERY streak
 * for that pair regardless of the normalized error, so "the agent
 * successfully read a file" clears all read-failure streaks (R4: successful
 * repeated reads never block).
 */
function serializePair(toolName: string, operationDiscriminator: string): string {
  return JSON.stringify({ t: toolName, o: operationDiscriminator });
}

// ---------------------------------------------------------------------------
// Pure state transition
// ---------------------------------------------------------------------------

/**
 * Apply one tools-node batch of tool results to the streak state and return
 * the next state plus the action the seam should take.
 *
 * Semantics (R4):
 *   - A success for a key resets that key's streak (entry removed). Successful
 *     repeated reads therefore never block — they keep resetting the streak.
 *   - A different normalized error for the same tool/operation pair removes
 *     the old streak and starts the new failure at count 1.
 *   - A failure for a key advances that key's streak by ONE step for the
 *     whole batch (parallel identical failures count as one failure round, so
 *     deterministic ordering cannot manufacture a false positive and the
 *     corrective turn is always honored between the limit and the stop).
 *   - When a key's count reaches `limit` and no corrective turn was issued
 *     yet, the action is `inject_corrective` (the next pre_model turn gets a
 *     corrective instruction) and `correctiveTurnIssued` flips true.
 *   - When a key's count reaches `limit + 1` and a corrective turn was
 *     already issued, the action is `stop_no_progress` (the seam throws/maps
 *     the typed outcome; the tool is not executed a fifth time).
 *
 * `limit` defaults to {@link DEFAULT_REPEATED_FAILURE_LIMIT}.
 */
export function applyToolResultsToStreaks(
  prev: NoProgressStreaks,
  results: ReadonlyArray<NoProgressToolResult>,
  limit: number = DEFAULT_REPEATED_FAILURE_LIMIT,
): NoProgressTransition {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`no-progress: invalid repeatedFailureLimit ${limit}`);
  }

  // First pass: collect, per {tool, operation} pair, whether the batch had
  // any success, and per full triple, whether it had a failure. A success on
  // a pair resets EVERY streak for that pair (regardless of the normalized
  // error) — R4: successful repeated reads never block. A failure advances
  // the streak for its exact triple by one step (parallel identical
  // failures count as one failure round, so deterministic ordering cannot
  // manufacture a false positive).
  const pairSuccess = new Set<string>();
  const failuresByPair = new Map<string, Map<string, NoProgressKey>>();
  for (const r of results) {
    const key = buildNoProgressKey(r);
    const pair = serializePair(key.toolName, key.operationDiscriminator);
    if (r.status === "success") {
      pairSuccess.add(pair);
    } else {
      const serialized = serializeNoProgressKey(key);
      let failures = failuresByPair.get(pair);
      if (!failures) {
        failures = new Map();
        failuresByPair.set(pair, failures);
      }
      if (!failures.has(serialized)) failures.set(serialized, key);
    }
  }

  const next: Map<string, NoProgressStreakEntry> = new Map(prev);
  let action: NoProgressAction = { kind: "continue" };

  // Apply success resets first: remove every streak whose pair had a success.
  if (pairSuccess.size > 0) {
    for (const serialized of [...next.keys()]) {
      const parsed = deserializeNoProgressKey(serialized);
      if (parsed && pairSuccess.has(serializePair(parsed.toolName, parsed.operationDiscriminator))) {
        next.delete(serialized);
      }
    }
  }

  // Apply failure advances per pair. Multiple different errors for the same
  // pair in one parallel batch demonstrate variation rather than a repeated
  // normalized failure, so reset that pair and start no streak this round.
  // A pair that also had a success in this batch is skipped (success wins —
  // R4: a success on the pair already reset the streak; the failure does not
  // re-create it in the same batch).
  for (const [pair, failures] of failuresByPair) {
    if (pairSuccess.has(pair)) continue;

    const priorKeysForPair = [...next.keys()].filter((serialized) => {
      const parsed = deserializeNoProgressKey(serialized);
      return parsed !== null &&
        serializePair(parsed.toolName, parsed.operationDiscriminator) === pair;
    });
    const failureKeys = [...failures.keys()];
    const sameAsOnlyPrior =
      failureKeys.length === 1 &&
      priorKeysForPair.length === 1 &&
      priorKeysForPair[0] === failureKeys[0];

    if (!sameAsOnlyPrior) {
      for (const priorKey of priorKeysForPair) next.delete(priorKey);
    }
    if (failureKeys.length !== 1) continue;

    const key = failures.get(failureKeys[0]!)!;
    const serialized = serializeNoProgressKey(key);
    const existing = next.get(serialized);

    const prevCount = existing?.count ?? 0;
    const prevCorrective = existing?.correctiveTurnIssued ?? false;
    const nextCount = prevCount + 1;

    if (nextCount >= limit + 1 && prevCorrective) {
      // Corrected turn already happened and the same failure recurred → stop.
      // Do NOT execute the tool a fifth time. The streak entry stays so a
      // resumed run does not silently restart the streak.
      next.set(serialized, {
        count: nextCount,
        correctiveTurnIssued: true,
      });
      if (action.kind === "continue") {
        action = { kind: "stop_no_progress", key };
      }
      continue;
    }

    if (nextCount >= limit && !prevCorrective) {
      // First time at the limit → issue exactly one corrective model turn.
      next.set(serialized, {
        count: nextCount,
        correctiveTurnIssued: true,
      });
      if (action.kind === "continue") {
        action = { kind: "inject_corrective", key };
      }
      continue;
    }

    // Below the limit, or already past a corrective but not yet at stop.
    next.set(serialized, {
      count: nextCount,
      correctiveTurnIssued: prevCorrective,
    });
  }

  while (next.size > MAX_NO_PROGRESS_STREAKS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }

  return { streaks: next, action };
}

/**
 * Reset the streak for one key (e.g. on an explicit user Stop / resume that
 * should not inherit a stale streak). Returns a new state map.
 */
export function resetStreakForKey(
  prev: NoProgressStreaks,
  key: NoProgressKey,
): NoProgressStreaks {
  const next = new Map(prev);
  next.delete(serializeNoProgressKey(key));
  return next;
}

// ---------------------------------------------------------------------------
// Corrective instruction (injected by pre_model when action === inject_corrective)
// ---------------------------------------------------------------------------

/**
 * The clear internal instruction injected into the next model turn when a
 * failure streak hits the limit. It tells the model WHY the loop was broken
 * without echoing the raw error or args, and steers it toward a different
 * approach. Generic on purpose — the specific tool / error are NOT named to
 * avoid leaking any payload into the prompt; the model already has its own
 * tool result in history.
 */
export const NO_PROGRESS_CORRECTIVE_INSTRUCTION =
  "[nautilo/no-progress] A tool has returned the same error repeatedly. " +
  "Stop retrying the identical operation. Change your approach: try a different " +
  "tool, different arguments, fix the underlying cause, or report to the user that " +
  "the step cannot be completed. Do not repeat the exact same call again.";

// ---------------------------------------------------------------------------
// Typed no_progress outcome (mirrors GraphBudgetOutcome; R9)
// ---------------------------------------------------------------------------

/**
 * Typed internal outcome for a graph that was stopped by the no-progress
 * breaker. Distinct from the user-visible `FriendlyErrorCategory` (which
 * stays `unknown` on the WS event so the closed `JobStatusEvent.errorCategory`
 * union in `@nautilo/types` is untouched). The runtime job-loop catch site
 * detects this outcome and emits a structured `[nautilo/job]` log token so
 * `rg "no_progress" server.log` bridges to the specific failure.
 */
export interface NoProgressOutcome {
  readonly kind: "no_progress";
  readonly toolName: string;
  readonly operationDiscriminator: string;
  readonly normalizedError: string;
}

/**
 * Build a {@link NoProgressOutcome} from a streak key.
 */
export function toNoProgressOutcome(key: NoProgressKey): NoProgressOutcome {
  return {
    kind: "no_progress",
    toolName: key.toolName,
    operationDiscriminator: key.operationDiscriminator,
    normalizedError: key.normalizedError,
  };
}

/**
 * Format a {@link NoProgressOutcome} as a single grep-able log token. Error
 * content is deliberately excluded: normalization cannot make paths, user
 * content, or secrets safe to log. Tool and operation are strict safe tokens.
 */
export function formatNoProgressLogToken(outcome: NoProgressOutcome): string {
  return `no_progress tool=${safeLogToken(outcome.toolName)} ` +
    `operation=${safeLogToken(outcome.operationDiscriminator)}`;
}

function safeLogToken(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "<unknown>";
}

/**
 * A typed Error the tools→pre_model seam throws when the breaker fires
 * (action === stop_no_progress). The runtime catch site maps it to a
 * {@link NoProgressOutcome} + user-safe friendly sentence. Carries the
 * checkpoint key only. Its normalized error remains internal and must never
 * be logged; the Error message itself is the constant `no_progress`.
 */
export class NoProgressError extends Error {
  readonly code = "no_progress" as const;
  readonly outcome: NoProgressOutcome;
  constructor(key: NoProgressKey) {
    super("no_progress");
    this.name = "NoProgressError";
    this.outcome = toNoProgressOutcome(key);
  }
}

/**
 * Recognize a thrown {@link NoProgressError} defensively (instanceof + stable
 * `name` / `code` markers) so a rewrapped rethrow still classifies.
 */
export function isNoProgressError(error: unknown): boolean {
  if (error instanceof NoProgressError) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e["name"] === "string" && e["name"] === "NoProgressError") return true;
  if (typeof e["code"] === "string" && e["code"] === "no_progress") return true;
  return false;
}

/**
 * Map a thrown value to a typed {@link NoProgressOutcome}, or `null` if it is
 * not a no-progress failure. Mirrors `toGraphBudgetOutcome`'s contract so the
 * runtime catch site can branch cleanly.
 */
export function toNoProgressOutcomeFromError(error: unknown): NoProgressOutcome | null {
  if (error instanceof NoProgressError) return error.outcome;
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  const outcome = e["outcome"];
  if (
    outcome &&
    typeof outcome === "object" &&
    (outcome as Record<string, unknown>)["kind"] === "no_progress"
  ) {
    return outcome as NoProgressOutcome;
  }
  return null;
}
