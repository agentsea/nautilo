import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PROFILE_AVATAR_URL,
  type AgentProfileFull,
  type AgentProfileResponse,
} from "@nautilo/types";

const harness: {
  response: AgentProfileResponse | null;
  loading: boolean;
  error: Error | null;
} = {
  response: null,
  loading: false,
  error: null,
};

function ownerAgent(overrides: Partial<AgentProfileFull> = {}): AgentProfileFull {
  return {
    name: "Jeannie",
    language: "en",
    voices: {},
    avatar: { kind: "preset", id: "shell" },
    avatarUrl: PROFILE_AVATAR_URL,
    defaultModel: null,
    personality: { prompt: null, tone: null, motherAnswer: null },
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: null,
    onboardingCompleted: true,
    welcomeMessageSent: true,
    agentIdentity: "agent-1",
    publicProfile: false,
    fallback: { enabled: false, chain: [] },
    ...overrides,
  };
}

beforeAll(() => {
  mock.module("../../src/hooks/use-profile", () => ({
    useProfile: () => ({
      response: harness.response,
      agent: harness.response?.agent ?? null,
      avatarSrc: "",
      avatarLoading: false,
      avatarError: null,
      loading: harness.loading,
      error: harness.error,
      refresh: async () => {},
    }),
  }));

  mock.module("../../src/pages/settings/sections/profile-section", () => ({
    ProfileSection: () => <div data-testid="profile-section-stub">Profile editor</div>,
  }));
  mock.module("../../src/pages/settings/sections/model-section", () => ({
    ModelSection: ({ showProviderKeyStatus }: { showProviderKeyStatus?: boolean }) => (
      <div data-testid="model-section-stub" data-provider-keys={String(showProviderKeyStatus)}>
        Model editor
      </div>
    ),
  }));
  mock.module("../../src/pages/settings/sections/fallback-section", () => ({
    FallbackSection: () => <div data-testid="fallback-section-stub">Fallback editor</div>,
  }));
});

afterAll(() => {
  mock.restore();
});

describe("MyAgentsSection", () => {
  test("renders empty state when ownedAgents is absent or empty", async () => {
    harness.loading = false;
    harness.error = null;
    harness.response = { viewerRole: "household", agent: ownerAgent() };
    const { MyAgentsSection } = await import(
      "../../src/pages/settings/sections/my-agents-section"
    );
    const html = renderToStaticMarkup(<MyAgentsSection showProviderKeyStatus={false} />);
    expect(html).toContain('data-testid="my-agents-section"');
    expect(html).toContain('data-testid="my-agents-empty-state"');
    expect(html).toContain("own any Agents on this Server yet");
    expect(html).not.toContain('data-testid="profile-section-stub"');
  });

  test("renders one owned Agent card with ProfileSection for a single ownedAgents entry", async () => {
    harness.response = {
      viewerRole: "owner",
      agent: ownerAgent(),
      ownedAgents: [{ agentId: "agent-1", handle: "jeannie", displayName: "Jeannie" }],
    } as AgentProfileResponse;
    const { MyAgentsSection } = await import(
      "../../src/pages/settings/sections/my-agents-section"
    );
    const html = renderToStaticMarkup(<MyAgentsSection showProviderKeyStatus={false} />);
    expect(html).toContain("My Agent: Jeannie");
    expect(html).toContain("This changes Jeannie (your Agent)");
    expect(html).toContain('data-testid="profile-section-stub"');
    expect(html).toContain('data-testid="model-section-stub"');
    expect(html).toContain('data-provider-keys="false"');
    expect(html).toContain('data-testid="fallback-section-stub"');
    expect(html).not.toContain('data-testid="my-agents-empty-state"');
  });

  test("shows multi-Agent hint when more than one owned Agent is listed", async () => {
    harness.response = {
      viewerRole: "owner",
      agent: ownerAgent(),
      ownedAgents: [
        { agentId: "agent-1", handle: "jeannie", displayName: "Jeannie" },
        { agentId: "agent-2", handle: "nova", displayName: "Nova" },
      ],
    } as AgentProfileResponse;
    const { MyAgentsSection } = await import(
      "../../src/pages/settings/sections/my-agents-section"
    );
    const html = renderToStaticMarkup(<MyAgentsSection />);
    expect(html).toContain('data-testid="my-agents-multi-hint"');
    expect(html).toContain("My Agent: Nova");
  });

  test("disambiguates colliding Agent display names via Agent handle suffix", async () => {
    harness.response = {
      viewerRole: "owner",
      agent: ownerAgent(),
      ownedAgents: [
        { agentId: "agent-1", handle: "jeannie_owner", displayName: "Jeannie" },
        { agentId: "agent-2", handle: "jeannie_guest", displayName: "Jeannie" },
      ],
    } as AgentProfileResponse;
    const { MyAgentsSection } = await import(
      "../../src/pages/settings/sections/my-agents-section"
    );
    const html = renderToStaticMarkup(<MyAgentsSection />);
    expect(html).toContain("My Agent: Jeannie (@jeannie_owner)");
    expect(html).toContain("My Agent: Jeannie (@jeannie_guest)");
  });
});
