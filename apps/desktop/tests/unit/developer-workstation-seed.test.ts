/**
 * D418 — Developer Workstation seed profile unit tests.
 *
 * Pins the shipped seed's posture: it strict-parses, uses host networking,
 * declares explicit toolchain capability ids + backends, carries a bounded env
 * key allowlist (no PATH / arbitrary env), uses safe root templates (never `/`
 * or the exact user home), and remains a profile TEMPLATE — it does not
 * activate or create authority. Cross-platform shaping (Xcode only on darwin)
 * and seed↔discovery id alignment are also pinned.
 */
import { describe, expect, test } from "bun:test";
import * as nodePath from "node:path";

import {
  compileWorkstationProfile,
  parseWorkstationProfile,
  PROFILE_CAPABILITY_BACKENDS,
  PROFILE_DISCOVERY_PROVIDERS,
  PROFILE_NETWORK_MODES,
  type DiscoveredWorkstationFacts,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";

import {
  buildDeveloperWorkstationSeedRecord,
  CAP_ANDROID_SDK,
  CAP_BUN,
  CAP_EXPO_METRO,
  CAP_GRADLE,
  CAP_HOMEBREW,
  CAP_JDK,
  CAP_MASTRO,
  CAP_NPM,
  CAP_XCODE,
  createDeveloperWorkstationSeedProfile,
  DEVELOPER_WORKSTATION_ENV_ALLOWLIST,
  DEVELOPER_WORKSTATION_SEED_CAPABILITIES,
  DEVELOPER_WORKSTATION_SEED_CAPABILITY_DECLARATIONS,
  DEVELOPER_WORKSTATION_SEED_PROFILE_ID,
  DEVELOPER_WORKSTATION_SEED_PROFILE_NAME,
  DEVELOPER_WORKSTATION_SEED_PROFILE_REVISION,
  DEVELOPER_WORKSTATION_SEED_PROTECTED_POLICY_VERSION,
  developerWorkstationSeedProfile,
} from "../../electron/workstation-profiles/developer-workstation-seed";

const HOME = nodePath.join(nodePath.sep, "Users", "dev");
const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("Developer Workstation seed — strict parsing", () => {
  test("parses fail-closed against the shared profile schema on darwin", () => {
    const result = createDeveloperWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.id).toBe(DEVELOPER_WORKSTATION_SEED_PROFILE_ID);
    expect(result.profile.revision).toBe(DEVELOPER_WORKSTATION_SEED_PROFILE_REVISION);
    expect(result.profile.name).toBe(DEVELOPER_WORKSTATION_SEED_PROFILE_NAME);
    expect(result.profile.protectedPolicyVersion).toBe(DEVELOPER_WORKSTATION_SEED_PROTECTED_POLICY_VERSION);
    expect(result.profile.createdAt).toBe(NOW.toISOString());
    expect(result.profile.updatedAt).toBe(NOW.toISOString());
  });

  test("parses on linux with the cross-platform toolchain set", () => {
    const result = createDeveloperWorkstationSeedProfile({ home: HOME, platform: "linux", now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.toolchainCapabilities.map((c) => c.id)).not.toContain(CAP_XCODE);
    expect(result.profile.toolchainCapabilities.map((c) => c.id)).toContain(CAP_BUN);
  });

  test("the convenience wrapper returns the parsed profile", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(profile.schemaVersion).toBe(1);
    expect(profile.id).toBe(DEVELOPER_WORKSTATION_SEED_PROFILE_ID);
  });

  test("rejects an invalid clock instead of producing an unparseable record", () => {
    const broken = new Date("not-a-date");
    const result = createDeveloperWorkstationSeedProfile({ home: HOME, platform: "darwin", now: broken });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_record");
  });
});

describe("Developer Workstation seed — posture", () => {
  test("uses host networking with an empty allow list", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(profile.network.mode).toBe("host");
    expect(PROFILE_NETWORK_MODES).toContain(profile.network.mode);
    expect(profile.network.allow).toEqual([]);
  });

  test("carries a bounded environment key allowlist with no PATH or arbitrary env", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(profile.environmentKeys).toEqual([...DEVELOPER_WORKSTATION_ENV_ALLOWLIST]);
    expect(profile.environmentKeys).not.toContain("PATH");
    expect(profile.environmentKeys).not.toContain("HOME");
    expect(profile.environmentKeys).not.toContain("USER");
    // Every key is unique.
    expect(new Set(profile.environmentKeys).size).toBe(profile.environmentKeys.length);
  });

  test("declares the broad guarded capability flags without escape capabilities", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(profile.capabilities).toEqual([...DEVELOPER_WORKSTATION_SEED_CAPABILITIES]);
    // No escape capability is representable in the closed enum, but assert the
    // device-control surface is the brokered one, not a raw host flag.
    expect(profile.capabilities).toContain("device_control");
    expect(profile.capabilities).toContain("mcp_hosts");
    expect(profile.capabilities).toContain("background_processes");
  });

  test("opts into the built-in discovery providers only", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    for (const provider of profile.discoveryProviders) {
      expect(PROFILE_DISCOVERY_PROVIDERS).toContain(provider);
    }
    // No "jdk" provider exists; JDK is discovered via a fixed-argv origin.
    expect(profile.discoveryProviders).not.toContain("jdk");
    expect(new Set(profile.discoveryProviders).size).toBe(profile.discoveryProviders.length);
  });
});

