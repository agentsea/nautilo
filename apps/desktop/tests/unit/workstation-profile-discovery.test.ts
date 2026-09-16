/**
 * D418 — advisory Developer Workstation discovery adapter tests.
 *
 * Pins the advisory contract with fully injected filesystem / exec / env seams:
 *   - installed tools emit canonical `DiscoveredWorkstationFacts` whose
 *     capabilities match the seed's id / backend / operations / env-key
 *     contracts and whose roots are existing readable paths within the seed's
 *     root templates;
 *   - missing tools are optional/missing review rows, never errors;
 *   - `execFile` is always invoked with a fixed binary + argument array (no
 *     shell strings), and only bounded allowlisted env keys are read;
 *   - out-of-profile readable paths are dropped + surfaced as review notes;
 *   - the discovered facts compile against the seed profile (discovery never
 *     creates authority the profile does not already authorize).
 */
import { describe, expect, test } from "bun:test";
import * as nodePath from "node:path";

import {
  compileWorkstationProfile,
  type DiscoveredWorkstationFacts,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";

import {
  CAP_ANDROID_SDK,
  CAP_BUN,
  CAP_EXPO_METRO,
  CAP_GRADLE,
  CAP_HOMEBREW,
  CAP_JDK,
  CAP_MASTRO,
  CAP_NPM,
  CAP_XCODE,
  DEVELOPER_WORKSTATION_ENV_ALLOWLIST,
  developerWorkstationSeedProfile,
} from "../../electron/workstation-profiles/developer-workstation-seed";
import {
  discoverWorkstationFacts,
  type WorkstationDiscoveryExec,
} from "../../electron/workstation-profiles/discovery";

const HOME = nodePath.join(nodePath.sep, "Users", "dev");
const NOW = new Date("2026-07-13T12:00:00.000Z");
const JDK_HOME = "/Library/Java/JavaVirtualMachines/temurin-17/Contents/Home";
const ANDROID_SDK = nodePath.join(HOME, "Library", "Android", "sdk");

interface FakeSeams {
  readonly fs: { access(path: string): Promise<void> };
  readonly exec: WorkstationDiscoveryExec;
  readonly getEnv: (key: string) => string | undefined;
  readonly existing: ReadonlySet<string>;
  readonly execCalls: Array<{ file: string; args: readonly string[] }>;
  readonly envCalls: string[];
}

function createFakeSeams(options: {
  existing?: readonly string[];
  execResponses?: ReadonlyMap<string, string>;
  env?: Record<string, string>;
}): FakeSeams {
  const existing = new Set(options.existing ?? []);
  const execResponses = options.execResponses ?? new Map();
  const env = options.env ?? {};
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const envCalls: string[] = [];
  return {
    existing,
    execCalls,
    envCalls,
    fs: {
      async access(path: string) {
        if (existing.has(path)) return;
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    },
    exec: ((file: string, args: readonly string[]) => {
      execCalls.push({ file, args: [...args] });
      const key = `${file}\u0000${JSON.stringify([...args])}`;
      const stdout = execResponses.get(key);
      if (stdout === undefined) {
        throw new Error(`no fake response for ${file} ${JSON.stringify([...args])}`);
      }
      return Promise.resolve({ stdout, stderr: "" });
    }) as WorkstationDiscoveryExec,
    getEnv: (key: string) => {
      envCalls.push(key);
      return env[key];
    },
  };
}

function darwinSeed(): WorkstationProfile {
  return developerWorkstationSeedProfile({ home: HOME, platform: "darwin", now: NOW });
}

function fullyInstalledDarwinSeams(): FakeSeams {
  const existing = [
    nodePath.join(HOME, ".bun"),
    nodePath.join(HOME, ".bun", "bin", "bun"),
    nodePath.join(HOME, ".npm"),
    "/opt/homebrew",
    "/opt/homebrew/bin/brew",
    nodePath.join(HOME, "Library", "Caches", "Homebrew"),
    JDK_HOME,
    nodePath.join(JDK_HOME, "bin", "java"),
    nodePath.join(HOME, ".gradle"),
    nodePath.join(HOME, ".expo"),
    ANDROID_SDK,
    nodePath.join(ANDROID_SDK, "platform-tools", "adb"),
    nodePath.join(HOME, ".android"),
    nodePath.join(HOME, "Library", "Developer", "Xcode", "DerivedData"),
    nodePath.join(HOME, "Library", "Developer", "CoreSimulator"),
    "/usr/bin/xcodebuild",
    nodePath.join(HOME, ".maestro"),
    nodePath.join(HOME, ".maestro", "bin", "maestro"),
  ];
  const execResponses = new Map<string, string>([
    [`${nodePath.join(HOME, ".bun", "bin", "bun")}\u0000${JSON.stringify(["--version"])}`, "1.2.0"],
    [`npm\u0000${JSON.stringify(["--version"])}`, "10.5.0"],
    [`/opt/homebrew/bin/brew\u0000${JSON.stringify(["--prefix"])}`, "/opt/homebrew"],
    [`/opt/homebrew/bin/brew\u0000${JSON.stringify(["--version"])}`, "Homebrew 4.2.0"],
    [`/usr/libexec/java_home\u0000${JSON.stringify([])}`, JDK_HOME],
    [`${nodePath.join(JDK_HOME, "bin", "java")}\u0000${JSON.stringify(["-version"])}`, "openjdk 17"],
    [`gradle\u0000${JSON.stringify(["--version"])}`, "Gradle 8.5"],
    [`expo\u0000${JSON.stringify(["--version"])}`, "Expo 5.0.0"],
    [`${nodePath.join(ANDROID_SDK, "platform-tools", "adb")}\u0000${JSON.stringify(["version"])}`, "Android Debug Bridge 1.0.41"],
    [`/usr/bin/xcodebuild\u0000${JSON.stringify(["-version"])}`, "Xcode 15.0"],
    [`${nodePath.join(HOME, ".maestro", "bin", "maestro")}\u0000${JSON.stringify(["--version"])}`, "Maestro 1.36.0"],
  ]);
  const env = {
    BUN_INSTALL: nodePath.join(HOME, ".bun"),
    JAVA_HOME: JDK_HOME,
    GRADLE_USER_HOME: nodePath.join(HOME, ".gradle"),
    ANDROID_HOME: ANDROID_SDK,
    ANDROID_SDK_ROOT: ANDROID_SDK,
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  };
  return createFakeSeams({ existing, execResponses, env });
}

describe("discoverWorkstationFacts — fully installed darwin host", () => {
  test("emits a capability per installed toolchain matching the seed contract", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });

    const ids = facts.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        CAP_ANDROID_SDK,
        CAP_BUN,
        CAP_EXPO_METRO,
        CAP_GRADLE,
        CAP_HOMEBREW,
        CAP_JDK,
        CAP_MASTRO,
        CAP_NPM,
        CAP_XCODE,
      ].sort(),
    );

    // Backends match the seed.
    const byId = new Map(facts.capabilities.map((c) => [c.id, c]));
    expect(byId.get(CAP_ANDROID_SDK)!.backend).toBe("brokered_host_service");
    expect(byId.get(CAP_XCODE)!.backend).toBe("brokered_host_service");
    expect(byId.get(CAP_MASTRO)!.backend).toBe("brokered_host_service");
    expect(byId.get(CAP_BUN)!.backend).toBe("sandboxed");
    expect(byId.get(CAP_HOMEBREW)!.backend).toBe("sandboxed");

    // Operations match the seed declarations (subset / equal).
    for (const cap of facts.capabilities) {
      const spec = profile.toolchainCapabilities.find((s) => s.id === cap.id)!;
      expect(cap.operations).toEqual([...spec.operations]);
    }

    // All review rows are "found".
    expect(review.summary).toEqual({ found: 9, optional: 0, missing: 0 });
    expect(review.rows.every((r) => r.status === "found")).toBe(true);
  });

  test("emits Homebrew prefix + cache as top-level roots within the seed's profile roots", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { facts } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const topPaths = facts.roots.map((r) => r.path);
    expect(topPaths).toContain("/opt/homebrew");
    expect(topPaths).toContain(nodePath.join(HOME, "Library", "Caches", "Homebrew"));
    for (const root of facts.roots) {
      expect(root.sourceProvider).toBe("homebrew");
    }
  });

  test("emits only existing readable paths, canonicalized", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { facts } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const allRootPaths = [
      ...facts.roots.map((r) => r.path),
      ...facts.capabilities.flatMap((c) => c.roots.map((r) => r.path)),
    ];
    for (const p of allRootPaths) {
      expect(seams.existing.has(p)).toBe(true);
      expect(p).toBe(nodePath.resolve(p));
    }
  });

  test("the discovered facts compile against the seed profile", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { facts } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    if (!compiled.ok) {
      throw new Error(`expected compile to succeed, got ${compiled.error.code}: ${compiled.error.message}`);
    }
    expect(compiled.ok).toBe(true);
    expect(compiled.compiled.capabilities.length).toBe(9);
  });
});

