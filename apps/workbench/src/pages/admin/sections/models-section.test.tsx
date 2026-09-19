import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { AssistantModelSummary, ServerModelConfig } from "@nautilo/api-client/browser";
import userEvent from "@testing-library/user-event";

let canManage = true;
let openRouterAvailable = true;
let modelLoadGate: Promise<void> | null = null;
let retainedLoadGate: Promise<void> | null = null;
const catalogModels: NonNullable<ServerModelConfig["catalogModels"]> = [
  {
    id: "openrouter:typesafe/jev-1.13", displayName: "Jev 1.13", provider: "openrouter",
    workload: "decision", availability: "selectable", input: ["text"], output: ["text"],
    features: { tools: false, structuredOutputs: null, reasoning: null, visualGrounding: null, webSearch: false, e2ee: false },
    decision: { operations: ["choice"] },
  },
  {
    id: "fireworks:synthetic/visual", displayName: "Visual Test Model", provider: "fireworks",
    workload: "chat", availability: "selectable", input: ["text", "image"], output: ["text"],
    features: { tools: true, structuredOutputs: true, reasoning: true, visualGrounding: true, webSearch: false, e2ee: null },
    decision: null,
  },
];
const initialConfig = {
  catalogModels: catalogModels as ServerModelConfig["catalogModels"],
  defaultChatModel: "anthropic:claude-sonnet-4-6",
  conductorModel: "",
  stenographerModel: "",
  reflectionModel: "",
  memoryReviewModel: null as string | null,
  embeddingModel: null as string | null,
  effectiveEmbeddingModel: "venice:text-embedding-qwen3-8b" as string | null,
  embeddingSelectionPending: false,
  embeddingModels: [
    {
      id: "venice:text-embedding-qwen3-8b",
      displayName: "Qwen3 Embedding 8B (Venice)",
      available: true,
    },
    {
      id: "openrouter:qwen/qwen3-embedding-8b",
      displayName: "Qwen3 Embedding 8B (OpenRouter)",
      available: true,
    },
    {
      id: "venice:text-embedding-3-small",
      displayName: "Text Embedding 3 Small (Venice)",
      available: true,
    },
    {
      id: "openrouter:openai/text-embedding-3-small",
      displayName: "Text Embedding 3 Small (OpenRouter)",
      available: true,
    },
    {
      id: "openai:text-embedding-3-small",
      displayName: "Text Embedding 3 Small (OpenAI)",
      available: false,
    },
    {
      id: "local:bge-m3",
      displayName: "BGE-M3",
      available: true,
    },
  ],
  imageModel: null as string | null,
  musicModel: null as string | null,
  videoModel: null as string | null,
  effectiveImageModel: "venice:gpt-image-2" as string | null,
  effectiveMusicModel: "venice:sonilo-v1-1-music" as string | null,
  effectiveVideoModel: "venice:seedance-2-5-text-to-video-basic" as string | null,
  imageModels: [
    { id: "venice:gpt-image-2", displayName: "GPT Image 2", provider: "venice", available: true },
    { id: "openai:gpt-image-2", displayName: "GPT Image 2 (OpenAI)", provider: "openai", available: false, unavailableReason: "OpenAI credential is not configured" },
  ],
  musicModels: [
    { id: "venice:sonilo-v1-1-music", displayName: "Sonilo", provider: "venice", available: true },
  ],
  videoModels: [
    { id: "venice:seedance-2-5-text-to-video-basic", displayName: "Seedance", provider: "venice", available: true },
  ],
  fallbackChain: [] as string[],
  reasoningOutput: {},
  reasoningPolicy: { defaultEffort: null, overrides: {} },
};
const savedConfig = { ...initialConfig };
let retainedRows: AssistantModelSummary[] = [];
const setServerModelsMock = mock(async (patch: typeof savedConfig) => ({
  ...savedConfig,
  ...patch,
}));
const resolveRetainedModelsMock = mock(async (ids: readonly string[]) => {
  const gate = retainedLoadGate;
  await gate;
  return retainedRows.filter((row) => ids.includes(row.id));
});

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: string) =>
    capability === "read_server_settings" ||
    (capability === "manage_server_operations" && canManage),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    getModels: async () => {
      const openRouterWasAvailable = openRouterAvailable;
      await modelLoadGate;
      return [
        {
          id: "openrouter:minimax/minimax-m3",
          displayName: "MiniMax M3 (OpenRouter)",
          provider: "openrouter",
          availability: "selectable",
        },
        {
          id: "venice:minimax-m3-preview",
          displayName: "MiniMax M3 (Venice)",
          provider: "venice",
          availability: "selectable",
        },
        {
          id: "anthropic:claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          provider: "anthropic",
          availability: "selectable",
        },
        {
          id: "openai:gpt-5.4-mini",
          displayName: "GPT-5.4 mini",
          provider: "openai",
          availability: "selectable",
          capabilities: { reasoning: true },
        },
      ].filter((model) => openRouterWasAvailable || model.provider !== "openrouter");
    },
    resolveRetainedModels: resolveRetainedModelsMock,
    admin: {
      serverModels: {
        get: async () => ({
          ...savedConfig,
          catalogModels: savedConfig.catalogModels?.map((model) => model.provider === "openrouter"
            ? { ...model, availability: openRouterAvailable ? "selectable" : "missing_credentials",
              ...(!openRouterAvailable ? { unavailableReason: "OpenRouter credential is not configured" } : {}) }
            : model),
          embeddingModels: savedConfig.embeddingModels.map((model) =>
            model.id.startsWith("openrouter:")
              ? { ...model, available: openRouterAvailable }
              : model,
          ),
        }),
        set: setServerModelsMock,
      },
    },
  },
}));

