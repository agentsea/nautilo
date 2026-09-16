import { describe, expect, test } from "bun:test";
import { presentWorkbenchApplicationTarget } from "../../src/lib/genie-application-targets";

function dependencies(overrides: Partial<Parameters<typeof presentWorkbenchApplicationTarget>[1]> = {}) {
  const navigations: Array<{ to: string; state: unknown }> = [];
  return {
    navigations,
    dependencies: {
      availability: {
        isVerified: true,
        capabilities: [],
        isDesktopShell: false,
      },
      navigate: (to: string, options?: { state?: unknown }) => {
        navigations.push({ to, state: options?.state ?? null });
      },
      customization: {
        hasDesktopBridge: false,
        getAccessToken: async () => "token",
        getTheme: () => null,
      },
      ...overrides,
    },
  };
}

describe("direct client UI action presentation", () => {
  test("uses local routing and target-only spotlight state", () => {
    const { dependencies: deps, navigations } = dependencies();
    return presentWorkbenchApplicationTarget({
      version: 1,
      target: "connections.ssh",
      presentation: "spotlight",
    }, deps).then((result) => {
      expect(result).toEqual({ kind: "presented", target: "connections.ssh" });
      expect(navigations).toEqual([{
        to: "/connections#ssh",
        state: {
          d513GuidePresentation: {
            version: 1,
            target: "connections.ssh",
            presentation: "spotlight",
          },
        },
      }]);
      expect(JSON.stringify(navigations[0]?.state)).not.toContain("actionId");
    });
  });

  test("downgrades a route-only API keys spotlight to its local reveal route without spotlight state", () => {
    const { dependencies: deps, navigations } = dependencies({
      availability: {
        isVerified: true,
        capabilities: ["manage_server_settings"],
        isDesktopShell: false,
        isSelfManaged: true,
      },
    });
    return presentWorkbenchApplicationTarget({
      version: 1,
      target: "admin.provider_credentials",
      presentation: "spotlight",
    }, deps).then((result) => {
      expect(result).toEqual({ kind: "presented", target: "admin.provider_credentials" });
      expect(navigations).toEqual([{ to: "/admin#provider-credentials", state: null }]);
    });
  });

  test("fails truthfully without navigating when current viewer availability rejects a target", () => {
    const { dependencies: deps, navigations } = dependencies({
      availability: { isVerified: false, capabilities: [], isDesktopShell: false },
    });
    return presentWorkbenchApplicationTarget({
      version: 1,
      target: "connections.github_cli",
      presentation: "reveal",
    }, deps).then((result) => {
      expect(result).toMatchObject({ kind: "unsupported" });
      expect(navigations).toEqual([]);
    });
  });

  test("shares the existing browser customization route and turns a native failure into bounded fallback", () => {
    const browser = dependencies();
    return presentWorkbenchApplicationTarget({
      version: 1,
      target: "genie.customization",
      presentation: "reveal",
    }, browser.dependencies).then((browserResult) => {
      expect(browserResult).toEqual({ kind: "presented", target: "genie.customization" });
      expect(browser.navigations).toEqual([{ to: "/customize-genie", state: null }]);

      const nativeFailure = dependencies({
        customization: {
          hasDesktopBridge: true,
          onboardingOpen: async () => { throw new Error("offline"); },
          getAccessToken: async () => "token",
          getTheme: () => null,
        },
      });
      return presentWorkbenchApplicationTarget({
        version: 1,
        target: "genie.customization",
        presentation: "reveal",
      }, nativeFailure.dependencies).then((failureResult) => {
        expect(failureResult.kind).toBe("unsupported");
        if (failureResult.kind === "unsupported") {
          expect(failureResult.fallbackText).toMatch(/visible Genie menu/i);
        }
        expect(nativeFailure.navigations).toEqual([]);
      });
    });
  });
});
