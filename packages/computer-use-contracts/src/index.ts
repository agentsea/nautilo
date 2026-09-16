import { z } from "zod";

export * from "./references.js";
export * from "./schema-digest.js";
export * from "./canonical-json.js";

export const COMPUTER_USE_RECOVERY_ACTIONS = [
  "retry_same_request",
  "observe_again",
  "request_access",
  "focus_target",
  "do_not_replay",
  "open_computer_use_settings",
  "reconnect_desktop",
] as const;

export const computerOperationOutcomeSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["observe", "resolve_target", "pre_effect_dispatch", "post_effect_verification"]),
  retrySafety: z.enum(["safe", "observe_before_retry", "never"]),
  stateChangeCertainty: z.enum(["not_applicable", "not_changed", "changed", "unknown"]),
  providerCondition: z.enum(["ready", "malformed_response", "permission_required", "cancelled", "unknown"]).optional(),
  targetCondition: z.enum(["current", "unavailable", "stale", "unknown"]).optional(),
  externalInterference: z.enum(["user_input"]).optional(),
  recovery: z.array(z.enum(COMPUTER_USE_RECOVERY_ACTIONS)),
  requiredCapability: z.enum(["provider_narrowing_or_cursor"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.stateChangeCertainty === "unknown" && !value.recovery.includes("do_not_replay")) {
    context.addIssue({ code: "custom", message: "unknown state change must prohibit replay" });
  }
  if (value.retrySafety === "observe_before_retry" && !value.recovery.includes("observe_again")) {
    context.addIssue({ code: "custom", message: "observe-before-retry must offer observation recovery" });
  }
  if (value.retrySafety === "safe" && !value.recovery.includes("retry_same_request")) {
    context.addIssue({ code: "custom", message: "safe retry must explicitly offer the same request" });
  }
  if (value.requiredCapability !== undefined && value.recovery.length > 0) {
    context.addIssue({ code: "custom", message: "a missing capability cannot advertise a recovery this tool surface lacks" });
  }
  if (value.externalInterference !== undefined
    && (!value.recovery.includes("observe_again") || value.recovery.includes("retry_same_request"))) {
    context.addIssue({ code: "custom", message: "external interference requires fresh observation and cannot retry the same request" });
  }
});

export type ComputerOperationOutcome = z.infer<typeof computerOperationOutcomeSchema>;

export * from "./browser.ts";
