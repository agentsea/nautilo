import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type NativeRuntimePlatform = "linux/amd64" | "linux/arm64";

export interface NativeRuntimeInventory {
  readonly platform: NativeRuntimePlatform;
  readonly sharpPackage: string;
  readonly sharpAddon: string;
  readonly sharpLibvipsPackage: string;
  readonly sharpLibvipsLibrary: string;
  readonly argon2Package: string;
  readonly argon2Addon: string;
}

const ROOT = "/srv/repo/node_modules";

export function expectedElfMachine(platform: NativeRuntimePlatform): number {
  return platform === "linux/amd64" ? 62 : 183;
}

export function runtimeArchForPlatform(platform: NativeRuntimePlatform): NodeJS.Architecture {
  return platform === "linux/amd64" ? "x64" : "arm64";
}

export async function collectNativeRuntimeInventory(platform: NativeRuntimePlatform): Promise<NativeRuntimeInventory> {
  const architecture = platform === "linux/amd64" ? "x64" : "arm64";
  const sharpPackage = join(ROOT, "sharp", "package.json");
  const sharpAddon = join(ROOT, "@img", `sharp-linux-${architecture}`, "lib", `sharp-linux-${architecture}-0.35.4.node`);
  const sharpLibvipsRoot = join(ROOT, "@img", `sharp-libvips-linux-${architecture}`);
  const sharpLibvipsPackage = join(sharpLibvipsRoot, "package.json");
  const libvipsCandidates = (await readdir(join(sharpLibvipsRoot, "lib")))
    .filter((name) => /^libvips-cpp\.so\.\d/.test(name));
  if (libvipsCandidates.length !== 1) {
    throw new Error(`expected exactly one glibc libvips payload for ${platform}, found ${libvipsCandidates.length}`);
  }
  const argon2Package = join(ROOT, "argon2", "package.json");
  const argon2Addon = platform === "linux/amd64"
    ? join(ROOT, "argon2", "prebuilds", "linux-x64", "argon2.glibc.node")
    : join(ROOT, "argon2", "prebuilds", "linux-arm64", "argon2.armv8.glibc.node");

  const inventory: NativeRuntimeInventory = {
    platform,
    sharpPackage,
    sharpAddon,
    sharpLibvipsPackage,
    sharpLibvipsLibrary: join(sharpLibvipsRoot, "lib", libvipsCandidates[0]!),
    argon2Package,
    argon2Addon,
  };
  await Promise.all(Object.values(inventory).filter((value) => value.startsWith("/")).map((path) => stat(path)));
  await assertPackageVersion(sharpPackage, "sharp", "0.35.4");
  await assertPackageVersion(sharpLibvipsPackage, `@img/sharp-libvips-linux-${architecture}`, "1.3.3");
  await assertPackageVersion(argon2Package, "argon2", "0.44.0");
  await assertElfArchitecture(sharpAddon, platform);
  await assertElfArchitecture(inventory.sharpLibvipsLibrary, platform);
  await assertElfArchitecture(argon2Addon, platform);
  return inventory;
}

export async function assertElfArchitecture(path: string, platform: NativeRuntimePlatform): Promise<void> {
  const header = await readFile(path);
  if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
    throw new Error(`${path} is not an ELF binary`);
  }
  const littleEndian = header[5] === 1;
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
  const expected = expectedElfMachine(platform);
  if (machine !== expected) throw new Error(`${path} ELF machine ${machine} does not match ${platform} (${expected})`);
}

async function assertPackageVersion(path: string, expectedName: string, expectedVersion: string): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as { name?: unknown; version?: unknown };
  if (value.name !== expectedName || value.version !== expectedVersion) {
    throw new Error(`${path} expected ${expectedName}@${expectedVersion}, got ${String(value.name)}@${String(value.version)}`);
  }
}
