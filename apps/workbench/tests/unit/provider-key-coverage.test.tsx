import "../bun-dom-preload";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import type { KeyReport } from "@nautilo/config-guard";
import { ProviderCredentialsEditor } from "../../src/pages/admin/sections/provider-credentials-section";
import { ProviderKeyCoverage } from "../../src/pages/admin/sections/provider-key-coverage";

let happyWindow: Window;

beforeAll(() => {
  happyWindow = globalThis.__NAUTILO_HAPPY_DOM_WINDOW__!;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => cleanup());

function report(id: string, name: string, status: KeyReport["status"]): KeyReport {
  return {
    id,
    name,
    envVar: `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    category: "llm",
    purpose: `${name} purpose`,
    required: false,
    signupUrl: "https://example.com/key",
    formatHint: "key-…",
    status,
    masked: status === "missing" ? null : "key-…last",
    hint: null,
  };
}

async function flushUntil(predicate: () => boolean, maxTicks = 80): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for provider key coverage state");
}

describe("ProviderKeyCoverage", () => {
  test("renders the exact functionality order and provider mapping", () => {
    const view = render(<ProviderKeyCoverage keys={[]} />);
    const rows = within(view.getByRole("table")).getAllByRole("row").slice(1);

    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
      "Classification, scoring, and Decisions (Surplus pilot account required)",
      "Chat",
      "Image understanding",
      "Embeddings",
      "Text-to-speech",
      "Speech-to-text",
      "Image generation",
      "Music generation",
      "Video generation",
      "Web search",
      "Browser use",
      "Document conversion",
    ]);
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent),
    ).toEqual([
      "TypeSafeOpenRouterVeniceSurplus Intelligence (qualified routes)",
      "VeniceOpenRouterOpenAIAnthropicGooglexAIFireworksTogether AISurplus Intelligence (qualified routes)OpenAI-compatible Gateway",
      "OpenAIAnthropicGoogleOpenRouterVeniceFireworksSurplus Intelligence (qualified models)",
      "VeniceOpenRouterOpenAISurplus Intelligence (Venice 3-large)",
      "ElevenLabs",
      "ElevenLabsGroq",
      "VeniceOpenRouterOpenAIGoogleSurplus Intelligence (generation only; qualified routes)",
      "VeniceSurplus Intelligence (qualified routes)",
      "VeniceSurplus Intelligence (qualified routes)",
      "Tavily",
      "Browser Use",
      "CloudConvert",
    ]);

    expect(within(rows[5]).queryByLabelText(/^OpenAI:/u)).toBeNull();
    expect(view.getAllByLabelText(/no supporting API key configured$/u)).toHaveLength(12);
  });

  test("TypeSafe covers classification, scoring, and Decisions without claiming chat", () => {
    const view = render(<ProviderKeyCoverage keys={[report("typesafe", "TypeSafe", "verified")]} />);
    expect(view.getByLabelText("Classification, scoring, and Decisions (Surplus pilot account required): supporting API key configured")).toBeTruthy();
    expect(view.getByLabelText("Chat: no supporting API key configured")).toBeTruthy();
    expect(view.getAllByLabelText(/supporting API key configured$/u).filter((element) => !element.getAttribute("aria-label")?.includes("no supporting"))).toHaveLength(1);
  });

  test("maps image generation to direct providers and qualified generation-only Surplus routes", () => {
    const view = render(
      <ProviderKeyCoverage
        keys={[
          report("venice", "Venice", "verified"),
          report("openrouter", "OpenRouter", "verified"),
          report("openai", "OpenAI", "verified"),
          report("google", "Google", "verified"),
        ]}
      />,
    );
    const imageRow = view
      .getAllByRole("row")
      .find((row) => within(row).queryByRole("rowheader")?.textContent === "Image generation");

    expect(imageRow).toBeDefined();
    expect(within(imageRow!).getByRole("cell").textContent).toBe(
      "VeniceOpenRouterOpenAIGoogleSurplus Intelligence (generation only; qualified routes)",
    );
    for (const provider of ["Venice", "OpenRouter", "OpenAI", "Google"]) {
      expect(
        within(imageRow!).getByLabelText(`${provider}: API key configured`),
      ).toBeTruthy();
    }
    expect(
      within(imageRow!).getByLabelText(
        "Surplus Intelligence (generation only; qualified routes): API key not configured",
      ),
    ).toBeTruthy();
    expect(within(imageRow!).queryByLabelText(/^Anthropic:/u)).toBeNull();
  });

  test("highlights only the implemented qualified Surplus families", () => {
    const view = render(
      <ProviderKeyCoverage keys={[report("surplus", "Surplus Intelligence", "verified")]} />,
    );

    for (const functionality of [
      "Classification, scoring, and Decisions (Surplus pilot account required)",
      "Chat",
      "Image understanding",
      "Embeddings",
      "Image generation",
      "Music generation",
      "Video generation",
    ]) {
      expect(
        view.getByLabelText(`${functionality}: supporting API key configured`),
      ).toBeTruthy();
    }
    for (const functionality of [
      "Text-to-speech",
      "Speech-to-text",
      "Web search",
      "Browser use",
      "Document conversion",
    ]) {
      expect(
        view.getByLabelText(`${functionality}: no supporting API key configured`),
      ).toBeTruthy();
    }
    expect(view.getByText(/Surplus rows require Prefer Surplus/u)).toBeTruthy();
    expect(view.getByLabelText("Surplus Intelligence (Venice 3-large): API key configured")).toBeTruthy();
  });

  test("maps Groq only to speech-to-text", () => {
    const view = render(
      <ProviderKeyCoverage keys={[report("groq", "Groq", "verified")]} />,
    );

    expect(
      view.getByLabelText("Speech-to-text: supporting API key configured"),
    ).toBeTruthy();
    expect(
      view.getByLabelText("Text-to-speech: no supporting API key configured"),
    ).toBeTruthy();
  });

  test("counts only present and verified reports and highlights only those providers", () => {
    const keys = [
      report("venice", "Venice", "present"),
      report("openrouter", "OpenRouter", "verified"),
      report("openai", "OpenAI", "invalid_key"),
      report("anthropic", "Anthropic", "unreachable"),
      report("google", "Google", "invalid_format"),
      report("fireworks", "Fireworks", "missing"),
      report("elevenlabs", "ElevenLabs", "present"),
      report("tavily", "Tavily", "verified"),
      report("browser-use", "Browser Use", "unreachable"),
      report("cloudconvert", "CloudConvert", "invalid_key"),
    ];
    const view = render(<ProviderKeyCoverage keys={keys} />);

    for (const functionality of [
      "Classification, scoring, and Decisions (Surplus pilot account required)",
      "Chat",
      "Image understanding",
      "Embeddings",
      "Text-to-speech",
      "Speech-to-text",
      "Image generation",
      "Music generation",
      "Video generation",
      "Web search",
    ]) {
      expect(
        view.getByLabelText(`${functionality}: supporting API key configured`),
      ).toBeTruthy();
    }
    for (const functionality of ["Browser use", "Document conversion"]) {
      expect(
        view.getByLabelText(`${functionality}: no supporting API key configured`),
      ).toBeTruthy();
    }

    expect(
      [...view.container.querySelectorAll('span[aria-label$="API key configured"]')].map(
        (chip) => chip.textContent,
      ),
    ).toEqual([
      "OpenRouter",
      "Venice",
      "Venice",
      "OpenRouter",
      "OpenRouter",
      "Venice",
      "Venice",
      "OpenRouter",
      "ElevenLabs",
      "ElevenLabs",
      "Venice",
      "OpenRouter",
      "Venice",
      "Venice",
      "Tavily",
    ]);
    expect(view.getAllByLabelText("OpenAI: API key not configured")).toHaveLength(4);
    expect(view.getByText(/not service availability/u)).toBeTruthy();
    expect(view.getByText(/local alternatives are not evaluated/u)).toBeTruthy();
  });

  test("refreshes coverage from validate response without another summary request", async () => {
    const missing = report("openai", "OpenAI", "missing");
    const verified = { ...missing, status: "verified" as const };
    const keyApi = {
      getKeySummary: mock(async () => ({ keys: [missing], hasLlm: false })),
      setupKeys: mock(async () => ({ success: true })),
      validateKeys: mock(async () => ({
        keys: [verified],
        summary: { total: 1, ok: 1, warnings: 0, errors: 0 },
      })),
      deleteServerProviderKey: mock(async () => ({ success: true })),
    };
    const view = render(
      <ProviderCredentialsEditor keyApi={keyApi} enabled viewerIsVerified />,
    );
    await flushUntil(
      () => view.queryAllByLabelText("OpenAI: API key not configured").length === 4,
    );

    await act(async () => {
      view.getByRole("button", { name: "Validate all" }).dispatchEvent(
        new happyWindow.MouseEvent("click", { bubbles: true }),
      );
    });
    await flushUntil(
      () => view.queryAllByLabelText("OpenAI: API key configured").length === 4,
    );

    expect(keyApi.validateKeys).toHaveBeenCalledTimes(1);
    expect(keyApi.getKeySummary).toHaveBeenCalledTimes(1);
  });

  test("does not expose coverage without permission and renders an unknown shell while loading", async () => {
    const pending = new Promise<never>(() => {});
    const disabledApi = {
      getKeySummary: mock(async () => pending),
      setupKeys: mock(async () => ({ success: true })),
      validateKeys: mock(async () => ({
        keys: [],
        summary: { total: 0, ok: 0, warnings: 0, errors: 0 },
      })),
      deleteServerProviderKey: mock(async () => ({ success: true })),
    };
    const denied = render(
      <ProviderCredentialsEditor keyApi={disabledApi} enabled={false} viewerIsVerified />,
    );
    expect(denied.queryByTestId("provider-key-coverage")).toBeNull();
    expect(denied.getByText(/don't have permission/u)).toBeTruthy();
    expect(disabledApi.getKeySummary).not.toHaveBeenCalled();
    expect(disabledApi.deleteServerProviderKey).not.toHaveBeenCalled();
    denied.unmount();

    const loading = render(
      <ProviderCredentialsEditor keyApi={disabledApi} enabled viewerIsVerified />,
    );
    expect(loading.getByText("Loading key status…")).toBeTruthy();
    expect(loading.getByTestId("provider-key-coverage")).toBeTruthy();
    expect(loading.getAllByLabelText("OpenAI: Checking coverage…")).toHaveLength(4);
    expect(loading.queryAllByLabelText("OpenAI: API key configured")).toHaveLength(0);
    expect(disabledApi.getKeySummary).toHaveBeenCalledTimes(1);
  });
});
