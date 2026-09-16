import { describe, expect, spyOn, test } from "bun:test";
import { createOpenHueHandler, DISPATCH_DEFAULT_TIMEOUT_MS, type RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

describe("Hue pairing relay lifetime", () => {
  test("keeps the response pending until after the local pairing process deadline", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    registry.register("desktop", "owner", { profile: "desktop-agent", canControlHue: true }, message => sent.push(message), 4);
    const timers = spyOn(globalThis, "setTimeout");
    const pending = registry.dispatch("desktop", {
      toolName: "hue_lights", args: { action: "setup", bridge: "bridge.local" },
      impact: "low", approvalObtained: true,
    });
    let receiptDeadline: number;
    try {
      receiptDeadline = timers.mock.calls[0]![1] as number;
    } finally { timers.mockRestore(); }
    const dispatch = sent[0];
    if (dispatch?.type !== "relay:dispatch") throw new Error("Missing Hue dispatch");
    const localHandler = createOpenHueHandler({
      platform: "linux",
      executor: { async execute(_binary, _argv, options) {
        // This previously failed: the server abandoned the result at 60s,
        // while the local executor was still waiting for the physical button.
        expect(options.timeoutMs).toBeGreaterThan(DISPATCH_DEFAULT_TIMEOUT_MS);
        expect(receiptDeadline).toBeGreaterThan(options.timeoutMs);
        return { stdout: "", stderr: "pairing timed out", exitCode: 1 };
      } },
    });
    try {
      const receipt = await localHandler(dispatch.args);
      registry.resolveDispatch(dispatch.correlationId, receipt);
      expect(await pending).toMatchObject({ status: "error", errorCode: "hue_setup_timeout" });
    } finally { await registry.unregister("desktop"); }
  });

  test.each(["discover", "list_lights", "set_light"])("preserves the ordinary %s deadline", async action => {
    const registry = new InMemoryRelayRegistry();
    registry.register("desktop", "owner", { profile: "desktop-agent", canControlHue: true }, () => {}, 4);
    const timers = spyOn(globalThis, "setTimeout");
    const pending = registry.dispatch("desktop", { toolName: "hue_lights", args: { action }, impact: "low", approvalObtained: true }).catch((error: unknown) => error);
    try { expect(timers.mock.calls[0]![1]).toBe(DISPATCH_DEFAULT_TIMEOUT_MS); }
    finally { timers.mockRestore(); await registry.unregister("desktop"); }
    expect(await pending).toBeInstanceOf(Error);
  });
});
