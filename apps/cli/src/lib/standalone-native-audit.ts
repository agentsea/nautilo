import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MACHO_64_LITTLE_ENDIAN = 0xfeedfacf;
const MACHO_CPU: Record<string, number> = {
  "darwin-arm64": 0x0100000c,
  "darwin-x64": 0x01000007,
};
const KEYRING_BINDING: Record<string, string> = {
  "darwin-arm64": "keyring.darwin-arm64.node",
  "darwin-x64": "keyring.darwin-x64.node",
};
export type StandaloneNativeAuditReceipt = {
  schemaVersion: 1;
  platform: string;
  architecture: "arm64" | "x64";
  nativeKeyringEmbedded: true;
  personalModulePathsExcluded: true;
};

function includesAscii(bytes: Buffer, value: string): boolean {
  return bytes.indexOf(Buffer.from(value, "utf8")) >= 0;
}

export function auditStandaloneNativeBinary(input: {
  binaryPath: string;
  platform: string;
  forbiddenRoots?: readonly string[];
}): StandaloneNativeAuditReceipt {
  const binaryPath = resolve(input.binaryPath);
  const details = lstatSync(binaryPath);
  if (details.isSymbolicLink() || !details.isFile() || (details.mode & 0o111) === 0) {
    throw new Error("Standalone native audit requires a regular executable candidate.");
  }
  const expectedCpu = MACHO_CPU[input.platform];
  const expectedBinding = KEYRING_BINDING[input.platform];
  if (expectedCpu === undefined || expectedBinding === undefined) {
    throw new Error(`Standalone native audit rejects unsupported platform ${input.platform}.`);
  }
  const bytes = readFileSync(binaryPath);
  if (
    bytes.length < 8 ||
    bytes.readUInt32LE(0) !== MACHO_64_LITTLE_ENDIAN ||
    bytes.readUInt32LE(4) !== expectedCpu
  ) {
    throw new Error(`Standalone native audit found the wrong Mach-O architecture for ${input.platform}.`);
  }
  if (!includesAscii(bytes, expectedBinding)) {
    throw new Error(`Standalone native audit did not find ${expectedBinding}.`);
  }
  for (const [platform, binding] of Object.entries(KEYRING_BINDING)) {
    if (platform !== input.platform && includesAscii(bytes, binding)) {
      throw new Error(`Standalone native audit found foreign native binding ${binding}.`);
    }
  }
  const text = bytes.toString("latin1");
  if (/var __filename = "\/[^"\n]*node_modules\//.test(text)) {
    throw new Error("Standalone native audit found an absolute bundled node_modules loader path.");
  }
  for (const root of input.forbiddenRoots ?? []) {
    const normalized = resolve(root);
    if (includesAscii(bytes, normalized)) {
      throw new Error("Standalone native audit found a forbidden build-workspace path.");
    }
  }
  return {
    schemaVersion: 1,
    platform: input.platform,
    architecture: input.platform === "darwin-arm64" ? "arm64" : "x64",
    nativeKeyringEmbedded: true,
    personalModulePathsExcluded: true,
  };
}
