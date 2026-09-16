import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

const source = readFileSync(
  join(import.meta.dir, "../../src/pages/settings/sections/mobile-access-section.tsx"),
  "utf8",
);
const settingsPage = readFileSync(
  join(import.meta.dir, "../../src/pages/settings/settings-page.tsx"),
  "utf8",
);
const devicesSection = readFileSync(
  join(import.meta.dir, "../../src/pages/settings/sections/devices-section.tsx"),
  "utf8",
);
const personalDevicesSection = readFileSync(
  join(import.meta.dir, "../../src/pages/settings/sections/personal-devices-section.tsx"),
  "utf8",
);

const readiness = {
  relayReady: true,
  relayStatus: "connected",
  keepAwakeEnabled: false,
  keepAwakePolicy: "off" as const,
  keepAwakeSupported: true,
  macosLidClosedGuidance: null,
};
const challenge = {
  deepLink: "nautilo://pair?challenge=server-authored",
  ceremonyContext: "server-authored-context",
  qrSecret: "server-authored-qr-secret",
  manualCode: "238 941",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const freshAuthIpcError = new Error(
  "Error invoking remote method 'remoteControl:createChallenge': ApiError: fresh_reauth_required",
);

let createChallengeImpl: () => Promise<typeof challenge> = async () => challenge;
let stepUpImpl: (
  opts?: { maxAgeSeconds?: number },
) => Promise<{ accessToken: string; issuedAt: number } | { error: "cancelled" }> = async () => ({
  accessToken: "fresh-token",
  issuedAt: 1,
});
const createChallengeMock = mock(() => createChallengeImpl());
const stepUpMock = mock((opts?: { maxAgeSeconds?: number }) => stepUpImpl(opts));
const getReadinessMock = mock(async () => readiness);
let listControllersImpl: () => Promise<{ controllers: Array<{
  bindingId: string;
  installationId: string;
  label: string | null;
  remoteHostId: string;
  createdAt: string;
  lastSeenAt: string | null;
}> }> = async () => ({ controllers: [] });
const listControllersMock = mock(() => listControllersImpl());
let revokeControllerImpl: (bindingId: string) => Promise<{ ok: true }> = async () => ({ ok: true });
const revokeControllerMock = mock((bindingId: string) => revokeControllerImpl(bindingId));

let MobileAccessSection: (typeof import("../../src/pages/settings/sections/mobile-access-section"))["MobileAccessSection"];
let happyWindow: Window;
let root: Root | null = null;
const priorGlobals: Record<string, unknown> = {};

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
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
  mock.module("qrcode.react", () => ({
    QRCodeSVG: (props: { value: string }) =>
      createElement("svg", { "data-testid": "mobile-access-qr", "data-value": props.value }),
  }));
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: true,
    desktopAPI: {
      auth: { stepUp: stepUpMock },
      remoteControl: {
        getReadiness: getReadinessMock,
        listControllers: listControllersMock,
        createChallenge: createChallengeMock,
        setKeepAwakePolicy: async () => ({ ok: true, enabled: false, policy: "off" }),
        renameController: async () => ({ ok: true }),
        revokeController: revokeControllerMock,
      },
    },
  }));
  ({ MobileAccessSection } = await import("../../src/pages/settings/sections/mobile-access-section"));
});

beforeEach(() => {
  createChallengeImpl = async () => challenge;
  stepUpImpl = async () => ({ accessToken: "fresh-token", issuedAt: 1 });
  listControllersImpl = async () => ({ controllers: [] });
  createChallengeMock.mockClear();
  stepUpMock.mockClear();
  getReadinessMock.mockClear();
  listControllersMock.mockClear();
  revokeControllerImpl = async () => ({ ok: true });
  revokeControllerMock.mockClear();
});

afterAll(async () => {
  if (root) await act(async () => root?.unmount());
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) globals[key] = value;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  mock.restore();
});

async function renderSection() {
  if (root) await act(async () => root?.unmount());
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(MobileAccessSection));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  expect(match).toBeDefined();
  return match!;
}

