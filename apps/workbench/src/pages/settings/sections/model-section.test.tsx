import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import type { AgentProfileFull } from "@nautilo/types";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";

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
let callerModels: AssistantModelSummary[] = [];
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
  agent.defaultModel = null;
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
  test("keeps MindSwapper selectable without displaying its internal priority and cost defaults", async () => {
    agent.defaultModel = callerModels[0]!.id;
    const modelId = "mindswapper:openai/gpt-oss-120b";
    callerModels.push({
      id: modelId,
      displayName: "GPT OSS 120B",
      provider: "mindswapper",
      priority: Number.MAX_SAFE_INTEGER,
      costCoefficient: 1,
      enabled: true,
      availability: "selectable",
    });
    const view = render(<MemoryRouter><ModelSection /></MemoryRouter>);
    const mindSwapper = await view.findByRole<HTMLInputElement>("radio", { name: /GPT OSS 120B MindSwapper/ });
    const existing = view.getByRole<HTMLInputElement>("radio", { name: /GPT-5.4 via OpenRouter/ });
    expect(view.getAllByRole("radio")).toEqual([existing, mindSwapper]);
    expect(existing.closest("label")?.textContent).toContain("Priority 1 · cost ×1");
    const label = mindSwapper.closest("label")?.textContent;
    expect(label).toContain("GPT OSS 120B");
    expect(label).toContain("MindSwapper");
    expect(label).toContain(modelId);
    expect(label).not.toContain("Priority");
    expect(label).not.toContain("cost ×");
    expect(label).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(existing.checked).toBe(true);
    expect(mindSwapper.checked).toBe(false);

    fireEvent.click(mindSwapper);
    expect(mindSwapper.checked).toBe(true);
    expect(existing.checked).toBe(false);
    expect(view.getByText("Selected catalog model:").textContent).toContain("GPT OSS 120B");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(await view.findByText("Saved")).toBeTruthy();
    expect(mindSwapper.checked).toBe(true);
  });

  test("shows the current admitted payer and explains request-time rechecking", async () => {
    agent.defaultModel = "openrouter:openai/gpt-5.4";
    callerModels[0] = { ...callerModels[0]!, fundingSource: "personal", fundingProviderRoute: "surplus" };
    const view = render(<MemoryRouter><ModelSection /></MemoryRouter>);
    expect(await view.findByText("Your key")).toBeTruthy();
    expect(view.getByText(/Funding is checked again when each request starts/).textContent).toContain("surplus");
  });

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
