/**
 * Tests for buildRelaySandboxProfile — D060 Sprint 1 G5.4.b.
 *
 * The builder is the single glue point between server posture +
 * relay-reported paths + deployment profile helpers. Tests pin:
 *   - shape of the wire envelope per deployment mode
 *   - graceful null return on missing required relay paths
 *   - permissive-with-no-userHome downgrades to locked (safer shape,
 *     not a hard throw)
 *   - the config field mirrors what the sandbox helper produces so
 *     the source of truth is `@nautilo/sandbox`, not this file.
 */

import { describe, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import type { ServerPosture } from "@nautilo/config";

import { buildRelaySandboxProfile } from "../../src/relay/sandbox-profile-builder";

const BASE_RELAY_CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  workspaceRoot: "/Users/tester/Projects/nautilo",
  allowedRoots: ["/Users/tester/Projects/nautilo"],
  dataDir: "/Users/tester/.nautilo",
  toolsBin: "/Users/tester/.nautilo/tools",
  userHome: "/Users/tester",
};

const POSTURE_SERVER: ServerPosture = {
  deploymentMode: "server",
  securityLevel: "paranoid",
};
const POSTURE_PERMISSIVE: ServerPosture = {
  deploymentMode: "desktop-permissive",
  securityLevel: "cautious",
};
const POSTURE_LOCKED: ServerPosture = {
  deploymentMode: "desktop-locked",
  securityLevel: "paranoid",
};

