import type { VerifiedOrdinaryOrigin } from "@nautilo/types";
import { isSupportedComputerUseToolName } from "./computer-use-admission";
import type { TaskReportBackContinuation } from "./task-report-back-continuation";
import { hasAvailableTaskReportBackContinuation } from "./task-report-back-continuation";

/**
 * D458 host-scope classification for Tool admission.
 *
 * Relay execution is host-scoped by default. The only exceptions are reviewed
 * Connection integrations whose authority belongs to the connection itself,
 * not to a paired computer. This fail-closed default means a newly registered
 * Relay Tool cannot accidentally inherit ambient same-Human desktop access.
 *
 * `file` and `apply_patch` are conditional because their trusted execution
 * routers can choose either server-owned Workspace state or a Current Folder
 * on a desktop. The eventual admission seam must resolve that trusted target
 * before deciding whether a paired host is required.
 */

export type HostScopeRequirement = "required" | "conditional" | "not_host_scoped";

const CONNECTION_RELAY_TOOLS = new Set(["google_workspace", "hue_lights"]);
const CONDITIONAL_HOST_TOOLS = new Set(["file", "apply_patch"]);

export function classifyHostScope(input: {
  readonly toolName: string;
  readonly executor: "cloud" | "relay";
  readonly hostedBy?: string | null | undefined;
}): HostScopeRequirement {
  if (input.hostedBy) return "required";
  if (CONDITIONAL_HOST_TOOLS.has(input.toolName)) return "conditional";
  // D516 — semantic computer tools are excluded from D458 host resolution.
  // Their exact host binding (relay, pairing generation, desktop session,
  // grant, provider) is established by the computer-use admission resolver and
  // re-fenced at dispatch and in Electron; the D458 resolver instead matches a
  // boolean wire capability (`canUseComputer`) that Electron never advertises,
  // so routing them through it denies every admitted call.
  if (isSupportedComputerUseToolName(input.toolName)) return "not_host_scoped";
  if (input.executor !== "relay") return "not_host_scoped";
  return CONNECTION_RELAY_TOOLS.has(input.toolName)
    ? "not_host_scoped"
    : "required";
}

export function isReviewedConnectionRelayTool(toolName: string): boolean {
  return CONNECTION_RELAY_TOOLS.has(toolName);
}

export type CategoricalHostAdmissionPrerequisite =
  | { readonly status: "allowed" }
  | { readonly status: "denied"; readonly reason: string };

/**
 * Decide only the categorical host-admission facts known before arguments or
 * live host selection. This deliberately does not choose or validate a
 * relay; post-model and dispatch retain those exact, per-call checks.
 */
export function checkCategoricalHostAdmissionPrerequisite(input: {
  readonly hostScope: HostScopeRequirement;
  readonly toolName: string;
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null | undefined;
  readonly taskReportBackContinuation?: TaskReportBackContinuation | null | undefined;
}): CategoricalHostAdmissionPrerequisite {
  if (input.hostScope !== "required") return { status: "allowed" };
  if (hasAvailableTaskReportBackContinuation(input.taskReportBackContinuation)) {
    if (input.toolName.startsWith("browser_") && !input.taskReportBackContinuation.browserSessionId) {
      return {
        status: "denied",
        reason: "the original embedded Browser session is no longer available",
      };
    }
    return { status: "allowed" };
  }
  if (!input.verifiedOrdinaryOrigin) {
    return {
      status: "denied",
      reason: "host-scoped tools require a verified authorized-computer origin",
    };
  }
  if (
    input.verifiedOrdinaryOrigin.kind === "paired_mobile" &&
    input.toolName.startsWith("browser_")
  ) {
    return {
      status: "denied",
      reason: "browser tools are not available from paired mobile in this release",
    };
  }
  return { status: "allowed" };
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve the two mixed server/desktop tools from the model-authored selector
 * plus trusted turn context. Invalid or newly-added conditional shapes fail
 * closed as host-scoped; they may still be rejected later by their own schema.
 */
export function resolveToolCallHostScope(input: {
  readonly classified: HostScopeRequirement;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly currentFolder: string;
}): Exclude<HostScopeRequirement, "conditional"> {
  if (input.classified !== "conditional") return input.classified;
  if (input.toolName === "file") {
    const zone = stringField(input.args, "zone");
    if (zone === "current" || zone === "absolute") return "required";
    if (zone === "workspace" || zone === "home" || zone === "scratch") {
      return "not_host_scoped";
    }
    if (zone !== undefined) return "required";
    const revisionId = stringField(input.args, "revisionId");
    if (revisionId?.startsWith("local:")) return "required";
    const command = stringField(input.args, "command");
    const path = stringField(input.args, "path");
    if (command === "list_revisions" && path?.startsWith("/")) return "required";
    return "not_host_scoped";
  }
  if (input.toolName === "apply_patch") {
    const target = stringField(input.args, "target");
    if (target === "current") return "required";
    if (target === "workspace") return "not_host_scoped";
    if (target !== undefined) return "required";
    return input.currentFolder.trim().length > 0 ? "required" : "not_host_scoped";
  }
  return "required";
}