async function beginPairing(container: HTMLElement) {
  await act(async () => {
    button(container, "Pair a phone").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain("Confirm it’s you");
  await act(async () => {
    button(container, "Continue").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("mobile access desktop settings surface", () => {
  test("renders the local QR encoder with the exact server-authored deep link", () => {
    expect(source).toContain('import { QRCodeSVG } from "qrcode.react"');
    expect(source).toContain("value={challenge.deepLink}");
    expect(source).toContain("mobile-access-manual-code");
  });

  test("does not confuse tool capabilities with access to the Human's controller fleet", () => {
    expect(source).not.toContain("useCan");
    expect(source).not.toContain("control_desktop");
    expect(source).not.toContain("control_home");
    expect(source).toContain("pendingRevokeId");
    expect(source).toContain("Confirm revoke");
  });

  test("is a nested Mobile controllers section with a bounded fresh-auth recovery", () => {
    expect(source).toContain('id="mobile-access"');
    expect(source).toContain("Mobile controllers");
    expect(source).toContain("Pair a phone");
    expect(source).toContain("Confirm it’s you");
    expect(source).toContain("desktopAPI.auth.stepUp({ maxAgeSeconds: 60 })");
    expect(source).toContain("FRESH_AUTH_RECOVERY_COPY");
    expect(source).toContain("withFreshReauthentication");
  });

  test("groups both purpose-specific fleets under Devices without merging their state", () => {
    expect(settingsPage).not.toContain('{ id: "mobile-access", label: "Mobile access", catalogueTarget: "settings.mobile_access" }');
    expect(settingsPage).toContain('{ id: "mobile-access", label: "Mobile controllers", catalogueTarget: "settings.mobile_access", parentId: "devices" }');
    expect(settingsPage).toContain("<PersonalDevicesSection />");
    expect(personalDevicesSection).toContain("<WorkComputersSection />");
    expect(personalDevicesSection).toContain("<MobileAccessSection />");
    expect(devicesSection).not.toContain("MobileAccessSection");
  });

  test("never makes a relay bearer part of the renderer view model", () => {
    expect(source).not.toContain("relayToken");
  });

  test("re-authenticates once then creates the pairing challenge", async () => {
    const responses = [freshAuthIpcError, challenge];
    createChallengeImpl = async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response!;
    };
    const container = await renderSection();

    await beginPairing(container);

    expect(createChallengeMock).toHaveBeenCalledTimes(2);
    expect(stepUpMock).toHaveBeenCalledTimes(1);
    expect(stepUpMock).toHaveBeenCalledWith({ maxAgeSeconds: 60 });
    expect(container.querySelector('[data-testid="mobile-access-pairing-challenge"]')).not.toBeNull();
    expect(container.textContent).toContain(challenge.manualCode);
  });

  test("clears a consumed challenge when the paired-controller snapshot changes", async () => {
    let paired = false;
    listControllersImpl = async () => ({
      controllers: paired
        ? [{
            bindingId: "00000000-0000-4000-8000-000000000071",
            installationId: "00000000-0000-4000-8000-000000000081",
            label: null,
            remoteHostId: "00000000-0000-4000-8000-000000000071",
            createdAt: "2026-07-29T00:00:00.000Z",
            lastSeenAt: "2026-07-29T00:00:01.000Z",
          }]
        : [],
    });
    const container = await renderSection();
    await beginPairing(container);
    expect(container.querySelector('[data-testid="mobile-access-pairing-challenge"]')).not.toBeNull();

    paired = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    expect(container.querySelector('[data-testid="mobile-access-pairing-challenge"]')).toBeNull();
    expect(container.textContent).toContain("Unnamed phone");
  });

  test("leaves setup unchanged when Logto reauthentication is cancelled", async () => {
    createChallengeImpl = async () => { throw freshAuthIpcError; };
    stepUpImpl = async () => ({ error: "cancelled" });
    const container = await renderSection();

    await beginPairing(container);

    expect(createChallengeMock).toHaveBeenCalledTimes(1);
    expect(stepUpMock).toHaveBeenCalledWith({ maxAgeSeconds: 60 });
    expect(container.querySelector('[data-testid="mobile-access-pairing-challenge"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-access-pairing-confirmation"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Pair a phone");
  });

  test("contains repeatedly rejected pairing errors after the one permitted retry", async () => {
    const rawSecondError = new Error(
      "Error invoking remote method 'remoteControl:createChallenge': ApiError: fresh_reauth_required",
    );
    const responses = [freshAuthIpcError, rawSecondError];
    createChallengeImpl = async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response!;
    };
    const container = await renderSection();

    await beginPairing(container);

    expect(createChallengeMock).toHaveBeenCalledTimes(2);
    expect(stepUpMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="mobile-access-pairing-challenge"]')).toBeNull();
    const alertCopy = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alertCopy).toContain("We couldn't confirm your sign-in for mobile controllers.");
    expect(alertCopy).not.toContain("ApiError");
    expect(alertCopy).not.toContain("remoteControl:createChallenge");
    expect(alertCopy).not.toContain("fresh_reauth_required");
  });

  test("re-authenticates once then revokes a stale phone without exposing IPC errors", async () => {
    listControllersImpl = async () => ({
      controllers: [{
        bindingId: "00000000-0000-4000-8000-000000000071",
        installationId: "00000000-0000-4000-8000-000000000081",
        label: null,
        remoteHostId: "00000000-0000-4000-8000-000000000071",
        createdAt: "2026-07-29T00:00:00.000Z",
        lastSeenAt: null,
      }],
    });
    const responses = [freshAuthIpcError, { ok: true } as const];
    revokeControllerImpl = async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response!;
    };
    const container = await renderSection();

    await act(async () => {
      button(container, "Revoke").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      button(container, "Confirm revoke").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(revokeControllerMock).toHaveBeenCalledTimes(2);
    expect(stepUpMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
