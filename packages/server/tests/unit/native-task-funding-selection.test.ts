import { beforeEach, describe, expect, test } from "bun:test";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { admittedDeepResearchTaskMetadata, deepResearchTaskMetadata } from "@nautilo/agent";

import {
  assertNativeTaskRetainedModelSelection,
  nativeTaskSelectionPurpose,
  shouldPrepareNativeTaskCallerFunding,
  validateNativeTaskExactModelSelection,
} from "../../src/lib/native-task-funding";

const NULL_TOOLS_MODEL = "google:gemini-2.5-pro";
const GOOGLE_ENV: NodeJS.ProcessEnv = { GOOGLE_API_KEY: "synthetic-test-key" };
const SERVER_BINDING = { kind: "server" as const, providerRoute: "openrouter" };
const PERSONAL_BINDING = {
  kind: "personal" as const,
  providerRoute: "openrouter",
  credentialId: "55555555-5555-4555-8555-555555555555",
  credentialRevision: 2,
};
const MODEL_PLAN = {
  version: 1 as const,
  supervisorModel: "openrouter:supervisor",
  researchModel: "openrouter:researcher",
  summarizationModel: "openrouter:summarizer",
  compressionModel: "openrouter:compressor",
  finalReportModel: "openrouter:reporter",
};
const SERVER_RESEARCH_METADATA = admittedDeepResearchTaskMetadata({
  reportLanguage: "English",
  invokingModelId: "openrouter:moonshotai/kimi-k3",
  modelPlan: MODEL_PLAN,
  preferenceRevisions: {
    supervisor: 1,
    research: 1,
    summarization: 1,
    compression: 1,
    finalReport: 1,
  },
  modelFunding: {
    supervisor: SERVER_BINDING,
    research: SERVER_BINDING,
    summarization: SERVER_BINDING,
    compression: SERVER_BINDING,
    finalReport: SERVER_BINDING,
  },
  tavilyFunding: { kind: "server", providerRoute: "tavily" },
});
const PERSONAL_RESEARCH_METADATA = admittedDeepResearchTaskMetadata({
  reportLanguage: "English",
  invokingModelId: "openrouter:moonshotai/kimi-k3",
  modelPlan: MODEL_PLAN,
  preferenceRevisions: {
    supervisor: 1,
    research: 1,
    summarization: 1,
    compression: 1,
    finalReport: 1,
  },
  modelFunding: {
    supervisor: PERSONAL_BINDING,
    research: SERVER_BINDING,
    summarization: SERVER_BINDING,
    compression: SERVER_BINDING,
    finalReport: SERVER_BINDING,
  },
  tavilyFunding: { kind: "server", providerRoute: "tavily" },
});

beforeEach(() => {
  resetModelCapabilitiesCacheForTests();
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
});

describe("native caller-funded Task model selection", () => {
  test("keeps admitted server-funded v2 research on caller funding without personal-key access", () => {
    expect(shouldPrepareNativeTaskCallerFunding(SERVER_RESEARCH_METADATA, {
      allowPersonalProviderKeys: false,
      capabilities: ["use_server_provider_credentials"],
    })).toBeTrue();
    expect(shouldPrepareNativeTaskCallerFunding(SERVER_RESEARCH_METADATA, {
      allowPersonalProviderKeys: true,
      capabilities: ["use_server_provider_credentials"],
    })).toBeTrue();

    expect(shouldPrepareNativeTaskCallerFunding(undefined, {
      allowPersonalProviderKeys: false,
      capabilities: ["use_server_provider_credentials"],
    })).toBeFalse();
    expect(shouldPrepareNativeTaskCallerFunding(SERVER_RESEARCH_METADATA, {
      allowPersonalProviderKeys: false,
      capabilities: [],
    })).toBeTrue();
    expect(shouldPrepareNativeTaskCallerFunding(PERSONAL_RESEARCH_METADATA, {
      allowPersonalProviderKeys: false,
      capabilities: ["use_server_provider_credentials"],
    })).toBeTrue();
    expect(shouldPrepareNativeTaskCallerFunding(deepResearchTaskMetadata({
      reportLanguage: "English",
      invokingModelId: null,
      modelPlan: MODEL_PLAN,
    }), {
      allowPersonalProviderKeys: false,
      capabilities: ["use_server_provider_credentials"],
    })).toBeFalse();
  });

  test("derives the shared canonical tool need from auto, none, and whitelist modes", () => {
    expect(nativeTaskSelectionPurpose({ toolsMode: "auto", toolsWhitelist: [] }))
      .toBe("task-tools");
    expect(nativeTaskSelectionPurpose({ toolsMode: undefined, toolsWhitelist: undefined }))
      .toBe("task-tools");
    expect(nativeTaskSelectionPurpose({ toolsMode: "none", toolsWhitelist: [] }))
      .toBe("chat");
    expect(nativeTaskSelectionPurpose({ toolsMode: "whitelist", toolsWhitelist: [] }))
      .toBe("chat");
    expect(nativeTaskSelectionPurpose({ toolsMode: "whitelist", toolsWhitelist: ["file"] }))
      .toBe("task-tools");
  });

  test("passes canonical tool intent through the shared exact-model validator", () => {
    const selection = {
      requestedModelId: NULL_TOOLS_MODEL,
    } as const;

    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "none",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toBeNull();
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "whitelist",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toBeNull();
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "auto",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toMatchObject({ code: "capability_mismatch" });
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "whitelist",
      toolsWhitelist: ["file"],
    }, GOOGLE_ENV)).toMatchObject({ code: "capability_mismatch" });
  });

  test("retained and resumed model pins are checked against the same tool need", () => {
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "none",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).not.toThrow();
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "whitelist",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).not.toThrow();
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "auto",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toThrow("unsupported_provider");
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "whitelist",
      toolsWhitelist: ["file"],
    }, GOOGLE_ENV)).toThrow("unsupported_provider");
  });
});