const { ModelsSection } = await import("./models-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  setServerModelsMock.mockClear();
  resolveRetainedModelsMock.mockClear();
  canManage = true;
  openRouterAvailable = true;
  modelLoadGate = null;
  retainedLoadGate = null;
  Object.assign(savedConfig, initialConfig);
  retainedRows = [];
});

describe("ModelsSection catalog inventory", () => {
  test("shows decision and coordinate capabilities without adding decision models to chat selectors", async () => {
    canManage = false;
    const view = render(<ModelsSection />);
    const table = await view.findByRole("table", { name: "Catalog models, providers, capabilities and server availability" });
    const jev = within(table).getByRole("row", { name: /Jev 1.13/ });
    expect(within(jev).getByText("OpenRouter")).toBeTruthy();
    expect(within(jev).getByText("decision", { exact: true })).toBeTruthy();
    expect(within(jev).getByText("Choice decisions")).toBeTruthy();
    expect(within(jev).getByText("Available on server")).toBeTruthy();
    expect(within(jev).getByText("Visual grounding (coordinates):").parentElement?.textContent)
      .toContain("Unverified");
    expect(within(jev).getByText("Tools:").parentElement?.textContent).toContain("Not supported");
    expect(view.container.querySelector('select option[value="openrouter:typesafe/jev-1.13"]')).toBeNull();

    const user = userEvent.setup({ document: globalThis.document });
    const search = view.getByRole("searchbox", { name: "Search model catalog" });
    await user.type(search, "coordinates");
    expect(within(table).queryByRole("row", { name: /Jev 1.13/ }) === null).toBe(true);
    expect(within(table).getByRole("row", { name: /Visual Test Model/ })).toBeTruthy();
    expect(view.getByText("1 of 2 models")).toBeTruthy();
    await user.clear(search);
    await user.type(search, "openrouter");
    expect(within(table).getByRole("row", { name: /Jev 1.13/ })).toBeTruthy();
    await user.clear(search);
    await user.type(search, "absent-model");
    expect(view.getByText("No models match your search.")).toBeTruthy();
  });

  test("refreshes catalog availability after credential activation and revocation while retaining unsaved settings", async () => {
    openRouterAvailable = false;
    const view = render(<ModelsSection />);
    await view.findByText("OpenRouter credential is not configured");
    const select = view.getByTestId("server-stenographer-model") as HTMLSelectElement;
    await act(async () => fireEvent.change(select, { target: { value: "openai:gpt-5.4-mini" } }));
    openRouterAvailable = true;
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));
    await waitFor(() => expect(view.queryByText("OpenRouter credential is not configured") === null).toBe(true));
    expect(select.value).toBe("openai:gpt-5.4-mini");
    openRouterAvailable = false;
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));
    await view.findByText("OpenRouter credential is not configured");
    expect(select.value).toBe("openai:gpt-5.4-mini");
    expect(setServerModelsMock).not.toHaveBeenCalled();
  });

  test("an older server explains the missing catalog view while preserving settings", async () => {
    savedConfig.catalogModels = undefined;
    const view = render(<ModelsSection />);
    await view.findByText("This server does not provide the model catalog view yet.");
    expect(view.getByTestId("server-stenographer-model")).toBeTruthy();
  });
});

