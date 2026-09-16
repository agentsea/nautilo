import type { WorkstationExecutionClass } from "@nautilo/trust";
import { scanCommand } from "@nautilo/security";

/**
 * Classify only the explicit, typed workstation opt-in. A command string,
 * tool name substring, client auto-approve flag, or another tool carrying
 * the same argument can never select host execution.
 */
export function classifyWorkstationExecutionClass(
  toolName: string,
  args?: Readonly<Record<string, unknown>>,
): WorkstationExecutionClass {
  if (toolName === "run_shell" && args?.["git"] !== undefined) {
    return "typed_broker";
  }
  if (toolName === "run_shell" && args?.["execution"] === "workstation") {
    return "real_workstation";
  }
  return "profile_bound_sandbox";
}

/**
 * The only command-shape branch retained after exact local host consent.
 * Routine and medium-risk developer commands proceed to Electron; critical
 * destruction and high-risk elevation return to the normal approval path.
 */
export function requiresNormalWorkstationCommandApproval(input: {
  readonly toolName: string;
  readonly executionClass: WorkstationExecutionClass;
  readonly args?: unknown;
}): boolean {
  if (input.toolName !== "run_shell" || input.executionClass === "typed_broker") {
    return false;
  }
  const raw =
    typeof input.args === "object" && input.args !== null
      ? (input.args as Readonly<Record<string, unknown>>)["command"]
      : undefined;
  const command = typeof raw === "string" ? raw : "";
  const severity = scanCommand(command, "standard").severity;
  return severity === "critical" || severity === "high";
}
