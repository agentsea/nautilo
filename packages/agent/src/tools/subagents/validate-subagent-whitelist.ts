import { getToolCatalog } from "@nautilo/catalog";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { MAX_SUBAGENT_DEPTH } from "../../agent/state";

export type ValidateSubagentToolsResult =
  | { ok: true; whitelist: string[] }
  | { ok: false; message: string };

/**
 * A managed command may yield before it exits. `write_stdin` is the only
 * continuation surface for reading, stopping, or (after its own approval)
 * interacting with that exact owned execution, so an `exec_command` Task
 * grant is incomplete without it. Keep the closure narrow: read-only history
 * access alone does not grant command launch, and no unrelated tools are
 * promoted.
 */
export function normalizeTaskToolWhitelist(requestedTools: readonly string[]): string[] {
  const normalized = [...requestedTools];
  if (normalized.includes("exec_command") && !normalized.includes("write_stdin")) {
    normalized.push("write_stdin");
  }
  return normalized;
}

/**
 * M084 — strict whitelist validation before starting a scope subagent.
 */
export function validateSubagentToolWhitelist(opts: {
  requestedTools: string[];
  parentEnvelope: MemoryAccessEnvelope;
  actorRole: string;
  toolPolicy: Record<string, string> | undefined;
  relayCapabilities?: Readonly<Record<string, boolean>> | undefined;
  /**
   * M150 — when true, validate the whitelist by AUTHORIZATION only
   * (actor-tier + toolPolicy), skipping the live relay-presence check. A
   * relay-executor tool (e.g. `run_shell`) the actor is authorized for then
   * passes validation even when no relay is connected at this instant. Used by
   * the Task dispatch seam: relay *presence* is gated separately at run start
   * (`task-run-executor` threads live `relayCapabilities` into the run's
   * catalog), so a `whitelist: ["run_shell"]` task validates at dispatch and
   * either runs the tool (relay live) or degrades to cloud-only (relay absent)
   * — never erroring at dispatch purely because the device is asleep (D1/R2).
   */
  skipRelayLiveCheck?: boolean;
  subagentDepth: number;
  subagentMaxDepth: number;
}): ValidateSubagentToolsResult {
  const catalog = getToolCatalog();
  if (!catalog) {
    return { ok: false, message: "Tool catalog not initialized." };
  }

  const requestedTools = normalizeTaskToolWhitelist(opts.requestedTools);
  const unknown = requestedTools.filter((n) => !catalog.has(n));
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown tool(s): ${unknown.join(", ")}` };
  }

  const snapshot = catalog.getFiltered(
    opts.toolPolicy,
    opts.relayCapabilities ?? undefined,
    opts.skipRelayLiveCheck ? { skipRelayLiveCheck: true } : undefined,
  );
  const parentAllowed = new Set(snapshot.entries.map((e) => e.name));

  const forbidden = requestedTools.filter((n) => !parentAllowed.has(n));
  if (forbidden.length > 0) {
    return {
      ok: false,
      message: `Tool(s) unavailable in this context: ${forbidden.join(", ")}`,
    };
  }

  return { ok: true, whitelist: requestedTools };
}

export function clampSubagentBranchMax(requestedMaxDepth: number | undefined): number {
  const req = requestedMaxDepth ?? 3;
  return Math.min(req, MAX_SUBAGENT_DEPTH);
}
