import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import type { AgentProfileFull } from "@nautilo/types";

const agent: AgentProfileFull = {
  name: "Terra",
  language: "en",
  voices: {},
  avatar: { kind: "preset", id: "shell" },
  avatarUrl: "/test-agent-avatar.png",
  defaultModel: null,
  personality: { prompt: null, tone: null, motherAnswer: null },
  privacySpectrum: null,
  workLifeMode: null,
  soulFile: null,
  onboardingCompleted: true,
  welcomeMessageSent: true,
  agentIdentity: "agent-terra",
  publicProfile: false,
  fallback: { enabled: false, chain: [] },
};
let keySummaryCalls = 0;
let callerModels: Array<{
  id: string;
  displayName: string;
  provider: string;
  priority: number;
  costCoefficient: number;
  availability: "selectable";
}> = [];
let capabilities = new Set<string>();

mock.module("../../../hooks/use-profile", () => ({
  useProfile: () => ({
    response: { viewerRole: "owner", agent },
  }),
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.has(capability),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    getCallerModels: async () => callerModels,
    resolveRetainedModels: async () => [],
    getKeySummary: async () => {
      keySummaryCalls += 1;
      return { keys: [] };
    },
    updateProfile: async () => agent,
    admin: {
      serverModels: {
        get: async () => ({
          defaultChatModel: "openrouter:openai/gpt-5.4",
          conductorModel: "",
          stenographerModel: "",
          reflectionModel: "",
          fallbackChain: [],
          reasoningOutput: {},
        }),
        set: async () => ({
          defaultChatModel: "openrouter:openai/gpt-5.4",
          conductorModel: "",
          stenographerModel: "",
          reflectionModel: "",
          fallbackChain: [],
          reasoningOutput: {},
        }),
      },
    },
  },
}));

const { ModelSection } = await import("./model-section");

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  keySummaryCalls = 0;
  callerModels = [{
    id: "openrouter:openai/gpt-5.4",
    displayName: "GPT-5.4 via OpenRouter",
    provider: "openrouter",
    priority: 1,
    costCoefficient: 1,
    availability: "selectable",
  }];
  capabilities = new Set([
    "read_server_settings",
    "manage_connection_providers",
  ]);
});

describe("ModelSection Agent scope", () => {
  test("names the Agent whose default model is being configured", async () => {
    const view = render(<MemoryRouter><ModelSection /></MemoryRouter>);

    await waitFor(() => {
      expect(
        view.getByRole("heading", { name: "Default model for Terra (per-Agent)" }),
      ).toBeTruthy();
    });
    expect(
      view.getByText(
        "Only Terra's model preference. Used by Terra in every Room unless that Room has its own override.",
      ),
    ).toBeTruthy();
    expect(view.getByText("Current default for Terra")).toBeTruthy();
    expect(
      view.getByText("Default model for Terra", { selector: "label" }),
    ).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: "Manage server-wide model policy in Server Admin." })
        .getAttribute("href"),
    ).toBe("/admin#models");
    expect(view.queryByText("Stream reasoning")).toBeNull();
  });

  test("does not inspect or hint at provider keys for a managed tenant", async () => {
    const view = render(<MemoryRouter><ModelSection showProviderKeyStatus={false} /></MemoryRouter>);
    await act(flush);
    expect(view.queryByText("Loading…")).toBeNull();
    expect(keySummaryCalls).toBe(0);
    expect(view.queryByText(/API key for this choice/)).toBeNull();
    expect(view.queryByText(/API keys section/)).toBeNull();
  });

  test("sends a personal-key member with no runnable model to their own key settings", async () => {
    callerModels = [];
    capabilities = new Set(["use_personal_provider_credentials"]);
    const view = render(<MemoryRouter><ModelSection /></MemoryRouter>);

    await act(flush);
    expect(view.queryByText("Loading…")).toBeNull();
    const link = view.getByRole("link", { name: "personal provider key" });
    expect(link.getAttribute("href")).toBe("/settings#personal-provider-keys");
    expect(view.getByText(/No model is runnable for your account/)).toBeTruthy();
    expect(view.queryByText(/server owner must add/i)).toBeNull();
    expect(view.queryByText(/Provider key status is unavailable/i)).toBeNull();
    expect(keySummaryCalls).toBe(0);
  });
});
