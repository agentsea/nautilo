import { describe, expect, test } from "bun:test";
import {
  RELAY_READ_SHELL_OUTPUT_PROTOCOL_VERSION,
  projectRelayCapabilitiesForProtocol,
} from "../../src/protocol";
import type { RelayCapabilities } from "../../src/types";

describe("retained shell-output capability", () => {
  const capabilities: RelayCapabilities = {
    profile: "desktop-agent",
    canReadShellOutput: true,
    canReadLocalExecutionHistory: true,
  };

  test("projects retained reads only at their protocol version", () => {
    expect(RELAY_READ_SHELL_OUTPUT_PROTOCOL_VERSION).toBe(22);
    expect(projectRelayCapabilitiesForProtocol(capabilities, 21)).toEqual({
      profile: "desktop-agent",
      canReadLocalExecutionHistory: true,
    });
    expect(projectRelayCapabilitiesForProtocol(capabilities, 22)).toEqual(capabilities);
  });
});
