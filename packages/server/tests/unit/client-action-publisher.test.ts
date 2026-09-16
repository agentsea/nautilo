import { describe, expect, test } from "bun:test";
import { ClientActionBindingRegistry } from "../../src/realtime/client-action-binding-registry";
import { publishDurableGuideUserClientAction } from "../../src/realtime/client-action-publisher";

const SESSION_ID = `${"A".repeat(21)}B`;
const NOW = Date.parse("2026-08-12T10:00:00.000Z");

function socket(options: { throwOnSend?: boolean; open?: boolean } = {}) {
  let close: (() => void) | undefined;
  const frames: string[] = [];
  return {
    OPEN: 1,
    readyState: options.open === false ? 3 : 1,
    frames,
    on(_event: "close", handler: () => void) { close = handler; },
    close() { close?.(); },
    send(payload: string) {
      if (options.throwOnSend) throw new Error("socket closed during write");
      frames.push(payload);
    },
  };
}

function lifecycleEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tool_result_persisted" as const,
    toolName: "guide_user",
    content: JSON.stringify({
      version: 1,
      kind: "guidance",
      actionId: "guide-user-action-1",
      target: "connections.google",
      presentation: "reveal",
      fallbackText: "Use Connections then Google Workspace to continue.",
    }),
    fingerprint: "persisted-tool-fingerprint",
    trustedExecutionEntrypoint: "foreground.main" as const,
    turnId: "turn-1",
    ...overrides,
  };
}

function boundRegistry(
  socketValue = socket(),
  initiatingClientSurface: unknown = undefined,
) {
  const registry = new ClientActionBindingRegistry(() => NOW);
  expect(registry.registerLiveSession({
    socket: socketValue,
    clientActionSessionId: SESSION_ID,
    actorId: "actor-1",
    initiatingClientSurface,
  })).toBe(true);
  const handle = registry.reserve({ clientActionSessionId: SESSION_ID, actorId: "actor-1" });
  if (!handle) throw new Error("reservation was unexpectedly refused");
  expect(registry.bind(handle, "turn-1")).toBe(true);
  return { registry, socket: socketValue };
}

describe("D513 exact client action publisher", () => {
  test("sends one validated reveal only to the consumed bound socket", () => {
    const { registry, socket: target } = boundRegistry();

    expect(publishDurableGuideUserClientAction(registry, lifecycleEvent(), NOW)).toBe(true);
    expect(target.frames).toHaveLength(1);
    expect(JSON.parse(target.frames[0]!)).toMatchObject({
      type: "ui.action.v1",
      actionId: "guide-user-action-1",
      target: "connections.google",
      presentation: "reveal",
    });
    expect(publishDurableGuideUserClientAction(registry, lifecycleEvent(), NOW)).toBe(false);
    expect(target.frames).toHaveLength(1);
  });

  test("consumes Mobile reveal and spotlight records without a socket send", () => {
    for (const initiatingClientSurface of ["mobile.native", "mobile.web"] as const) {
      const { registry, socket: target } = boundRegistry(socket(), initiatingClientSurface);
      expect(publishDurableGuideUserClientAction(registry, lifecycleEvent(), NOW)).toBe(false);
      expect(target.frames).toHaveLength(0);
      expect(registry.consumeOnce("turn-1")).toBeNull();
    }
  });

  test.each(["workbench.desktop", "workbench.browser", "unknown"] as const)("keeps a %s binding publishable", (initiatingClientSurface) => {
    const { registry, socket: target } = boundRegistry(socket(), initiatingClientSurface);
    expect(publishDurableGuideUserClientAction(registry, lifecycleEvent(), NOW)).toBe(true);
    expect(target.frames).toHaveLength(1);
  });

  test.each([
    ["link presentation", lifecycleEvent({ content: JSON.stringify({
      version: 1,
      kind: "guidance",
      actionId: "guide-user-action-1",
      target: "connections.google",
      presentation: "link",
      fallbackText: "Use Connections then Google Workspace to continue.",
    }) })],
    ["discovery", lifecycleEvent({ content: JSON.stringify({ version: 1, kind: "discovery", targets: [] }) })],
    ["wrong tool", lifecycleEvent({ toolName: "other_tool" })],
    ["malformed result", lifecycleEvent({ content: "{bad json" })],
  ])("does not consume a binding for %s", (_label, event) => {
    const { registry, socket: target } = boundRegistry();
    expect(publishDurableGuideUserClientAction(registry, event, NOW)).toBe(false);
    expect(target.frames).toHaveLength(0);
    expect(registry.consumeOnce("turn-1")).not.toBeNull();
  });

  test.each([
    ["foreground.fork", "foreground.fork"],
    ["foreground.task_report_back", "foreground.task_report_back"],
    ["background.task", "background.task"],
    ["foreground.subagent", "foreground.subagent"],
    ["conductor/system", null],
  ] as const)("does not consume a binding for %s provenance", (_label, provenance) => {
    const { registry, socket: target } = boundRegistry();
    expect(publishDurableGuideUserClientAction(
      registry,
      lifecycleEvent({ trustedExecutionEntrypoint: provenance }),
      NOW,
    )).toBe(false);
    expect(target.frames).toHaveLength(0);
    expect(registry.consumeOnce("turn-1")).not.toBeNull();
  });

  test("consumes before a closed or failed direct send and never restores it", () => {
    const closed = boundRegistry(socket({ open: false }));
    expect(publishDurableGuideUserClientAction(closed.registry, lifecycleEvent(), NOW)).toBe(false);
    expect(closed.registry.consumeOnce("turn-1")).toBeNull();

    const failed = boundRegistry(socket({ throwOnSend: true }));
    expect(publishDurableGuideUserClientAction(failed.registry, lifecycleEvent(), NOW)).toBe(false);
    expect(failed.registry.consumeOnce("turn-1")).toBeNull();
  });
});
