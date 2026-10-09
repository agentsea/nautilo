import type { ToolCall } from "@langchain/core/messages/tool";
import { getCapabilityFundingSession } from "./capability-funding";
import { isPersonalTaskControlCall } from "./personal-task-controls";
import { TOOL_EXPOSURE_MANIFEST, activeComputerUseCoreToolNames } from "../tools/exposure/manifest";
import { getToolCatalog } from "@nautilo/catalog";

function hasPersonalCapabilityFunding(): boolean {
  const funding = getCapabilityFundingSession();
  return funding !== undefined && funding.parentFundingKind !== "server";
}

/** These execution families do not yet have personal funding admission. */
const DEFERRED_PERSONAL_TOOLS = new Set([
  "in_scope", "in_private_namespace", "ask_peer", "generate_repo_docs",
  "regenerate_soul", "security_scan", "find_voice", "audition_voices",
  "transcribe_audio", "generate_image", "generate_video", "generate_music",
  // New Browser Use runs spend the server's hosted-provider account until
  // that service receives its own personal funding adapter.
  "browse_web", "run_website_task",
]);

/** Ordinary tools retain their existing permission/content/device gates. */
export function isSupportedPersonalTool(name: string): boolean {
  if (DEFERRED_PERSONAL_TOOLS.has(name)) return false;
  const reviewed = [...TOOL_EXPOSURE_MANIFEST.coreToolNames,
    ...Object.values(TOOL_EXPOSURE_MANIFEST.families).flat(), ...activeComputerUseCoreToolNames()];
  // Connected-account tools retain their independently scoped account authority;
  // hosted execution still enforces its platform-spending guard at dispatch.
  return reviewed.includes(name) || getToolCatalog()?.get(name)?.connectedAppProviderId !== undefined;
}

export function personalToolReady(name: string): boolean {
  return hasPersonalCapabilityFunding() && isSupportedPersonalTool(name);
}

export function personalToolCallSupported(call: Pick<ToolCall, "name" | "args">, legacyTaskControls: boolean): boolean {
  return hasPersonalCapabilityFunding()
    ? personalToolReady(call.name)
    : legacyTaskControls && isPersonalTaskControlCall(call);
}

export function personalToolUnavailable(name: string): string | null {
  return hasPersonalCapabilityFunding() && !personalToolReady(name)
    ? "Personal funding is not available for this workflow yet."
    : null;
}