describe("discoverWorkstationFacts — safety contract", () => {
  test("execFile is always invoked with a fixed binary and an argument array, never a shell string", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(seams.execCalls.length).toBeGreaterThan(0);
    for (const call of seams.execCalls) {
      expect(typeof call.file).toBe("string");
      expect(call.file.length).toBeGreaterThan(0);
      expect(Array.isArray(call.args)).toBe(true);
      for (const arg of call.args) expect(typeof arg).toBe("string");
      // No shell string invocation.
      expect(call.file).not.toBe("sh");
      expect(call.file).not.toBe("/bin/sh");
      expect(call.file).not.toBe("bash");
      expect(call.args).not.toContain("-c");
    }
  });

  test("only bounded, allowlisted environment keys are read", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const allow = new Set<string>(DEVELOPER_WORKSTATION_ENV_ALLOWLIST);
    for (const key of seams.envCalls) {
      expect(allow.has(key)).toBe(true);
    }
    // No PATH / HOME / USER / arbitrary dump.
    expect(seams.envCalls).not.toContain("PATH");
    expect(seams.envCalls).not.toContain("HOME");
    expect(seams.envCalls).not.toContain("USER");
  });
});

describe("discoverWorkstationFacts — missing tools are review rows, not errors", () => {
  test("an empty host yields only missing/optional rows, no capabilities, and never rejects", async () => {
    const profile = darwinSeed();
    const seams = createFakeSeams({ existing: [], env: {} });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(facts.capabilities).toEqual([]);
    expect(facts.roots).toEqual([]);
    expect(facts.environmentKeys).toEqual([]);
    expect(review.summary.found).toBe(0);
    expect(review.summary.missing + review.summary.optional).toBe(9);
    // The empty facts still compile (nothing to intersect).
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    expect(compiled.ok).toBe(true);
  });

  test("a tool whose executable is absent but cache is present is optional, not found", async () => {
    const profile = darwinSeed();
    const seams = createFakeSeams({
      existing: [nodePath.join(HOME, ".bun")],
      env: {},
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const bunRow = review.rows.find((r) => r.capabilityId === CAP_BUN)!;
    expect(bunRow.status).toBe("optional");
    expect(bunRow.roots).toEqual([nodePath.join(HOME, ".bun")]);
    expect(facts.capabilities.map((c) => c.id)).not.toContain(CAP_BUN);
  });
});

describe("discoverWorkstationFacts — out-of-profile paths are surfaced, not asserted as facts", () => {
  test("a Homebrew prefix outside the seed root templates is dropped + noted", async () => {
    const profile = darwinSeed();
    const customPrefix = nodePath.join(nodePath.sep, "custom", "brew");
    // Brew is found at the well-known Apple Silicon path, but `--prefix`
    // reports a custom prefix outside the seed's root templates. The cache
    // remains within the seed, so it is kept; the custom prefix is dropped.
    const seams = createFakeSeams({
      existing: [
        "/opt/homebrew/bin/brew",
        "/opt/homebrew",
        customPrefix,
        nodePath.join(HOME, "Library", "Caches", "Homebrew"),
      ],
      execResponses: new Map([
        [`/opt/homebrew/bin/brew\u0000${JSON.stringify(["--prefix"])}`, customPrefix],
        [`/opt/homebrew/bin/brew\u0000${JSON.stringify(["--version"])}`, "Homebrew 4.2.0"],
      ]),
      env: {},
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    // The homebrew capability is still emitted (executable found) but no roots.
    const homebrew = facts.capabilities.find((c) => c.id === CAP_HOMEBREW);
    expect(homebrew).not.toBeUndefined();
    expect(homebrew!.roots).toEqual([]);
    // The custom prefix is not smuggled into facts.roots.
    expect(facts.roots.map((r) => r.path)).not.toContain(customPrefix);
    const row = review.rows.find((r) => r.capabilityId === CAP_HOMEBREW)!;
    expect(row.note).toMatch(/outside the profile root templates/);
    expect(row.note).toContain(customPrefix);
  });

  test("a JDK home outside the authorized parent is dropped + noted", async () => {
    const profile = darwinSeed();
    const customJdk = nodePath.join(HOME, "jdks", "temurin-17");
    const seams = createFakeSeams({
      existing: [customJdk, nodePath.join(customJdk, "bin", "java")],
      execResponses: new Map([
        [`/usr/libexec/java_home\u0000${JSON.stringify([])}`, customJdk],
        [`${nodePath.join(customJdk, "bin", "java")}\u0000${JSON.stringify(["-version"])}`, "openjdk 17"],
      ]),
      env: { JAVA_HOME: customJdk },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const jdk = facts.capabilities.find((c) => c.id === CAP_JDK)!;
    expect(jdk.roots).toEqual([]);
    const row = review.rows.find((r) => r.capabilityId === CAP_JDK)!;
    expect(row.note).toMatch(/outside the profile root templates/);
  });
});

describe("discoverWorkstationFacts — platform + review model", () => {
  test("the linux seed declares no Xcode capability, so discovery emits no Xcode row", async () => {
    const profile = developerWorkstationSeedProfile({ home: HOME, platform: "linux", now: NOW });
    const seams = createFakeSeams({
      existing: [
        nodePath.join(HOME, ".bun"),
        nodePath.join(HOME, ".bun", "bin", "bun"),
        nodePath.join(HOME, ".npm"),
        "/home/linuxbrew/.linuxbrew",
        "/home/linuxbrew/.linuxbrew/bin/brew",
        nodePath.join(HOME, ".cache", "Homebrew"),
        nodePath.join(HOME, ".gradle"),
        nodePath.join(HOME, ".expo"),
        nodePath.join(HOME, "Android", "Sdk"),
        nodePath.join(HOME, "Android", "Sdk", "platform-tools", "adb"),
        nodePath.join(HOME, ".android"),
        nodePath.join(HOME, ".maestro"),
        nodePath.join(HOME, ".maestro", "bin", "maestro"),
      ],
      execResponses: new Map([
        [`${nodePath.join(HOME, ".bun", "bin", "bun")}\u0000${JSON.stringify(["--version"])}`, "1.2.0"],
        [`npm\u0000${JSON.stringify(["--version"])}`, "10.5.0"],
        [`/home/linuxbrew/.linuxbrew/bin/brew\u0000${JSON.stringify(["--prefix"])}`, "/home/linuxbrew/.linuxbrew"],
        [`/home/linuxbrew/.linuxbrew/bin/brew\u0000${JSON.stringify(["--version"])}`, "Homebrew 4.2.0"],
        [`gradle\u0000${JSON.stringify(["--version"])}`, "Gradle 8.5"],
        [`expo\u0000${JSON.stringify(["--version"])}`, "Expo 5.0.0"],
        [`${nodePath.join(HOME, "Android", "Sdk", "platform-tools", "adb")}\u0000${JSON.stringify(["version"])}`, "Android Debug Bridge 1.0.41"],
        [`${nodePath.join(HOME, ".maestro", "bin", "maestro")}\u0000${JSON.stringify(["--version"])}`, "Maestro 1.36.0"],
      ]),
      env: { GRADLE_USER_HOME: nodePath.join(HOME, ".gradle") },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "linux",
      clock: () => NOW,
    });
    expect(facts.capabilities.map((c) => c.id)).not.toContain(CAP_XCODE);
    expect(review.rows.find((r) => r.capabilityId === CAP_XCODE)).toBeUndefined();
  });

  test("a profile that declares Xcode on a non-darwin host gets a missing macOS-only row", async () => {
    // The darwin seed declares CAP_XCODE; run its discovery on a linux host to
    // exercise the adapter's macOS-only guard.
    const profile = darwinSeed();
    const seams = createFakeSeams({ existing: [], env: {} });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "linux",
      clock: () => NOW,
    });
    expect(facts.capabilities.map((c) => c.id)).not.toContain(CAP_XCODE);
    const xcodeRow = review.rows.find((r) => r.capabilityId === CAP_XCODE)!;
    expect(xcodeRow.status).toBe("missing");
    expect(xcodeRow.note).toMatch(/macOS/);
  });

  test("the review model carries host-network implication, hard boundaries, and a summary", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(review.networkMode).toBe("host");
    expect(review.hostNetworkImplication.length).toBeGreaterThan(0);
    expect(review.hostNetworkImplication).toMatch(/host networking/i);
    expect(review.hardBoundaries.length).toBeGreaterThan(0);
    expect(review.hardBoundaries.some((b) => /credential|Keychain/i.test(b))).toBe(true);
    expect(review.generatedAt).toBe(NOW.toISOString());
    expect(review.platform).toBe("darwin");
    expect(review.home).toBe(HOME);
    expect(review.summary.found).toBe(9);
  });
});

describe("discoverWorkstationFacts — admin-declared custom capability (decision-ready delta)", () => {
  // The spec (5.3.1) requires an unknown toolchain to produce a decision-
  // ready profile delta instead of requiring a code release. A profile-declared
  // capability with no built-in adapter falls back to the generic adapter,
  // which proposes a delta from the admin-declared spec via fixed-argv probe +
  // declared root paths + bounded existing-config env keys. It never creates
  // authority: the emitted capability is advisory and compiles only because the
  // profile already declares it; a missing tool yields an optional/missing row.

  function customCapabilityProfile(options: {
    readonly executable?: string;
    readonly roots?: readonly { path: string; access: readonly ("read" | "create_modify" | "delete" | "execute")[] }[];
  }): WorkstationProfile {
    const base = darwinSeed();
    return {
      ...base,
      roots: [...base.roots, ...(options.roots ?? [])],
      toolchainCapabilities: [
        ...base.toolchainCapabilities,
        {
          id: "cap-rust",
          kind: "toolchain",
          discoveredFrom: "admin",
          executable: options.executable ?? "cargo",
          roots: options.roots ?? [{ path: nodePath.join(HOME, ".cargo"), access: ["read", "create_modify"] }],
          environmentKeys: ["CARGO_HOME"],
          backend: "sandboxed",
          operations: ["build", "test"],
        },
      ],
    };
  }

  test("a fully absent admin-declared toolchain yields a missing row, no capability, and never rejects", async () => {
    const profile = customCapabilityProfile({});
    const seams = createFakeSeams({ existing: [], env: {} });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(facts.capabilities.map((c) => c.id)).not.toContain("cap-rust");
    const row = review.rows.find((r) => r.capabilityId === "cap-rust")!;
    expect(row.status).toBe("missing");
    expect(row.origin).toBe("existing_config");
    expect(row.backend).toBe("sandboxed");
    expect(row.note).toMatch(/admin-declared toolchain/i);
    expect(row.note).toContain("cargo");
  });

  test("roots present but executable absent yields an optional row carrying the proposed delta shape", async () => {
    const cargoRoot = nodePath.join(HOME, ".cargo");
    const profile = customCapabilityProfile({});
    const seams = createFakeSeams({ existing: [cargoRoot], env: { CARGO_HOME: cargoRoot } });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(facts.capabilities.map((c) => c.id)).not.toContain("cap-rust");
    const row = review.rows.find((r) => r.capabilityId === "cap-rust")!;
    expect(row.status).toBe("optional");
    expect(row.origin).toBe("existing_config");
    expect(row.roots).toEqual([cargoRoot]);
    expect(row.environmentKeys).toEqual(["CARGO_HOME"]);
    expect(row.note).toMatch(/executable "cargo" was not found/i);
  });

  test("an installed admin-declared toolchain emits a capability that compiles against the profile", async () => {
    const cargoRoot = nodePath.join(HOME, ".cargo");
    const profile = customCapabilityProfile({});
    const seams = createFakeSeams({
      existing: [cargoRoot],
      execResponses: new Map([[`cargo\u0000${JSON.stringify(["--version"])}`, "cargo 1.78.0"]]),
      env: { CARGO_HOME: cargoRoot },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const cap = facts.capabilities.find((c) => c.id === "cap-rust");
    expect(cap).not.toBeUndefined();
    expect(cap!.executable).toBe("cargo");
    expect(cap!.backend).toBe("sandboxed");
    expect(cap!.operations).toEqual(["build", "test"]);
    expect(cap!.roots.map((r) => r.path)).toEqual([cargoRoot]);
    expect(cap!.environmentKeys).toEqual(["CARGO_HOME"]);
    const row = review.rows.find((r) => r.capabilityId === "cap-rust")!;
    expect(row.status).toBe("found");
    expect(row.version).toBe("cargo 1.78.0");
    // The proposed delta compiles only because the profile already declares it
    // — discovery never creates authority the profile does not authorize.
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    expect(compiled.ok).toBe(true);
  });

  test("the generic adapter probes with fixed argv only — no shell string and no env dump", async () => {
    const profile = customCapabilityProfile({});
    const seams = createFakeSeams({
      existing: [nodePath.join(HOME, ".cargo")],
      execResponses: new Map([[`cargo\u0000${JSON.stringify(["--version"])}`, "cargo 1.78.0"]]),
      env: { CARGO_HOME: nodePath.join(HOME, ".cargo") },
    });
    await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const cargoCalls = seams.execCalls.filter((c) => c.file === "cargo");
    expect(cargoCalls.length).toBeGreaterThan(0);
    for (const call of cargoCalls) {
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.args).not.toContain("-c");
      expect(call.file).not.toBe("sh");
      expect(call.file).not.toBe("bash");
    }
    // Only the admin-declared env key is read for the custom capability.
    expect(seams.envCalls).toContain("CARGO_HOME");
    expect(seams.envCalls).not.toContain("PATH");
    expect(seams.envCalls).not.toContain("HOME");
  });
});

describe("discoverWorkstationFacts — custom-but-authorized layouts (existing_config origin)", () => {
  test("JAVA_HOME pointing to a JDK inside the authorized parent is discovered via existing_config", async () => {
    // java_home is absent (e.g. it failed or this is a non-standard setup), so
    // the adapter falls back to the JAVA_HOME env key. The env value points to
    // a JDK inside the seed's authorized `/Library/Java/JavaVirtualMachines`
    // parent, so the discovered root is kept (not dropped) with origin
    // `existing_config`.
    const profile = darwinSeed();
    const customJdkHome = nodePath.join(
      "/Library/Java/JavaVirtualMachines",
      "corretto-21",
      "Contents",
      "Home",
    );
    const seams = createFakeSeams({
      existing: [customJdkHome, nodePath.join(customJdkHome, "bin", "java")],
      execResponses: new Map([
        [`${nodePath.join(customJdkHome, "bin", "java")}\u0000${JSON.stringify(["-version"])}`, "openjdk 21"],
        // No /usr/libexec/java_home response → the env fallback path is taken.
      ]),
      env: { JAVA_HOME: customJdkHome },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const jdk = facts.capabilities.find((c) => c.id === CAP_JDK)!;
    expect(jdk.roots.map((r) => r.path)).toContain(customJdkHome);
    const row = review.rows.find((r) => r.capabilityId === CAP_JDK)!;
    expect(row.status).toBe("found");
    expect(row.origin).toBe("existing_config");
    expect(row.environmentKeys).toEqual(["JAVA_HOME"]);
  });

  test("a custom Android SDK location authorized via an admin profile delta is discovered", async () => {
    // An admin expanded the profile to authorize a non-default Android SDK
    // location. Discovery reads ANDROID_HOME, finds the SDK at the authorized
    // custom root, and emits it — the admin-delta flow, no code release.
    const base = darwinSeed();
    const customSdk = nodePath.join(HOME, "AndroidCustom", "sdk");
    const customAdb = nodePath.join(customSdk, "platform-tools", "adb");
    const profile: WorkstationProfile = {
      ...base,
      toolchainCapabilities: base.toolchainCapabilities.map((cap) =>
        cap.id === CAP_ANDROID_SDK
          ? {
              ...cap,
              roots: [{ path: customSdk, access: ["read", "create_modify", "delete", "execute"] }],
            }
          : cap,
      ),
    };
    const seams = createFakeSeams({
      existing: [customSdk, customAdb, nodePath.join(HOME, ".android")],
      execResponses: new Map([[`${customAdb}\u0000${JSON.stringify(["version"])}`, "Android Debug Bridge 1.0.41"]]),
      env: { ANDROID_HOME: customSdk, ANDROID_SDK_ROOT: customSdk },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const android = facts.capabilities.find((c) => c.id === CAP_ANDROID_SDK)!;
    expect(android.roots.map((r) => r.path)).toContain(customSdk);
    const row = review.rows.find((r) => r.capabilityId === CAP_ANDROID_SDK)!;
    expect(row.status).toBe("found");
    expect(row.environmentKeys).toEqual(["ANDROID_HOME", "ANDROID_SDK_ROOT"]);
    // The custom-SDK facts compile against the admin-expanded profile.
    const compiled = compileWorkstationProfile(profile, facts, { now: NOW });
    expect(compiled.ok).toBe(true);
  });

  test("GRADLE_USER_HOME pointing to a custom authorized location is discovered", async () => {
    const base = darwinSeed();
    const customGradle = nodePath.join(HOME, "gradle-custom");
    const profile: WorkstationProfile = {
      ...base,
      toolchainCapabilities: base.toolchainCapabilities.map((cap) =>
        cap.id === CAP_GRADLE
          ? { ...cap, roots: [{ path: customGradle, access: ["read", "create_modify"] }] }
          : cap,
      ),
    };
    const seams = createFakeSeams({
      existing: [customGradle],
      execResponses: new Map([[`gradle\u0000${JSON.stringify(["--version"])}`, "Gradle 8.7"]]),
      env: { GRADLE_USER_HOME: customGradle },
    });
    const { facts, review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const gradle = facts.capabilities.find((c) => c.id === CAP_GRADLE)!;
    expect(gradle.roots.map((r) => r.path)).toContain(customGradle);
    const row = review.rows.find((r) => r.capabilityId === CAP_GRADLE)!;
    expect(row.status).toBe("found");
    expect(row.origin).toBe("existing_config");
  });
});

describe("discoverWorkstationFacts — IPC redaction at the discovery boundary", () => {
  test("the review model never carries environment VALUES, only allowlisted key names", async () => {
    // The review model is the shape that crosses IPC (main returns
    // `result.review`, never the raw facts). Pin that a sensitive env VALUE is
    // never serialized into the review — only bounded key names appear. This is
    // the discovery-side guarantee that complements main's IPC redaction.
    const profile = darwinSeed();
    const secretValue = "SUPER_SECRET_TOKEN_DO_NOT_LEAK";
    const seams = createFakeSeams({
      existing: [nodePath.join(HOME, ".bun"), nodePath.join(HOME, ".bun", "bin", "bun")],
      execResponses: new Map([
        [`${nodePath.join(HOME, ".bun", "bin", "bun")}\u0000${JSON.stringify(["--version"])}`, "1.2.0"],
      ]),
      env: {
        BUN_INSTALL: secretValue,
        // A non-allowlisted key carrying the same secret must never be read.
        SECRET_API_KEY: secretValue,
      },
    });
    const { review } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain(secretValue);
    // Only allowlisted key names appear; the non-allowlisted key is never read.
    expect(seams.envCalls).not.toContain("SECRET_API_KEY");
    for (const key of seams.envCalls) {
      expect(DEVELOPER_WORKSTATION_ENV_ALLOWLIST).toContain(key);
    }
    // Key names may appear (advisory display); values never do.
    expect(serialized).toContain("BUN_INSTALL");
  });

  test("the review carries no grant ids, sessions, or compiled state — it is advisory only", async () => {
    const profile = darwinSeed();
    const seams = fullyInstalledDarwinSeams();
    const { review, facts } = await discoverWorkstationFacts({
      profile,
      fs: seams.fs,
      execFileAsync: seams.exec,
      getEnv: seams.getEnv,
      home: HOME,
      platform: "darwin",
      clock: () => NOW,
    });
    expect(review).not.toHaveProperty("grantIds");
    expect(review).not.toHaveProperty("activeSession");
    expect(review).not.toHaveProperty("compiledAt");
    // Facts are the authoritative advisory shape; the review is the IPC-safe
    // projection. Facts carry no authority/session state either.
    expect(facts).not.toHaveProperty("grantIds");
    expect(facts).not.toHaveProperty("compiledAt");
  });
});
