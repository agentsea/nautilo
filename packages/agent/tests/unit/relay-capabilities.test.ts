import { describe, it, expect } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { buildRuntimeCapabilityTokens } from "../../src/runtime/relay-capabilities";
import type { ToolRelayRegistry } from "../../src/nodes/tools";

function fakeRegistry(
  byUser: Record<string, { id: string; caps: RelayCapabilities }[]>,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser(capability: string, userId: string): string[] {
      return (byUser[userId] ?? [])
        .filter((r) =>
          capability === "canUseStructuredSsh"
            ? r.caps.structuredSsh?.state === "enabled"
            : capability === "canConfigureStructuredSsh"
              ? r.caps.structuredSsh !== undefined && r.caps.structuredSsh.state !== "unavailable" && r.caps.structuredSsh.ssh === "observed"
            : (r.caps as Record<string, unknown>)[capability] === true,
        )
        .map((r) => r.id);
    },
    getCapabilities(relayId: string): RelayCapabilities | null {
      for (const relays of Object.values(byUser)) {
        const hit = relays.find((r) => r.id === relayId);
        if (hit) return hit.caps;
      }
      return null;
    },
    // unused by buildRuntimeCapabilityTokens
    dispatch: (() => {
      throw new Error("not used");
    }) as unknown as ToolRelayRegistry["dispatch"],
  };
}

describe("buildRuntimeCapabilityTokens — Cua readiness isolation", () => {
  it("does not project owner-wide Cua readiness as a catalog token", () => {
    const reg = fakeRegistry({
      u1: [
        { id: "mac-a", caps: { profile: "desktop-agent", canRunShell: true } },
        { id: "mac-b", caps: { profile: "desktop-agent", canControlDesktop: true } },
      ],
    });

    const tokens = buildRuntimeCapabilityTokens(reg, "u1");
    expect(tokens?.["canRunShell"]).toBe(true);
    expect(tokens?.["canControlDesktop"]).toBeUndefined();
    expect(tokens?.["control_desktop"]).toBeUndefined();
  });

  it("keeps unrelated desktop capabilities without reviving retired desktop tools", () => {
    const reg = fakeRegistry({
      u1: [{ id: "r1", caps: { profile: "desktop-agent", canControlDesktop: true, canSeeDesktop: true } }],
    });
    const tokens = buildRuntimeCapabilityTokens(reg, "u1");
    expect(tokens).toBeDefined();
    expect(tokens?.["canControlDesktop"]).toBeUndefined();
    expect(tokens?.["canSeeDesktop"]).toBe(true);
    expect(tokens?.["control_desktop"]).toBeUndefined();
    expect(tokens?.["use_high_impact_tools"]).toBeUndefined();
  });

  it("does not create Computer Use authority from readiness without an exact receipt", () => {
    const reg = fakeRegistry({
      u1: [{ id: "r1", caps: { profile: "desktop-agent", canControlDesktop: true } }],
    });
    const tokens = buildRuntimeCapabilityTokens(reg, "u1");
    expect(tokens?.["canControlDesktop"]).toBeUndefined();
    expect(tokens?.["control_desktop"]).toBeUndefined();
    expect(tokens?.["canUseComputer"]).toBeUndefined();
  });

  it("returns undefined when no relay is connected", () => {
    expect(buildRuntimeCapabilityTokens(null, "u1")).toBeUndefined();
    expect(buildRuntimeCapabilityTokens(fakeRegistry({}), "u1")).toBeUndefined();
  });
});

describe("buildRuntimeCapabilityTokens — structured SSH readiness (D500)", () => {
  it("detects a relay whose only advertised operation is retained SSH output", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-output",
        caps: { profile: "desktop-agent", canReadStructuredSshOutput: true },
      }],
    }), "u1");

    expect(tokens?.["canReadStructuredSshOutput"]).toBe(true);
    expect(tokens?.["use_high_impact_tools"]).toBeUndefined();
  });

  it("projects shared SSH and copy tokens only from a fully enabled aggregate", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-ready",
        caps: {
          profile: "desktop-agent",
          structuredSsh: {
            version: 1,
            state: "enabled",
            provider: "openssh",
            ssh: "observed",
            scp: "observed",
            auth: true,
            exec: true,
            upload: true,
            download: true,
          },
        },
      }],
    }), "u1");

    expect(tokens?.["canUseStructuredSsh"]).toBe(true);
    expect(tokens?.["canUseStructuredSshCopy"]).toBe(true);
    expect(tokens?.["use_high_impact_tools"]).toBeUndefined();
  });

  it("does not project unavailable or not-enabled structured SSH readiness", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-unavailable",
        caps: {
          profile: "desktop-agent",
          canRunShell: true,
          structuredSsh: {
            version: 1,
            state: "unavailable",
            provider: "openssh",
            ssh: "unavailable",
            scp: "unavailable",
          },
        },
      }],
    }), "u1");

    expect(tokens?.["canRunShell"]).toBe(true);
    expect(tokens?.["canUseStructuredSsh"]).toBeUndefined();
    expect(tokens?.["canUseStructuredSshCopy"]).toBeUndefined();

    const notEnabled = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-not-enabled",
        caps: {
          profile: "desktop-agent",
          structuredSsh: {
            version: 1,
            state: "not-enabled",
            provider: "openssh",
            ssh: "observed",
            scp: "observed",
          },
        },
      }],
    }), "u1");

    expect(notEnabled?.["canConfigureStructuredSsh"]).toBe(true);
    expect(notEnabled?.["canConfigureStructuredSshCopy"]).toBe(true);
    expect(notEnabled?.["canUseStructuredSsh"]).toBeUndefined();
  });

  it("withholds shared SSH tools for partial auth/exec and copy directions", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-partial",
        caps: {
          profile: "desktop-agent",
          structuredSsh: {
            version: 1,
            state: "enabled",
            provider: "openssh",
            ssh: "observed",
            scp: "observed",
            auth: true,
            exec: false,
            upload: true,
            download: false,
          },
        },
      }],
    }), "u1");
    expect(tokens?.["canUseStructuredSsh"]).toBeUndefined();
    expect(tokens?.["canUseStructuredSshCopy"]).toBeUndefined();
  });

  it("withholds copy when scp is unobserved even when both copy directions are enabled", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u1: [{
        id: "ssh-without-scp",
        caps: {
          profile: "desktop-agent",
          structuredSsh: {
            version: 1,
            state: "enabled",
            provider: "openssh",
            ssh: "observed",
            scp: "unavailable",
            auth: true,
            exec: true,
            upload: true,
            download: true,
          },
        },
      }],
    }), "u1");
    expect(tokens?.["canUseStructuredSsh"]).toBe(true);
    expect(tokens?.["canUseStructuredSshCopy"]).toBeUndefined();
  });

  it("does not project another user's available structured SSH readiness", () => {
    const tokens = buildRuntimeCapabilityTokens(fakeRegistry({
      u2: [{
        id: "other-user-ssh-ready",
        caps: {
          profile: "desktop-agent",
          structuredSsh: {
            version: 1,
            state: "enabled",
            provider: "openssh",
            ssh: "observed",
            scp: "unavailable",
            auth: true,
            exec: true,
            upload: true,
            download: true,
          },
        },
      }],
    }), "u1");

    expect(tokens).toBeUndefined();
  });

  it("returns no structured SSH token when disconnected or absent", () => {
    expect(buildRuntimeCapabilityTokens(null, "u1")).toBeUndefined();
    expect(buildRuntimeCapabilityTokens(fakeRegistry({}), "u1")).toBeUndefined();
  });
});
