import { describe, expect, test } from "bun:test";
import {
  RELAY_SHELL_REPLACEMENTS_PROTOCOL_VERSION,
  isRelayLocalGitCapability,
  projectRelayCapabilitiesForProtocol,
} from "../../src/protocol";
import type { RelayCapabilities } from "../../src/types";

describe("protocol 22 shell replacement capabilities", () => {
  const capabilities: RelayCapabilities = {
    profile: "desktop-agent",
    canUseLocalGit: true,
    localGit: { version: 1 },
    canReadShellOutput: true,
    canReadLocalExecutionHistory: true,
  };

  test("strictly recognizes the typed Local Git marker", () => {
    expect(isRelayLocalGitCapability({ version: 1 })).toBe(true);
    expect(isRelayLocalGitCapability({ version: 1, enabled: true })).toBe(false);
    expect(isRelayLocalGitCapability({ version: "1" })).toBe(false);
    expect(isRelayLocalGitCapability([1])).toBe(false);
    expect(isRelayLocalGitCapability(null)).toBe(false);
  });

  test("projects all replacement capabilities only at their protocol version", () => {
    expect(RELAY_SHELL_REPLACEMENTS_PROTOCOL_VERSION).toBe(22);
    const oldPeer = projectRelayCapabilitiesForProtocol(capabilities, 21);
    expect(oldPeer).toEqual({
      profile: "desktop-agent",
      canReadLocalExecutionHistory: true,
    });
    expect(projectRelayCapabilitiesForProtocol(capabilities, 22)).toEqual(capabilities);
  });

  test("does not infer a Local Git marker from its boolean or vice versa", () => {
    expect(projectRelayCapabilitiesForProtocol({
      profile: "desktop-agent", canUseLocalGit: true, canReadShellOutput: true,
    }, 22)).toMatchObject({ canUseLocalGit: true, canReadShellOutput: true });
    expect(isRelayLocalGitCapability(undefined)).toBe(false);
    expect(projectRelayCapabilitiesForProtocol({
      profile: "desktop-agent", localGit: { version: 1 }, canReadShellOutput: true,
    }, 22)).toMatchObject({ localGit: { version: 1 }, canReadShellOutput: true });
  });
});