describe("ModelsSection Stenographer model", () => {
  test("queues a provider refresh that arrives before the initial model load", async () => {
    openRouterAvailable = false;
    savedConfig.reasoningPolicy = {
      defaultEffort: null,
      overrides: { "openai:gpt-5.4-mini": "high" },
    };
    let releaseModelLoad = () => {};
    modelLoadGate = new Promise<void>((resolve) => {
      releaseModelLoad = resolve;
    });

    const view = render(<ModelsSection />);
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));
    openRouterAvailable = true;
    releaseModelLoad();

    const scope = await waitFor(() =>
      view.getByRole("combobox", { name: "Reasoning policy scope" }) as HTMLSelectElement,
    );
    await waitFor(() => expect(view.container.querySelector(
      '#server-conductor-model option[value="openrouter:minimax/minimax-m3"]',
    )).not.toBeNull());
    expect(scope.value).toBe("specific");
    expect((view.getByRole("combobox", { name: "Reasoning intensity" }) as HTMLSelectElement).value)
      .toBe("high");
  });

  test("refreshes provider availability after a key save without discarding draft edits", async () => {
    openRouterAvailable = false;
    const view = render(<ModelsSection />);
    await waitFor(() => expect(view.container.querySelector("#server-default-model"))
      .not.toBeNull());
    const defaultModel = view.container.querySelector("#server-default-model") as HTMLSelectElement;
    const scope = view.getByRole("combobox", { name: "Reasoning policy scope" });
    const intensity = view.getByRole("combobox", { name: "Reasoning intensity" });
    const embedding = view.getByTestId("server-embedding-model") as HTMLSelectElement;

    expect(view.container.querySelector(
      '#server-conductor-model option[value="openrouter:minimax/minimax-m3"]',
    )).toBeNull();
    expect(Array.from(embedding.options).find(
      (option) => option.value === "openrouter:qwen/qwen3-embedding-8b",
    )?.disabled).toBe(true);

    await act(async () => {
      fireEvent.change(defaultModel, { target: { value: "openai:gpt-5.4-mini" } });
      fireEvent.change(scope, { target: { value: "specific" } });
      fireEvent.change(intensity, { target: { value: "high" } });
    });

    openRouterAvailable = true;
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));

    await waitFor(() => expect(view.container.querySelector(
      '#server-conductor-model option[value="openrouter:minimax/minimax-m3"]',
    )).not.toBeNull());
    expect(defaultModel.querySelector(
      'option[value="openrouter:minimax/minimax-m3"]',
    )).not.toBeNull();
    expect(Array.from(embedding.options).find(
      (option) => option.value === "openrouter:qwen/qwen3-embedding-8b",
    )?.disabled).toBe(false);
    expect(defaultModel.value).toBe("openai:gpt-5.4-mini");
    expect((scope as HTMLSelectElement).value).toBe("specific");
    expect((intensity as HTMLSelectElement).value).toBe("high");
  });

  test("retains an unsaved selection when refreshed credentials make it unavailable", async () => {
    const view = render(<ModelsSection />);
    await waitFor(() => expect(view.container.querySelector("#server-default-model"))
      .not.toBeNull());
    const defaultModel = view.container.querySelector("#server-default-model") as HTMLSelectElement;

    await act(async () => fireEvent.change(defaultModel, {
      target: { value: "openrouter:minimax/minimax-m3" },
    }));
    retainedRows = [{
      id: "openrouter:minimax/minimax-m3",
      displayName: "MiniMax M3 (OpenRouter)",
      availability: "missing-key",
      unavailableReason: "OpenRouter credential is not configured",
    }];
    openRouterAvailable = false;
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));

    await waitFor(() => expect(defaultModel.selectedOptions[0]?.textContent)
      .toBe("MiniMax M3 (OpenRouter) (Unavailable)"));
    expect(defaultModel.value).toBe("openrouter:minimax/minimax-m3");
    expect(defaultModel.selectedOptions[0]?.disabled).toBe(true);
  });

  test("restarts an in-flight availability refresh when the draft selection changes", async () => {
    const view = render(<ModelsSection />);
    await waitFor(() => expect(view.container.querySelector("#server-default-model"))
      .not.toBeNull());
    const defaultModel = view.container.querySelector("#server-default-model") as HTMLSelectElement;
    resolveRetainedModelsMock.mockClear();

    let releaseRetainedLoad = () => {};
    retainedLoadGate = new Promise<void>((resolve) => {
      releaseRetainedLoad = resolve;
    });
    retainedRows = [{
      id: "openrouter:minimax/minimax-m3",
      displayName: "MiniMax M3 (OpenRouter)",
      availability: "missing-key",
      unavailableReason: "OpenRouter credential is not configured",
    }];
    openRouterAvailable = false;
    act(() => window.dispatchEvent(new Event("nautilo:provider-keys-saved")));
    await waitFor(() => expect(resolveRetainedModelsMock).toHaveBeenCalled());

    await act(async () => fireEvent.change(defaultModel, {
      target: { value: "openrouter:minimax/minimax-m3" },
    }));
    releaseRetainedLoad();

    await waitFor(() => expect(defaultModel.selectedOptions[0]?.textContent)
      .toBe("MiniMax M3 (OpenRouter) (Unavailable)"));
    expect(resolveRetainedModelsMock.mock.calls.some(([ids]) =>
      ids.includes("openrouter:minimax/minimax-m3"))).toBe(true);
    expect(defaultModel.value).toBe("openrouter:minimax/minimax-m3");
  });

  test("recommends the routed MiniMax M3 defaults for Conductor", async () => {
    const view = render(<ModelsSection />);
    await waitFor(() => expect(view.container.querySelector("#server-conductor-model"))
      .not.toBeNull());

    const recommended = view.container.querySelector(
      '#server-conductor-model optgroup[label="★ Recommended for Conductor"]',
    );
    expect(Array.from(recommended?.querySelectorAll("option") ?? []).map((option) => option.value))
      .toEqual([
        "openrouter:minimax/minimax-m3",
        "venice:minimax-m3-preview",
      ]);
    expect(view.getByText(/Automatic prefers MiniMax M3/)).toBeTruthy();
  });

  test("uses the live catalogue and persists a selected model", async () => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-stenographer-model") as HTMLSelectElement,
    );
    expect(select.value).toBe("");
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toContain("GPT-5.4 mini");

    await act(async () => {
      fireEvent.change(select, {
        target: { value: "openai:gpt-5.4-mini" },
      });
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Save changes" }));
    });

    await waitFor(() => {
      expect(setServerModelsMock).toHaveBeenCalledWith({
        defaultChatModel: "anthropic:claude-sonnet-4-6",
        conductorModel: "",
        stenographerModel: "openai:gpt-5.4-mini",
        reflectionModel: "",
        memoryReviewModel: null,
        embeddingModel: null,
        fallbackChain: [],
        reasoningPolicy: { defaultEffort: null, overrides: {} },
      });
      expect(view.getByText("Saved. Live now.")).toBeTruthy();
    });
  });

  test("persists an independent Reflection model", async () => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-reflection-model") as HTMLSelectElement,
    );
    expect(select.value).toBe("");
    await act(async () => {
      fireEvent.change(select, { target: { value: "openai:gpt-5.4-mini" } });
      fireEvent.click(view.getByRole("button", { name: "Save changes" }));
    });
    await waitFor(() => expect(setServerModelsMock).toHaveBeenCalledWith({
      defaultChatModel: "anthropic:claude-sonnet-4-6",
      conductorModel: "",
      stenographerModel: "",
      reflectionModel: "openai:gpt-5.4-mini",
      memoryReviewModel: null,
      embeddingModel: null,
      fallbackChain: [],
        reasoningPolicy: { defaultEffort: null, overrides: {} },
    }));
  });

  test("saves a scoped server reasoning-effort policy", async () => {
    const view = render(<ModelsSection />);
    const scope = await waitFor(() => view.getByRole("combobox", { name: "Reasoning policy scope" }));
    const intensity = view.getByRole("combobox", { name: "Reasoning intensity" });

    await act(async () => {
      fireEvent.change(scope, { target: { value: "specific" } });
      fireEvent.change(intensity, { target: { value: "high" } });
      fireEvent.click(view.getByRole("button", { name: "Save changes" }));
    });

    await waitFor(() => {
      expect(setServerModelsMock).toHaveBeenCalledWith({
        defaultChatModel: "anthropic:claude-sonnet-4-6",
        conductorModel: "",
        stenographerModel: "",
        reflectionModel: "",
        memoryReviewModel: null,
        embeddingModel: null,
        fallbackChain: [],
        reasoningPolicy: { defaultEffort: null, overrides: { "openai:gpt-5.4-mini": "high" } },
      });
    });
  });

  test("keeps all server model controls read-only without manage_server_operations", async () => {
    canManage = false;
    const view = render(<ModelsSection />);
    const scope = await waitFor(() => view.getByRole("combobox", { name: "Reasoning policy scope" }));
    expect((scope as HTMLSelectElement).disabled).toBe(true);
    expect((view.getByTestId("server-stenographer-model") as HTMLSelectElement).disabled)
      .toBe(true);
    expect(view.getByText("manage_server_operations", { selector: "code" })).toBeTruthy();
  });

  test("retains unavailable values in all five Admin roles with reasons and recovery actions", async () => {
    Object.assign(savedConfig, {
      defaultChatModel: "legacy:default",
      conductorModel: "legacy:conductor",
      stenographerModel: "legacy:stenographer",
      reflectionModel: "legacy:reflection",
      memoryReviewModel: null,
      fallbackChain: ["legacy:fallback-a", "legacy:fallback-b"],
    });
    retainedRows = [
      "default",
      "conductor",
      "stenographer",
      "reflection",
      "fallback-a",
      "fallback-b",
    ].map((name, index) => ({
      id: `legacy:${name}`,
      displayName: `Legacy ${name}`,
      priority: 100 + index,
      availability: "unknown-model",
      unavailableReason: "model is not present in the current signed catalog",
    }));

    const view = render(<ModelsSection />);
    await waitFor(() => {
      expect(view.container.querySelector("#server-default-model")).not.toBeNull();
      expect(view.container.querySelector("#server-conductor-model")).not.toBeNull();
    });
    const defaultSelect = view.container.querySelector("#server-default-model") as HTMLSelectElement;
    const conductorSelect = view.container.querySelector("#server-conductor-model") as HTMLSelectElement;
    const stenographerSelect = view.getByTestId("server-stenographer-model") as HTMLSelectElement;
    const reflectionSelect = view.getByTestId("server-reflection-model") as HTMLSelectElement;

    for (const select of [defaultSelect, conductorSelect, stenographerSelect, reflectionSelect]) {
      expect(select.selectedOptions[0]?.textContent).toContain("Unavailable");
      expect(select.selectedOptions[0]?.disabled).toBe(true);
    }
    expect(view.getAllByText("model is not present in the current signed catalog").length)
      .toBeGreaterThanOrEqual(6);
    expect(view.getByText("Legacy fallback-a")).toBeTruthy();
    expect(view.getByText("Legacy fallback-b")).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });
});

