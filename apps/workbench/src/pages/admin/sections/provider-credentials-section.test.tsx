import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KeyReport } from "@nautilo/config-guard";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { ProviderCredentialsEditor } from "./provider-credentials-section";

function key(overrides: Partial<KeyReport>): KeyReport {
  const id = overrides.id ?? "openai";
  return {
    id,
    name: overrides.name ?? id,
    envVar: overrides.envVar ?? `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    category: "llm",
    purpose: "Provider models",
    required: false,
    signupUrl: "",
    formatHint: "key-...",
    status: "present",
    masked: "key-…1234",
    hint: null,
    ...overrides,
  };
}

function api(initialKeys: KeyReport[]) {
  return {
    getKeySummary: mock(async () => ({ keys: initialKeys, hasLlm: true })),
    setupKeys: mock(async () => ({ success: true })),
    validateKeys: mock(async (_providerId?: string) => ({
      keys: initialKeys,
      summary: { total: initialKeys.length, valid: initialKeys.length, invalid: 0, unreachable: 0 },
    })),
    deleteServerProviderKey: mock(async () => ({ success: true })),
    getNautiloGateway: mock(async () => ({ baseUrl: null })),
    updateNautiloGateway: mock(async (baseUrl: string) => ({ baseUrl })),
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

describe("ProviderCredentialsEditor", () => {
  test("uses the shared stable order and shows masked previews with per-row actions", async () => {
    const keys = [
      key({ id: "anthropic", name: "Anthropic", status: "missing", masked: null }),
      key({ id: "custom-one", name: "Custom one" }),
      key({ id: "openai", name: "OpenAI", masked: "sk-…1234" }),
      key({ id: "custom-two", name: "Custom two" }),
      key({ id: "gateway", name: "Gateway" }),
    ];
    const view = render(<ProviderCredentialsEditor
      keyApi={api(keys)}
      enabled
      viewerIsVerified
    />);

    await view.findByText("sk-…1234");
    expect([...view.container.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      "OpenAI",
      "Anthropic",
      "Custom one",
      "Custom two",
      "Gateway",
    ]);
    expect(view.getByRole("button", { name: "Replace OpenAI key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Validate OpenAI key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Delete OpenAI key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Add Anthropic key" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("unmasked-secret");
  });

  test("routes targeted validation and deletion while retaining Validate all", async () => {
    const openai = key({ id: "openai", name: "OpenAI", masked: "sk-…1234" });
    const keyApi = api([openai]);
    let refreshEvents = 0;
    window.addEventListener("nautilo:provider-keys-saved", () => { refreshEvents += 1; }, { once: true });
    const view = render(<ProviderCredentialsEditor keyApi={keyApi} enabled viewerIsVerified />);

    await view.findByText("sk-…1234");
    fireEvent.click(view.getByRole("button", { name: "Replace OpenAI key" }));
    const user = userEvent.setup({ document: globalThis.document });
    await user.type(view.getByLabelText("New value for OPENAI_API_KEY"), "server-replacement");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(keyApi.setupKeys).toHaveBeenCalledWith(
      { OPENAI_API_KEY: "server-replacement" },
      true,
    ));

    fireEvent.click(view.getByRole("button", { name: "Validate OpenAI key" }));
    await waitFor(() => expect(keyApi.validateKeys).toHaveBeenCalledWith("openai"));

    fireEvent.click(view.getByRole("button", { name: "Validate all" }));
    await waitFor(() => expect(keyApi.validateKeys).toHaveBeenCalledWith());

    fireEvent.click(view.getByRole("button", { name: "Delete OpenAI key" }));
    expect(view.getByText("Delete this server key?")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteServerProviderKey).toHaveBeenCalledWith("openai"));
    await waitFor(() => expect(refreshEvents).toBe(1));
    expect(view.getByRole("button", { name: "Add OpenAI key" })).toBeTruthy();
    expect(view.queryByText("sk-…1234")).toBeNull();
  });

  test("keeps the loaded key list visible when a targeted action fails", async () => {
    const openai = key({ id: "openai", name: "OpenAI", masked: "sk-…1234" });
    const keyApi = api([openai]);
    keyApi.validateKeys = mock(async () => {
      throw new Error("Provider unavailable");
    });
    const view = render(<ProviderCredentialsEditor keyApi={keyApi} enabled viewerIsVerified />);

    await view.findByText("sk-…1234");
    fireEvent.click(view.getByRole("button", { name: "Validate OpenAI key" }));

    expect(await view.findByText("Provider unavailable")).toBeTruthy();
    expect(view.getByText("sk-…1234")).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace OpenAI key" })).toBeTruthy();
  });
});
