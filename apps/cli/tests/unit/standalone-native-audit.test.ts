import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nativeKeyringPackageForTarget } from "../../scripts/compile-standalone-native.ts";
import { auditStandaloneNativeBinary, auditStandaloneNativeBytes } from "../../src/lib/standalone-native-audit.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(input: {
  cpu?: number;
  strings?: readonly string[];
} = {}): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(input.cpu ?? 0x0100000c, 4);
  return Buffer.concat([
    header,
    Buffer.from(`\0${(input.strings ?? ["keyring.darwin-arm64.node"]).join("\0")}\0`),
  ]);
}

describe("standalone native artifact audit", () => {
  test("accepts only the target Mach-O and exact embedded native keyring", () => {
    expect(auditStandaloneNativeBytes({
      bytes: candidate(),
      platform: "darwin-arm64",
    })).toEqual({
      schemaVersion: 1,
      platform: "darwin-arm64",
      architecture: "arm64",
      nativeKeyringEmbedded: true,
      personalModulePathsExcluded: true,
    });
    expect(() => auditStandaloneNativeBytes({
      bytes: candidate({ cpu: 0x01000007, strings: ["keyring.darwin-x64.node"] }),
      platform: "darwin-arm64",
    })).toThrow(/wrong Mach-O architecture/);
  });

  test("rejects foreign bindings, personal loaders, and build roots", () => {
    expect(() => auditStandaloneNativeBytes({
      bytes: candidate({ strings: ["keyring.darwin-arm64.node", "keyring.darwin-x64.node"] }),
      platform: "darwin-arm64",
    })).toThrow(/foreign native binding/);
    expect(() => auditStandaloneNativeBytes({
      bytes: candidate({
        strings: [
          "keyring.darwin-arm64.node",
          'var __filename = "/Users/operator/project/node_modules/@napi-rs/keyring/index.js";',
        ],
      }),
      platform: "darwin-arm64",
    })).toThrow(/absolute bundled node_modules/);
    expect(() => auditStandaloneNativeBytes({
      bytes: candidate({ strings: ["keyring.darwin-arm64.node", resolve("/private/build/checkout")] }),
      platform: "darwin-arm64",
      forbiddenRoots: ["/private/build/checkout"],
    })).toThrow(/forbidden build-workspace/);
  });

  test.skipIf(process.platform === "win32")("requires executable file permissions before auditing bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-native-audit-test-"));
    roots.push(root);
    const path = join(root, "nautilo");
    writeFileSync(path, candidate(), { mode: 0o600 });
    expect(() => auditStandaloneNativeBinary({ binaryPath: path, platform: "darwin-arm64" })).toThrow(/regular executable/);
    chmodSync(path, 0o755);
    expect(auditStandaloneNativeBinary({ binaryPath: path, platform: "darwin-arm64" }).nativeKeyringEmbedded).toBe(true);
  });

  test("maps only the locked native macOS targets", () => {
    expect(nativeKeyringPackageForTarget("bun-darwin-arm64")).toBe("@napi-rs/keyring-darwin-arm64");
    expect(nativeKeyringPackageForTarget("bun-darwin-x64")).toBe("@napi-rs/keyring-darwin-x64");
    expect(() => nativeKeyringPackageForTarget("bun-linux-x64")).toThrow(/unsupported target/);
  });

});