describe("ModelsSection Embedding model", () => {
  test("offers server, automatic, and supported qualified choices", async () => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-embedding-model") as HTMLSelectElement,
    );

    expect(select.selectedOptions[0]?.textContent).toBe("Server configuration");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Server configuration",
      "Automatic — Venice → OpenRouter → OpenAI",
      "Qwen3 Embedding 8B (Venice)",
      "Qwen3 Embedding 8B (OpenRouter)",
      "Text Embedding 3 Small (Venice)",
      "Text Embedding 3 Small (OpenRouter)",
      "Text Embedding 3 Small (OpenAI) (Unavailable)",
    ]);
    expect(select.options[6]?.disabled).toBe(true);
  });

  test("persists automatic independently", async () => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-embedding-model") as HTMLSelectElement,
    );

    await act(async () => fireEvent.change(select, { target: { value: "" } }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));

    await waitFor(() => expect(setServerModelsMock.mock.calls[0]?.[0].embeddingModel).toBe(""));
  });

  test("persists an explicit Qwen3 provider choice", async () => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-embedding-model") as HTMLSelectElement,
    );

    await act(async () => fireEvent.change(select, {
      target: { value: "openrouter:qwen/qwen3-embedding-8b" },
    }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));

    await waitFor(() => expect(setServerModelsMock.mock.calls[0]?.[0].embeddingModel)
      .toBe("openrouter:qwen/qwen3-embedding-8b"));
  });

  test.each([
    "venice:text-embedding-3-small",
    "openrouter:openai/text-embedding-3-small",
  ])("persists the retained OpenAI embedding choice %s", async (embeddingModel) => {
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-embedding-model") as HTMLSelectElement,
    );

    await act(async () => fireEvent.change(select, { target: { value: embeddingModel } }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));

    await waitFor(() => expect(setServerModelsMock.mock.calls[0]?.[0].embeddingModel)
      .toBe(embeddingModel));
  });

  test("displays the effective model and vector rebuild warning", async () => {
    const view = render(<ModelsSection />);

    await waitFor(() => {
      expect(view.getByTestId("effective-embedding-model").textContent)
        .toBe("Current effective model: Qwen3 Embedding 8B (Venice)");
    });
    expect(view.getByText("Changing the embedding provider or model does not rebuild existing vectors."))
      .toBeTruthy();
  });

  test("displays unavailable when no embedding model resolves", async () => {
    savedConfig.effectiveEmbeddingModel = null;
    const view = render(<ModelsSection />);

    await waitFor(() => {
      expect(view.getByTestId("effective-embedding-model").textContent)
        .toBe("Current effective model: Unavailable");
    });
  });

  test("reports when the saved selection is not active yet", async () => {
    savedConfig.embeddingSelectionPending = true;
    const view = render(<ModelsSection />);

    await waitFor(() => {
      expect(view.getByRole("status").textContent)
        .toBe("Saved selection is not active yet. Reload to retry applying it.");
    });
  });

  test("preserves a configured model that is absent from the supported list", async () => {
    savedConfig.embeddingModel = "legacy:embedding-model";
    const view = render(<ModelsSection />);
    const select = await waitFor(() =>
      view.getByTestId("server-embedding-model") as HTMLSelectElement,
    );

    expect(select.value).toBe("legacy:embedding-model");
    expect(select.selectedOptions[0]?.textContent).toBe("legacy:embedding-model (Unavailable)");
    expect(select.selectedOptions[0]?.disabled).toBe(true);
  });
});

