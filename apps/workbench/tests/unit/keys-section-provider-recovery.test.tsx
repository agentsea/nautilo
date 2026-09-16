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
  type KeyReport,
} from "@nautilo/config-guard";
import type { SetupKeysResult } from "@nautilo/api-client/browser";
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
};

beforeAll(() => {
  happyWindow = globalThis.__NAUTILO_HAPPY_DOM_WINDOW__!;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  apiStub.getKeySummary.mockReset();
  apiStub.setupKeys.mockReset();
  apiStub.validateKeys.mockReset();
  apiStub.getKeySummary.mockImplementation(async () => ({
    keys: [keyReport],
    hasLlm: false,
  }));
  apiStub.setupKeys.mockImplementation(async () => ({
    success: true,
    details: [{ key: keyReport.envVar, action: "applied" }],
  }));
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
    const ids = ["anthropic", "cloudconvert", "openai", "tavily", "gateway", "venice", "groq", "google", "elevenlabs", "fireworks", "openrouter", "browser-use"];
    const keys = ids.map((id) => ({ ...keyReport, id, name: id, envVar: `${id}_API_KEY` }));
    apiStub.getKeySummary.mockImplementation(async () => ({ keys, hasLlm: false }));
    const container = await renderEditor();
    expect([...container.querySelectorAll("code")].map((el) => el.textContent)).toEqual(
      ["venice", "openrouter", "elevenlabs", "openai", "anthropic", "google", "fireworks", "groq", "cloudconvert", "tavily", "browser-use", "gateway"].map((id) => `${id}_API_KEY`),
    );
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
