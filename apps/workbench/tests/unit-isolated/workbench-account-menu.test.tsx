import { act } from "react";
import type { ReactNode } from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;
let clientRoot: Root | null = null;
let viewerRole: "owner" | "member" = "owner";
let setupStatusFailure: Error | null = null;
let setupServerUrl = "http://localhost:6201";
const copiedText: string[] = [];
const getSetupStatus = mock(async () => {
  if (setupStatusFailure) throw setupStatusFailure;
  return { serverUrl: setupServerUrl };
});

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  Object.defineProperty(happyWindow.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedText.push(value);
      },
    },
  });

  mock.module("../../src/lib/api", () => ({
    apiClient: { getSetupStatus },
  }));

  mock.module("../../src/lib/desktop", () => ({
    isDesktop: true,
    getShellStateOnBoot: () => {
      if (typeof window === "undefined") return null;
      const api = (
        window as unknown as {
          nautiloDesktop?: {
            shellStateOnBoot?: () => import("../../src/lib/desktop").ShellStateOnBoot;
          };
        }
      ).nautiloDesktop;
      const fn = api?.shellStateOnBoot;
      if (typeof fn !== "function") return null;
      try {
        return fn();
      } catch {
        return null;
      }
    },
    computeInitialLastOpenAtSeed: (input: {
      hasEverBeenOpen: boolean;
      shellStateOnBoot: unknown;
      now: number;
    }) => {
      const base = input.hasEverBeenOpen ? input.now : null;
      if (
        input.shellStateOnBoot != null &&
        input.shellStateOnBoot !== "live" &&
        base === null
      ) {
        return input.now;
      }
      return base;
    },
  }));

  mock.module("../../src/hooks/use-auth", () => ({
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    computeViewerOnWhoamiFailure: (
      prev: { staleWhoami?: boolean } & Record<string, unknown>,
    ) => (prev?.staleWhoami ? prev : { ...prev, staleWhoami: true }),
    computeViewerOnNullToken: (cached: Record<string, unknown> | null) =>
      cached
        ? { ...cached, staleWhoami: true }
        : {
            role: "guest",
            label: "Guest",
            userIdentity: null,
            sessionUserId: null,
            isVerified: false,
            staleWhoami: false,
          },
    useAuth: () => ({
      session: {
        state: "signed-in" as const,
        signIn: async () => {},
        signOut: async () => {},
        getAccessToken: async () => "token",
      },
      viewer: {
        role: viewerRole,
        label: "Operator",
        userIdentity: "u",
        sessionUserId: "user-1",
        sessionActorId: "actor-1",
        isVerified: true,
        staleWhoami: false,
      },
    }),
  }));
});

beforeEach(async () => {
  if (clientRoot) {
    await act(async () => {
      clientRoot!.unmount();
    });
    clientRoot = null;
  }
  viewerRole = "owner";
  setupStatusFailure = null;
  setupServerUrl = "http://localhost:6201";
  copiedText.length = 0;
  getSetupStatus.mockClear();
});

afterAll(async () => {
  if (clientRoot) {
    await act(async () => {
      clientRoot!.unmount();
    });
    clientRoot = null;
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
  mock.restore();
});

async function renderAccountMenu(): Promise<HTMLElement> {
  const { WorkbenchAccountMenu } =
    await import("../../src/components/workbench-account-menu");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.replaceChildren(container);
  clientRoot = createRoot(container);
  await act(async () => {
    clientRoot!.render(
      <MemoryRouter>
        <WorkbenchAccountMenu variant="header" />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const toggle = container.querySelector('button[aria-haspopup="menu"]');
  await act(async () => {
    (toggle as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function clickButton(
  container: ParentNode,
  label: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WorkbenchAccountMenu", () => {
  test("never renders the everyday Switch server entry", async () => {
    const container = await renderAccountMenu();
    expect(container.innerHTML).not.toContain("Switch server…");
    expect(container.innerHTML).not.toContain(
      'data-testid="account-switch-server"',
    );
  });

  test("gives owners a durable Server Guide entry above Settings", async () => {
    const html = (await renderAccountMenu()).innerHTML;
    expect(html).toContain("Server Guide");
    expect(html.indexOf("Server Guide")).toBeLessThan(html.indexOf("Settings"));
  });

  test("lets a regular member open the Desktop guide and copy the canonical URL", async () => {
    viewerRole = "member";
    setupServerUrl = "http://[::1]:6201";
    const container = await renderAccountMenu();
    const accountButton = container.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    )!;

    expect(container.textContent).not.toContain("Server Guide");
    await clickButton(container, "Connect Desktop");

    expect(getSetupStatus).toHaveBeenCalledTimes(1);
    expect(
      happyWindow.document.querySelector('[role="dialog"]'),
    ).not.toBeNull();
    expect(
      happyWindow.document.querySelector(
        '[data-testid="desktop-connection-url"]',
      )?.textContent,
    ).toBe("http://[::1]:6201");
    expect(happyWindow.document.body.textContent).toContain(
      "works only when Desktop is on the computer running the server",
    );
    expect(happyWindow.document.activeElement?.getAttribute("aria-label")).toBe(
      "Close",
    );

    await clickButton(happyWindow.document.body, "Copy URL");
    expect(copiedText).toEqual(["http://[::1]:6201"]);
    expect(happyWindow.document.body.textContent).toContain("Copied");

    const closeButton = happyWindow.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )!;
    const copyButton = Array.from(
      happyWindow.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Copied")!;
    copyButton.focus();
    await act(async () => {
      happyWindow.dispatchEvent(
        new happyWindow.KeyboardEvent("keydown", { key: "Tab" }),
      );
    });
    expect(happyWindow.document.activeElement).toBe(closeButton);

    await act(async () => {
      happyWindow.dispatchEvent(
        new happyWindow.KeyboardEvent("keydown", { key: "Escape" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(happyWindow.document.querySelector('[role="dialog"]')).toBeNull();
    expect(happyWindow.document.activeElement).toBe(accountButton);
  });

  test("lets a member retry when loading the canonical URL fails", async () => {
    viewerRole = "member";
    setupStatusFailure = new Error("unavailable");
    const container = await renderAccountMenu();

    await clickButton(container, "Connect Desktop");
    expect(happyWindow.document.body.textContent).toContain(
      "The server address is temporarily unavailable.",
    );

    setupStatusFailure = null;
    await clickButton(happyWindow.document.body, "Retry");

    expect(getSetupStatus).toHaveBeenCalledTimes(2);
    expect(
      happyWindow.document.querySelector(
        '[data-testid="desktop-connection-url"]',
      )?.textContent,
    ).toBe("http://localhost:6201");
  });

  test("SSR smoke: header variant renders account control", async () => {
    const { WorkbenchAccountMenu } =
      await import("../../src/components/workbench-account-menu");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WorkbenchAccountMenu variant="header" />
      </MemoryRouter>,
    );
    expect(html).toContain("Account menu");
  });
});
