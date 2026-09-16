import { describe, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";

import {
  composeDesktopNonComputerUseCapabilities,
  type DesktopNonComputerUseCapabilityFragment,
} from "../../electron/relay-capabilities.ts";
import type { HostedCapabilityFragment } from "../../electron/relay-hosted-adapters.ts";

function compose(overrides: Partial<{
  browserRuntime: Pick<RelayCapabilities, "canControlBrowser" | "browserSessionId">;
  hasResearchRead: boolean;
  hasResearchConsentRecovery: boolean;
  hasResearchSearch: boolean;
  googleWorkspaceRuntime: Pick<RelayCapabilities, "canUseGoogleWorkspace">;
  hueRuntime: Pick<RelayCapabilities, "canDiscoverHue" | "canControlHue">;
  hosted: HostedCapabilityFragment;
}> = {}): DesktopNonComputerUseCapabilityFragment {
  return composeDesktopNonComputerUseCapabilities({
    browserRuntime: {},
    hasResearchRead: false,
    hasResearchConsentRecovery: false,
    hasResearchSearch: false,
    googleWorkspaceRuntime: {},
    hueRuntime: {},
    hosted: { mcpTools: [] },
    ...overrides,
  });
}

describe("composeDesktopNonComputerUseCapabilities", () => {
  test("returns only the exact empty hosted MCP declaration when no runtime is available", () => {
    expect(compose()).toEqual({ mcpTools: [] });
  });

  test("adds continuation and snapshot inspection exactly when the browser runtime is runnable", () => {
    expect(compose({
      browserRuntime: {
        canControlBrowser: true,
        browserSessionId: "browser-session",
      },
    })).toEqual({
      canControlBrowser: true,
      browserSessionId: "browser-session",
      canContinueBrowserPageRead: true,
      canInspectBrowserPageSnapshot: true,
      mcpTools: [],
    });
    expect(compose({
      browserRuntime: { canControlBrowser: false },
      hasResearchRead: true,
      hasResearchConsentRecovery: true,
      hasResearchSearch: true,
    })).toEqual({ canControlBrowser: false, mcpTools: [] });
  });

  test("advertises research base only for read plus browser and gates optional ports independently", () => {
    expect(compose({
      browserRuntime: { canControlBrowser: true },
      hasResearchRead: true,
    })).toEqual({
      canControlBrowser: true,
      canContinueBrowserPageRead: true,
      canInspectBrowserPageSnapshot: true,
      canResearchWeb: true,
      canDeferResearchChallenges: true,
      canReplayResearchConsent: true,
      mcpTools: [],
    });
    expect(compose({
      browserRuntime: { canControlBrowser: true },
      hasResearchRead: true,
      hasResearchConsentRecovery: true,
      hasResearchSearch: true,
    })).toMatchObject({
      canResearchWeb: true,
      canDeferResearchChallenges: true,
      canReplayResearchConsent: true,
      canRecoverResearchConsent: true,
      canSearchResearchWeb: true,
    });
    expect(compose({
      browserRuntime: { canControlBrowser: true },
      hasResearchConsentRecovery: true,
      hasResearchSearch: true,
    })).not.toHaveProperty("canResearchWeb");
  });

  test("copies the exact cached Google and Hue fragments and current hosted fragment", () => {
    const hosted: HostedCapabilityFragment = {
      mcpTools: [],
      codex: {
        version: 1,
        hostKind: "electron",
        maxProfiles: 4,
        maxActiveTurns: 4,
      },
      acp: {
        version: 2,
        hostKind: "electron",
        registrations: ["opencode-acp"],
      },
      claudeExecution: { version: 1 },
    };
    const result = compose({
      googleWorkspaceRuntime: { canUseGoogleWorkspace: true },
      hueRuntime: { canDiscoverHue: true, canControlHue: true },
      hosted,
    });

    expect(result).toEqual({
      canUseGoogleWorkspace: true,
      canDiscoverHue: true,
      canControlHue: true,
      mcpTools: [],
      codex: hosted.codex,
      acp: hosted.acp,
      claudeExecution: hosted.claudeExecution,
    });
    expect(result.codex).toBe(hosted.codex);
    expect(result.acp).toBe(hosted.acp);
    expect(result.claudeExecution).toBe(hosted.claudeExecution);
  });

  test("reads the supplied hosted fragment on every composition without caching it", () => {
    let hosted: HostedCapabilityFragment = { mcpTools: [] };
    const current = () => compose({ hosted });
    expect(current()).toEqual({ mcpTools: [] });
    hosted = {
      mcpTools: [],
      claude: {
        version: 1,
        hostKind: "electron",
        registrations: ["claude-agent-sdk"],
      },
    };
    expect(current()).toEqual({
      mcpTools: [],
      claude: hosted.claude,
    });
  });

  test("cannot leak Computer Use or media fields from any input fragment", () => {
    const result = composeDesktopNonComputerUseCapabilities({
      browserRuntime: {
        canControlBrowser: true,
        canControlDesktop: true,
        canSeeDesktop: true,
        computerUseSemanticVersion: 1,
      } as Pick<RelayCapabilities, "canControlBrowser" | "browserSessionId">,
      hasResearchRead: false,
      hasResearchConsentRecovery: false,
      hasResearchSearch: false,
      googleWorkspaceRuntime: {
        canUseGoogleWorkspace: true,
        desktopAutomation: { state: "ready" },
      } as unknown as Pick<RelayCapabilities, "canUseGoogleWorkspace">,
      hueRuntime: {
        canDiscoverHue: true,
        mediaExtraction: true,
      } as unknown as Pick<
        RelayCapabilities,
        "canDiscoverHue" | "canControlHue"
      >,
      hosted: {
        mcpTools: [],
        canControlDesktop: true,
        desktopAutomation: { state: "ready" },
      } as unknown as HostedCapabilityFragment,
    });

    expect(result).not.toHaveProperty("canControlDesktop");
    expect(result).not.toHaveProperty("canSeeDesktop");
    expect(result).not.toHaveProperty("computerUseSemanticVersion");
    expect(result).not.toHaveProperty("desktopAutomation");
    expect(Object.keys(result).some((key) => /media/i.test(key))).toBe(false);
  });
});
