import { parseBlockOps, type BlockOp } from "./block-op-types";

/**
 * D087 Phase 1 — shared `StagedEnvelope` shape + parser.
 *
 * The agent-side staging handlers (write / insert / str_replace /
 * delete / move / copy) return a JSON-encoded envelope that names a
 * staged patch and carries everything the workbench needs to render
 * it. The shape is produced in `packages/agent/src/tools/file/commands/_shared.ts`
 * (`StagedResultEnvelope`); this module is the workbench-side mirror
 * both `file-renderer.tsx` (which renders the DiffView) and
 * `turn-action-bar.tsx` (which counts pending stages) parse against.
 *
 * D087 PR-013 MINOR #3 — consolidated from three copies. Previously
 * `file-renderer.tsx` and `turn-action-bar.tsx` each had their own
 * `tryParseStagedEnvelope` implementation with slightly different
 * validation rules, and `file-renderer-parsing.test.ts` intentionally
 * re-implemented the guard inline to verify the shape. Two production
 * copies is a maintenance hazard — a future tweak to the agent
 * envelope could land correctly in one renderer and silently miss the
 * other. The test still re-implements inline by design (guards the
 * parser itself); production callers share this module.
 */

export interface StagedEnvelope {
  staged: true;
  patchId: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  command: string;
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
  binary?: true;
  bytes?: number;
  warnings?: string[];
  /**
   * Optional structural discriminator — present only for delete /
   * move / copy staging envelopes. Shape matches the agent-side
   * `StructuralOp` from `staged-patches.ts` loosely (open to unknown
   * fields so future extensions don't require a workbench update).
   */
  structural?: {
    kind: "delete" | "move" | "copy";
    [k: string]: unknown;
  };
  /** Only present on move / copy envelopes — the destination path. */
  destinationPath?: string;
  /**
   * D121-P6/P7 — block-edit metadata. When non-empty, `file-renderer` routes
   * to `<BlockDiffView>` instead of line-level `<DiffView>`.
   */
  blockOps?: BlockOp[];
  /** M088C — external workspace artifact id (tool + cited paths). */
  artifactId?: string;
  /**
   * D121-P6 — Postgres `artifacts.id` when known (updates). New artifact
   * creates omit this until the row exists after Accept.
   */
  artifactInternalId?: string;
}

/**
 * Parse a tool-result string into a full `StagedEnvelope`. Returns
 * `null` when the input is:
 *   - undefined / null / empty
 *   - not JSON (doesn't start with `{`)
 *   - valid JSON but `staged !== true`
 *   - valid JSON but missing any of the minimum-viable fields
 *     (patchId, path, unifiedDiff, stats with both numeric halves)
 *
 * Callers that only need a narrow subset (e.g. turn-action-bar just
 * wants patchId/path/command/structural for counting) still get the
 * full shape back — narrowing at the use site is cheap and keeps the
 * parser single-purpose.
 */
export function parseStagedEnvelope(
  text: string | undefined | null,
): StagedEnvelope | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["staged"] !== true) return null;

  const patchId = typeof obj["patchId"] === "string" ? obj["patchId"] : "";
  const filePath = typeof obj["path"] === "string" ? obj["path"] : "";
  const command = typeof obj["command"] === "string" ? obj["command"] : "";
  const zone = obj["zone"];
  const summary = typeof obj["summary"] === "string" ? obj["summary"] : "";
  const unifiedDiff =
    typeof obj["unifiedDiff"] === "string" ? obj["unifiedDiff"] : "";
  const binary = obj["binary"] === true;
  const stats = obj["stats"];

  if (!patchId || !filePath || !command || (!binary && !unifiedDiff)) return null;
  if (zone !== "workspace" && zone !== "current" && zone !== "absolute") {
    return null;
  }
  if (
    !stats ||
    typeof stats !== "object" ||
    typeof (stats as Record<string, unknown>)["additions"] !== "number" ||
    typeof (stats as Record<string, unknown>)["deletions"] !== "number"
  ) {
    return null;
  }

  const envelope: StagedEnvelope = {
    staged: true,
    patchId,
    path: filePath,
    zone,
    command,
    stats: stats as StagedEnvelope["stats"],
    summary,
    unifiedDiff,
  };
  if (binary) envelope.binary = true;
  if (typeof obj["bytes"] === "number") envelope.bytes = obj["bytes"];
  if (Array.isArray(obj["warnings"])) {
    envelope.warnings = obj["warnings"].filter(
      (warning): warning is string => typeof warning === "string",
    );
  }
  const structural = obj["structural"];
  if (
    structural &&
    typeof structural === "object" &&
    (structural as Record<string, unknown>)["kind"] === "delete"
  ) {
    envelope.structural = structural as StagedEnvelope["structural"];
  } else if (
    structural &&
    typeof structural === "object" &&
    ((structural as Record<string, unknown>)["kind"] === "move" ||
      (structural as Record<string, unknown>)["kind"] === "copy")
  ) {
    envelope.structural = structural as StagedEnvelope["structural"];
  }
  const destinationPath = obj["destinationPath"];
  if (typeof destinationPath === "string") {
    envelope.destinationPath = destinationPath;
  }
  const blockOps = parseBlockOps(obj["blockOps"]);
  if (blockOps) envelope.blockOps = blockOps;
  if (typeof obj["artifactId"] === "string" && obj["artifactId"].length > 0) {
    envelope.artifactId = obj["artifactId"];
  }
  if (typeof obj["artifactInternalId"] === "string" && obj["artifactInternalId"].length > 0) {
    envelope.artifactInternalId = obj["artifactInternalId"];
  }
  return envelope;
}

