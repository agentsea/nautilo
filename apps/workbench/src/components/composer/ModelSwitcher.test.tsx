import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Window } from "happy-dom";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";

let happyWindow: Window;
let container: HTMLDivElement;
let root: Root;
const priorGlobals: Record<string, unknown> = {};

const getModels = mock(async () => [
  {
    id: "openai:gpt-next",
    displayName: "GPT Next",
    priority: 3,
    capabilities: {},
    controls: {
      reasoning: {
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
        canDisable: true,
        mandatory: false,
      },
    },
  },
  {
    id: "anthropic:claude-sonnet",
    displayName: "Claude Sonnet",
    priority: 5,
    capabilities: {},
  },
  {
    id: "fireworks:accounts/fireworks/models/kimi-k3",
    displayName: "Kimi K3",
    priority: 2,
    capabilities: {},
    controls: {
      serving: {
        defaultProfile: "standard",
        profiles: [
          {
            id: "standard",
            label: "Standard",
            description: "Balanced Fireworks capacity.",
            intent: "balanced",
            pricing: { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 },
          },
          {
            id: "priority",
            label: "Priority",
            description: "Higher reliability during peak traffic.",
            intent: "reliability",
            pricing: { inputPerMtok: 3.75, cachedInputPerMtok: 0.375, outputPerMtok: 18.75 },
          },
          {
            id: "fast",
            label: "Fast",
            description: "Fast response speeds for interactive work.",
            intent: "throughput",
            pricing: { inputPerMtok: 4.5, cachedInputPerMtok: 0.45, outputPerMtok: 22.5 },
          },
        ],
      },
    },
  },
  {
    id: "anthropic:claude-opus",
    displayName: "Claude Opus",
    priority: 1,
    capabilities: {},
    controls: {
      reasoning: {
        levels: ["low", "medium", "high", "max"],
        defaultLevel: "high",
        canDisable: false,
        mandatory: false,
      },
      serving: {
        defaultProfile: "standard",
        profiles: [
          { id: "standard", label: "Standard", intent: "balanced" },
          { id: "priority", label: "Priority", intent: "reliability" },
        ],
      },
    },
  },
  {
    id: "openai:gpt-default",
    displayName: "GPT Default",
    priority: 1,
    capabilities: {},
  },
]);
let retainedModelRows: AssistantModelSummary[] = [];
const resolveRetainedModels = mock(async (ids: readonly string[]) => {
  const ordinary = (await getModels()).filter((model) => ids.includes(model.id));
  return [...ordinary, ...retainedModelRows.filter((model) => ids.includes(model.id))];
});
const updateProfile = mock(async () => {});
let persistedRoomSelection: {
  modelId: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
  servingProfileId?: string;
} | null = null;
const getRoomModelControlSelection = mock(async () => persistedRoomSelection);
const updateRoomModelControlSelection = mock(
  async (
    _roomId: string,
    _agentId: string,
    selection: typeof persistedRoomSelection,
  ) => {
    persistedRoomSelection = selection;
    return selection;
  },
);

let profileResponse: unknown;
let ModelSwitcher: (typeof import("./ModelSwitcher"))["ModelSwitcher"];

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/rooms/test" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });

  mock.module("../../lib/api", () => ({
    apiClient: {
      getModels,
      resolveRetainedModels,
      updateProfile,
      getRoomModelControlSelection,
      updateRoomModelControlSelection,
    },
  }));
  mock.module("../../hooks/use-profile", () => ({
    useProfile: () => ({ response: profileResponse }),
  }));
  ({ ModelSwitcher } = await import("./ModelSwitcher"));
});

beforeEach(() => {
  getModels.mockClear();
  resolveRetainedModels.mockClear();
  updateProfile.mockClear();
  getRoomModelControlSelection.mockClear();
  updateRoomModelControlSelection.mockClear();
  persistedRoomSelection = null;
  retainedModelRows = [];
  profileResponse = {
    viewerRole: "owner",
    agent: {
      defaultModel: "openai:gpt-default",
      fallback: { enabled: true, chain: ["openai:gpt-default"] },
    },
  };
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete globals[key];
    else globals[key] = priorGlobals[key];
  }
});

function renderSwitcher(roomId = "room-1", agentId: string | null = "agent-1"): void {
  act(() => {
    root.render(
      <MemoryRouter>
        <ModelSwitcher roomId={roomId} agentId={agentId} />
      </MemoryRouter>,
    );
  });
}

function openPicker(): HTMLButtonElement {
  const trigger = container.querySelector(
    '[data-testid="composer-model-switcher"]',
  ) as HTMLButtonElement;
  act(() => trigger.click());
  return trigger;
}

