import "../bun-dom-preload";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { Window } from "happy-dom";
import {
  BROWSER_USE_API_KEY_ENV_VAR,
  MANAGED_GATEWAY_API_KEY_ENV_VAR,
  type KeyReport,
} from "@nautilo/config-guard";
import { ApiError, type SetupKeysResult } from "@nautilo/api-client/browser";
import { ProviderCredentialsEditor } from "../../src/pages/admin/sections/provider-credentials-section";

let happyWindow: Window;

const keyReport: KeyReport = {
  id: "openai",
  name: "OpenAI",
  envVar: "OPENAI_API_KEY",
  category: "llm",
  purpose: "OpenAI models",
  required: true,
  signupUrl: "https://platform.openai.com/api-keys",
  formatHint: "sk-…",
  status: "missing",
  masked: null,
  hint: null,
};

const browserUseKeyReport: KeyReport = {
  id: "browser-use",
  name: "Browser Use",
  envVar: BROWSER_USE_API_KEY_ENV_VAR,
  category: "browser",
  purpose: "Protected website sign-in and cloud browser automation",
  required: false,
  signupUrl: "https://cloud.browser-use.com/settings?tab=api-keys&new=1",
  formatHint: "bu_...",
  status: "missing",
  masked: null,
  hint: null,
};

const gatewayKeyReport: KeyReport = {
  ...keyReport,
  id: "nautilo-gateway",
  name: "Nautilo Gateway",
  envVar: MANAGED_GATEWAY_API_KEY_ENV_VAR,
  purpose: "Nautilo Gateway access",
  required: false,
};

const apiStub = {
  getKeySummary: mock(async () => ({ keys: [keyReport], hasLlm: false })),
  setupKeys: mock(async (): Promise<SetupKeysResult> => ({
    success: true,
    details: [{ key: keyReport.envVar, action: "applied" }],
  })),
  validateKeys: mock(async () => ({
    keys: [keyReport],
    summary: { total: 1, ok: 0, warnings: 0, errors: 1 },
  })),
  getNautiloGateway: mock(async () => ({ baseUrl: null as string | null })),
  updateNautiloGateway: mock(async (baseUrl: string) => ({ baseUrl })),
};

beforeAll(() => {
  happyWindow = globalThis.__NAUTILO_HAPPY_DOM_WINDOW__!;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  apiStub.getKeySummary.mockReset();
  apiStub.setupKeys.mockReset();
  apiStub.validateKeys.mockReset();
  apiStub.getNautiloGateway.mockReset();
  apiStub.updateNautiloGateway.mockReset();
  apiStub.getKeySummary.mockImplementation(async () => ({
    keys: [keyReport],
    hasLlm: false,
  }));
  apiStub.setupKeys.mockImplementation(async () => ({
    success: true,
    details: [{ key: keyReport.envVar, action: "applied" }],
  }));
  apiStub.getNautiloGateway.mockImplementation(async () => ({ baseUrl: null }));
  apiStub.updateNautiloGateway.mockImplementation(async (baseUrl) => ({ baseUrl }));
});

afterEach(async () => {
  cleanup();
});

async function flushUntil(predicate: () => boolean, maxTicks = 80): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for KeysSection state");
}

async function renderEditor(): Promise<HTMLDivElement> {
  const view = render(
    <ProviderCredentialsEditor
      keyApi={apiStub}
      enabled
      viewerIsVerified
    />,
  );
  await flushUntil(() => view.container.textContent?.includes("Add key") ?? false);
  return view.container;
}

async function beginEdit(container: HTMLElement): Promise<HTMLButtonElement> {
  const addButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add key",
  );
  expect(addButton).toBeDefined();
  await act(async () => {
    addButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
  });

  const input = container.querySelector(
    'input[aria-label="New value for OPENAI_API_KEY"]',
  );
  expect(input).not.toBeNull();
  const reactPropsKey = Object.keys(input!).find((key) =>
    key.startsWith("__reactProps$"),
  );
  const reactProps = reactPropsKey
    ? (input as unknown as Record<string, unknown>)[reactPropsKey]
    : undefined;
  const onChange = (
    reactProps as
      | { onChange?: (event: { target: { value: string } }) => void }
      | undefined
  )?.onChange;
  expect(onChange).toBeDefined();
  await act(async () => {
    onChange?.({ target: { value: "sk-test-provider-key" } });
  });
  await flushUntil(() => {
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    return save?.hasAttribute("disabled") === false;
  });

  const saveButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  expect(saveButton).toBeDefined();
  expect(saveButton?.disabled).toBe(false);
  return saveButton!;
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (input as unknown as Record<string, unknown>)[reactPropsKey]
    : undefined;
  const onChange = (
    reactProps as { onChange?: (event: { target: { value: string } }) => void } | undefined
  )?.onChange;
  expect(onChange).toBeDefined();
  await act(async () => {
    onChange?.({ target: { value } });
  });
}

