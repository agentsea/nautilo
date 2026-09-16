import { describe, expect, test } from "bun:test";

import {
  ROLES_THAT_CAN_MUTATE_AGENT_PROFILE,
  ROLES_THAT_CAN_SELECT_AGENT_VOICE,
  getViewerAffordances,
} from "../../src/viewer-affordances";

describe("getViewerAffordances", () => {
  test("owner with userId — canonical Agent Profile mutation + voice + session speech", () => {
    expect(getViewerAffordances({ role: "owner", userId: "u-1" })).toEqual({
      canMutateAgentProfile: true,
      canSelectAgentVoice: true,
      canToggleSessionSpeech: true,
    });
  });

  test("guest without userId and no caps — session speech only", () => {
    expect(getViewerAffordances({ role: "guest", userId: null })).toEqual({
      canMutateAgentProfile: false,
      canSelectAgentVoice: false,
      canToggleSessionSpeech: true,
    });
  });

  test("stranger without userId and no caps — session speech only", () => {
    expect(getViewerAffordances({ role: "stranger", userId: null })).toEqual({
      canMutateAgentProfile: false,
      canSelectAgentVoice: false,
      canToggleSessionSpeech: true,
    });
  });

  // M129 — capability-backed canMutateAgentProfile.
  test("manage_agents cap grants canMutateAgentProfile even for a low role", () => {
    const aff = getViewerAffordances({
      role: "guest",
      userId: "u-9",
      capabilities: ["manage_agents"],
    });
    expect(aff.canMutateAgentProfile).toBe(true);
    // voice stays owner-only at the role level
    expect(aff.canSelectAgentVoice).toBe(false);
  });

  test("no manage_agents cap and a role not in the legacy set — canMutateAgentProfile false", () => {
    const aff = getViewerAffordances({
      role: "guest",
      userId: "u-10",
      capabilities: ["read_memories"],
    });
    expect(aff.canMutateAgentProfile).toBe(false);
  });

  test("canonical member role fallback still works when caps are omitted", () => {
    const aff = getViewerAffordances({ role: "member", userId: "u-2" });
    expect(aff.canMutateAgentProfile).toBe(true);
    expect(aff.canSelectAgentVoice).toBe(false);
  });
});

describe("ROLES_THAT_CAN_MUTATE_AGENT_PROFILE", () => {
  test("owner + canonical non-guest roles may mutate; guest/stranger may not", () => {
    expect(ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has("owner")).toBe(true);
    expect(ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has("admin")).toBe(true);
    expect(ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has("member")).toBe(true);
    expect(ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has("guest")).toBe(false);
    expect(ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has("stranger")).toBe(false);
  });
});

describe("ROLES_THAT_CAN_SELECT_AGENT_VOICE", () => {
  test("owner may select voice; other canonical roles may not", () => {
    expect(ROLES_THAT_CAN_SELECT_AGENT_VOICE.has("owner")).toBe(true);
    expect(ROLES_THAT_CAN_SELECT_AGENT_VOICE.has("member")).toBe(false);
    expect(ROLES_THAT_CAN_SELECT_AGENT_VOICE.has("admin")).toBe(false);
    expect(ROLES_THAT_CAN_SELECT_AGENT_VOICE.has("guest")).toBe(false);
    expect(ROLES_THAT_CAN_SELECT_AGENT_VOICE.has("stranger")).toBe(false);
  });
});
