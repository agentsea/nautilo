import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { check } from "@nautilo/config-guard";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";

interface CheckConfigContext {
  causalHumanUserId?: string;
}

interface CheckConfigDeps {
  check?: typeof check;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
}

export function createCheckConfigTool(
  context?: CheckConfigContext,
  deps: CheckConfigDeps = {},
) {
  return new DynamicStructuredTool({
    name: "check_config",
    description:
      "Read-only: list configured API keys (masked), format status, and optional live provider verification. Use before suggesting .env changes.",
    schema: z.object({
      validate: z
        .boolean()
        .default(false)
        .describe("If true, ping providers (slow, uses network)"),
    }),
    func: async ({ validate }) => {
      if (validate) {
        await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
          context?.causalHumanUserId?.trim() ?? "",
          "provider_key_health_validation",
        );
      }
      const result = await (deps.check ?? check)({ validate });

      const lines = result.keys.map((k) => {
        const status =
          k.status === "verified"
            ? "verified"
            : k.status === "present"
              ? "present"
              : k.status === "invalid_format"
                ? `invalid_format${k.hint ? ` (${k.hint})` : ""}`
                : k.status === "invalid_key"
                  ? "invalid_key"
                  : k.status === "unreachable"
                    ? "unreachable"
                    : "missing";
        const req = k.required ? " (required)" : "";
        return `${k.name}${req}: ${status}${k.masked ? ` [${k.masked}]` : ""}`;
      });

      const s = result.summary;
      lines.push("");
      lines.push(
        `Summary: ${s.configured}/${s.total} configured, ${s.verified} verified, ${s.invalid} invalid`,
      );
      lines.push(
        `LLM=${s.hasLlm} embeddings=${s.hasEmbeddings} voice=${s.hasVoice} search=${s.hasSearch}`,
      );

      return lines.join("\n");
    },
  });
}