async function renderGatewayEditor(): Promise<ReturnType<typeof render>> {
  apiStub.getKeySummary.mockImplementation(async () => ({
    keys: [gatewayKeyReport],
    hasLlm: false,
  }));
  const view = render(
    <ProviderCredentialsEditor keyApi={apiStub} enabled viewerIsVerified />,
  );
  await flushUntil(() => view.container.textContent?.includes("Nautilo Gateway API URL") ?? false);
  await flushUntil(() => view.container.textContent?.includes("Edit") ?? false);
  return view;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("KeysSection provider recovery", () => {
  test("shows the non-secret Gateway URL, saves it, and reloads the persisted value", async () => {
    let persisted = "http://127.0.0.1:43318/v1";
    apiStub.getNautiloGateway.mockImplementation(async () => ({ baseUrl: persisted }));
    apiStub.updateNautiloGateway.mockImplementation(async (baseUrl) => {
      persisted = baseUrl;
      return { baseUrl };
    });

    const view = await renderGatewayEditor();
    const onSaved = mock(() => {});
    happyWindow.addEventListener("nautilo:provider-keys-saved", onSaved);
    expect(view.getByText(persisted)).toBeTruthy();
    await act(async () => {
      view.getByRole("button", { name: "Edit" }).click();
    });
    const input = view.getByLabelText(
      "Nautilo Gateway API URL (coming soon)",
    ) as HTMLInputElement;
    expect(input.type).toBe("url");
    expect(input.type).not.toBe("password");
    expect(input.autocomplete).toBe("off");
    await changeInput(input, "https://gateway.example.test/v1");
    await act(async () => {
      view.getByRole("button", { name: "Save" }).click();
    });
    await flushUntil(() => view.container.textContent?.includes("https://gateway.example.test/v1") ?? false);
    expect(apiStub.updateNautiloGateway).toHaveBeenCalledWith("https://gateway.example.test/v1");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((onSaved.mock.calls[0]?.[0] as CustomEvent<unknown>).detail).toBeUndefined();
    happyWindow.removeEventListener("nautilo:provider-keys-saved", onSaved);

    view.unmount();
    const reloaded = await renderGatewayEditor();
    expect(reloaded.getByText("https://gateway.example.test/v1")).toBeTruthy();
    expect(apiStub.getNautiloGateway).toHaveBeenCalledTimes(2);
  });

  test("keeps an invalid Gateway URL editable and recovers on the next save", async () => {
    apiStub.getNautiloGateway.mockImplementation(async () => ({
      baseUrl: "http://127.0.0.1:43318/v1",
    }));
    apiStub.updateNautiloGateway
      .mockImplementationOnce(async () => {
        throw new ApiError(400, "API URL must end in /v1");
      })
      .mockImplementationOnce(async (baseUrl) => ({ baseUrl }));

    const view = await renderGatewayEditor();
    await act(async () => view.getByRole("button", { name: "Edit" }).click());
    const input = view.getByLabelText(
      "Nautilo Gateway API URL (coming soon)",
    ) as HTMLInputElement;
    await changeInput(input, "https://gateway.example.test");
    await act(async () => view.getByRole("button", { name: "Save" }).click());
    await flushUntil(() => view.container.textContent?.includes("API URL must end in /v1") ?? false);
    expect(input.value).toBe("https://gateway.example.test");

    await changeInput(input, "https://gateway.example.test/v1");
    expect(view.queryByText("API URL must end in /v1")).toBeNull();
    await act(async () => view.getByRole("button", { name: "Save" }).click());
    await flushUntil(() => view.container.textContent?.includes("https://gateway.example.test/v1") ?? false);
    expect(apiStub.updateNautiloGateway).toHaveBeenCalledTimes(2);
  });

  test("keeps a forbidden Gateway URL save recoverable without hiding key management", async () => {
    apiStub.getNautiloGateway.mockImplementation(async () => ({
      baseUrl: "http://127.0.0.1:43318/v1",
    }));
    apiStub.updateNautiloGateway.mockImplementationOnce(async () => {
      throw new ApiError(403, "Forbidden");
    });

    const view = await renderGatewayEditor();
    await act(async () => view.getByRole("button", { name: "Edit" }).click());
    const input = view.getByLabelText(
      "Nautilo Gateway API URL (coming soon)",
    ) as HTMLInputElement;
    await changeInput(input, "https://gateway.example.test/v1");
    await act(async () => view.getByRole("button", { name: "Save" }).click());
    await flushUntil(
      () => view.container.textContent?.includes("do not have permission to change") ?? false,
    );
    expect(input.value).toBe("https://gateway.example.test/v1");
    expect(view.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(view.getByText(MANAGED_GATEWAY_API_KEY_ENV_VAR)).toBeTruthy();
  });

  test("shows a forbidden Gateway URL load independently of the key editor", async () => {
    apiStub.getNautiloGateway.mockImplementationOnce(async () => {
      throw new ApiError(403, "Forbidden");
    });
    apiStub.getKeySummary.mockImplementation(async () => ({
      keys: [gatewayKeyReport],
      hasLlm: false,
    }));

    const view = render(
      <ProviderCredentialsEditor keyApi={apiStub} enabled viewerIsVerified />,
    );
    await flushUntil(
      () => view.container.textContent?.includes("do not have permission to view") ?? false,
    );
    expect(view.getByText(MANAGED_GATEWAY_API_KEY_ENV_VAR)).toBeTruthy();
    expect(
      view.queryByLabelText("Nautilo Gateway API URL (coming soon)"),
    ).toBeNull();
  });

  test("guards the Gateway URL against duplicate concurrent saves", async () => {
    apiStub.getNautiloGateway.mockImplementation(async () => ({ baseUrl: null }));
    const pending = deferred<{ baseUrl: string }>();
    apiStub.updateNautiloGateway.mockImplementationOnce(async () => pending.promise);

    const view = await renderGatewayEditor();
    await act(async () => view.getByRole("button", { name: "Edit" }).click());
    const input = view.getByLabelText(
      "Nautilo Gateway API URL (coming soon)",
    ) as HTMLInputElement;
    await changeInput(input, "https://gateway.example.test/v1");
    const saveButton = view.getByRole("button", { name: "Save" });
    act(() => {
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    });
    expect(apiStub.updateNautiloGateway).toHaveBeenCalledTimes(1);
    pending.resolve({ baseUrl: "https://gateway.example.test/v1" });
    await flushUntil(() => view.container.textContent?.includes("https://gateway.example.test/v1") ?? false);
  });

  test("saves the Gateway key under its canonical configuration name", async () => {
    apiStub.setupKeys.mockImplementationOnce(async () => ({
      success: true,
      details: [{ key: MANAGED_GATEWAY_API_KEY_ENV_VAR, action: "applied" }],
    }));
    const view = await renderGatewayEditor();
    await act(async () => {
      view.getByRole("button", { name: "Add key" }).click();
    });
    const input = view.getByLabelText(
      `New value for ${MANAGED_GATEWAY_API_KEY_ENV_VAR}`,
    ) as HTMLInputElement;
    const value = `ngw_${"a".repeat(43)}`;
    await changeInput(input, value);
    await act(async () => {
      view.getByRole("button", { name: "Save" }).click();
    });
    await flushUntil(() => apiStub.setupKeys.mock.calls.length === 1);

    expect(apiStub.setupKeys).toHaveBeenCalledWith(
      { [MANAGED_GATEWAY_API_KEY_ENV_VAR]: value },
      true,
    );
  });

  test("omits Get a key for a provider without a signup destination", async () => {
    apiStub.getKeySummary.mockImplementation(async () => ({
      keys: [keyReport, { ...keyReport, id: "gateway", name: "OpenAI-Compatible Gateway", envVar: "NAUTILO_GATEWAY_API_KEY", signupUrl: "" }],
      hasLlm: false,
    }));
    const container = await renderEditor();
    const links = [...container.querySelectorAll("a")].filter((link) => link.textContent === "Get a key");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(keyReport.signupUrl);
    expect(container.textContent).toContain("NAUTILO_GATEWAY_API_KEY");
  });

  test("orders key fields for onboarding while preserving the remaining registry order", async () => {
    const ids = ["anthropic", "cloudconvert", "openai", "tavily", "gateway", "venice", "groq", "google", "elevenlabs", "fireworks", "openrouter", "browser-use", "nautilo-gateway"];
    const keys = ids.map((id) => ({
      ...keyReport,
      id,
      name: id === "gateway" ? "OpenAI-Compatible Gateway" : id,
      envVar: id === "nautilo-gateway" ? MANAGED_GATEWAY_API_KEY_ENV_VAR : `${id}_API_KEY`,
    }));
    apiStub.getKeySummary.mockImplementation(async () => ({ keys, hasLlm: false }));
    const container = await renderEditor();
    expect([...container.querySelectorAll("code")].map((el) => el.textContent)).toEqual(
      [
        "venice_API_KEY",
        "openrouter_API_KEY",
        "elevenlabs_API_KEY",
        "openai_API_KEY",
        "anthropic_API_KEY",
        "google_API_KEY",
        "fireworks_API_KEY",
        "groq_API_KEY",
        "cloudconvert_API_KEY",
        "tavily_API_KEY",
        "browser-use_API_KEY",
        "gateway_API_KEY",
        MANAGED_GATEWAY_API_KEY_ENV_VAR,
      ],
    );
    expect([...container.querySelectorAll("label")].slice(-3).map((el) => el.textContent)).toEqual([
      "OpenAI-Compatible Gateway",
      "Nautilo Gateway API URL (coming soon)",
      "Nautilo Gateway key (coming soon)",
    ]);
    expect(keys.map((key) => key.id)).toEqual(ids);
  });

  test("renders Browser Use as an ordinary server-managed API key", async () => {
    apiStub.getKeySummary.mockImplementationOnce(async () => ({
      keys: [browserUseKeyReport],
      hasLlm: false,
    }));

    const container = await renderEditor();

    expect(container.textContent).toContain("Browser Use");
    expect(container.textContent).toContain(BROWSER_USE_API_KEY_ENV_VAR);
    expect(container.textContent).toContain(browserUseKeyReport.purpose);
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Add key",
      ),
    ).toBe(true);
  });

  test("emits one payload-free refresh event only after successful save refresh", async () => {
    const refresh = deferred<{ keys: KeyReport[]; hasLlm: boolean }>();
    apiStub.getKeySummary
      .mockImplementationOnce(async () => ({ keys: [keyReport], hasLlm: false }))
      .mockImplementationOnce(async () => refresh.promise);

    const container = await renderEditor();
    const saveButton = await beginEdit(container);
    // Draft input is local editor state, not saved key coverage.
    expect(
      container.querySelectorAll('[aria-label="OpenAI: API key not configured"]'),
    ).toHaveLength(3);
    expect(
      container.querySelector('[aria-label="OpenAI: API key configured"]'),
    ).toBeNull();
    const events: Event[] = [];
    const onSaved = (event: Event) => events.push(event);
    happyWindow.addEventListener("nautilo:provider-keys-saved", onSaved);

    await act(async () => {
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiStub.setupKeys).toHaveBeenCalledTimes(1);
    expect(apiStub.getKeySummary).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(0);

    refresh.resolve({
      keys: [{ ...keyReport, status: "present", masked: "sk-…-key" }],
      hasLlm: true,
    });
    await flushUntil(() => events.length === 1);
    expect(events).toHaveLength(1);
    expect(
      container.querySelector('[aria-label="OpenAI: API key configured"]'),
    ).not.toBeNull();
    expect((events[0] as CustomEvent<unknown>).detail).toBeUndefined();
    happyWindow.removeEventListener("nautilo:provider-keys-saved", onSaved);
  });

  test("rolled-back failure stays editable with inline error and emits no event", async () => {
    apiStub.setupKeys.mockImplementationOnce(async () => ({
      success: false,
      error: "Transaction rolled back",
      details: [
        {
          key: keyReport.envVar,
          action: "failed",
          reason: "Provider rejected; changes rolled back",
        },
      ],
      rolledBack: true,
    }) as SetupKeysResult);

    const container = await renderEditor();
    const saveButton = await beginEdit(container);
    const onSaved = mock(() => {});
    happyWindow.addEventListener("nautilo:provider-keys-saved", onSaved);

    await act(async () => {
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(
      () => container.textContent?.includes("Provider rejected; changes rolled back") ?? false,
    );

    expect(onSaved).not.toHaveBeenCalled();
    expect(apiStub.getKeySummary).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('input[aria-label="New value for OPENAI_API_KEY"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Provider rejected; changes rolled back",
    );
    happyWindow.removeEventListener("nautilo:provider-keys-saved", onSaved);
  });

  test("duplicate concurrent save invokes setupKeys once", async () => {
    const pending = deferred<SetupKeysResult>();
    apiStub.setupKeys.mockImplementationOnce(async () => pending.promise);

    const container = await renderEditor();
    const saveButton = await beginEdit(container);
    act(() => {
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      saveButton.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    });
    expect(apiStub.setupKeys).toHaveBeenCalledTimes(1);

    pending.resolve({
      success: false,
      error: "Save cancelled",
      details: [{ key: keyReport.envVar, action: "failed", reason: "Save cancelled" }],
    });
    await flushUntil(() => container.textContent?.includes("Save cancelled") ?? false);
  });
});
