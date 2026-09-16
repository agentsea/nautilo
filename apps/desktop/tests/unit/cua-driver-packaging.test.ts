import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  PINNED_CUA_DRIVER_ARCHIVE_NAME,
  PINNED_CUA_DRIVER_ARCHIVE_SHA256,
  PINNED_CUA_DRIVER_ARCHIVE_URL,
  PINNED_CUA_DRIVER_LICENSE_SHA256,
  PINNED_CUA_DRIVER_LICENSE_URL,
  PINNED_CUA_DRIVER_RELEASE_TAG,
  PINNED_CUA_DRIVER_RELEASE_REVISION,
  PINNED_CUA_DRIVER_SOURCE_REVISION,
  parseSafeCuaDriverArchive,
  vendorCuaDriver,
  type CuaDriverReleaseContract,
} from "../../scripts/vendor-cua-driver.ts";
import { buildScreenRecordingPermissionHelper } from "../../scripts/build-screen-recording-permission.ts";

const desktopRoot = join(import.meta.dir, "../..");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const electronBuilder = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
const afterPack = readFileSync(join(desktopRoot, "scripts/after-pack.cjs"), "utf8");
const afterSign = readFileSync(join(desktopRoot, "scripts/after-sign.cjs"), "utf8");
const vendorScript = readFileSync(join(desktopRoot, "scripts/vendor-cua-driver.ts"), "utf8");
const cuaEntitlementsPlist = readFileSync(join(desktopRoot, "entitlements.cua-driver.plist"), "utf8");
const screenPermissionEntitlementsPlist = readFileSync(
  join(desktopRoot, "entitlements.screen-recording-permission.plist"),
  "utf8",
);
const require = createRequire(import.meta.path);
const yaml = require("js-yaml") as { load: (source: string) => unknown };
const afterSignModule = require("../../scripts/after-sign.cjs") as {
  parseCodesignIdentity: (details: string) => { identifier: string | null; teamIdentifier: string | null; authorities: string[] };
  assertCuaDriverMatchesNautiloIdentity: (
    driver: { identifier: string | null; teamIdentifier: string | null; authorities: string[] },
    app: { identifier: string | null; teamIdentifier: string | null; authorities: string[] },
    expectedTeam?: string,
  ) => void;
  assertExactCuaDriverEntitlements: (entitlements: unknown) => void;
  assertScreenRecordingPermissionMatchesNautiloIdentity: (
    helper: { identifier: string | null; teamIdentifier: string | null; authorities: string[] },
    app: { identifier: string | null; teamIdentifier: string | null; authorities: string[] },
    expectedTeam?: string,
  ) => void;
  assertExactScreenRecordingPermissionEntitlements: (entitlements: unknown) => void;
};
const signMacosModule = require("../../scripts/sign-adhoc.cjs") as {
  wrapOptionsForFile: (
    appPath: string,
    original: ((filePath: string) => Record<string, unknown> | null) | undefined,
    cuaEntitlements: string,
    screenEntitlements?: string,
  ) => (filePath: string) => Record<string, unknown> | null;
  withCuaDriverEntitlements: (
    options: Record<string, unknown> & { app: string; optionsForFile?: (filePath: string) => Record<string, unknown> | null },
    cuaEntitlements: string,
  ) => Record<string, unknown> & { optionsForFile: (filePath: string) => Record<string, unknown> | null };
  executeSign: (
    options: Record<string, unknown> & { app: string; optionsForFile?: (filePath: string) => Record<string, unknown> | null },
    signImpl: (options: Record<string, unknown>) => Promise<void>,
    cuaEntitlements: string,
  ) => Promise<void>;
  CUA_DRIVER_IDENTIFIER: string;
  SCREEN_RECORDING_PERMISSION_IDENTIFIER: string;
  SCREEN_RECORDING_PERMISSION_RELATIVE_PATH: string;
};

