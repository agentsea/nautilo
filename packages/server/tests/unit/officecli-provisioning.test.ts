/**
 * D372 P4 — OfficeCLI provisioning / checksum policy unit tests.
 *
 * Pure helpers only: manifest parse, path resolve, sha256 verify. No network,
 * no real OfficeCLI binary required.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkOfficeCliProvisioning,
  detectOfficeCliPlatformKey,
  loadOfficeCliManifest,
  OfficeCliManifestError,
  OfficeCliProvisioningError,
  officeCliAvailable,
  parseOfficeCliManifest,
  resolveOfficeCliOrNull,
  resolveOfficeCliVendorRoot,
  resetOfficeCliVerificationCache,
  resolveVendoredOfficeCliPath,
  sha256HexOfBytes,
  verifyOfficeCliBinary,
  verifyOfficeCliOnce,
} from "@nautilo/config/officecli";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_MANIFEST = {
  officecli: {
    version: "1.0.128",
    source: "https://github.com/OfficeCLI/OfficeCLI",
    license: "Apache-2.0",
    binaryName: "officecli",
    artifacts: {
      "darwin-arm64": {
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sizeMin: 10,
      },
      "linux-x64": {
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      "win-x64": {
        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        binaryName: "officecli.exe",
      },
    },
  },
} as const;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "officecli-prov-"));
}

function writeManifest(dir: string, data: unknown = SAMPLE_MANIFEST): string {
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function writeBinary(dir: string, name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

async function expectRejects(
  run: () => Promise<unknown>,
  assert: (err: unknown) => void,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  assert(thrown);
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe("detectOfficeCliPlatformKey", () => {
  test("maps darwin arm64", () => {
    expect(detectOfficeCliPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
  });

  test("maps linux x64", () => {
    expect(detectOfficeCliPlatformKey("linux", "x64")).toBe("linux-x64");
  });

  test("maps win32 arm64 to win-x64 slot", () => {
    expect(detectOfficeCliPlatformKey("win32", "arm64")).toBe("win-x64");
  });

  test("returns null for unsupported combos", () => {
    expect(detectOfficeCliPlatformKey("aix", "ppc")).toBeNull();
    expect(detectOfficeCliPlatformKey("linux", "ia32")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

describe("parseOfficeCliManifest", () => {
  test("parses wrapped manifest", () => {
    const parsed = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    expect(parsed.officecli.version).toBe("1.0.128");
    expect(parsed.officecli.license).toBe("Apache-2.0");
    expect(parsed.officecli.artifacts["darwin-arm64"]?.sha256).toHaveLength(64);
    expect(parsed.officecli.artifacts["darwin-arm64"]?.sizeMin).toBe(10);
  });

  test("rejects invalid sha256", () => {
    const bad = {
      officecli: {
        ...SAMPLE_MANIFEST.officecli,
        artifacts: {
          "darwin-arm64": { sha256: "not-a-hash" },
        },
      },
    };
    expect(() => parseOfficeCliManifest(JSON.stringify(bad))).toThrow(OfficeCliManifestError);
  });

  test("rejects empty artifacts", () => {
    const bad = {
      officecli: {
        version: "1.0.0",
        source: "https://example.com",
        license: "Apache-2.0",
        artifacts: {},
      },
    };
    expect(() => parseOfficeCliManifest(JSON.stringify(bad))).toThrow(OfficeCliManifestError);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseOfficeCliManifest("{")).toThrow(OfficeCliManifestError);
  });
});

// ---------------------------------------------------------------------------
// Vendor root + path resolution
// ---------------------------------------------------------------------------

describe("resolveOfficeCliVendorRoot", () => {
  test("defaults to packages/server/vendor/officecli under repoRoot", () => {
    const root = resolveOfficeCliVendorRoot({ repoRoot: "/repo" });
    expect(root).toBe("/repo/packages/server/vendor/officecli");
  });

  test("OFFICECLI_VENDOR_ROOT wins", () => {
    const root = resolveOfficeCliVendorRoot({
      repoRoot: "/repo",
      env: { OFFICECLI_VENDOR_ROOT: "/custom/vendor" },
    });
    expect(root).toBe("/custom/vendor");
  });

  test("relative OFFICECLI_VENDOR_ROOT resolves against repoRoot", () => {
    const root = resolveOfficeCliVendorRoot({
      repoRoot: "/repo",
      env: { OFFICECLI_VENDOR_ROOT: "vendor/officecli" },
    });
    expect(root).toBe("/repo/vendor/officecli");
  });
});

describe("resolveVendoredOfficeCliPath", () => {
  test("joins vendorRoot, platform key, and binary name", () => {
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    const path = resolveVendoredOfficeCliPath({
      vendorRoot: "/vendor",
      platformKey: "darwin-arm64",
      manifest,
    });
    expect(path).toBe("/vendor/darwin-arm64/officecli");
  });

  test("uses win artifact binaryName", () => {
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    const path = resolveVendoredOfficeCliPath({
      vendorRoot: "/vendor",
      platformKey: "win-x64",
      manifest,
    });
    expect(path).toBe("/vendor/win-x64/officecli.exe");
  });

  // M203 — the binary is no longer committed to git; path resolution must be
  // purely computed from the manifest + platform key with no on-disk binary.
  test("resolves linux-x64 without any binary present on disk", () => {
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    const path = resolveVendoredOfficeCliPath({
      vendorRoot: "/vendor",
      platformKey: "linux-x64",
      manifest,
    });
    expect(path).toBe("/vendor/linux-x64/officecli");
  });

  test("throws when platform missing from manifest", () => {
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    expect(() =>
      resolveVendoredOfficeCliPath({
        vendorRoot: "/vendor",
        platformKey: "linux-arm64",
        manifest,
      }),
    ).toThrow(OfficeCliProvisioningError);
  });
});

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

describe("verifyOfficeCliBinary", () => {
  test("passes when sha256 matches", async () => {
    const dir = makeTmpDir();
    const bytes = Buffer.from("fake-officecli-payload");
    const hash = sha256HexOfBytes(bytes);
    const binaryPath = writeBinary(dir, "officecli", bytes);
    const result = await verifyOfficeCliBinary({
      binaryPath,
      expectedSha256: hash,
      platformKey: "darwin-arm64",
    });
    expect(result.ok).toBe(true);
    expect(result.actualSha256).toBe(hash);
    expect(result.size).toBe(bytes.length);
  });

  test("throws CHECKSUM_MISMATCH on wrong hash", async () => {
    const dir = makeTmpDir();
    const binaryPath = writeBinary(dir, "officecli", Buffer.from("x"));
    await expectRejects(
      () => verifyOfficeCliBinary({
        binaryPath,
        expectedSha256: "d".repeat(64),
        platformKey: "darwin-arm64",
      }),
      (err) => expect(err).toMatchObject({ code: "CHECKSUM_MISMATCH" }),
    );
  });

  test("throws SIZE_TOO_SMALL when below sizeMin", async () => {
    const dir = makeTmpDir();
    const bytes = Buffer.from("tiny");
    const hash = sha256HexOfBytes(bytes);
    const binaryPath = writeBinary(dir, "officecli", bytes);
    await expectRejects(
      () => verifyOfficeCliBinary({
        binaryPath,
        expectedSha256: hash,
        sizeMin: 100,
        platformKey: "darwin-arm64",
      }),
      (err) => expect(err).toMatchObject({ code: "SIZE_TOO_SMALL" }),
    );
  });

  test("throws BINARY_MISSING for missing file", async () => {
    await expectRejects(
      () => verifyOfficeCliBinary({
        binaryPath: "/no/such/officecli",
        expectedSha256: "a".repeat(64),
      }),
      (err) => expect(err).toMatchObject({ code: "BINARY_MISSING" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Composite check
// ---------------------------------------------------------------------------

describe("checkOfficeCliProvisioning", () => {
  test("happy path with vendored tree layout", async () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const bytes = Buffer.from("pinned-binary-bytes");
    const hash = sha256HexOfBytes(bytes);
    const platformDir = join(vendorRoot, "darwin-arm64");
    mkdirSync(platformDir, { recursive: true });
    writeBinary(platformDir, "officecli", bytes);

    const manifest = loadOfficeCliManifest(join(vendorRoot, "manifest.json"));
    manifest.officecli.artifacts["darwin-arm64"] = {
      sha256: hash,
      sizeMin: 1,
    };
    writeFileSync(join(vendorRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    const result = await checkOfficeCliProvisioning({
      vendorRoot,
      platformKey: "darwin-arm64",
    });
    expect(result.version).toBe("1.0.128");
    expect(result.binaryPath).toBe(join(vendorRoot, "darwin-arm64", "officecli"));
    expect(result.sha256).toBe(hash);
    expect(readFileSync(result.binaryPath).equals(bytes)).toBe(true);
  });

  test("propagates manifest parse errors", async () => {
    const vendorRoot = makeTmpDir();
    writeFileSync(join(vendorRoot, "manifest.json"), "{");
    await expectRejects(
      () => checkOfficeCliProvisioning({ vendorRoot, platformKey: "darwin-arm64" }),
      (err) => expect(err).toBeInstanceOf(OfficeCliManifestError),
    );
  });
});

// ---------------------------------------------------------------------------
// D391 — non-throwing availability probe (officeCliAvailable / resolveOfficeCliOrNull)
// ---------------------------------------------------------------------------

describe("resolveOfficeCliOrNull / officeCliAvailable", () => {
  test("returns the vendored binary path when the platform artifact is present + executable", () => {
    const vendorRoot = makeTmpDir();
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    // Update the darwin-arm64 entry to a real hash + write the binary.
    const bytes = Buffer.from("pinned-binary-bytes-for-availability-probe");
    const hash = sha256HexOfBytes(bytes);
    manifest.officecli.artifacts["darwin-arm64"] = { sha256: hash, sizeMin: 1 };
    writeFileSync(join(vendorRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
    const platformDir = join(vendorRoot, "darwin-arm64");
    mkdirSync(platformDir, { recursive: true });
    writeBinary(platformDir, "officecli", bytes);

    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "darwin-arm64",
      // Strip env so OFFICECLI_PATH / PATH can't leak the host's real binary
      // into this test (we want to exercise the vendored-binary branch).
      env: {},
    });
    expect(resolved).toBe(join(vendorRoot, "darwin-arm64", "officecli"));
    expect(officeCliAvailable({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: {},
    })).toBe(true);
  });

  test("returns null when the platform artifact is absent (binary not vendored)", () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    // No platform subdir / binary created.
    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "linux-x64",
      env: {},
    });
    expect(resolved).toBeNull();
    expect(officeCliAvailable({
      vendorRoot,
      platformKey: "linux-x64",
      env: {},
    })).toBe(false);
  });

  test("returns null when the platform is unsupported (no manifest slot)", () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "linux-arm64", // SAMPLE_MANIFEST has no linux-arm64 artifact
      env: {},
    });
    expect(resolved).toBeNull();
    expect(officeCliAvailable({
      vendorRoot,
      platformKey: "linux-arm64",
      env: {},
    })).toBe(false);
  });

  test("returns null when detectOfficeCliPlatformKey() yields null on the host", () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: null,
      env: {},
    });
    expect(resolved).toBeNull();
  });

  test("returns null (never throws) when the manifest is malformed", () => {
    const vendorRoot = makeTmpDir();
    writeFileSync(join(vendorRoot, "manifest.json"), "{not valid json");
    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: {},
    });
    expect(resolved).toBeNull();
    expect(officeCliAvailable({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: {},
    })).toBe(false);
  });

  test("returns null when the vendored binary exists but is not executable", () => {
    const vendorRoot = makeTmpDir();
    const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
    const bytes = Buffer.from("pinned-binary-bytes");
    const hash = sha256HexOfBytes(bytes);
    manifest.officecli.artifacts["darwin-arm64"] = { sha256: hash };
    writeFileSync(join(vendorRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
    const platformDir = join(vendorRoot, "darwin-arm64");
    mkdirSync(platformDir, { recursive: true });
    // Write the binary but strip the exec bit (skip on Windows where X_OK is no-op).
    const binaryPath = join(platformDir, "officecli");
    writeFileSync(binaryPath, bytes);
    if (process.platform !== "win32") chmodSync(binaryPath, 0o644);

    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: {},
    });
    if (process.platform === "win32") {
      // Windows has no exec bit — the file is "executable" by default.
      expect(resolved).toBe(binaryPath);
    } else {
      expect(resolved).toBeNull();
      expect(officeCliAvailable({
        vendorRoot,
        platformKey: "darwin-arm64",
        env: {},
      })).toBe(false);
    }
  });

  test("OFFICECLI_PATH override wins when it points to an executable file", () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const overrideDir = makeTmpDir();
    const overrideBytes = Buffer.from("override-officecli-bytes");
    const overridePath = writeBinary(overrideDir, "officecli", overrideBytes);

    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: { OFFICECLI_PATH: overridePath },
    });
    expect(resolved).toBe(overridePath);
    expect(officeCliAvailable({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: { OFFICECLI_PATH: overridePath },
    })).toBe(true);
  });

  test("returns null when OFFICECLI_PATH points to a non-existent path", () => {
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const resolved = resolveOfficeCliOrNull({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: { OFFICECLI_PATH: "/no/such/officecli-binary", PATH: "" },
    });
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D391 2.4 — verify-once integrity gate (cached, darwin-drift-tolerant)
// ---------------------------------------------------------------------------

/** Set up a vendored tree for `platformKey` whose binary bytes hash to the
 *  manifest sha, and return the vendorRoot + binaryPath. */
