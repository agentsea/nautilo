import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../../../packages/runtime/src/relay-registry.ts";
import { ComputerUseLocalStore } from "../../electron/computer-use/local-store.ts";

describe("server pairing references consumed by the installed Desktop grant store", () => {
  for (const [row, leading] of [
    ["synthetic-pairing-0", "e"],
    ["synthetic-pairing-1", "0"],
    ["synthetic-pairing-33", "-"],
    ["synthetic-pairing-36", "_"],
  ] as const) {
    test(`persists and restores a grant when the digest starts with ${leading}`, async () => {
      const digest = createHash("sha256").update(`nautilo-relay-v8:${row}`).digest("base64url");
      expect(digest[0]).toBe(leading);
      const registry = new InMemoryRelayRegistry();
      await registry.register("relay-1", "human-1", { profile: "desktop-agent" }, () => {}, RELAY_PROTOCOL_VERSION, "desktop-1", 0, row);
      const acknowledgement = registry.getV8Acknowledgement("relay-1");
      expect(acknowledgement).not.toBeNull();
      const reference = acknowledgement!.pairingGenerationRef;
      let bytes: string | null = null;
      const options = {
        instanceId: "acceptance-fixture",
        serverBindingId: "server-binding-fixture",
        filePath: "/unused/pairing-reference.json",
        storage: {
          read: async () => bytes,
          writeAtomic: async (next: string) => { bytes = next; },
        },
      };
      const store = new ComputerUseLocalStore(options);
      expect(await store.mint({
        instanceId: options.instanceId,
        serverBindingId: options.serverBindingId,
        humanUserId: "human-1",
        agentId: "agent-1",
        relayId: "relay-1",
        pairingGeneration: reference,
      })).toMatchObject({ ok: true, data: { pairingGeneration: reference, grantGeneration: 1 } });
      expect(await new ComputerUseLocalStore(options).get()).toMatchObject({
        ok: true, data: { receipt: { pairingGeneration: reference } },
      });
      expect(reference).not.toContain(row);
    });
  }
});