describe("buildRelaySandboxProfile", () => {
  test("server mode: workspace-only, no readOnlyPaths", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: BASE_RELAY_CAPS,
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("server");
    expect(profile.securityLevel).toBe("paranoid");
    expect(profile.workspace).toBe("/Users/tester/Projects/nautilo");
    expect(profile.dataDir).toBe("/Users/tester/.nautilo");
    expect(profile.toolsBin).toBe("/Users/tester/.nautilo/tools");
    expect(profile.config.mode).toBe("enabled");
    expect(profile.config.writablePaths).toEqual([]);
    expect(profile.config.projectPaths).toEqual([]);
    expect(profile.config.readOnlyPaths).toBeUndefined();
  });

  test("desktop-permissive: broad RO home + narrow RW project", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: BASE_RELAY_CAPS,
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("desktop-permissive");
    expect(profile.securityLevel).toBe("cautious");
    expect(profile.workspace).toBe("/Users/tester/Projects/nautilo");
    expect(profile.config.readOnlyPaths).toEqual(["/Users/tester"]);
  });

  test("desktop-permissive uses per-turn currentFolder as execution root", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        currentFolderRoot: "/Users/tester/Projects/current-app",
        allowedRoots: ["/Users/tester/Documents/Nautilo"],
      },
      currentFolder: "/Users/tester/Projects/current-app",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("desktop-permissive");
    expect(profile.workspace).toBe("/Users/tester/Projects/current-app");
    expect(profile.config.readOnlyPaths).toEqual(["/Users/tester"]);
  });

  test("clean desktop profile uses its visible Genie Workspace when no Current Folder is selected", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        // The named root wins over the generic jail list and is the root a
        // newly paired phone can use without visiting Settings first.
        workspaceRoot: "/Users/tester/Documents/Nautilo",
        allowedRoots: ["/Users/tester/other-jail-root"],
      },
      currentFolder: null,
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.workspace).toBe("/Users/tester/Documents/Nautilo");
  });

  test("does not accept a stale Current Folder that differs from the exact relay's private root", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_LOCKED,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        workspaceRoot: "/Users/tester/Documents/Nautilo",
        currentFolderRoot: "/Users/tester/Projects/exact-host-project",
      },
      currentFolder: "/Users/tester/Projects/other-host-project",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.workspace).toBe("/Users/tester/Documents/Nautilo");
  });

  test("does not accept a Current Folder when the selected relay has not bound one", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_LOCKED,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        workspaceRoot: "/Users/tester/Documents/Nautilo",
      },
      currentFolder: "/Users/tester/Projects/context-from-another-host",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.workspace).toBe("/Users/tester/Documents/Nautilo");
  });

  test("desktop-locked uses per-turn currentFolder as execution root", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_LOCKED,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        currentFolderRoot: "/Users/tester/Projects/current-app",
        allowedRoots: ["/Users/tester/Documents/Nautilo"],
      },
      currentFolder: "/Users/tester/Projects/current-app",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("desktop-locked");
    expect(profile.workspace).toBe("/Users/tester/Projects/current-app");
  });

  test("paranoid server posture keeps the exact Current Folder on a Desktop relay", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        workspaceRoot: "/Users/tester/Documents/Nautilo",
        currentFolderRoot: "/Users/tester/Projects/current-app",
        allowedRoots: [
          "/Users/tester/Documents/Nautilo",
          "/Users/tester/Projects/current-app",
        ],
      },
      currentFolder: "/Users/tester/Projects/current-app",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("server");
    expect(profile.securityLevel).toBe("paranoid");
    expect(profile.workspace).toBe("/Users/tester/Projects/current-app");
  });

  test("true headless server mode ignores advisory currentFolder and stays workspace-confined", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: {
        ...BASE_RELAY_CAPS,
        profile: "device-relay",
        workspaceRoot: "/var/nautilo/artifacts",
        allowedRoots: ["/var/nautilo/artifacts"],
      },
      currentFolder: "/Users/tester/Projects/current-app",
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("server");
    expect(profile.workspace).toBe("/var/nautilo/artifacts");
  });

  test("unsafe currentFolder falls back to relay workspace", () => {
    for (const currentFolder of ["relative/path", "/etc", "/etc/passwd", "/path/with\nnewline"]) {
      const profile = buildRelaySandboxProfile({
        posture: POSTURE_PERMISSIVE,
        relayCaps: {
          ...BASE_RELAY_CAPS,
          workspaceRoot: "/Users/tester/Documents/Nautilo",
          allowedRoots: ["/Users/tester/Documents/Nautilo"],
        },
        currentFolder,
      });
      expect(profile).not.toBeNull();
      if (!profile) throw new Error("narrow");
      expect(profile.workspace).toBe("/Users/tester/Documents/Nautilo");
    }
  });

  test("desktop-locked: workspace-only, paranoid default", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_LOCKED,
      relayCaps: BASE_RELAY_CAPS,
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    expect(profile.mode).toBe("desktop-locked");
    expect(profile.securityLevel).toBe("paranoid");
    expect(profile.config.readOnlyPaths).toBeUndefined();
  });

  test("desktop-permissive WITHOUT userHome: degrades to desktop-locked shape", () => {
    const { userHome, ...capsNoHome } = BASE_RELAY_CAPS;
    void userHome;
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: capsNoHome,
    });
    expect(profile).not.toBeNull();
    if (!profile) throw new Error("narrow");
    // Mode field echoes what the helper built (locked), NOT the
    // posture (permissive) — so forensic logs show the actual
    // shape that ran, not the intent.
    expect(profile.mode).toBe("desktop-locked");
    expect(profile.config.readOnlyPaths).toBeUndefined();
  });

  test("null when the explicit workspaceRoot is missing", () => {
    const { workspaceRoot, ...capsNoWs } = BASE_RELAY_CAPS;
    void workspaceRoot;
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: capsNoWs,
    });
    expect(profile).toBeNull();
  });

  test("null when dataDir missing", () => {
    const { dataDir, ...capsNoData } = BASE_RELAY_CAPS;
    void dataDir;
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: capsNoData,
    });
    expect(profile).toBeNull();
  });

  test("null when toolsBin missing", () => {
    const { toolsBin, ...capsNoTools } = BASE_RELAY_CAPS;
    void toolsBin;
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: capsNoTools,
    });
    expect(profile).toBeNull();
  });

  test("null when required paths are empty strings (not just undefined)", () => {
    // Defend against callers that report placeholder empty strings
    // instead of omitting the field. Either way = invalid input.
    expect(
      buildRelaySandboxProfile({
        posture: POSTURE_SERVER,
        relayCaps: { ...BASE_RELAY_CAPS, dataDir: "" },
      }),
    ).toBeNull();
    expect(
      buildRelaySandboxProfile({
        posture: POSTURE_SERVER,
        relayCaps: { ...BASE_RELAY_CAPS, toolsBin: "" },
      }),
    ).toBeNull();
    expect(
      buildRelaySandboxProfile({
        posture: POSTURE_SERVER,
        relayCaps: { ...BASE_RELAY_CAPS, workspaceRoot: "" },
      }),
    ).toBeNull();
  });

  test("failIfNoBackend: paranoid profiles (server, locked) set it TRUE; permissive sets it FALSE", () => {
    // Self-review SEC-1 regression lock. Dropping this field on the
    // wire silently breaks the paranoid contract — relay would
    // passthrough-execute on a host without bwrap/sandbox-exec.
    const serverProfile = buildRelaySandboxProfile({
      posture: POSTURE_SERVER,
      relayCaps: BASE_RELAY_CAPS,
    });
    const lockedProfile = buildRelaySandboxProfile({
      posture: POSTURE_LOCKED,
      relayCaps: BASE_RELAY_CAPS,
    });
    const permissiveProfile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: BASE_RELAY_CAPS,
    });
    if (!serverProfile || !lockedProfile || !permissiveProfile) {
      throw new Error("expected all three profiles to build");
    }
    expect(serverProfile.failIfNoBackend).toBe(true);
    expect(lockedProfile.failIfNoBackend).toBe(true);
    expect(permissiveProfile.failIfNoBackend).toBe(false);
  });

  test("envelope config mirrors @nautilo/sandbox helper output (single source of truth)", () => {
    // If someone adds a writablePaths default to desktopPermissive,
    // this test catches the drift — the envelope SHOULD carry
    // whatever the helper emits, not a re-derived copy.
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: BASE_RELAY_CAPS,
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.mode).toBe("enabled");
    // The permissive helper has no default Downloads + no extras
    // → writablePaths is empty by default. projectPaths too (injected
    // at runtime by the workspace switcher, not at profile-build).
    expect(profile.config.writablePaths).toEqual([]);
    expect(profile.config.projectPaths).toEqual([]);
    expect(profile.config.passthroughEnv).toEqual([]);
  });

  test("D099: session-approved writable paths ride the next relay envelope", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: BASE_RELAY_CAPS,
      extraWritablePaths: ["/Users/tester/Documents/approved.md"],
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.writablePaths).toContain(
      "/Users/tester/Documents/approved.md",
    );
  });

  test("D103: posture networkPolicy rides the relay envelope", () => {
    const profile = buildRelaySandboxProfile({
      posture: POSTURE_PERMISSIVE,
      relayCaps: BASE_RELAY_CAPS,
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.networkPolicy).toEqual({ mode: "host" });
  });

  test("D103: explicit proxy allowlist is serialized without undefined optionals", () => {
    const profile = buildRelaySandboxProfile({
      posture: {
        ...POSTURE_LOCKED,
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [
            { type: "domain", host: "api.openai.com" },
            { type: "wildcard", suffix: "github.com", ports: [443] },
          ],
        },
      },
      relayCaps: BASE_RELAY_CAPS,
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "api.openai.com" },
        { type: "wildcard", suffix: "github.com", ports: [443] },
      ],
    });
  });

  test("D103 Phase E: session network approvals widen isolated posture to proxy allowlist", () => {
    const profile = buildRelaySandboxProfile({
      posture: {
        ...POSTURE_LOCKED,
        networkPolicy: { mode: "isolated" },
      },
      relayCaps: BASE_RELAY_CAPS,
      extraNetworkAllowRules: [
        { type: "domain", host: "api.openai.com", ports: [443] },
      ],
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "api.openai.com", ports: [443] },
      ],
    });
  });

  test("D103 Phase E: session network approvals merge into proxy allowlist", () => {
    const profile = buildRelaySandboxProfile({
      posture: {
        ...POSTURE_LOCKED,
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [{ type: "domain", host: "api.openai.com", ports: [443] }],
        },
      },
      relayCaps: BASE_RELAY_CAPS,
      extraNetworkAllowRules: [
        { type: "domain", host: "api.openai.com", ports: [443] },
        { type: "domain", host: "registry.npmjs.org", ports: [443] },
      ],
    });
    if (!profile) throw new Error("expected profile");
    expect(profile.config.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "api.openai.com", ports: [443] },
        { type: "domain", host: "registry.npmjs.org", ports: [443] },
      ],
    });
  });
});
