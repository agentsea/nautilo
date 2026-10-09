import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedElfMachine, runtimeArchForPlatform } from "./native-runtime-contract.ts";
import { executionMode } from "./native-runtime-probe-cli.ts";
import { officeCliProbeEnvironment } from "./native-runtime-probe.ts";

describe("native runtime contract", () => {
  test("keeps native Sharp probes aligned with the canonical runtime install", () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
    const sharpVersion = JSON.parse(read("runtime-install/packages/server/package.json")).dependencies.sharp as string;
    const lock = read("runtime-install/bun.lock");
    const contract = read("native-runtime-contract.ts");
    const gate = read("release-evidence-gate.ts");
    expect(contract).toContain(`-${sharpVersion}.node`);
    expect(contract).toContain(`assertPackageVersion(sharpPackage, "sharp", "${sharpVersion}")`);
    expect(gate).toContain(`sharp.version !== "${sharpVersion}"`);
    for (const architecture of ["arm64", "x64"]) {
      const version = lock.match(new RegExp(`"@img/sharp-libvips-linux-${architecture}": \\["@img/sharp-libvips-linux-${architecture}@([^" ]+)"`))?.[1];
      expect(version).toBeDefined();
      expect(contract).toContain('assertPackageVersion(sharpLibvipsPackage, `@img/sharp-libvips-linux-${architecture}`, "' + version + '")');
    }
  });

  test("maps candidate platforms to their runtime and ELF identities", () => {
    expect(runtimeArchForPlatform("linux/amd64")).toBe("x64");
    expect(runtimeArchForPlatform("linux/arm64")).toBe("arm64");
    expect(expectedElfMachine("linux/amd64")).toBe(62);
    expect(expectedElfMachine("linux/arm64")).toBe(183);
  });

  test("labels host-matching execution as native and cross-architecture execution as emulated", () => {
    expect(executionMode("aarch64", "linux/arm64")).toBe("native");
    expect(executionMode("aarch64", "linux/amd64")).toBe("emulated");
    expect(executionMode("x86_64", "linux/amd64")).toBe("native");
    expect(executionMode("x86_64", "linux/arm64")).toBe("emulated");
  });

  test("runs OfficeCLI with the deterministic production process contract", () => {
    const env = officeCliProbeEnvironment({ KEEP: "yes" });

    expect(env).toEqual({
      KEEP: "yes",
      OFFICECLI_SKIP_UPDATE: "1",
      OFFICECLI_NO_AUTO_RESIDENT: "1",
    });
  });
});
