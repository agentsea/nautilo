import { genieRecoveryResult } from "../genie-recovery";

const CODEX_HARNESS_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  CODEX_NOT_ENABLED:
    "Codex is not enabled for this account. Open Codex setup, enable it, then try again.",
  CODEX_PROFILE_UNAVAILABLE:
    "Codex needs a signed-in active account. Open Codex setup, sign in, then try again.",
  CODEX_MODEL_UNAVAILABLE:
    "That Codex model is not available for the selected account. List Codex harness models again and choose an exact returned id.",
  CODEX_ROOM_UNAVAILABLE:
    "Codex needs an active Room with this Genie. Return to the conversation and try again.",
  CODEX_HOST_UNAVAILABLE:
    "Codex cannot reach the selected Desktop. Open Codex setup, connect Desktop, then try again.",
  CODEX_WORKSPACE_UNAVAILABLE:
    "Codex could not resolve its starting directory on the selected Desktop. If the task named a path, verify that local directory and retry; otherwise check that the Desktop's Genie Workspace is available. Current Folder selection is optional.",
  CODEX_SOURCE_FORBIDDEN:
    "Codex can be used only by the user's own Genie in the active Room.",
  CODEX_TASK_FORBIDDEN:
    "This Codex task cannot be controlled from the current Genie and Room.",
  CODEX_TURN_UNAVAILABLE:
    "The Codex task has no active turn to steer. Read the task state or create a follow-up after it finishes.",
  CODEX_STEER_UNAVAILABLE:
    "This Codex runtime does not support steering the active turn. Let it finish or stop it.",
  CLAUDE_TASK_FORBIDDEN:
    "This Claude task cannot be controlled from the current Genie and Room.",
  CLAUDE_TURN_UNAVAILABLE:
    "The Claude task has no active turn to steer. Read the task state or create a follow-up after it finishes.",
  CLAUDE_STEER_UNAVAILABLE:
    "Claude could not deliver that direction to the active turn. Let it finish or stop it.",
};

/** Turn the server's bounded Codex failure code into safe, actionable guidance. */
export function codexHarnessFailureGuidance(error: unknown, domainTool: "task" | "in_background" = "task"): string | null {
  const code = error instanceof Error ? error.message : String(error);
  const text = CODEX_HARNESS_FAILURE_GUIDANCE[code];
  if (!text) return null;
  if (code === "CODEX_NOT_ENABLED") return genieRecoveryResult(domainTool, text, { requirement: "human_enablement" });
  if (code === "CODEX_HOST_UNAVAILABLE") return genieRecoveryResult(domainTool, text, { requirement: "desktop" });
  if (code === "CODEX_PROFILE_UNAVAILABLE") return genieRecoveryResult(domainTool, text, { requirement: "login" });
  return text;
}
