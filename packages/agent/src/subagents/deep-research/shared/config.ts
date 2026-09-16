import { z } from "zod";
import {
  resolveDeepResearchModelPlan,
  validateDeepResearchModelPlan,
  type DeepResearchModelPlan,
} from "./model-plan";

const SearchAPI = z.enum(["anthropic", "openai", "tavily", "duckduckgo", "exa", "none"]);

const ConfigurationSchema = z.object({
  max_structured_output_retries: z.number().int().min(1).max(10).default(3),
  allow_clarification: z.boolean().default(false),
  max_concurrent_research_units: z.number().int().min(1).max(20).default(5),
  search_api: SearchAPI.default("tavily"),
  max_researcher_iterations: z.number().int().min(1).max(10).default(6),
  max_react_tool_calls: z.number().int().min(1).max(30).default(10),
  search_max_results: z.number().int().min(1).max(25).default(5),
  search_depth: z.enum(["basic", "advanced"]).default("basic"),
  max_tool_messages: z.number().int().min(1).max(500).default(64),
  prefer_native_search: z.boolean().default(true),

  supervisor_model: z.string().default("anthropic:claude-sonnet-4-5-20250929"),
  supervisor_model_max_tokens: z.number().int().default(10000),

  summarization_model: z.string().default("fireworks:accounts/fireworks/models/kimi-k2p6"),
  summarization_model_max_tokens: z.number().int().default(8192),
  max_content_length: z.number().int().min(1000).max(200000).default(50000),

  research_model: z.string().default("fireworks:accounts/fireworks/models/kimi-k2p6"),
  research_model_max_tokens: z.number().int().default(10000),

  compression_model: z.string().default("fireworks:accounts/fireworks/models/kimi-k2p6"),
  compression_model_max_tokens: z.number().int().default(4096),

  final_report_model: z.string().default("openai:gpt-5.5-2026-04-23"),
  final_report_model_max_tokens: z.number().int().default(10000),

  anthropic_long_context_beta: z.boolean().default(false),
  summarization_enabled: z.boolean().default(true),
  summarization_max_items: z.number().int().min(1).max(10).default(3),
  summarization_timeout_ms: z.number().int().min(1000).max(300000).default(60000),

  openai_api_key: z.string().optional().nullable().default(null),
  anthropic_api_key: z.string().optional().nullable().default(null),
  google_api_key: z.string().optional().nullable().default(null),
  fireworks_api_key: z.string().optional().nullable().default(null),
  openrouter_api_key: z.string().optional().nullable().default(null),
  xai_api_key: z.string().optional().nullable().default(null),
  together_api_key: z.string().optional().nullable().default(null),
  venice_api_key: z.string().optional().nullable().default(null),

  base_url_overrides: z
    .object({
      openai: z.string().url().optional().nullable().default(null),
      anthropic: z.string().url().optional().nullable().default(null),
      google: z.string().url().optional().nullable().default(null),
      fireworks: z.string().url().optional().nullable().default(null),
      openrouter: z.string().url().optional().nullable().default(null),
      xai: z.string().url().optional().nullable().default(null),
      together: z.string().url().optional().nullable().default(null),
      venice: z.string().url().optional().nullable().default(null),
    })
    .optional()
    .nullable()
    .default(null),

  mcp_config: z
    .object({
      url: z.string().url().optional().nullable().default(null),
      tools: z.array(z.string()).optional().nullable().default(null),
      auth_required: z.boolean().optional().nullable().default(false),
    })
    .optional()
    .nullable()
    .default(null),
  mcp_prompt: z.string().optional().nullable().default(null),
});

export type Configuration = z.infer<typeof ConfigurationSchema>;


function envGet(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  return environment[key];
}

export interface DeepResearchRuntimeConfigOptions {
  env?: NodeJS.ProcessEnv;
  modelPlan?: DeepResearchModelPlan;
}

function credentialEnvironment(
  environment: NodeJS.ProcessEnv,
  configuration: Configuration,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(configuration.openai_api_key ? { OPENAI_API_KEY: configuration.openai_api_key } : {}),
    ...(configuration.anthropic_api_key ? { ANTHROPIC_API_KEY: configuration.anthropic_api_key } : {}),
    ...(configuration.google_api_key ? { GOOGLE_API_KEY: configuration.google_api_key } : {}),
    ...(configuration.fireworks_api_key ? { FIREWORKS_API_KEY: configuration.fireworks_api_key } : {}),
    ...(configuration.openrouter_api_key ? { OPENROUTER_API_KEY: configuration.openrouter_api_key } : {}),
    ...(configuration.xai_api_key ? { XAI_API_KEY: configuration.xai_api_key } : {}),
    ...(configuration.together_api_key ? { TOGETHER_API_KEY: configuration.together_api_key } : {}),
    ...(configuration.venice_api_key ? { VENICE_API_KEY: configuration.venice_api_key } : {}),
  };
}

function explicitModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function fromRuntimeConfig(
  runtime?: Partial<Configuration>,
  options: DeepResearchRuntimeConfigOptions = {},
): Configuration {
  const environment = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const envOverrides: Partial<Record<keyof Configuration, unknown>> = {};
  const keys = Object.keys(ConfigurationSchema.shape) as (keyof Configuration)[];
  for (const key of keys) {
    const envKey = String(key).toUpperCase();
    const raw = envGet(environment, envKey);
    if (raw == null) continue;
    try {
      let parsed: unknown = raw;
      if (/^(true|false)$/i.test(raw)) {
        parsed = raw.toLowerCase() === "true";
      } else if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        const numeric = Number(raw);
        if (!Number.isNaN(numeric)) parsed = numeric;
      } else if (raw.startsWith("{") || raw.startsWith("[")) {
        parsed = JSON.parse(raw);
      }
      envOverrides[key] = parsed;
    } catch {
      // ignore invalid env values
    }
  }
  const envFirst = { ...runtime, ...envOverrides };
  const parsed = ConfigurationSchema.parse(envFirst);
  const availabilityEnv = credentialEnvironment(environment, parsed);
  const modelPlan = options.modelPlan
    ? validateDeepResearchModelPlan(options.modelPlan, availabilityEnv)
    : resolveDeepResearchModelPlan({
        env: availabilityEnv,
        configured: {
          supervisorModel: explicitModel(envFirst.supervisor_model),
          researchModel: explicitModel(envFirst.research_model),
          summarizationModel: explicitModel(envFirst.summarization_model),
          compressionModel: explicitModel(envFirst.compression_model),
          finalReportModel: explicitModel(envFirst.final_report_model),
        },
      });

  return {
    ...parsed,
    supervisor_model: modelPlan.supervisorModel,
    research_model: modelPlan.researchModel,
    summarization_model: modelPlan.summarizationModel,
    compression_model: modelPlan.compressionModel,
    final_report_model: modelPlan.finalReportModel,
  };
}