function searchModels(query: string): void {
  const input = container.querySelector("#composer-model-search") as HTMLInputElement;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on search input");
  const props = (input as HTMLInputElement & Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  act(() => {
    props.onChange({ target: { value: query } });
  });
}

function optionNames(scope: ParentNode = container): string[] {
  return [...scope.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector(".font-medium")?.textContent ?? "",
  );
}

describe("ModelSwitcher", () => {
  test("groups selectable models by provider and orders rows by priority", async () => {
    renderSwitcher();
    await act(flush);
    openPicker();

    const groups = [...container.querySelectorAll('[role="group"]')];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Anthropic",
      "OpenAI",
      "Fireworks",
    ]);
    expect(optionNames(groups[0])).toEqual(["Claude Opus", "Claude Sonnet"]);
    expect(optionNames(groups[1])).toEqual(["GPT Default", "GPT Next"]);
    expect(optionNames(groups[2])).toEqual(["Kimi K3"]);
  });

  test("filters in memory by model name, provider label, and full ID fragment", async () => {
    renderSwitcher();
    await act(flush);
    openPicker();

    searchModels("kimi");
    expect(optionNames()).toEqual(["Kimi K3"]);

    searchModels("Fireworks");
    expect(optionNames()).toEqual(["Kimi K3"]);

    searchModels("accounts/fireworks/models/kimi");
    expect(optionNames()).toEqual(["Kimi K3"]);
    expect(getModels).toHaveBeenCalledTimes(2);
    expect(resolveRetainedModels).toHaveBeenCalledTimes(1);
  });

  test("shows no-match copy and resets the query after closing", async () => {
    renderSwitcher();
    await act(flush);
    const trigger = openPicker();

    searchModels("does-not-exist");
    expect(container.textContent).toContain("No models match this search.");

    act(() => trigger.click());
    act(() => trigger.click());
    expect((container.querySelector("#composer-model-search") as HTMLInputElement).value).toBe("");
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(5);
  });

  test("does not guess the shared server default from the first picker row", async () => {
    profileResponse = {
      viewerRole: "owner",
      agent: {
        defaultModel: null,
        fallback: { enabled: true, chain: ["openai:gpt-default"] },
      },
    };
    renderSwitcher();
    await act(flush);

    expect(
      container.querySelector('[data-testid="composer-model-switcher"]')?.textContent,
    ).toContain("Server default");
    openPicker();
    expect(
      [...container.querySelectorAll('[role="option"]')].find(
        (option) => option.getAttribute("aria-selected") === "true",
      ),
    ).toBeUndefined();
  });

  test("persists an ordinary picker choice as a Room-local selection", async () => {
    renderSwitcher();
    await act(flush);

    openPicker();
    const next = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("GPT Next"),
    ) as HTMLButtonElement;
    await act(async () => {
      next.click();
      await flush();
    });

    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1", {
      modelId: "openai:gpt-next",
      reasoningEffort: "medium",
    });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test("keeps the picker open and reports a failed default save", async () => {
    updateRoomModelControlSelection.mockImplementationOnce(async () => {
      throw new Error("Profile service unavailable");
    });
    renderSwitcher();
    await act(flush);

    openPicker();
    searchModels("GPT Next");
    const next = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("GPT Next"),
    ) as HTMLButtonElement;
    await act(async () => {
      next.click();
      await flush();
    });

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.textContent).toContain("Could not save Room model controls: Profile service unavailable");
    expect((container.querySelector("#composer-model-search") as HTMLInputElement).value).toBe(
      "GPT Next",
    );
  });

  test("keeps model-only rows as a Model-only picker", async () => {
    renderSwitcher();
    await act(flush);
    openPicker();

    expect(container.querySelector('[aria-label="Model controls"]')?.textContent).toContain("Model");
    expect(container.querySelector('[aria-label="Model controls"]')?.textContent).not.toContain("Effort");
    expect(container.querySelector('[aria-label="Model controls"]')?.textContent).not.toContain("Serving");
  });

  test("shows and saves Reasoning only for a reasoning-only model", async () => {
    profileResponse = {
      viewerRole: "owner",
      agent: { defaultModel: "openai:gpt-next", fallback: { enabled: true, chain: ["openai:gpt-next"] } },
    };
    renderSwitcher();
    await act(flush);
    openPicker();

    const rows = container.querySelector('[aria-label="Model controls"]') as HTMLElement;
    expect(rows.textContent).toContain("Effort");
    expect(rows.textContent).not.toContain("Serving");
    const effort = [...rows.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Effort")) as HTMLButtonElement;
    act(() => effort.click());
    const high = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("High"),
    ) as HTMLButtonElement;
    await act(async () => {
      high.click();
      await flush();
    });

    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1", {
      modelId: "openai:gpt-next",
      reasoningEffort: "high",
    });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test("saves Fireworks Kimi Serving choices to Room A only", async () => {
    profileResponse = {
      viewerRole: "owner",
      agent: {
        defaultModel: "fireworks:accounts/fireworks/models/kimi-k3",
        fallback: { enabled: true, chain: ["openai:gpt-default"] },
      },
    };
    renderSwitcher("room-a");
    await act(flush);
    openPicker();

    const rows = container.querySelector('[aria-label="Model controls"]') as HTMLElement;
    expect(rows.textContent).toContain("Serving");
    expect(rows.textContent).not.toContain("Effort");
    const serving = [...rows.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Serving")) as HTMLButtonElement;
    act(() => serving.click());
    expect(container.querySelector('[aria-label="Serving profile"]')?.textContent).toContain("Standard");
    expect(container.querySelector('[aria-label="Serving profile"]')?.textContent).toContain("Priority");
    expect(container.querySelector('[aria-label="Serving profile"]')?.textContent).toContain("Fast");
    expect(container.querySelector('[aria-label="Serving profile"]')?.textContent).toContain("Input $4.50/M");

    const fast = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("Fast"),
    ) as HTMLButtonElement;
    await act(async () => {
      fast.click();
      await flush();
    });
    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-a", "agent-1", {
      modelId: "fireworks:accounts/fireworks/models/kimi-k3",
      servingProfileId: "fast",
    });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test("shows both controls only for a model that advertises both", async () => {
    profileResponse = {
      viewerRole: "owner",
      agent: { defaultModel: "anthropic:claude-opus", fallback: { enabled: true, chain: ["anthropic:claude-opus"] } },
    };
    renderSwitcher();
    await act(flush);
    openPicker();

    const rows = container.querySelector('[aria-label="Model controls"]') as HTMLElement;
    expect(rows.textContent).toContain("Effort");
    expect(rows.textContent).toContain("Serving");
  });

  test("resets incompatible controls when the Room model changes", async () => {
    persistedRoomSelection = {
      modelId: "anthropic:claude-opus",
      reasoningEffort: "max",
      servingProfileId: "priority",
    };
    renderSwitcher();
    await act(flush);
    openPicker();

    const next = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("GPT Next"),
    ) as HTMLButtonElement;
    await act(async () => {
      next.click();
      await flush();
    });
    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1", {
      modelId: "openai:gpt-next",
      reasoningEffort: "medium",
    });
  });

  test("loads and resets the Room override without changing the Agent default", async () => {
    persistedRoomSelection = {
      modelId: "fireworks:accounts/fireworks/models/kimi-k3",
      servingProfileId: "priority",
    };
    renderSwitcher();
    await act(flush);
    openPicker();
    expect(getRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1");
    const reset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Reset to Agent default"),
    ) as HTMLButtonElement;
    await act(async () => {
      reset.click();
      await flush();
    });
    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1", null);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test("retains an unavailable Room override without offering it as a choice and allows reset", async () => {
    persistedRoomSelection = { modelId: "openrouter:retired-model" };
    retainedModelRows = [{
      id: "openrouter:retired-model",
      displayName: "Retired routed model",
      priority: 99,
      capabilities: {},
      availability: "missing-key",
      unavailableReason: "OpenRouter credential is not configured",
    }];
    renderSwitcher();
    await act(flush);
    await act(flush);

    expect(container.querySelector('[data-testid="composer-model-switcher"]')?.textContent)
      .toContain("Retired routed model");
    openPicker();
    expect(container.textContent).toContain(
      "Retired routed model is unavailable: OpenRouter credential is not configured",
    );
    expect(optionNames()).not.toContain("Retired routed model");

    const reset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Reset to Agent default"),
    ) as HTMLButtonElement;
    await act(async () => {
      reset.click();
      await flush();
    });
    expect(updateRoomModelControlSelection).toHaveBeenCalledWith("room-1", "agent-1", null);
  });

  test("does not read or write a Room override while its Agent target is ambiguous", async () => {
    renderSwitcher("room-1", null);
    await act(flush);
    openPicker();

    expect(getRoomModelControlSelection).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Focus one of your Agents to set Room model controls.");
    const next = [...container.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("GPT Next"),
    ) as HTMLButtonElement;
    act(() => next.click());
    expect(updateRoomModelControlSelection).not.toHaveBeenCalled();
  });
});
