import { describe, expect, test } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";

import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  mcpTools: [{ serverName: "context7", toolNames: ["get-docs"] }],
};

describe("Relay hosted-MCP dispatch provenance", () => {
  test("v19 forwards the exact owning Relay while v18 preserves compatibility", async () => {
    for (const protocolVersion of [18, 19] as const) {
      const registry = new InMemoryRelayRegistry();
      const sent: RelayServerMessage[] = [];
      await registry.register(
        "relay-1",
        "user-1",
        CAPS,
        (message) => sent.push(message),
        protocolVersion,
      );

      const pending = registry.dispatch("relay-1", {
        toolName: "get-docs",
        args: { query: "relay" },
        impact: "read-only",
        approvalObtained: true,
        hostedBy: "relay-1",
      });
      const dispatch = sent[0] as Extract<
        RelayServerMessage,
        { type: "relay:dispatch" }
      >;
      expect(dispatch.hostedBy).toBe(
        protocolVersion === 19 ? "relay-1" : undefined,
      );
      registry.resolveDispatch(dispatch.correlationId, {
        status: "ok",
        result: { docs: true },
      });
      expect(await pending).toMatchObject({ status: "ok" });
    }
  });

  test("rejects a hostedBy Relay mismatch before transport", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(
      "relay-1",
      "user-1",
      CAPS,
      (message) => sent.push(message),
      19,
    );

    let rejection: unknown;
    try {
      await registry.dispatch("relay-1", {
        toolName: "get-docs",
        args: { query: "relay" },
        impact: "read-only",
        approvalObtained: true,
        hostedBy: "relay-2",
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("Relay binding changed");
    expect(sent).toEqual([]);
  });
});
