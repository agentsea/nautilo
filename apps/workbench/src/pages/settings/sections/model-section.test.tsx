import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

mock.module("../../../hooks/use-profile", () => ({
  useProfile: () => ({
    response: { viewerRole: "owner", agent },
  }),
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => () => true,
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    getModels: async () => [
      {
        id: "openrouter:openai/gpt-5.4",
        displayName: "GPT-5.4 via OpenRouter",
        provider: "openrouter",
        priority: 1,
        costCoefficient: 1,
        availability: "selectable",
      },
    ],
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

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  keySummaryCalls = 0;
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
    await waitFor(() => expect(view.queryByText("Loading…")).toBeNull());
    expect(keySummaryCalls).toBe(0);
    expect(view.queryByText(/API key for this choice/)).toBeNull();
    expect(view.queryByText(/API keys section/)).toBeNull();
  });
});
