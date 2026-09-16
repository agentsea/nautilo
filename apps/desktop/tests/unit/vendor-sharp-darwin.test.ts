import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SHARP_DARWIN_PACKAGES,
  npmTarballUrl,
  vendorSharpDarwin,
  type SharpDarwinPackage,
} from "../../scripts/vendor-sharp-darwin.ts";

const desktopRoot = join(import.meta.dir, "../..");

function tarballFor(spec: SharpDarwinPackage): Buffer {
  const root = mkdtempSync(join(tmpdir(), "nautilo-sharp-vendor-fixture-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "lib"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: spec.name, version: spec.version })}\n`);
    if (spec.requiresLicenseFile) writeFileSync(join(packageRoot, "LICENSE"), "fixture license\n");
    for (const requiredFile of spec.requiredFiles) {
      const target = join(packageRoot, requiredFile);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, Buffer.from(`${spec.name}:${spec.version}`));
    }
    const archive = join(root, "package.tgz");
    const result = spawnSync("tar", ["-czf", archive, "package"], { cwd: root });
    if (result.status !== 0) throw new Error("could not create Sharp vendor fixture tarball");
    return readFileSync(archive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixturePackages(): { readonly packages: readonly SharpDarwinPackage[]; readonly archives: ReadonlyMap<string, Buffer> } {
  const pairs = SHARP_DARWIN_PACKAGES.map((spec) => {
    const initial = { ...spec, version: "fixture" };
    const bytes = tarballFor(initial);
    const packageSpec = { ...initial, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    return [packageSpec, bytes] as const;
  });
  return {
    packages: pairs.map(([spec]) => spec),
    archives: new Map(pairs.map(([spec, bytes]) => [npmTarballUrl(spec), bytes])),
  };
}

test("Sharp Darwin tarball pins stay identical to the repository bun.lock", () => {
  const lock = readFileSync(join(desktopRoot, "../..", "bun.lock"), "utf8");
  for (const spec of SHARP_DARWIN_PACKAGES) {
    const entry = lock.split("\n").find((line) => line.includes(`\"${spec.name}\": [`));
    expect(entry).toBeDefined();
    expect(entry).toContain(`\"${spec.name}@${spec.version}\"`);
    expect(entry).toContain(`\"${spec.integrity}\"`);
  }
});

test("vendors both Darwin Sharp addon and libvips trees atomically from verified fixture tarballs", async () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-sharp-vendor-test-"));
  try {
    const { packages, archives } = fixturePackages();
    let fetches = 0;
    const fetchImpl: typeof fetch = async (input) => {
      fetches += 1;
      const bytes = archives.get(String(input));
      return bytes === undefined ? new Response("not found", { status: 404 }) : new Response(bytes, { status: 200 });
    };
    const vendorDir = join(root, "vendor", "sharp-darwin");
    await expect(vendorSharpDarwin({ vendorDir, packages, fetchImpl })).resolves.toBe("installed");
    expect(fetches).toBe(4);
    for (const spec of packages) {
      const leaf = spec.name.slice(spec.name.lastIndexOf("/") + 1);
      const packageRoot = join(vendorDir, "node_modules", "@img", leaf);
      expect(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))).toEqual({ name: spec.name, version: "fixture" });
      if (spec.requiresLicenseFile) expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toBe("fixture license\n");
      for (const requiredFile of spec.requiredFiles) {
        expect(readFileSync(join(packageRoot, requiredFile), "utf8")).toBe(`${spec.name}:fixture`);
      }
    }
    await expect(vendorSharpDarwin({ vendorDir, packages, fetchImpl })).resolves.toBe("cached");
    expect(fetches).toBe(4);
    const first = packages[0]!;
    const firstLeaf = first.name.slice(first.name.lastIndexOf("/") + 1);
    writeFileSync(join(vendorDir, "node_modules", "@img", firstLeaf, first.requiredFiles[0]!), "tampered");
    await expect(vendorSharpDarwin({ vendorDir, packages, fetchImpl })).resolves.toBe("installed");
    expect(fetches).toBe(8);
    expect(readFileSync(join(vendorDir, "node_modules", "@img", firstLeaf, first.requiredFiles[0]!), "utf8")).toBe(`${first.name}:fixture`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not leave a vendor tree after an integrity failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-sharp-vendor-failure-"));
  try {
    const { packages } = fixturePackages();
    const vendorDir = join(root, "vendor", "sharp-darwin");
    const fetchImpl: typeof fetch = async () => new Response("wrong bytes", { status: 200 });
    await expect(vendorSharpDarwin({ vendorDir, packages, fetchImpl })).rejects.toThrow("SHA-512 integrity verification failed");
    expect(existsSync(vendorDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
