import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  VoiceControlsContext,
  type VoiceControls,
} from "../../src/adapters/runtime-contexts";
import {
  serversIconState,
  serversToggleIntent,
} from "../../src/components/navigation-rail/left-column-nav";

const voiceState: VoiceControls = {
  enabled: false,
  playing: false,
  toggle: () => {},
  stop: () => {},
  sendText: () => Promise.resolve(false),
};

let NavigationRail: (typeof import("../../src/components/navigation-rail/navigation-rail"))["NavigationRail"];

beforeAll(async () => {
  // NavigationRail reads useCan/useViewerAffordances through useAuth. Stub auth
  // (not use-viewer-affordances) so parallel test files keep the real hook.
  mock.module("../../src/hooks/use-auth", () => ({
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    computeViewerOnWhoamiFailure: (prev: { staleWhoami?: boolean } & Record<string, unknown>) =>
      prev?.staleWhoami ? prev : { ...prev, staleWhoami: true },
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
      viewer: {
        role: "owner" as const,
        label: "Operator",
        userIdentity: "user-1",
        sessionUserId: "user-1",
        sessionActorId: null,
        isVerified: true,
        capabilities: [],
      },
    }),
  }));
  mock.module("../../src/hooks/use-can", () => ({
    useCan: () => () => false,
  }));

  ({ NavigationRail } = await import(
    "../../src/components/navigation-rail/navigation-rail"
  ));
});

afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  mock.restore();
});

function renderRail(children: ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <VoiceControlsContext.Provider value={voiceState}>
        {children}
      </VoiceControlsContext.Provider>
    </MemoryRouter>,
  );
}

describe("NavigationRail", () => {
  test("models Servers as a mutually-exclusive browser-column mode", () => {
    const state = {
      panelEligible: true,
      browserMode: "artifacts" as const,
      browserCollapsed: false,
    };
    expect(serversIconState(state)).toBe("inactive");
    expect(serversToggleIntent(state)).toEqual({
      browserMode: "servers", collapsed: false, navigateHome: false, minimumWidthPx: 360,
    });
  });

  test("renders the Settings destination", () => {
    expect(
      renderRail(
        <NavigationRail
          identityLabel="Operator"
          identityRole="owner"
          onAction={() => {}}
        />,
      ),
    ).toContain("Settings");
  });

  // D303: the rail no longer owns Home (moved to the NAUTILO wordmark) or an
  // Open-folder action (folder picking lives in the Files panel; the left-column
  // panel toggles are mounted via the shell's extraSection, not these items).
  test("no longer renders Home or Open folder rail items", () => {
    const html = renderRail(
      <NavigationRail
        identityLabel="Operator"
        identityRole="owner"
        onAction={() => {}}
      />,
    );
    expect(html).not.toContain("Open folder");
    expect(html).not.toContain(">Home<");
    expect(html).not.toContain('aria-label="Home"');
  });

  // D365 — theme toggle lives on the rail when theme props are supplied.
  test("renders the theme toggle when theme props are provided", () => {
    const html = renderRail(
      <NavigationRail
        identityLabel="Operator"
        identityRole="owner"
        onAction={() => {}}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(html).toContain('data-testid="navigation-rail-theme-toggle"');
    expect(html).toContain('aria-label="Dark mode"');
  });

  test("omits the theme toggle when theme props are absent", () => {
    expect(
      renderRail(
        <NavigationRail
          identityLabel="Operator"
          identityRole="owner"
          onAction={() => {}}
        />,
      ),
    ).not.toContain('data-testid="navigation-rail-theme-toggle"');
  });
});
