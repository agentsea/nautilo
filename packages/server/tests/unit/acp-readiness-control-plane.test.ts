import { describe, expect, test } from "bun:test";
import { HermesAcpRelayReadinessResolver, OpenCodeAcpRelayReadinessResolver } from "../../src/acp/readiness-control-plane";

describe("D452 Hermes ACP readiness control plane", () => {
  test("uses an exact authenticated target and exposes only classified evidence", async () => {
    const calls: unknown[] = [];
    const resolver = new HermesAcpRelayReadinessResolver({
      requestAcpReadiness: async (input) => { calls.push(input); return "authentication_required"; },
    }, { relayId: "relay-1", userId: "owner-1" }, () => "request-1");
    expect(await resolver.inspect()).toEqual({
      executableBasename: "hermes", versionOutput: new TextEncoder().encode("0.20.4"),
      preflight: "authentication_required",
    });
    expect(calls).toEqual([{
      relayId: "relay-1", userId: "owner-1", requestId: "request-1", registrationId: "hermes-acp",
    }]);
  });

  test("uses the exact OpenCode registration without exposing native details", async () => {
    const calls: unknown[] = [];
    const resolver = new OpenCodeAcpRelayReadinessResolver({
      requestAcpReadiness: async (input) => { calls.push(input); return "ready"; },
    }, { relayId: "relay-1", userId: "owner-1" }, () => "request-open");
    expect(await resolver.inspect()).toEqual({
      executableBasename: "opencode", versionOutput: new TextEncoder().encode("1.18.16"), preflight: "passed",
    });
    expect(calls).toEqual([expect.objectContaining({
      requestId: "request-open", registrationId: "opencode-acp",
    })]);
  });
});
