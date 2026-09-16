/** D550 — compact Desktop Genie identity panel contract. */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type {
  AgentProfilePublic,
  AgentProfileResponse,
  AgentProfileScoped,
  CapabilitySlug,
  ViewerRole,
} from "@nautilo/types";
import { PROFILE_AVATAR_URL, SHELL_AGENT_NAME } from "@nautilo/types";

let capabilities: CapabilitySlug[] = [];

beforeAll(() => {
  mock.module("../../src/hooks/use-can", () => ({
    useCan: () => (capability: CapabilitySlug) => capabilities.includes(capability),
  }));
  mock.module("../../src/hooks/use-profile", () => ({
    useProfile: () => ({
      response: null,
      agent: null,
      avatarSrc: PROFILE_AVATAR_URL,
      avatarLoading: false,
      loading: false,
    }),
  }));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  capabilities = [];
});

const IDLE_VOICE = {
  enabled: false,
  playing: false,
  toggle: () => undefined,
  stop: () => undefined,
};

const SCOPED_AGENT: AgentProfileScoped = {
  name: "Genie",
  avatar: { kind: "preset", id: "shell" },
  avatarUrl: PROFILE_AVATAR_URL,
  language: "en",
  agentIdentity: "agent-test",
};

const PUBLIC_AGENT: AgentProfilePublic = {
  name: SHELL_AGENT_NAME,
  avatar: { kind: "preset", id: "shell" },
  avatarUrl: PROFILE_AVATAR_URL,
};

function makeResponse(role: ViewerRole): AgentProfileResponse {
  if (role === "owner") {
    return {
      viewerRole: "owner",
      agent: {
        name: "Jeannie",
        language: "en",
        voices: { default: { voiceId: "alice", voiceName: "Alice" } },
        avatar: { kind: "preset", id: "shell" },
        avatarUrl: PROFILE_AVATAR_URL,
        defaultModel: null,
        personality: { prompt: null, tone: null, motherAnswer: null },
        privacySpectrum: null,
        workLifeMode: null,
        soulFile: "# Jeannie\n\n## Essence\nWarm, incisive, and quietly playful.",
        onboardingCompleted: true,
        welcomeMessageSent: true,
        agentIdentity: "agent-owner",
        publicProfile: false,
        fallback: { enabled: false, chain: [] },
      },
    };
  }
  if (role === "household" || role === "teammate") {
    return { viewerRole: role, agent: SCOPED_AGENT };
  }
  return { viewerRole: role, agent: PUBLIC_AGENT };
}

function renderPanel(node: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("PanelIdentity — compact context panel", () => {
  test("owner sees personal identity, Soul, and named customization action", async () => {
    capabilities = [];
    const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
    const html = renderPanel(
      <PanelIdentity
        response={makeResponse("owner")}
        name="Jeannie"
        avatarSrc={PROFILE_AVATAR_URL}
        loading={false}
        showSubagentDock={false}
        canToggleSessionSpeech
        voice={IDLE_VOICE}
      />,
    );

    expect(html).toContain("Jeannie");
    expect(html).toContain("Online");
    expect(html).toContain("Warm, incisive, and quietly playful.");
    expect(html).toContain("Customize Jeannie");
    expect(html).toContain("/settings#my-agents");
    expect(html).toContain("items-center justify-center gap-4");
    expect(html).toContain("Voice off");
    expect(html).toContain('aria-pressed="false"');
  });

  test("duplicate Room and Voice controls are absent", async () => {
    capabilities = [];
    const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
    const html = renderPanel(
      <PanelIdentity
        response={makeResponse("owner")}
        name="Jeannie"
        avatarSrc={PROFILE_AVATAR_URL}
        loading={false}
        showSubagentDock={false}
      />,
    );

    expect(html).not.toContain(">Voice<");
    expect(html).not.toContain(">Room<");
    expect(html).not.toContain("Select a chat room");
  });

  test.each(["household", "teammate", "guest"] as const)(
    "%s chat-capable viewer sees compact Voice off while private Soul and customization stay hidden",
    async (role) => {
      capabilities = [];
      const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
      const html = renderPanel(
        <PanelIdentity
          response={makeResponse(role)}
          name="Genie"
          avatarSrc={PROFILE_AVATAR_URL}
          loading={false}
          showSubagentDock={false}
          canToggleSessionSpeech
          voice={IDLE_VOICE}
        />,
      );

      expect(html).toContain("Voice off");
      expect(html).toContain("Your private soul file is hidden");
      expect(html).not.toContain("Warm, incisive, and quietly playful.");
      expect(html).not.toContain("Customize Genie");
    },
  );

  test("manage_agents capability exposes the explicit customization action", async () => {
    capabilities = ["manage_agents"];
    const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
    const html = renderPanel(
      <PanelIdentity
        response={makeResponse("teammate")}
        name="Genie"
        avatarSrc={PROFILE_AVATAR_URL}
        loading={false}
        showSubagentDock={false}
      />,
    );

    expect(html).toContain("Customize Genie");
    expect(html).toContain("/settings#my-agents");
  });

  test("active playback replaces the toggle copy with a compact stop action", async () => {
    capabilities = [];
    const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
    const html = renderPanel(
      <PanelIdentity
        response={makeResponse("owner")}
        name="Jeannie"
        avatarSrc={PROFILE_AVATAR_URL}
        loading={false}
        showSubagentDock={false}
        canToggleSessionSpeech
        voice={{ ...IDLE_VOICE, enabled: true, playing: true }}
      />,
    );

    expect(html).toContain("Stop speaking");
    expect(html).toContain('aria-label="Stop Genie voice playback"');
  });

  test("viewer affordance hides the compact voice control when speech cannot be toggled", async () => {
    const { PanelIdentity } = await import("../../src/components/identity/assistant-identity");
    const html = renderPanel(
      <PanelIdentity
        response={makeResponse("guest")}
        name="Genie"
        avatarSrc={PROFILE_AVATAR_URL}
        loading={false}
        showSubagentDock={false}
        canToggleSessionSpeech={false}
        voice={IDLE_VOICE}
      />,
    );

    expect(html).not.toContain("Voice off");
    expect(html).not.toContain("Turn Genie voice playback on");
  });
});