describe("Developer Workstation seed — safe root templates", () => {
  test("uses the operator home when callers omit a home override", () => {
    const result = createDeveloperWorkstationSeedProfile({ platform: "darwin", now: NOW });
    expect(result.ok).toBe(true);
  });

  test("never uses the filesystem root or the exact user home as a root", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const allRootPaths = [
      ...profile.roots.map((r) => r.path),
      ...profile.toolchainCapabilities.flatMap((c) => c.roots.map((r) => r.path)),
    ];
    for (const p of allRootPaths) {
      expect(nodePath.isAbsolute(p)).toBe(true);
      expect(p).not.toBe(nodePath.parse(p).root);
      expect(p).not.toBe(HOME);
    }
  });

  test("includes the Homebrew prefixes and cache as top-level roots on darwin", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const paths = profile.roots.map((r) => r.path);
    expect(paths).toContain("/opt/homebrew");
    expect(paths).toContain("/usr/local");
    expect(paths).toContain(nodePath.join(HOME, "Library", "Caches", "Homebrew"));
  });

  test("uses the Linuxbrew prefix on non-darwin", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "linux", now: NOW });
    const paths = profile.roots.map((r) => r.path);
    expect(paths).toContain("/home/linuxbrew/.linuxbrew");
    expect(paths).toContain(nodePath.join(HOME, ".cache", "Homebrew"));
    expect(paths).not.toContain("/opt/homebrew");
  });

  test("does not bake the Current Folder / monorepo root into the template", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const allRootPaths = [
      ...profile.roots.map((r) => r.path),
      ...profile.toolchainCapabilities.flatMap((c) => c.roots.map((r) => r.path)),
    ];
    // The seed is a template; the monorepo is discovered + compiled separately.
    expect(allRootPaths).not.toContain(nodePath.join(HOME, "code"));
    expect(allRootPaths).not.toContain(nodePath.join(HOME, "Projects"));
  });
});

describe("Developer Workstation seed — toolchain capabilities", () => {
  test("declares every shared capability id with an explicit, supported backend", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const ids = profile.toolchainCapabilities.map((c) => c.id);
    for (const declaration of DEVELOPER_WORKSTATION_SEED_CAPABILITY_DECLARATIONS) {
      expect(ids).toContain(declaration.id);
      const cap = profile.toolchainCapabilities.find((c) => c.id === declaration.id)!;
      expect(PROFILE_CAPABILITY_BACKENDS).toContain(cap.backend);
      expect(cap.backend).toBe(declaration.backend);
      expect(cap.operations).toEqual([...declaration.operations]);
      expect(cap.environmentKeys).toEqual([...declaration.environmentKeys]);
      expect(cap.discoveredFrom).toBe(declaration.discoveredFrom);
      expect(cap.kind).toBe(declaration.kind);
    }
  });

  test("device-control toolchains use the brokered host-service backend, not sandboxed", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const byId = new Map(profile.toolchainCapabilities.map((c) => [c.id, c]));
    expect(byId.get(CAP_ANDROID_SDK)!.backend).toBe("brokered_host_service");
    expect(byId.get(CAP_XCODE)!.backend).toBe("brokered_host_service");
    expect(byId.get(CAP_MASTRO)!.backend).toBe("brokered_host_service");
    // Package managers / build tools run sandboxed.
    expect(byId.get(CAP_BUN)!.backend).toBe("sandboxed");
    expect(byId.get(CAP_HOMEBREW)!.backend).toBe("sandboxed");
    expect(byId.get(CAP_JDK)!.backend).toBe("sandboxed");
  });

  test("includes Xcode only on darwin", () => {
    const darwin = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(darwin.toolchainCapabilities.map((c) => c.id)).toContain(CAP_XCODE);
    const linux = developerWorkstationSeedProfile({ home: HOME, platform: "linux", now: NOW });
    expect(linux.toolchainCapabilities.map((c) => c.id)).not.toContain(CAP_XCODE);
  });

  test("authorizes the JDK parent that contains a discovered java home", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const jdk = profile.toolchainCapabilities.find((c) => c.id === CAP_JDK)!;
    expect(jdk.roots.map((r) => r.path)).toContain("/Library/Java/JavaVirtualMachines");
  });

  test("the Homebrew capability owns no filesystem root; the prefix is a top-level root", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const homebrew = profile.toolchainCapabilities.find((c) => c.id === CAP_HOMEBREW)!;
    expect(homebrew.roots).toEqual([]);
  });

  test("toolchain capability ids are unique", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const ids = profile.toolchainCapabilities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every capability declares a non-empty executable + operations so the generic delta adapter can propose facts", () => {
    // 5.3.1: an unknown toolchain produces a decision-ready profile delta
    // without a code release. The generic adapter derives a proposed delta
    // from each capability's declared executable / roots / env keys / backend /
    // operations, so pin that the seed declares every field the adapter needs.
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    for (const cap of profile.toolchainCapabilities) {
      expect(cap.executable.length).toBeGreaterThan(0);
      expect(cap.operations.length).toBeGreaterThan(0);
      expect(cap.backend === "sandboxed" || cap.backend === "brokered_host_service").toBe(true);
      // Roots may be empty (e.g. Homebrew owns no capability root), so only
      // assert that the declared roots are absolute + traversal-free.
      for (const root of cap.roots) {
        expect(nodePath.isAbsolute(root.path)).toBe(true);
        expect(root.path).not.toBe(nodePath.parse(root.path).root);
      }
    }
  });
});

