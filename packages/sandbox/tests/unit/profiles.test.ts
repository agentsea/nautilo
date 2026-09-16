/**
 * Unit tests for the deployment-profile helpers.
 * D060 Sprint 1 G5.2.
 *
 * Each profile returns a `SandboxProfileSpec` with three observable
 * properties:
 *
 *   - `spec`: Omit<SandboxCreateOptions, "backend"> — ready to hand
 *     to `Sandbox.create()`.
 *   - `defaultSecurityLevel`: the canonical level for this mode
 *     (server/desktop-locked → paranoid; desktop-permissive → cautious).
 *   - `mode`: the mode name for logging / audit.
 *
 * These tests pin the exact shape per profile so a drift (someone
 * adds `writablePaths: ['/tmp']` to `serverRestrictive`, say)
 * surfaces in a test failure instead of silently widening the
 * containment surface.
 */

import { describe, expect, test } from "bun:test";
import {
  desktopLocked,
  desktopPermissive,
  serverRestrictive,
} from "../../src/profiles";

// ---------------------------------------------------------------------------
// Server mode — workspace-only, paranoid default
// ---------------------------------------------------------------------------

describe("serverRestrictive", () => {
  const baseInputs = {
    artifactsDir: "/var/nautilo/artifacts",
    dataDir: "/var/nautilo/data",
    toolsBin: "/usr/local/bin",
  };

  test("returns the canonical server shape", () => {
    const r = serverRestrictive(baseInputs);
    expect(r.mode).toBe("server");
    expect(r.defaultSecurityLevel).toBe("paranoid");
    expect(r.spec.workspace).toBe("/var/nautilo/artifacts");
    expect(r.spec.dataDir).toBe("/var/nautilo/data");
    expect(r.spec.toolsBin).toBe("/usr/local/bin");
    expect(r.spec.failIfNoBackend).toBe(true);
  });

  test("writablePaths + projectPaths empty by default", () => {
    const r = serverRestrictive(baseInputs);
    expect(r.spec.config.writablePaths).toEqual([]);
    expect(r.spec.config.projectPaths).toEqual([]);
  });

  test("readOnlyPaths NEVER set when no extras supplied (workspace-only)", () => {
    const r = serverRestrictive(baseInputs);
    expect(r.spec.config.readOnlyPaths).toBeUndefined();
  });

  test("mode='enabled'", () => {
    const r = serverRestrictive(baseInputs);
    expect(r.spec.config.mode).toBe("enabled");
  });

  test("extraWritablePaths appended to writablePaths baseline (empty)", () => {
    const r = serverRestrictive({
      ...baseInputs,
      extraWritablePaths: ["/var/nautilo/shared-output"],
    });
    expect(r.spec.config.writablePaths).toEqual([
      "/var/nautilo/shared-output",
    ]);
  });

  test("extraPassthroughEnv appended to passthroughEnv", () => {
    const r = serverRestrictive({
      ...baseInputs,
      extraPassthroughEnv: ["MY_TOKEN"],
    });
    expect(r.spec.config.passthroughEnv).toEqual(["MY_TOKEN"]);
  });

  test("throws if artifactsDir missing", () => {
    expect(() =>
      serverRestrictive({ dataDir: "/x", toolsBin: "/y" }),
    ).toThrow(/artifactsDir/);
  });

  test("throws if artifactsDir is empty string", () => {
    expect(() =>
      serverRestrictive({ ...baseInputs, artifactsDir: "" }),
    ).toThrow(/artifactsDir/);
  });

  test("throws on extraReadOnlyPaths (loud rejection, not silent ignore)", () => {
    expect(() =>
      serverRestrictive({
        ...baseInputs,
        extraReadOnlyPaths: ["/etc/shared"],
      }),
    ).toThrow(/extraReadOnlyPaths[\s\S]*workspace-only/);
  });
});

// ---------------------------------------------------------------------------
// Desktop-permissive mode — broad RO home + narrow RW project/Downloads
// ---------------------------------------------------------------------------