export interface AppliedEnvelope {
  applied: true;
  revisionId?: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  command: string;
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
  binary?: true;
  bytes?: number;
  warnings?: string[];
  structural?: {
    kind: "delete" | "move" | "copy";
    [k: string]: unknown;
  };
  destinationPath?: string;
  blockOps?: BlockOp[];
  artifactId?: string;
  artifactInternalId?: string;
  diffPreviewOmitted?: true;
}

export function parseAppliedEnvelope(
  text: string | undefined | null,
): AppliedEnvelope | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["applied"] !== true || obj["staged"] === true) return null;

  const filePath = typeof obj["path"] === "string" ? obj["path"] : "";
  const command = typeof obj["command"] === "string" ? obj["command"] : "";
  const zone = obj["zone"];
  const summary = typeof obj["summary"] === "string" ? obj["summary"] : "";
  const unifiedDiff =
    typeof obj["unifiedDiff"] === "string" ? obj["unifiedDiff"] : "";
  const binary = obj["binary"] === true;
  const stats = obj["stats"];

  if (!filePath || !command || (!binary && !unifiedDiff)) return null;
  if (zone !== "workspace" && zone !== "current" && zone !== "absolute") {
    return null;
  }
  if (
    !stats ||
    typeof stats !== "object" ||
    typeof (stats as Record<string, unknown>)["additions"] !== "number" ||
    typeof (stats as Record<string, unknown>)["deletions"] !== "number"
  ) {
    return null;
  }

  const envelope: AppliedEnvelope = {
    applied: true,
    path: filePath,
    zone,
    command,
    stats: stats as AppliedEnvelope["stats"],
    summary,
    unifiedDiff,
  };
  if (typeof obj["revisionId"] === "string" && obj["revisionId"].length > 0) {
    envelope.revisionId = obj["revisionId"];
  }
  if (binary) envelope.binary = true;
  if (typeof obj["bytes"] === "number") envelope.bytes = obj["bytes"];
  if (Array.isArray(obj["warnings"])) {
    envelope.warnings = obj["warnings"].filter(
      (warning): warning is string => typeof warning === "string",
    );
  }
  const structural = obj["structural"];
  if (
    structural &&
    typeof structural === "object" &&
    (structural as Record<string, unknown>)["kind"] === "delete"
  ) {
    envelope.structural = structural as AppliedEnvelope["structural"];
  } else if (
    structural &&
    typeof structural === "object" &&
    ((structural as Record<string, unknown>)["kind"] === "move" ||
      (structural as Record<string, unknown>)["kind"] === "copy")
  ) {
    envelope.structural = structural as AppliedEnvelope["structural"];
  }
  const destinationPath = obj["destinationPath"];
  if (typeof destinationPath === "string") {
    envelope.destinationPath = destinationPath;
  }
  const blockOps = parseBlockOps(obj["blockOps"]);
  if (blockOps) envelope.blockOps = blockOps;
  if (typeof obj["artifactId"] === "string" && obj["artifactId"].length > 0) {
    envelope.artifactId = obj["artifactId"];
  }
  if (typeof obj["artifactInternalId"] === "string" && obj["artifactInternalId"].length > 0) {
    envelope.artifactInternalId = obj["artifactInternalId"];
  }
  if (obj["diffPreviewOmitted"] === true) envelope.diffPreviewOmitted = true;
  return envelope;
}