describe("Developer Workstation seed — record shape", () => {
  test("the raw record carries exactly the schema-allowed profile keys", () => {
    const record = buildDeveloperWorkstationSeedRecord({ home: HOME, platform: "darwin", now: NOW });
    const allowed = new Set([
      "schemaVersion",
      "id",
      "revision",
      "name",
      "roots",
      "discoveryProviders",
      "environmentKeys",
      "executableRules",
      "network",
      "capabilities",
      "toolchainCapabilities",
      "protectedPolicyVersion",
      "createdAt",
      "updatedAt",
    ]);
    for (const key of Object.keys(record)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(record["schemaVersion"]).toBe(1);
  });

  test("the executable rules declare explicit argv tokens and a sandboxed backend", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    expect(profile.executableRules.length).toBeGreaterThanOrEqual(1);
    for (const rule of profile.executableRules) {
      expect(rule.backend).toBe("sandboxed");
      expect(Array.isArray(rule.argv)).toBe(true);
    }
  });
});

describe("Developer Workstation seed — compiles against representative discovered facts", () => {
  test("facts within the seed's root templates compile to a contained intersection", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const bunRoot = nodePath.join(HOME, ".bun");
    const facts: DiscoveredWorkstationFacts = {
      roots: [
        { path: "/opt/homebrew", access: ["read", "create_modify", "delete", "execute"], sourceProvider: "homebrew" },
      ],
      environmentKeys: ["BUN_INSTALL"],
      capabilities: [
        {
          id: CAP_BUN,
          executable: nodePath.join(bunRoot, "bin", "bun"),
          roots: [{ path: bunRoot, access: ["read", "create_modify"], sourceProvider: "bun" }],
          environmentKeys: ["BUN_INSTALL"],
          backend: "sandboxed",
          operations: ["run", "install", "test"],
        },
      ],
    };
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.compiled.profileId).toBe(profile.id);
    expect(compiled.compiled.profileRevision).toBe(profile.revision);
    expect(compiled.compiled.capabilities.map((c) => c.id)).toContain(CAP_BUN);
  });

  test("rejects a discovered root the seed does not authorize (discovery never creates authority)", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const facts: DiscoveredWorkstationFacts = {
      roots: [{ path: nodePath.join(nodePath.sep, "etc", "secret"), access: ["read"] }],
      environmentKeys: [],
      capabilities: [],
    };
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("discovered_root_not_allowed");
  });
});

describe("Developer Workstation seed — store-ready", () => {
  test("a parsed seed is accepted by parseWorkstationProfile on re-parse (idempotent)", () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
    const reparsed = parseWorkstationProfile(profile, { now: NOW });
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.profile.id).toBe(profile.id);
    expect(reparsed.profile.toolchainCapabilities.map((c) => c.id)).toEqual(
      profile.toolchainCapabilities.map((c) => c.id),
    );
  });

  test("the seed profile object is a plain template with no activation/authority side effects", () => {
    const profile: WorkstationProfile = developerWorkstationSeedProfile({
      home: HOME,
      platform: "darwin",
      now: NOW,
    });
    // The seed is just a validated record; it carries no grant ids, sessions, or
    // compiled state. Activation + compilation happen elsewhere.
    expect(profile).not.toHaveProperty("grantIds");
    expect(profile).not.toHaveProperty("compiledAt");
    expect(profile).not.toHaveProperty("activeSession");
  });
});