type FixtureEntry = { readonly path: string; readonly bytes?: Buffer; readonly type?: "0" | "2"; readonly mode?: number };

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`);
}

function fixtureTar(entries: readonly FixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, "utf8");
    octal(entry.mode ?? 0o755, 8).copy(header, 100);
    octal(body.length, 12).copy(header, 124);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    octal(checksum, 8).copy(header, 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function fixtureContract(archive: Buffer, license: Buffer): CuaDriverReleaseContract {
  return {
    driverVersion: "fixture-0.19.3",
    releaseRevision: "abcdef0123456789abcdef0123456789abcdef01",
    reviewedSourceRevision: "0123456789abcdef0123456789abcdef01234567",
    sourceUrl: "https://github.com/example/cua/tree/0123456789abcdef0123456789abcdef01234567",
    releaseTag: "cua-driver-rs-vfixture-0.19.3",
    releaseUrl: "https://github.com/example/cua/releases/tag/cua-driver-rs-vfixture-0.19.3",
    archiveName: "cua-driver-rs-fixture-darwin-universal-binary.tar.gz",
    archiveUrl: "https://github.com/example/cua/releases/download/cua-driver-rs-vfixture-0.19.3/cua-driver-rs-fixture-darwin-universal-binary.tar.gz",
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    licenseUrl: "https://raw.githubusercontent.com/example/cua/0123456789abcdef0123456789abcdef01234567/LICENSE.md",
    licenseSha256: createHash("sha256").update(license).digest("hex"),
  };
}

function fixtureFetch(contract: CuaDriverReleaseContract, archive: Buffer, license: Buffer): {
  readonly fetch: typeof fetch;
  readonly requests: string[];
} {
  const requests: string[] = [];
  const bodies = new Map<string, Buffer>([
    [contract.archiveUrl, archive],
    [contract.licenseUrl, license],
  ]);
  return {
    requests,
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      const body = bodies.get(url);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    },
  };
}

test("Cua pin identifies the reviewed immutable 0.23.2 universal bare release", () => {
  expect(PINNED_CUA_DRIVER_RELEASE_TAG).toBe("cua-driver-rs-v0.23.2");
  expect(PINNED_CUA_DRIVER_SOURCE_REVISION).toBe("e88e9d899ac5effaeae38619527ebaa46b26ce72");
  expect(PINNED_CUA_DRIVER_RELEASE_REVISION).toBe("e88e9d899ac5effaeae38619527ebaa46b26ce72");
  expect(PINNED_CUA_DRIVER_ARCHIVE_NAME).toBe("cua-driver-rs-0.23.2-darwin-universal-binary.tar.gz");
  expect(PINNED_CUA_DRIVER_ARCHIVE_URL).toBe(
    "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.23.2/cua-driver-rs-0.23.2-darwin-universal-binary.tar.gz",
  );
  expect(PINNED_CUA_DRIVER_ARCHIVE_SHA256).toBe(
    "0127c82ff17922df4290931a8ebf9b4a8b21656aad24cba6f21ee50e41ed4493",
  );
  expect(PINNED_CUA_DRIVER_LICENSE_URL).toBe(
    "https://raw.githubusercontent.com/trycua/cua/e88e9d899ac5effaeae38619527ebaa46b26ce72/LICENSE.md",
  );
  expect(PINNED_CUA_DRIVER_LICENSE_SHA256).toBe(
    "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9",
  );
});

test("Cua archive parser accepts only safe regular members and preserves exact bytes", () => {
  const binary = Buffer.from("universal Mach-O fixture");
  const archive = fixtureTar([
    { path: "cua-driver", bytes: binary, mode: 0o755 },
  ]);
  const entries = parseSafeCuaDriverArchive(archive);
  expect(entries.get("cua-driver")?.bytes).toEqual(binary);
  expect(createHash("sha256").update(entries.get("cua-driver")!.bytes).digest("hex"))
    .toBe(createHash("sha256").update(binary).digest("hex"));
});

test("Cua archive parser fails closed on link and traversal members before extraction", () => {
  expect(() => parseSafeCuaDriverArchive(fixtureTar([{ path: "cua-driver", type: "2" }]))).toThrow("forbidden type");
  expect(() => parseSafeCuaDriverArchive(fixtureTar([{ path: "../cua-driver", bytes: Buffer.from("x") }]))).toThrow("unsafe tar member path");
});

test("Cua vendor atomically installs verified bytes, rejects cache tampering, and never installs unsafe archives", async () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-cua-vendor-test-"));
  try {
    const binary = Buffer.from("universal Mach-O fixture");
    const archive = fixtureTar([{ path: "cua-driver", bytes: binary, mode: 0o755 }]);
    const license = Buffer.from("MIT License\nfixture\n");
    const contract = fixtureContract(archive, license);
    const transport = fixtureFetch(contract, archive, license);
    const vendorDirectory = join(root, "vendor", "cua-driver");
    const options = {
      vendorDirectory,
      contract,
      fetchImpl: transport.fetch,
      inspectArchitectures: () => ["x86_64", "arm64"],
      log: () => {},
    };

    expect(await vendorCuaDriver(options)).toBe("installed");
    expect(transport.requests).toEqual([contract.archiveUrl, contract.licenseUrl]);
    expect(readdirSync(vendorDirectory).sort()).toEqual(["LICENSE", "PROVENANCE.md", "cua-driver", "manifest.json"]);
    expect(readFileSync(join(vendorDirectory, "cua-driver"))).toEqual(binary);
    expect(readFileSync(join(vendorDirectory, "LICENSE"))).toEqual(license);
    expect(statSync(join(vendorDirectory, "cua-driver")).mode & 0o777).toBe(0o755);
    const manifest = JSON.parse(readFileSync(join(vendorDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.driverVersion).toBe(contract.driverVersion);
    expect(manifest.releaseRevision).toBe(contract.releaseRevision);
    expect(manifest.reviewedSourceRevision).toBe(contract.reviewedSourceRevision);
    expect(manifest.archiveSha256).toBe(contract.archiveSha256);
    expect(manifest.licenseSha256).toBe(contract.licenseSha256);
    expect(manifest.packagedPath).toBe("tools-cua/cua-driver");
    const provenance = readFileSync(join(vendorDirectory, "PROVENANCE.md"), "utf8");
    expect(provenance).toContain(`Release tag revision: ${contract.releaseRevision}`);
    expect(provenance).toContain(`Reviewed equivalent source revision: ${contract.reviewedSourceRevision}`);
    expect(provenance).toContain(`Archive SHA-256: ${contract.archiveSha256}`);

    expect(await vendorCuaDriver(options)).toBe("cached");
    expect(transport.requests).toHaveLength(2);
    for (const file of ["LICENSE", "PROVENANCE.md", "manifest.json"] as const) {
      writeFileSync(join(vendorDirectory, file), "tampered\n");
      expect(await vendorCuaDriver(options)).toBe("installed");
    }
    writeFileSync(join(vendorDirectory, "cua-driver"), "tampered");
    expect(await vendorCuaDriver(options)).toBe("installed");
    expect(transport.requests).toHaveLength(10);

    const unsafeArchive = fixtureTar([{ path: "cua-driver", type: "2" }]);
    const unsafeContract = fixtureContract(unsafeArchive, license);
    const unsafeTransport = fixtureFetch(unsafeContract, unsafeArchive, license);
    const unsafeDirectory = join(root, "unsafe", "cua-driver");
    let unsafeFailure: unknown;
    try {
      await vendorCuaDriver({ ...options, vendorDirectory: unsafeDirectory, contract: unsafeContract, fetchImpl: unsafeTransport.fetch });
    } catch (error) { unsafeFailure = error; }
    expect(unsafeFailure).toBeInstanceOf(Error);
    expect((unsafeFailure as Error).message).toContain("forbidden type");
    expect(existsSync(unsafeDirectory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cua is vendored only during packaging and ships as one direct child outside ASAR", () => {
  expect(packageJson.scripts["vendor:cua-driver"]).toBe("bun scripts/vendor-cua-driver.ts");
  for (const scriptName of ["package:mac:build", "package:dev:build"] as const) {
    const script = packageJson.scripts[scriptName];
    expect(script).toContain("bun run vendor:cua-driver");
    expect(script.indexOf("bun run vendor:cua-driver")).toBeLessThan(script.indexOf("electron-builder"));
  }
  expect(packageJson.scripts["dev:prepare"]).not.toContain("vendor:cua-driver");
  expect(packageJson.scripts["dev:launch"]).not.toContain("vendor:cua-driver");
  expect(() => yaml.load(electronBuilder)).not.toThrow();
  const config = yaml.load(electronBuilder) as {
    readonly mac?: { readonly sign?: string; readonly extraResources?: readonly ResourceMapping[] };
    readonly win?: { readonly extraResources?: readonly ResourceMapping[] };
    readonly linux?: { readonly extraResources?: readonly ResourceMapping[] };
    readonly extraResources?: readonly ResourceMapping[];
  };
  type ResourceMapping = { readonly from?: string; readonly to?: string; readonly filter?: readonly string[] };
  const cuaMapping = {
    from: "vendor/cua-driver",
    to: "tools-cua",
    filter: ["qualification.patch", "cua-driver", "LICENSE", "manifest.json", "PROVENANCE.md"],
  };
  expect(config.mac?.sign).toBe("./scripts/sign-adhoc.cjs");
  expect(config.mac?.extraResources?.filter((mapping) => mapping.from === cuaMapping.from)).toEqual([cuaMapping]);
  for (const resources of [config.extraResources, config.linux?.extraResources, config.win?.extraResources]) {
    expect(resources?.some((mapping) => mapping.from === cuaMapping.from || mapping.to === cuaMapping.to) ?? false).toBe(false);
  }
  expect(vendorScript).not.toContain("process.env.PATH");
});

test("Cua executable bit and final nested signing audit are part of the normal builder flow", () => {
  expect(afterPack).toContain('"cua-driver"');
  expect(afterPack).toContain("fixVendoredToolBinaryPerms");
  expect(afterPack).toContain("0o755");
  expect(afterSign).toContain("tools-cua");
  expect(afterSign).toContain("cua-driver");
  expect(afterSign).toContain("--verify");
  expect(afterSign).toContain("--strict");
  expect(afterSign).toContain("TeamIdentifier");
  expect(afterSign).not.toContain("CuaDriver.app");
});

test("Screen Recording helper is prepared for every desktop launch/package flow and ships mac-only", () => {
  expect(packageJson.scripts["compile:screen-recording-permission"])
    .toBe("bun scripts/build-screen-recording-permission.ts");
  expect(packageJson.scripts.app).toContain("bun run dev:prepare");
  for (const scriptName of ["dev:prepare", "package:mac:build", "package:dev:build"] as const) {
    const script = packageJson.scripts[scriptName];
    const compileIndex = script.indexOf("bun run compile:screen-recording-permission");
    expect(compileIndex).toBeGreaterThanOrEqual(0);
    const boundary = scriptName.startsWith("package:") ? script.indexOf("electron-builder") : script.indexOf("build:electron");
    expect(boundary).toBeGreaterThan(compileIndex);
  }

  const config = yaml.load(electronBuilder) as {
    readonly mac?: { readonly extraResources?: readonly ResourceMapping[] };
    readonly win?: { readonly extraResources?: readonly ResourceMapping[] };
    readonly linux?: { readonly extraResources?: readonly ResourceMapping[] };
    readonly extraResources?: readonly ResourceMapping[];
  };
  type ResourceMapping = { readonly from?: string; readonly to?: string; readonly filter?: readonly string[] };
  const helperMapping = {
    from: "vendor/screen-recording-permission",
    to: "tools-permissions",
    filter: ["nautilo-screen-recording-permission"],
  };
  expect(config.mac?.extraResources?.filter((mapping) => mapping.from === helperMapping.from))
    .toEqual([helperMapping]);
  for (const resources of [config.extraResources, config.linux?.extraResources, config.win?.extraResources]) {
    expect(resources?.some((mapping) => mapping.from === helperMapping.from || mapping.to === helperMapping.to) ?? false)
      .toBe(false);
  }
});

test("Screen Recording helper preparation is a no-op outside macOS", () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-screen-recording-permission-test-"));
  try {
    expect(buildScreenRecordingPermissionHelper(root, "linux")).toBeNull();
    expect(existsSync(join(root, "vendor", "screen-recording-permission"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom signer overrides only the exact Screen Recording helper path", () => {
  const appPath = resolve("/tmp/Nautilo.app");
  const original = (filePath: string) => ({
    entitlements: "original.plist",
    additionalArguments: ["--preserve-metadata=flags"],
    marker: filePath,
  });
  const cuaEntitlements = resolve("/tmp/entitlements.cua-driver.plist");
  const screenEntitlements = resolve("/tmp/entitlements.screen-recording-permission.plist");
  const wrapped = signMacosModule.wrapOptionsForFile(
    appPath,
    original,
    cuaEntitlements,
    screenEntitlements,
  );
  const exactHelper = join(appPath, signMacosModule.SCREEN_RECORDING_PERMISSION_RELATIVE_PATH);
  expect(signMacosModule.SCREEN_RECORDING_PERMISSION_IDENTIFIER)
    .toBe("com.nautilo.desktop.screen-recording-permission");
  expect(wrapped(exactHelper)).toEqual({
    entitlements: screenEntitlements,
    additionalArguments: [
      "--preserve-metadata=flags",
      "--identifier",
      "com.nautilo.desktop.screen-recording-permission",
    ],
    marker: exactHelper,
  });
  const sameBasenameElsewhere = join(
    appPath,
    "Contents/Resources/other/nautilo-screen-recording-permission",
  );
  expect(wrapped(sameBasenameElsewhere)).toEqual(original(sameBasenameElsewhere));
  const hostile = signMacosModule.wrapOptionsForFile(
    appPath,
    () => ({ additionalArguments: ["--identifier=com.attacker"] }),
    cuaEntitlements,
    screenEntitlements,
  );
  expect(() => hostile(exactHelper)).toThrow("controlled only by Nautilo");
});

test("custom signer changes only the exact packaged Cua path and preserves all original per-file options", () => {
  const appPath = resolve("/tmp/Nautilo.app");
  const original = (filePath: string) => ({
    entitlements: "original.plist",
    timestamp: "http://timestamp",
    additionalArguments: ["--preserve-metadata=flags"],
    marker: filePath,
  });
  const cuaEntitlements = resolve("/tmp/entitlements.cua-driver.plist");
  const wrapped = signMacosModule.wrapOptionsForFile(appPath, original, cuaEntitlements);
  const exactCua = join(appPath, "Contents", "Resources", "tools-cua", "cua-driver");
  expect(signMacosModule.CUA_DRIVER_IDENTIFIER).toBe("com.nautilo.desktop.cua-driver");
  expect(wrapped(exactCua)).toEqual({
    entitlements: cuaEntitlements,
    timestamp: "http://timestamp",
    additionalArguments: ["--preserve-metadata=flags", "--identifier", "com.nautilo.desktop.cua-driver"],
    marker: exactCua,
  });
  const sameBasenameElsewhere = join(appPath, "Contents", "Resources", "other", "cua-driver");
  expect(wrapped(sameBasenameElsewhere)).toEqual(original(sameBasenameElsewhere));
  const framework = join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
  expect(wrapped(framework)).toEqual(original(framework));
  const hostile = signMacosModule.wrapOptionsForFile(
    appPath,
    () => ({ additionalArguments: ["-icom.attacker"] }),
    cuaEntitlements,
  );
  expect(() => hostile(exactCua)).toThrow("controlled only by Nautilo");
  const unrelatedLongArgument = signMacosModule.wrapOptionsForFile(
    appPath,
    () => ({ additionalArguments: ["--ignore-resources"] }),
    cuaEntitlements,
  );
  expect(unrelatedLongArgument(exactCua)?.additionalArguments).toEqual([
    "--ignore-resources",
    "--identifier",
    "com.nautilo.desktop.cua-driver",
  ]);

  const signOptions = { app: appPath, identity: "-", strictVerify: true, optionsForFile: original };
  const constructed = signMacosModule.withCuaDriverEntitlements(signOptions, cuaEntitlements);
  expect(constructed.app).toBe(signOptions.app);
  expect(constructed.identity).toBe(signOptions.identity);
  expect(constructed.strictVerify).toBe(true);
  expect(constructed.optionsForFile(exactCua)?.entitlements).toBe(cuaEntitlements);
  expect(constructed.optionsForFile(exactCua)?.additionalArguments).toEqual([
    "--preserve-metadata=flags",
    "--identifier",
    "com.nautilo.desktop.cua-driver",
  ]);
});

test("contributor signer accepts only explicit ad-hoc identity before invoking signing", async () => {
  const app = resolve("/tmp/Nautilo.app");
  const signed: Record<string, unknown>[] = [];
  const capture = async (options: Record<string, unknown>) => { signed.push(options); };
  for (const identity of [undefined, "", "DEVELOPER_ID_HASH", "Developer ID Application: Example"]) {
    await expect(signMacosModule.executeSign({ app, platform: "darwin", identity }, capture))
      .rejects.toThrow("explicit ad-hoc");
  }
  expect(signed).toHaveLength(0);
  await signMacosModule.executeSign({ app, platform: "darwin", identity: "-", strictVerify: true }, capture);
  expect(signed).toHaveLength(1);
  expect(signed[0]?.identity).toBe("-");
  expect(signed[0]?.strictVerify).toBe(true);
  const options = signed[0]?.optionsForFile as (path: string) => Record<string, unknown>;
  expect(options(join(app, "Contents/Resources/tools-cua/cua-driver")).additionalArguments)
    .toEqual(["--identifier", "com.nautilo.desktop.cua-driver"]);
});

test("checked-in Cua entitlements grant exactly screen capture and AppleEvents", () => {
  const trueKeys = [...cuaEntitlementsPlist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)]
    .map((match) => match[1])
    .sort();
  expect(trueKeys).toEqual([
    "com.apple.security.automation.apple-events",
    "com.apple.security.device.screen-capture",
  ]);
  expect(cuaEntitlementsPlist.match(/<key>/g)).toHaveLength(2);
  expect(cuaEntitlementsPlist).not.toContain("<false/>");
  for (const forbidden of ["allow-jit", "network", "audio-input", "inherit"]) {
    expect(cuaEntitlementsPlist).not.toContain(forbidden);
  }
});

test("Screen Recording helper keeps one pinned identifier and exactly one entitlement", () => {
  const trueKeys = [...screenPermissionEntitlementsPlist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)]
    .map((match) => match[1]);
  expect(trueKeys).toEqual(["com.apple.security.device.screen-capture"]);
  expect(screenPermissionEntitlementsPlist.match(/<key>/g)).toHaveLength(1);
  expect(() => afterSignModule.assertExactScreenRecordingPermissionEntitlements({
    "com.apple.security.device.screen-capture": true,
  })).not.toThrow();
  expect(() => afterSignModule.assertExactScreenRecordingPermissionEntitlements({
    "com.apple.security.device.screen-capture": true,
    "com.apple.security.automation.apple-events": true,
  })).toThrow("contain exactly");
  expect(() => afterSignModule.assertExactScreenRecordingPermissionEntitlements({
    "com.apple.security.device.screen-capture": false,
  })).toThrow("must be true");
});

test("post-sign requires the exact helper, strict signature, and enclosing Nautilo Team", () => {
  const authority = "Developer ID Application: Nautilo Test (ABCDE12345)";
  const helper = {
    identifier: "com.nautilo.desktop.screen-recording-permission",
    teamIdentifier: "ABCDE12345",
    authorities: [authority],
  };
  const appIdentity = {
    identifier: "com.nautilo.desktop",
    teamIdentifier: "ABCDE12345",
    authorities: [authority],
  };
  expect(() => afterSignModule.assertScreenRecordingPermissionMatchesNautiloIdentity(
    helper,
    appIdentity,
    "ABCDE12345",
  )).not.toThrow();
  expect(() => afterSignModule.assertScreenRecordingPermissionMatchesNautiloIdentity(
    { ...helper, teamIdentifier: "ZZZZZ99999" },
    appIdentity,
  )).toThrow("TeamIdentifier must match");
  expect(() => afterSignModule.assertScreenRecordingPermissionMatchesNautiloIdentity(
    { ...helper, identifier: "com.attacker.helper" },
    appIdentity,
  )).toThrow("com.nautilo.desktop.screen-recording-permission");
  expect(afterSign).toContain("missing packaged Screen Recording helper");
  expect(afterSign).toContain('["--verify", "--strict", "--verbose=4", helperPath]');
  expect(afterSign).toContain("assertScreenRecordingPermissionMatchesNautiloIdentity");
  expect(afterSign).toContain("process.env.APPLE_TEAM_ID");
});

test("post-sign audits exact Cua entitlements plus matching Developer ID or ad-hoc identity", () => {
  const authority = "Developer ID Application: Nautilo Test (ABCDE12345)";
  const driver = afterSignModule.parseCodesignIdentity(`Identifier=com.nautilo.desktop.cua-driver\nTeamIdentifier=ABCDE12345\nAuthority=${authority}`);
  expect(driver)
    .toEqual({ identifier: "com.nautilo.desktop.cua-driver", teamIdentifier: "ABCDE12345", authorities: [authority] });
  const adhoc = afterSignModule.parseCodesignIdentity("Identifier=com.nautilo.desktop.cua-driver\nTeamIdentifier=not set\nSignature=adhoc");
  expect(adhoc)
    .toEqual({ identifier: "com.nautilo.desktop.cua-driver", teamIdentifier: null, authorities: [] });
  expect(() => afterSignModule.assertCuaDriverMatchesNautiloIdentity(
    driver,
    { identifier: "com.nautilo.desktop", teamIdentifier: "ABCDE12345", authorities: [authority] },
    "ABCDE12345",
  )).not.toThrow();
  expect(() => afterSignModule.assertCuaDriverMatchesNautiloIdentity(
    adhoc,
    { identifier: "com.nautilo.desktop", teamIdentifier: null, authorities: [] },
  )).not.toThrow();
  expect(() => afterSignModule.assertCuaDriverMatchesNautiloIdentity(
    adhoc,
    { identifier: "com.example.untrusted-fixture", teamIdentifier: null, authorities: [] },
    undefined,
  )).toThrow("com.nautilo.desktop");
  expect(() => afterSignModule.assertCuaDriverMatchesNautiloIdentity(
    driver,
    { identifier: "com.nautilo.desktop", teamIdentifier: "ZZZZZ99999", authorities: ["Developer ID Application: Other (ZZZZZ99999)"] },
  )).toThrow("match enclosing Nautilo.app");
  expect(() => afterSignModule.assertCuaDriverMatchesNautiloIdentity(
    { ...adhoc, identifier: "cua-driver-5555494475cb5c6a14553cca88d1ef30003bb143" },
    { identifier: "com.nautilo.desktop", teamIdentifier: null, authorities: [] },
  )).toThrow("com.nautilo.desktop.cua-driver");
  const exactEntitlements = {
    "com.apple.security.device.screen-capture": true,
    "com.apple.security.automation.apple-events": true,
  };
  expect(() => afterSignModule.assertExactCuaDriverEntitlements(exactEntitlements)).not.toThrow();
  expect(() => afterSignModule.assertExactCuaDriverEntitlements({ ...exactEntitlements, "com.apple.security.cs.allow-jit": true }))
    .toThrow("contain exactly");
  expect(() => afterSignModule.assertExactCuaDriverEntitlements({ ...exactEntitlements, "com.apple.security.device.screen-capture": false }))
    .toThrow("must be true");
  expect(afterSign).toContain("match enclosing Nautilo.app");
  expect(afterSign).toContain("appIdentity.teamIdentifier");
});
