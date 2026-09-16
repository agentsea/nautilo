import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { transaction } from "@nautilo/config-guard";

export function createUpdateConfigTool() {
  return new DynamicStructuredTool({
    name: "update_config",
    description:
      "Safely update API keys in the local .env file: snapshot, validate, atomic write, optional provider health check, auto-rollback on failure. Use this instead of write_file for .env.",
    schema: z.object({
      operations: z
        .array(
          z.object({
            type: z.enum(["set", "remove"]),
            key: z.string().describe("Environment variable name (e.g. TAVILY_API_KEY)"),
            value: z
              .string()
              .optional()
              .describe("Value for set operations (omit for remove)"),
          }),
        )
        .describe("Changes applied in one transaction"),
      reason: z.string().describe("Why this change is being made (audit log)"),
      healthCheck: z
        .enum(["keys", "server", "none"])
        .default("keys")
        .describe(
          "After write: keys = verify affected providers; server = GET /health; none = skip",
        ),
      overwrite: z
        .boolean()
        .default(false)
        .describe("If false, skip keys that already have values in the environment"),
    }),
    func: async ({ operations, reason, healthCheck, overwrite }) => {
      const result = await transaction({
        operations,
        reason,
        healthCheck,
        overwrite,
        actor: "agent",
      });

      if (result.success) {
        return `OK: ${result.applied} key(s) applied, ${result.skipped} skipped. snapshot=${result.snapshot ?? "none"}`;
      }
      if (result.rolledBack) {
        return `Rolled back: ${result.error ?? "unknown error"}. snapshot=${result.snapshot ?? "none"}`;
      }
      return `Rejected: ${result.error ?? "unknown"}`;
    },
  });
}
