import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  genieRecoveryResultV1Schema,
  type GenieRecoveryResultV1,
  type GenieRecoveryRequirement,
  type UiTargetId,
} from "@nautilo/types";

export const GENIE_RECOVERY_PRODUCERS = {
  google_workspace: { target: "connections.google", requirement: "login" },
  task: { target: "connections.codex", requirement: "login" },
  in_background: { target: "connections.codex", requirement: "login" },
  launch_customization: { target: "genie.customization", requirement: "human_enablement" },
} as const satisfies Record<string, { target: UiTargetId; requirement: GenieRecoveryRequirement }>;

export function genieRecoveryResult(
  domainTool: keyof typeof GENIE_RECOVERY_PRODUCERS,
  text: string,
  overrides: Partial<{ requirement: GenieRecoveryRequirement }> = {},
): string {
  const producer = GENIE_RECOVERY_PRODUCERS[domainTool];
  return JSON.stringify(genieRecoveryResultFor({ ...producer, ...overrides, domainTool }, text));
}

export function genieRecoveryResultFor(
  recovery: { target: UiTargetId; requirement: GenieRecoveryRequirement; domainTool: string },
  text: string,
): GenieRecoveryResultV1 {
  return genieRecoveryResultV1Schema.parse({
    version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
    text,
    recovery,
  });
}
