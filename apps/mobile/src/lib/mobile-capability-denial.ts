import {
  AgentInvocationRequiredError,
  ArtifactWriteRequiredError,
} from "@nautilo/api-client/browser";

export const INVOKE_AGENTS_REQUIRED_COPY =
  "You don’t have permission to ask Genie or other agents to respond.";
export const WRITE_ARTIFACTS_REQUIRED_COPY =
  "You don’t have permission to change files on this server.";

export type MobileCapabilityDenial = Readonly<{
  capability: "invoke_agents" | "write_artifacts";
  message: string;
}>;

export type MobileCapabilityScope = Readonly<{
  serverId: string;
  userId: string;
}>;

function stableErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof error.code === "string") return error.code;
    if ("message" in error && typeof error.message === "string") return error.message;
  }
  return String(error);
}

export function classifyMobileCapabilityDenial(error: unknown): MobileCapabilityDenial | null {
  const text = stableErrorText(error);
  if (
    error instanceof AgentInvocationRequiredError ||
    text.includes("invoke_agents_required")
  ) {
    return { capability: "invoke_agents", message: INVOKE_AGENTS_REQUIRED_COPY };
  }
  if (
    error instanceof ArtifactWriteRequiredError ||
    text.includes("write_artifacts_required")
  ) {
    return { capability: "write_artifacts", message: WRITE_ARTIFACTS_REQUIRED_COPY };
  }
  return null;
}

function sameScope(
  left: MobileCapabilityScope | null,
  right: MobileCapabilityScope | null,
): boolean {
  return left !== null && right !== null &&
    left.serverId === right.serverId && left.userId === right.userId;
}

/**
 * Refreshes advisory viewer state after one stable denial. There is
 * intentionally no retry callback: the denied action remains denied.
 */
export async function recoverMobileCapabilityDenial(input: Readonly<{
  error: unknown;
  actionScope: MobileCapabilityScope | null;
  getCurrentScope: () => MobileCapabilityScope | null;
  refreshViewer: () => Promise<unknown>;
}>): Promise<MobileCapabilityDenial | null> {
  const denial = classifyMobileCapabilityDenial(input.error);
  if (!denial) return null;
  return refreshMobileCapabilityDenial({ ...input, denial });
}

export async function refreshMobileCapabilityDenial(input: Readonly<{
  denial: MobileCapabilityDenial;
  actionScope: MobileCapabilityScope | null;
  getCurrentScope: () => MobileCapabilityScope | null;
  refreshViewer: () => Promise<unknown>;
}>): Promise<MobileCapabilityDenial | null> {
  if (!sameScope(input.actionScope, input.getCurrentScope())) return null;
  await input.refreshViewer();
  return sameScope(input.actionScope, input.getCurrentScope()) ? input.denial : null;
}
