import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import {
  getToolCatalog,
  ToolCatalog,
  initToolCatalog,
} from "@nautilo/catalog";
import { buildRuntimeCapabilityTokens } from "../../src/runtime/relay-capabilities";
import { createRunShellTool } from "../../src/tools/shell/run-shell";
import { createTerminalTool } from "../../src/tools/terminal/terminal";
import { createHueLightsTool } from "../../src/tools/device/hue-lights";

type MockRelayRegistry = Parameters<typeof buildRuntimeCapabilityTokens>[0];

function mockRelayRegistry(opts: {
  hasRelay: boolean;
  canRunShell?: boolean;
  canReadWorkspace?: boolean;
  canWriteWorkspace?: boolean;
  canUseTerminal?: boolean;
  hasPendingTerminalHandoff?: boolean;
  canControlHue?: boolean;
}): NonNullable<MockRelayRegistry> {
  return {
    findByCapabilityForUser: (capability) =>
      opts.hasRelay && (capability !== "canControlHue" || opts.canControlHue === true)
        ? ["mock-relay-1"]
        : [],
    getCapabilities: () =>
      opts.hasRelay
        ? {
            profile: "desktop-agent",
            canRunShell: opts.canRunShell ?? true,
            canReadWorkspace: opts.canReadWorkspace ?? true,
            canWriteWorkspace: opts.canWriteWorkspace ?? true,
            canUseTerminal: opts.canUseTerminal,
            hasPendingTerminalHandoff: opts.hasPendingTerminalHandoff,
            canControlHue: opts.canControlHue,
          }
        : null,
    dispatch: async () => ({ status: "ok" as const, result: "" }),
  };
}

function initRelayPlumbingCatalog(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "run_shell",
    factory: () => createRunShellTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "destructive",
    tags: ["shell", "command", "exec", "terminal"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_workstation"],
    relayCapabilities: ["canRunShell"],
    resultScanPolicy: "on-suspicious",
  });
  catalog.register({
    name: "terminal",
    factory: () => createTerminalTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "high",
    tags: ["shell", "terminal", "pty", "interactive"],
    requiredCapabilities: ["use_workstation"],
    relayCapabilities: ["canUseTerminal"],
    resultScanPolicy: "on-suspicious",
  });
  catalog.register({
    name: "hue_lights",
    factory: () => createHueLightsTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    tags: ["hue", "lights", "smart-home"],
    requiresApproval: false,
    requiredCapabilities: ["control_home"],
    resultScanPolicy: "on-suspicious",
  });
  initToolCatalog(catalog);
}

describe("Layer 1 — relay-capability plumbing", () => {
  beforeAll(() => {
    initRelayPlumbingCatalog();
  });

  afterEach(() => {});

  test("WITH desktop-agent relay connected: catalog includes run_shell for owner-tier", () => {
    const registry = mockRelayRegistry({ hasRelay: true });

    const tokens = buildRuntimeCapabilityTokens(registry, "user-1");
    expect(tokens).toBeDefined();
    expect(tokens?.["canRunShell"]).toBe(true);

    const catalog = getToolCatalog();
    expect(catalog).not.toBeNull();
    const snap = catalog!.getFiltered(undefined, tokens);
    expect(snap.entries.map((e) => e.name)).toContain("run_shell");
  });

  test("WITHOUT any relay: tokens are undefined and run_shell is filtered out", () => {
    const tokens = buildRuntimeCapabilityTokens(null, "user-1");
    expect(tokens).toBeUndefined();

    const catalog = getToolCatalog();
    expect(catalog).not.toBeNull();
    const snap = catalog!.getFiltered(undefined, tokens);
    expect(snap.entries.map((e) => e.name)).not.toContain("run_shell");
  });

  test("relay present but canRunShell=false: run_shell is not exposed", () => {
    const registry = mockRelayRegistry({ hasRelay: true, canRunShell: false });
    const tokens = buildRuntimeCapabilityTokens(registry, "user-1");
    expect(tokens).toBeDefined();
    expect(tokens?.["canRunShell"]).toBeUndefined();

    const catalog = getToolCatalog();
    const snap = catalog!.getFiltered(undefined, tokens);
    expect(snap.entries.map((e) => e.name)).not.toContain("run_shell");
  });

  test("terminal requires its own PTY relay capability", () => {
    const withoutPty = buildRuntimeCapabilityTokens(
      mockRelayRegistry({ hasRelay: true, canUseTerminal: false }),
      "user-1",
    );
    expect(withoutPty?.["canUseTerminal"]).toBeUndefined();
    expect(getToolCatalog()!.getFiltered(undefined, withoutPty).entries.map((e) => e.name))
      .not.toContain("terminal");

    const withPty = buildRuntimeCapabilityTokens(
      mockRelayRegistry({ hasRelay: true, canUseTerminal: true }),
      "user-1",
    );
    expect(withPty?.["canUseTerminal"]).toBe(true);
    expect(getToolCatalog()!.getFiltered(undefined, withPty).entries.map((e) => e.name))
      .toContain("terminal");
  });

  test("pending terminal handoff projects a presence-only runtime token", () => {
    const pending = buildRuntimeCapabilityTokens(
      mockRelayRegistry({
        hasRelay: true,
        canUseTerminal: true,
        hasPendingTerminalHandoff: true,
      }),
      "user-1",
    );
    expect(pending?.["hasPendingTerminalHandoff"]).toBe(true);

    const noTerminal = buildRuntimeCapabilityTokens(
      mockRelayRegistry({
        hasRelay: true,
        canUseTerminal: false,
        hasPendingTerminalHandoff: true,
      }),
      "user-1",
    );
    expect(noTerminal?.["hasPendingTerminalHandoff"]).toBeUndefined();
  });

  test("WITH a Hue-capable relay: catalog includes hue_lights", () => {
    const tokens = buildRuntimeCapabilityTokens(
      mockRelayRegistry({ hasRelay: true, canControlHue: true }),
      "user-1",
    );
    expect(tokens?.["canControlHue"]).toBe(true);
    expect(tokens?.["control_home"]).toBe(true);

    const snap = getToolCatalog()!.getFiltered(undefined, tokens);
    expect(snap.entries.map((e) => e.name)).toContain("hue_lights");
  });

  test("relay without Hue capability: hue_lights is filtered out", () => {
    const tokens = buildRuntimeCapabilityTokens(
      mockRelayRegistry({ hasRelay: true, canControlHue: false }),
      "user-1",
    );
    expect(tokens?.["control_home"]).toBeUndefined();

    const snap = getToolCatalog()!.getFiltered(undefined, tokens);
    expect(snap.entries.map((e) => e.name)).not.toContain("hue_lights");
  });
});