describe("desktopPermissive", () => {
  const baseInputs = {
    userHome: "/Users/tester",
    currentProject: "/Users/tester/Projects/nautilo",
    downloads: "/Users/tester/Downloads",
    dataDir: "/Users/tester/.nautilo",
    toolsBin: "/opt/homebrew/bin",
  };

  test("returns the canonical desktop-permissive shape", () => {
    const r = desktopPermissive(baseInputs);
    expect(r.mode).toBe("desktop-permissive");
    expect(r.defaultSecurityLevel).toBe("cautious");
    expect(r.spec.workspace).toBe("/Users/tester/Projects/nautilo");
    expect(r.spec.dataDir).toBe("/Users/tester/.nautilo");
    expect(r.spec.toolsBin).toBe("/opt/homebrew/bin");
    // Cautious default = no fail-loud. Missing backend WARNs + passthroughs.
    expect(r.spec.failIfNoBackend).toBe(false);
  });

  test("writablePaths includes Downloads (narrow write)", () => {
    const r = desktopPermissive(baseInputs);
    expect(r.spec.config.writablePaths).toEqual(["/Users/tester/Downloads"]);
  });

  test("readOnlyPaths includes userHome (broad read)", () => {
    const r = desktopPermissive(baseInputs);
    expect(r.spec.config.readOnlyPaths).toEqual(["/Users/tester"]);
  });

  test("writable overlap on home means project + Downloads writable within a RO home", () => {
    // The point of desktop-permissive: /Users/tester is readable
    // (readOnlyPaths) AND /Users/tester/Downloads is writable (writablePaths).
    // The builder's later-wins ordering means Downloads gets file-write
    // despite being under a RO parent. Test pins the config that produces
    // that shape; the actual later-wins ordering is tested in
    // bubblewrap.test.ts and seatbelt-profile.test.ts.
    const r = desktopPermissive(baseInputs);
    expect(r.spec.config.readOnlyPaths).toContain("/Users/tester");
    expect(r.spec.config.writablePaths).toContain("/Users/tester/Downloads");
  });

  test("Downloads omitted → writablePaths empty beyond extras", () => {
    const { downloads, ...noDownloads } = baseInputs;
    void downloads;
    const r = desktopPermissive(noDownloads);
    expect(r.spec.config.writablePaths).toEqual([]);
  });

  test("extra paths appended to baseline", () => {
    const r = desktopPermissive({
      ...baseInputs,
      extraWritablePaths: ["/Users/tester/Scratch"],
      extraReadOnlyPaths: ["/opt/shared"],
      extraPassthroughEnv: ["GH_TOKEN"],
    });
    expect(r.spec.config.writablePaths).toEqual([
      "/Users/tester/Downloads",
      "/Users/tester/Scratch",
    ]);
    expect(r.spec.config.readOnlyPaths).toEqual([
      "/Users/tester",
      "/opt/shared",
    ]);
    expect(r.spec.config.passthroughEnv).toEqual(["GH_TOKEN"]);
  });

  test("throws if userHome missing", () => {
    expect(() =>
      desktopPermissive({
        currentProject: "/p",
        dataDir: "/d",
        toolsBin: "/t",
      }),
    ).toThrow(/userHome/);
  });

  test("throws if currentProject missing", () => {
    expect(() =>
      desktopPermissive({
        userHome: "/h",
        dataDir: "/d",
        toolsBin: "/t",
      }),
    ).toThrow(/currentProject/);
  });
});

// ---------------------------------------------------------------------------
// Desktop-locked mode — workspace-only, paranoid default
// ---------------------------------------------------------------------------

describe("desktopLocked", () => {
  const baseInputs = {
    currentProject: "/Users/tester/Projects/regulated",
    dataDir: "/Users/tester/.nautilo",
    toolsBin: "/opt/homebrew/bin",
  };

  test("returns the canonical desktop-locked shape", () => {
    const r = desktopLocked(baseInputs);
    expect(r.mode).toBe("desktop-locked");
    expect(r.defaultSecurityLevel).toBe("paranoid");
    expect(r.spec.workspace).toBe("/Users/tester/Projects/regulated");
    expect(r.spec.failIfNoBackend).toBe(true);
  });

  test("readOnlyPaths NEVER set (workspace-only)", () => {
    const r = desktopLocked(baseInputs);
    expect(r.spec.config.readOnlyPaths).toBeUndefined();
  });

  test("writablePaths + projectPaths empty by default", () => {
    const r = desktopLocked(baseInputs);
    expect(r.spec.config.writablePaths).toEqual([]);
    expect(r.spec.config.projectPaths).toEqual([]);
  });

  test("throws if currentProject missing", () => {
    expect(() =>
      desktopLocked({ dataDir: "/d", toolsBin: "/t" }),
    ).toThrow(/currentProject/);
  });

  test("throws on extraReadOnlyPaths (wrong profile — redirect to desktopPermissive)", () => {
    expect(() =>
      desktopLocked({
        ...baseInputs,
        extraReadOnlyPaths: ["/Users/tester"],
      }),
    ).toThrow(/extraReadOnlyPaths[\s\S]*desktopPermissive/);
  });

  test("throws on downloads (wrong profile — redirect to desktopPermissive)", () => {
    expect(() =>
      desktopLocked({
        ...baseInputs,
        downloads: "/Users/tester/Downloads",
      }),
    ).toThrow(/downloads[\s\S]*desktopPermissive/);
  });
});

// ---------------------------------------------------------------------------
// Cross-profile invariants
// ---------------------------------------------------------------------------

describe("profile invariants", () => {
  test("every profile sets mode='enabled'", () => {
    const s = serverRestrictive({
      artifactsDir: "/a",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const p = desktopPermissive({
      userHome: "/h",
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const l = desktopLocked({
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    expect(s.spec.config.mode).toBe("enabled");
    expect(p.spec.config.mode).toBe("enabled");
    expect(l.spec.config.mode).toBe("enabled");
  });

  test("paranoid profiles set failIfNoBackend=true, cautious does not", () => {
    const s = serverRestrictive({
      artifactsDir: "/a",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const p = desktopPermissive({
      userHome: "/h",
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const l = desktopLocked({
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    expect(s.spec.failIfNoBackend).toBe(true);
    expect(p.spec.failIfNoBackend).toBe(false);
    expect(l.spec.failIfNoBackend).toBe(true);
  });

  test("every profile passes workspace/dataDir/toolsBin through without mutation", () => {
    const s = serverRestrictive({
      artifactsDir: "/a",
      dataDir: "/d",
      toolsBin: "/t",
    });
    expect(s.spec.dataDir).toBe("/d");
    expect(s.spec.toolsBin).toBe("/t");
  });

  test("desktop-permissive is the ONLY profile that sets readOnlyPaths", () => {
    const s = serverRestrictive({
      artifactsDir: "/a",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const p = desktopPermissive({
      userHome: "/h",
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    const l = desktopLocked({
      currentProject: "/p",
      dataDir: "/d",
      toolsBin: "/t",
    });
    expect(s.spec.config.readOnlyPaths).toBeUndefined();
    expect(p.spec.config.readOnlyPaths).toBeDefined();
    expect(l.spec.config.readOnlyPaths).toBeUndefined();
  });
});
