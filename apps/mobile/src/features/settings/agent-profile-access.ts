import type { AgentProfileFull, AgentProfileResponse } from "@nautilo/types";

const AGENT_PROFILE_REQUIRED = "agent_profile_required";

export function requireAgentProfile(response: AgentProfileResponse): AgentProfileFull {
  if (response.viewerRole === "owner") return response.agent;
  throw Object.assign(
    new Error("This signed-in account does not have an Agent profile on this server."),
    { status: 403, code: AGENT_PROFILE_REQUIRED },
  );
}

export function isAgentProfileRequiredError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === AGENT_PROFILE_REQUIRED;
}
