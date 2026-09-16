import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const manifestPath = join(repoRoot, "packages/server/vendor/agent-browser/manifest.json");
const vendorScriptPath = join(repoRoot, "dev/scripts/vendor-agent-browser.ts");

test("D568 server agent-browser manifest pins official v0.35.2 local and Linux artifacts", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    "agent-browser": {
      version: string;
      source: string;
      license: string;
      binaryName: string;
      artifacts: Record<string, { url: string; sha256: string; sizeMin: number }>;
    };
  };
  const entry = manifest["agent-browser"];
  expect(entry).toMatchObject({
    version: "0.35.2",
    source: "https://github.com/vercel-labs/agent-browser",
    license: "Apache-2.0",
    binaryName: "agent-browser",
  });
  expect(entry.artifacts).toEqual({
    "darwin-arm64": {
      url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.2/agent-browser-darwin-arm64",
      sha256: "e1e08f3b0a1c711750209e6a25b6f3a9dab7ed6e6a24b55a2556050b991fcc97",
      sizeMin: 12_247_424,
    },
    "darwin-x64": {
      url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.2/agent-browser-darwin-x64",
      sha256: "d76cfc76885d5007f3c119008a80a145b381ec4dfdd202f43e46cd0829751774",
      sizeMin: 13_378_880,
    },
    "linux-arm64": {
      url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.2/agent-browser-linux-arm64",
      sha256: "1599fec4f4e75dc26fc08eecc06ca4b729a0361932b32a6afb99885f0f829ecb",
      sizeMin: 12_332_896,
    },
    "linux-x64": {
      url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.2/agent-browser-linux-x64",
      sha256: "b699f24eebdb7fde91a34a9d697a1b84c3145f54327b60694b46f06b2972ce4d",
      sizeMin: 14_021_032,
    },
  });
});

test("D568 server vendor path is explicit, checksum-verified, and not Desktop vendoring", () => {
  const script = readFileSync(vendorScriptPath, "utf8");
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");
  const gitignore = readFileSync(join(repoRoot, "packages/server/vendor/agent-browser/.gitignore"), "utf8");
  const nativeProbe = readFileSync(join(repoRoot, "packaging/docker/native-runtime-probe.ts"), "utf8");

  expect(rootPackage.scripts["agent-browser:vendor"]).toBe("bun dev/scripts/vendor-agent-browser.ts");
  expect(script).toContain("fetchAndVerifyVendoredBinary");
  expect(script).toContain('join(repoRoot, "packages", "server", "vendor", "agent-browser")');
  expect(script).toContain('const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]');
  expect(script).not.toContain("apps/desktop");
  expect(gitignore).toContain("*/agent-browser");
  expect(dockerignore).toContain("packages/server/vendor/agent-browser/");
  expect(nativeProbe).toContain("probeAgentBrowser");
  expect(nativeProbe).toContain('"--version"');
});

test("D568 production image retains the WebSocket client used by Browser Use CDP discovery", () => {
  const sourcePackage = JSON.parse(readFileSync(join(repoRoot, "packages/server/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runtimePackage = JSON.parse(readFileSync(
    join(repoRoot, "packaging/docker/runtime-install/packages/server/package.json"),
    "utf8",
  )) as { dependencies: Record<string, string> };

  expect(sourcePackage.dependencies["ws"]).toBe("8.21.2");
  expect(sourcePackage.devDependencies?.["ws"]).toBeUndefined();
  expect(runtimePackage.dependencies["ws"]).toBe(sourcePackage.dependencies["ws"]);
});
