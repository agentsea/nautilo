import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayServerMessage,
} from "@nautilo/relay";
import {
  InMemoryRelayRegistry,
  RelayDispatchOutcomeUnknownError,
} from "../../src/relay-registry";

const CAPABILITIES: RelayCapabilities = {
  profile: "desktop-agent",
  canControlBrowser: true,
};

const MUTATION = {
  toolName: "browser_click",
  args: { ref: "e1" },
  impact: "low" as const,
  approvalObtained: true,
  executionClass: "browser" as const,
};

async function fixture(options: { receiptGraceMs?: number } = {}) {
  const sent: RelayServerMessage[] = [];
  const registry = new InMemoryRelayRegistry({
    desktopAutomationResultReceiptGraceMs: options.receiptGraceMs ?? 5,
  });
  await registry.register(
    "relay-1",
    "human-1",
    CAPABILITIES,
    message => { sent.push(message); },
    RELAY_PROTOCOL_VERSION,
    "session-1",
  );
  return { registry, sent };
}

function dispatchFrame(sent: RelayServerMessage[]) {
  const frame = sent.find(
    (message): message is Extract<RelayServerMessage, { type: "relay:dispatch" }> =>
      message.type === "relay:dispatch",
  );
  if (frame === undefined) throw new Error("Missing browser dispatch frame");
  return frame;
}

function expectUnknown(error: unknown, reason: RelayDispatchOutcomeUnknownError["reason"]): void {
  expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
  expect(error).toMatchObject({ desktopAutomationOutcome: "unknown", reason });
}

describe("InMemoryRelayRegistry Browser mutation receipts", () => {
  test("a sent mutation waits for the canonical receipt after cancellation", async () => {
    const { registry, sent } = await fixture({ receiptGraceMs: 20 });
    const controller = new AbortController();
    const pending = registry.dispatch("relay-1", { ...MUTATION, signal: controller.signal });
    let settled = false;
    pending.finally(() => { settled = true; }).catch(() => undefined);
    const frame = dispatchFrame(sent);

    controller.abort();
    await Promise.resolve();

    expect(sent[1]).toEqual({ type: "relay:cancel", correlationId: frame.correlationId });
    expect(settled).toBe(false);
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { clicked: true } });
    expect(await pending).toEqual({ status: "ok", result: { clicked: true } });
  });

  test("a cancelled mutation without a receipt becomes typed outcome-unknown and ignores a late receipt", async () => {
    const { registry, sent } = await fixture();
    const controller = new AbortController();
    const pending = registry.dispatch("relay-1", { ...MUTATION, signal: controller.signal });
    const frame = dispatchFrame(sent);
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expectUnknown(error, "cancel");
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);

    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { clicked: true } });
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
  });

  test("a timed-out mutation without a receipt becomes typed outcome-unknown", async () => {
    const { registry, sent } = await fixture();
    const error = await registry.dispatch("relay-1", { ...MUTATION, timeout: 1 })
      .catch((caught: unknown) => caught);

    expectUnknown(error, "timeout");
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);
  });

  test.each(["disconnect", "replacement", "shutdown"] as const)(
    "a sent mutation becomes typed outcome-unknown on %s",
    async reason => {
      const { registry, sent } = await fixture();
      const pending = registry.dispatch("relay-1", MUTATION).catch((caught: unknown) => caught);
      dispatchFrame(sent);

      if (reason === "disconnect") {
        await registry.unregister("relay-1");
      } else if (reason === "replacement") {
        await registry.register(
          "relay-1",
          "human-1",
          CAPABILITIES,
          () => undefined,
          RELAY_PROTOCOL_VERSION,
          "session-2",
        );
      } else {
        registry.stop();
      }

      expectUnknown(await pending, reason);
      expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    },
  );

  test.each(["browser_hover", "browser_scroll"])(
    "%s is effectful even though it need not change page data",
    async toolName => {
      const { registry } = await fixture();
      const pending = registry.dispatch("relay-1", { ...MUTATION, toolName })
        .catch((caught: unknown) => caught);

      await registry.unregister("relay-1");

      expectUnknown(await pending, "disconnect");
    },
  );

  test("an already-aborted mutation is rejected before the send seam", async () => {
    const { registry, sent } = await fixture();
    const controller = new AbortController();
    controller.abort();

    const error = await registry.dispatch("relay-1", { ...MUTATION, signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as Error).message).toBe("Dispatch cancelled");
    expect(sent).toHaveLength(0);
  });

  test("read-only browser snapshots retain the ordinary timeout failure", async () => {
    const { registry, sent } = await fixture();
    const error = await registry.dispatch("relay-1", {
      toolName: "browser_snapshot",
      args: {},
      impact: "read-only",
      approvalObtained: true,
      executionClass: "browser",
      timeout: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as Error).message).toContain("Relay dispatch timed out");
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(0);
  });
});
