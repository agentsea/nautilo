/**
 * M132 — `manage_profile` and `regenerate_soul` must thread the turn's
 * context `agentId` into `upsertProfile(ownerId, agentId, data)`, since
 * the Profile is now agent-keyed. They must NOT do a full-priv `actors`
 * lookup (D129) — the agentId arrives via the tool-context envelope.
 *
 * **Isolated runner**: this `mock.module`s the profile-store (which
 * transitively imports `@nautilo/db`). Bun cannot un-replace a module, so
 * this runs in its own `bun test` process per the unit-isolated convention.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

type UpsertCall = [ownerId: string, agentId: string, data: Record<string, unknown>];
const upsertCalls: UpsertCall[] = [];

// M156 — a profile NAME change is identity-critical and now routes through
// the transactional `renameAgentProfileIdentity` helper (in `@nautilo/db`)
// instead of `upsertProfile`. Record those calls here so the mocked-DB test
// stays DB-independent.
type RenameCall = { ownerUserId: string; agentId: string; name: string };
const renameCalls: RenameCall[] = [];
const soulGenerationHumans: string[] = [];

const fakeProfile = {
  id: "p1",
  userId: "owner-1",
  agentId: "agent-1",
  name: "Genie",
  soulFile: null,
  language: "en",
  privacySpectrum: null,
  workLifeMode: null,
  voiceName: null,
  voiceId: null,
  voices: {},
  personalityPrompt: null,
  motherAnswer: null,
  avatar: null,
  publicProfile: false,
  personalityTone: null,
  defaultModel: null,
  onboardingCompleted: false,
  welcomeMessageSent: false,
  fallbackEnabled: false,
  fallbackChain: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    renameAgentProfileIdentity: async (args: RenameCall) => {
      renameCalls.push(args);
      return { name: args.name, handle: "nova" };
    },
  }));
  mock.module("../../src/store/profile-store", () => ({
    getProfile: async () => fakeProfile,
    getProfileByAgentId: async () => fakeProfile,
    upsertProfile: async (
      ownerId: string,
      agentId: string,
      data: Record<string, unknown>,
    ) => {
      upsertCalls.push([ownerId, agentId, data]);
      return fakeProfile;
    },
    // D261 — keep the mock surface complete so the @nautilo/agent index
    // re-export (which now includes the voices helpers) links cleanly.
    getVoices: async () => ({}),
    upsertVoiceAssignment: async () => {},
    removeVoiceAssignment: async () => {},
    assertValidVoiceLangKey: () => {},
  }));
  mock.module("../../src/tools/config/emit-profile-updated", () => ({
    emitProfileUpdated: () => {},
  }));
  mock.module("../../src/soul/generate-soul-file", () => ({
    generateSoulFile: async (
      _input: unknown,
      _signal: AbortSignal | undefined,
      authorization: { humanUserId?: string } | undefined,
    ) => {
      soulGenerationHumans.push(authorization?.humanUserId ?? "");
      return "# Soul\n\nGenerated.";
    },
  }));
});

afterAll(() => {
  upsertCalls.length = 0;
  renameCalls.length = 0;
});

describe("M132 — config tools thread context agentId into upsertProfile", () => {
  test("manage_profile name update routes through renameAgentProfileIdentity (ownerUserId, agentId, name)", async () => {
    const { createManageProfileTool } = await import("../../src/tools/config/manage-profile");
    const tool = createManageProfileTool({ ownerId: "owner-1", agentId: "agent-1" });
    const out = await tool.invoke({ action: "update", fields: { name: "Nova" } });
    expect(out).toContain("Profile updated");
    // M156 — the name change goes through the transactional identity helper,
    // NOT upsertProfile (which would skip the actor-cache + handle sync).
    const renamed = renameCalls.find((c) => c.name === "Nova");
    expect(renamed).toBeDefined();
    expect(renamed?.ownerUserId).toBe("owner-1");
    expect(renamed?.agentId).toBe("agent-1");
    // Name-only patch must not also fire a redundant upsertProfile write.
    expect(upsertCalls.some((c) => c[2]["name"] === "Nova")).toBe(false);
  });

  test("manage_profile update with no agent in context fails closed", async () => {
    const { createManageProfileTool } = await import("../../src/tools/config/manage-profile");
    const tool = createManageProfileTool({ ownerId: "owner-1" });
    const out = await tool.invoke({ action: "update", fields: { name: "Ghost" } });
    expect(out).toContain("no agent in context");
    expect(upsertCalls.some((c) => c[2]["name"] === "Ghost")).toBe(false);
    expect(renameCalls.some((c) => c.name === "Ghost")).toBe(false);
  });

  test("regenerate_soul apply passes (ownerId, agentId, { soulFile })", async () => {
    const { createRegenerateSoulTool } = await import("../../src/tools/config/regenerate-soul");
    const tool = createRegenerateSoulTool({
      ownerId: "owner-1",
      causalHumanUserId: "initiator-1",
      agentId: "agent-1",
    });
    const out = await tool.invoke({ action: "apply" });
    expect(out).toContain("Soul file saved");
    const call = upsertCalls.find((c) => typeof c[2]["soulFile"] === "string");
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("owner-1");
    expect(call?.[1]).toBe("agent-1");
    expect(soulGenerationHumans).toContain("initiator-1");
  });

  test("regenerate_soul fails closed without an initiating Human", async () => {
    const { createRegenerateSoulTool } = await import("../../src/tools/config/regenerate-soul");
    const tool = createRegenerateSoulTool({ ownerId: "owner-1", agentId: "agent-1" });
    const before = soulGenerationHumans.length;
    const out = await tool.invoke({ action: "preview" });
    expect(out).toContain("no Human in context");
    expect(soulGenerationHumans).toHaveLength(before);
  });
});