function setupVendored(
  platformKey: "darwin-arm64" | "linux-x64",
  bytes: Buffer,
): { vendorRoot: string; binaryPath: string } {
  const vendorRoot = makeTmpDir();
  const manifest = parseOfficeCliManifest(JSON.stringify(SAMPLE_MANIFEST));
  manifest.officecli.artifacts[platformKey] = {
    sha256: sha256HexOfBytes(bytes),
    sizeMin: 1,
  };
  writeFileSync(join(vendorRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  const platformDir = join(vendorRoot, platformKey);
  mkdirSync(platformDir, { recursive: true });
  const binaryPath = writeBinary(platformDir, "officecli", bytes);
  return { vendorRoot, binaryPath };
}

describe("verifyOfficeCliOnce", () => {
  test("verifies the vendored binary sha and returns ok when it matches", async () => {
    resetOfficeCliVerificationCache();
    const bytes = Buffer.from("verify-once-matching-bytes");
    const { vendorRoot, binaryPath } = setupVendored("linux-x64", bytes);
    const outcome = await verifyOfficeCliOnce({
      vendorRoot,
      platformKey: "linux-x64",
      env: {},
    });
    expect(outcome).toMatchObject({ ok: true, binaryPath, shaChecked: true });
    if (outcome.ok) expect(outcome.note).toBeUndefined();
  });

  test("REFUSES a linux binary whose sha does not match the manifest", async () => {
    resetOfficeCliVerificationCache();
    const { vendorRoot } = setupVendored("linux-x64", Buffer.from("original-bytes"));
    // Corrupt the on-disk binary so its sha no longer matches the pinned value.
    const binaryPath = join(vendorRoot, "linux-x64", "officecli");
    writeBinary(join(vendorRoot, "linux-x64"), "officecli", Buffer.from("tampered-bytes-XYZ"));
    const outcome = await verifyOfficeCliOnce({
      vendorRoot,
      platformKey: "linux-x64",
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CHECKSUM_MISMATCH");
      expect(outcome.error).toContain(binaryPath);
    }
  });

  test("TOLERATES a darwin sha drift (macOS codesign) and returns a note", async () => {
    resetOfficeCliVerificationCache();
    const { vendorRoot } = setupVendored("darwin-arm64", Buffer.from("darwin-original"));
    // Simulate the post-first-run codesign mutation: bytes differ from manifest.
    writeBinary(join(vendorRoot, "darwin-arm64"), "officecli", Buffer.from("darwin-codesigned"));
    const outcome = await verifyOfficeCliOnce({
      vendorRoot,
      platformKey: "darwin-arm64",
      env: {},
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.shaChecked).toBe(true);
      expect(outcome.note).toContain("signed-at-package");
      expect(outcome.note).toContain("OfficeCLI");
    }
  });

  test("trusts an OFFICECLI_PATH override without hashing (shaChecked=false)", async () => {
    resetOfficeCliVerificationCache();
    const { vendorRoot } = setupVendored("linux-x64", Buffer.from("vendored-bytes"));
    const overrideDir = makeTmpDir();
    const overridePath = writeBinary(overrideDir, "officecli", Buffer.from("override-bytes"));
    const outcome = await verifyOfficeCliOnce({
      vendorRoot,
      platformKey: "linux-x64",
      env: { OFFICECLI_PATH: overridePath },
    });
    expect(outcome).toMatchObject({ ok: true, binaryPath: overridePath, shaChecked: false });
  });

  test("returns UNAVAILABLE when no usable binary exists", async () => {
    resetOfficeCliVerificationCache();
    const vendorRoot = makeTmpDir();
    writeManifest(vendorRoot);
    const outcome = await verifyOfficeCliOnce({
      vendorRoot,
      platformKey: "linux-x64",
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("UNAVAILABLE");
  });

  test("caches the result: a post-verify byte change is NOT re-hashed until reset", async () => {
    resetOfficeCliVerificationCache();
    const { vendorRoot } = setupVendored("linux-x64", Buffer.from("cache-bytes-A"));
    const platformDir = join(vendorRoot, "linux-x64");

    const first = await verifyOfficeCliOnce({ vendorRoot, platformKey: "linux-x64", env: {} });
    expect(first.ok).toBe(true);

    // Tamper AFTER the first verify. A cached hit must not re-hash → still ok.
    writeBinary(platformDir, "officecli", Buffer.from("cache-bytes-B-tampered"));
    const second = await verifyOfficeCliOnce({ vendorRoot, platformKey: "linux-x64", env: {} });
    expect(second.ok).toBe(true);

    // After a reset the gate re-hashes the (now-mismatched) bytes → refuse.
    resetOfficeCliVerificationCache();
    const third = await verifyOfficeCliOnce({ vendorRoot, platformKey: "linux-x64", env: {} });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("CHECKSUM_MISMATCH");
  });
});