describe("ModelsSection media generation models", () => {
  test("offers server configuration, automatic, and supported family choices", async () => {
    const view = render(<ModelsSection />);
    const image = await waitFor(() => view.getByTestId("server-image-model") as HTMLSelectElement);
    const music = view.getByTestId("server-music-model") as HTMLSelectElement;
    const video = view.getByTestId("server-video-model") as HTMLSelectElement;

    expect(image.selectedOptions[0]?.textContent).toBe("Server configuration");
    expect(Array.from(image.options).map((option) => option.textContent)).toEqual([
      "Server configuration",
      "Automatic — Venice → OpenRouter → OpenAI → Google",
      "GPT Image 2",
      "GPT Image 2 (OpenAI) (Unavailable)",
    ]);
    expect(image.options[3]?.disabled).toBe(true);
    expect(Array.from(music.options).map((option) => option.textContent)).toContain("Sonilo");
    expect(Array.from(video.options).map((option) => option.textContent)).toContain("Seedance");
  });

  test("persists automatic independently and displays effective models", async () => {
    const view = render(<ModelsSection />);
    const image = await waitFor(() => view.getByTestId("server-image-model") as HTMLSelectElement);
    await act(async () => fireEvent.change(image, { target: { value: "" } }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));

    await waitFor(() => expect(setServerModelsMock.mock.calls[0]?.[0].imageModel).toBe(""));
    expect(view.getByTestId("effective-image-model").textContent)
      .toBe("Current effective model: GPT Image 2");
    expect(view.getByTestId("effective-music-model").textContent)
      .toBe("Current effective model: Sonilo");
    expect(view.getByTestId("effective-video-model").textContent)
      .toBe("Current effective model: Seedance");
  });

  test("preserves an unavailable explicit selection with its recovery reason", async () => {
    savedConfig.imageModel = "legacy:image-model";
    savedConfig.effectiveImageModel = null;
    const view = render(<ModelsSection />);
    const image = await waitFor(() => view.getByTestId("server-image-model") as HTMLSelectElement);

    expect(image.value).toBe("legacy:image-model");
    expect(image.selectedOptions[0]?.textContent).toBe("legacy:image-model (Unavailable)");
    expect(image.selectedOptions[0]?.disabled).toBe(true);
    expect(view.getByText("This saved model is not present in the current supported catalogue.")).toBeTruthy();
    expect(view.getByTestId("effective-image-model").textContent)
      .toBe("Current effective model: Unavailable");
  });

  test("does not resubmit an unchanged unavailable media selection with another change", async () => {
    savedConfig.imageModel = "legacy:image-model";
    const view = render(<ModelsSection />);
    const stenographer = await waitFor(() =>
      view.getByTestId("server-stenographer-model") as HTMLSelectElement,
    );
    await act(async () => fireEvent.change(stenographer, {
      target: { value: "openai:gpt-5.4-mini" },
    }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));

    await waitFor(() => expect(setServerModelsMock).toHaveBeenCalledTimes(1));
    expect(setServerModelsMock.mock.calls[0]?.[0]).not.toHaveProperty("imageModel");
    expect(setServerModelsMock.mock.calls[0]?.[0].stenographerModel)
      .toBe("openai:gpt-5.4-mini");
  });
});


test("Memory model selection persists independently and inherits Conductor when cleared", async () => {
  const view = render(<ModelsSection />);
  const select = await waitFor(() => view.getByTestId("server-memory-review-model") as HTMLSelectElement);
  expect(select.options[0]?.textContent).toBe("— Inherit Conductor model —");
  expect(select.value).toBe("");
  await act(async () => fireEvent.change(select, { target: { value: "openai:gpt-5.4-mini" } }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));
  await waitFor(() => expect(setServerModelsMock.mock.calls[0]?.[0].memoryReviewModel).toBe("openai:gpt-5.4-mini"));
  await act(async () => fireEvent.change(select, { target: { value: "" } }));
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Save changes" })));
  await waitFor(() => expect(setServerModelsMock.mock.calls[1]?.[0].memoryReviewModel).toBeNull());
});
