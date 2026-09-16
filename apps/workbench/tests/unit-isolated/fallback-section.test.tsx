/**
 * D141 — FallbackSection (settings) unit tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import {
  PROFILE_AVATAR_URL,
  type AgentProfileFull,
  type AgentProfileResponse,
} from "@nautilo/types";

// M126 follow-up: lazy-instantiate happy-dom inside `beforeAll`
// (module-top construction pollutes Bun's test-collection phase and
// cascades into "Export named X not found" errors on Linux Bun 1.3.11).
let happyWindow: Window;

const catalog: AssistantModelSummary[] = [
  {
    id: "anthropic:claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    priority: 1,
    enabled: true,
    costCoefficient: 1,
  },
  {
    id: "anthropic:claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    priority: 2,
    enabled: true,
    costCoefficient: 1,
  },
  {
    id: "openai:gpt-4o-mini",
    displayName: "GPT-4o mini",
    priority: 3,
    enabled: true,
    costCoefficient: 1,
  },
];
let retainedRows: AssistantModelSummary[] = [];

const harness: {
  authRole: "owner" | "guest";
  profile: AgentProfileResponse | null;
} = {
  authRole: "owner",
  profile: null,
};

const apiStub = {
  getModels: mock(async () => catalog),
  resolveRetainedModels: mock(async (ids: readonly string[]) =>
    [...catalog, ...retainedRows].filter((model) => ids.includes(model.id)),
  ),
  updateFallbackPolicy: mock(async (policy: { enabled: boolean; chain: string[] }) => policy),
};

const priorGlobals: Record<string, unknown> = {};

function baseAgent(overrides: Partial<AgentProfileFull> = {}): AgentProfileFull {
  return {
    name: "Genie",
    language: "en",
    voices: {},
    avatar: { kind: "preset", id: "avatar-01" },
    avatarUrl: PROFILE_AVATAR_URL,
    defaultModel: null,
    personality: { prompt: null, tone: null, motherAnswer: null },
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: null,
    onboardingCompleted: true,
    welcomeMessageSent: true,
    agentIdentity: "agent-1",
    publicProfile: false,
    fallback: { enabled: false, chain: [] },
    ...overrides,
  };
}

function ownerResponse(agent: AgentProfileFull): AgentProfileResponse {
  return { viewerRole: "owner", agent };
}

let FallbackSection: (typeof import("../../src/pages/settings/sections/fallback-section"))["FallbackSection"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });

  mock.module("../../src/hooks/use-auth", () => ({
    // Stack 19 Phase 6.9.6 fix: partial mocks of hooks/use-auth omit
    // production exports (AuthProvider, computeViewerOn*), which leaks
    // under Bun's mock-hoisting → other test files importing them get
    // `Export named 'X' not found`. Mirror the full surface as
    // sign-in-dialog / invite-redeem siblings do.
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    computeViewerOnWhoamiFailure: (prev: { staleWhoami?: boolean } & Record<string, unknown>) =>
      prev?.staleWhoami ? prev : { ...prev, staleWhoami: true },
    computeViewerOnNullToken: (cached: Record<string, unknown> | null) =>
      cached
        ? { ...cached, staleWhoami: true }
        : {
            role: "guest", label: "Guest", userIdentity: null, sessionUserId: null,
            isVerified: false, staleWhoami: false,
          },
    useAuth: () => ({
      session: {
        state: "signed-in" as const,
        signIn: async () => {},
        signOut: async () => {},
        getAccessToken: async () => "token",
      },
      viewer: {
        role: harness.authRole,
        label: harness.authRole === "owner" ? "Owner" : "Guest",
        userIdentity: "u",
        sessionUserId: "s",
        isVerified: harness.authRole === "owner",
        staleWhoami: false,
      },
    }),
  }));

  mock.module("../../src/hooks/use-profile", () => ({
    useProfile: () => ({
      response: harness.profile,
      agent: harness.profile?.viewerRole === "owner" ? harness.profile.agent : null,
      avatarSrc: "",
      avatarLoading: false,
      avatarError: null,
      loading: false,
      error: null,
      refresh: async () => {},
    }),
  }));

  mock.module("../../src/lib/api", () => ({
    apiClient: apiStub,
  }));

  ({ FallbackSection } = await import("../../src/pages/settings/sections/fallback-section"));
});

beforeEach(() => {
  harness.authRole = "owner";
  harness.profile = ownerResponse(baseAgent());
  apiStub.getModels.mockClear();
  apiStub.resolveRetainedModels.mockClear();
  apiStub.updateFallbackPolicy.mockClear();
  retainedRows = [];
  apiStub.getModels.mockImplementation(async () => catalog);
  apiStub.updateFallbackPolicy.mockImplementation(async (p) => p);
});

afterAll(async () => {
  await new Promise<void>((r) => setTimeout(r, 80));
  mock.restore();
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

async function flushUntil(
  predicate: () => boolean,
  maxTicks = 120,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await flush();
  }
}

async function waitForOwnerEditor(host: HTMLElement): Promise<void> {
  await flushUntil(() => host.textContent?.includes("Fallback order") ?? false);
}

function getSaveButton(host: HTMLElement): HTMLButtonElement | null {
  const buttons = [...host.querySelectorAll("button")];
  return buttons.find((b) => b.textContent?.includes("Save") && !b.textContent?.includes("Models")) ?? null;
}

describe("FallbackSection (D141)", () => {
  test("guest viewer: GuestPlaceholder and no Save button", async () => {
    harness.authRole = "guest";
    harness.profile = null;

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await flushUntil(() => host.textContent?.includes("Model fallback policy") ?? false);

    expect(host.textContent).toContain("Model fallback policy");
    expect(getSaveButton(host)).toBeNull();

    root.unmount();
    host.remove();
    await flush();
    await flush();
    harness.authRole = "owner";
  });

  test("owner empty fallback: toggle off, empty hint, no cross-provider note, Save disabled", async () => {
    harness.profile = ownerResponse(baseAgent({ fallback: { enabled: false, chain: [] } }));

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    const toggle = host.querySelector('[data-testid="fallback-toggle"]');
    expect(toggle?.textContent).toContain("Off");
    expect(host.textContent).toContain("No fallback models yet");
    expect(host.querySelector('aside[role="note"]')).toBeNull();

    const save = getSaveButton(host);
    expect(save).not.toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("owner enabled + single chain model: list shows model, toggle on, Save disabled", async () => {
    harness.profile = ownerResponse(
      baseAgent({
        fallback: { enabled: true, chain: ["anthropic:claude-sonnet-4-6"] },
      }),
    );

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    expect(host.querySelector('[data-testid="fallback-toggle"]')?.textContent).toContain("On");
    expect(host.textContent).toContain("Claude Sonnet 4.6");
    expect((getSaveButton(host) as HTMLButtonElement).disabled).toBe(true);

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("retains every unavailable chain row with its reason and permits removal", async () => {
    retainedRows = ["retired-a", "retired-b"].map((name, index) => ({
      id: `openrouter:${name}`,
      displayName: `Retired ${index + 1}`,
      priority: 90 + index,
      availability: "missing-key",
      unavailableReason: "OpenRouter credential is not configured",
    }));
    harness.profile = ownerResponse(baseAgent({
      fallback: {
        enabled: true,
        chain: ["openrouter:retired-a", "openrouter:retired-b"],
      },
    }));

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);
    await flushUntil(() => (host.textContent?.match(/OpenRouter credential is not configured/g)?.length ?? 0) === 2);

    expect(host.textContent).toContain("Retired 1");
    expect(host.textContent).toContain("Retired 2");
    expect(host.textContent?.match(/Unavailable/g)).toHaveLength(2);
    expect(host.textContent?.match(/OpenRouter credential is not configured/g)).toHaveLength(2);
    expect(host.querySelector('option[value="openrouter:retired-a"]')).toBeNull();

    const remove = host.querySelector('button[aria-label="Remove Retired 1"]');
    remove?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    await flushUntil(() => !host.textContent?.includes("Retired 1"));
    expect(host.textContent).not.toContain("Retired 1");
    expect((getSaveButton(host) as HTMLButtonElement).disabled).toBe(false);

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("single-provider chain (two Anthropic): cross-provider aside absent", async () => {
    harness.profile = ownerResponse(
      baseAgent({
        fallback: {
          enabled: true,
          chain: ["anthropic:claude-sonnet-4-6", "anthropic:claude-opus-4-6"],
        },
      }),
    );

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    expect(host.querySelector('aside[role="note"]')).toBeNull();

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("cross-provider chain: aside note is rendered", async () => {
    harness.profile = ownerResponse(
      baseAgent({
        fallback: {
          enabled: true,
          chain: ["anthropic:claude-sonnet-4-6", "openai:gpt-4o-mini"],
        },
      }),
    );

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    const aside = host.querySelector('aside[role="note"]');
    expect(aside).not.toBeNull();
    expect(aside?.textContent).toContain("spans multiple providers");

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("add then save: calls updateFallbackPolicy and shows Saved", async () => {
    harness.profile = ownerResponse(baseAgent({ fallback: { enabled: false, chain: [] } }));

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    const addBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add");
    expect(addBtn).not.toBeNull();
    expect((addBtn as HTMLButtonElement).disabled).toBe(false);
    addBtn?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));

    await flushUntil(() => getSaveButton(host)?.disabled === false);

    const save = getSaveButton(host);
    expect((save as HTMLButtonElement).disabled).toBe(false);
    save?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));

    await flushUntil(() => host.textContent?.includes("Saved"));

    expect(apiStub.updateFallbackPolicy).toHaveBeenCalled();
    const body = apiStub.updateFallbackPolicy.mock.calls[0]?.[0];
    expect(body).toEqual({
      enabled: false,
      chain: ["anthropic:claude-sonnet-4-6"],
    });
    expect(host.textContent).toContain("Saved");

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });

  test("save error: shows error StatusPill message", async () => {
    harness.profile = ownerResponse(baseAgent({ fallback: { enabled: false, chain: [] } }));
    apiStub.updateFallbackPolicy.mockImplementation(async () => {
      throw new Error("fallback-save-failed");
    });

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<FallbackSection />);
    await waitForOwnerEditor(host);

    const toggle = host.querySelector('[data-testid="fallback-toggle"]');
    toggle?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    await flush();
    const save = getSaveButton(host);
    expect((save as HTMLButtonElement).disabled).toBe(false);
    save?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));

    await flushUntil(() => host.textContent?.includes("fallback-save-failed"));

    expect(host.textContent).toContain("fallback-save-failed");

    root.unmount();
    host.remove();
    await flush();
    await flush();
  });
});
