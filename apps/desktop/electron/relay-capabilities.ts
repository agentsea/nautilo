import type { RelayCapabilities } from "@nautilo/relay";

import type { HostedCapabilityFragment } from "./relay-hosted-adapters.ts";

type BrowserRuntimeFragment = Pick<
  RelayCapabilities,
  "canControlBrowser" | "browserSessionId"
>;

type GoogleWorkspaceRuntimeFragment = Pick<
  RelayCapabilities,
  "canUseGoogleWorkspace"
>;

type HueRuntimeFragment = Pick<
  RelayCapabilities,
  "canDiscoverHue" | "canControlHue"
>;

export type DesktopNonComputerUseCapabilityFragment = Partial<
  Pick<
    RelayCapabilities,
    | "canControlBrowser"
    | "browserSessionId"
    | "canContinueBrowserPageRead"
    | "canInspectBrowserPageSnapshot"
    | "canResearchWeb"
    | "canDeferResearchChallenges"
    | "canReplayResearchConsent"
    | "canRecoverResearchConsent"
    | "canSearchResearchWeb"
    | "canUseGoogleWorkspace"
    | "canDiscoverHue"
    | "canControlHue"
    | "codex"
    | "acp"
    | "claude"
    | "claudeExecution"
  >
> & Pick<RelayCapabilities, "mcpTools">;

/** Pure allowlisted composition of non-Computer-Use Desktop capabilities. */
export function composeDesktopNonComputerUseCapabilities(input: {
  readonly browserRuntime: BrowserRuntimeFragment;
  readonly hasResearchRead: boolean;
  readonly hasResearchConsentRecovery: boolean;
  readonly hasResearchSearch: boolean;
  readonly googleWorkspaceRuntime: GoogleWorkspaceRuntimeFragment;
  readonly hueRuntime: HueRuntimeFragment;
  readonly hosted: HostedCapabilityFragment;
}): DesktopNonComputerUseCapabilityFragment {
  const browserRunnable = input.browserRuntime.canControlBrowser === true;
  const researchRunnable = input.hasResearchRead && browserRunnable;

  return {
    ...(input.browserRuntime.canControlBrowser === undefined
      ? {}
      : { canControlBrowser: input.browserRuntime.canControlBrowser }),
    ...(input.browserRuntime.browserSessionId === undefined
      ? {}
      : { browserSessionId: input.browserRuntime.browserSessionId }),
    ...(browserRunnable
      ? {
          canContinueBrowserPageRead: true,
          canInspectBrowserPageSnapshot: true,
        }
      : {}),
    ...(researchRunnable
      ? {
          canResearchWeb: true,
          canDeferResearchChallenges: true,
          canReplayResearchConsent: true,
          ...(input.hasResearchConsentRecovery
            ? { canRecoverResearchConsent: true }
            : {}),
          ...(input.hasResearchSearch ? { canSearchResearchWeb: true } : {}),
        }
      : {}),
    ...(input.googleWorkspaceRuntime.canUseGoogleWorkspace === undefined
      ? {}
      : {
          canUseGoogleWorkspace:
            input.googleWorkspaceRuntime.canUseGoogleWorkspace,
        }),
    ...(input.hueRuntime.canDiscoverHue === undefined
      ? {}
      : { canDiscoverHue: input.hueRuntime.canDiscoverHue }),
    ...(input.hueRuntime.canControlHue === undefined
      ? {}
      : { canControlHue: input.hueRuntime.canControlHue }),
    mcpTools: input.hosted.mcpTools,
    ...(input.hosted.codex === undefined ? {} : { codex: input.hosted.codex }),
    ...(input.hosted.acp === undefined ? {} : { acp: input.hosted.acp }),
    ...(input.hosted.claude === undefined
      ? {}
      : { claude: input.hosted.claude }),
    ...(input.hosted.claudeExecution === undefined
      ? {}
      : { claudeExecution: input.hosted.claudeExecution }),
  };
}
