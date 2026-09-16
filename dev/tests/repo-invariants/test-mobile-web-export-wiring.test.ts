import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("D515 Mobile Web export wiring", () => {
  test("keeps the canonical export explicit in artifacts, Turbo, and CI", () => {
    const rootPackage = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    const mobilePackage = JSON.parse(source("apps/mobile/package.json")) as { scripts: Record<string, string> };
    const turbo = JSON.parse(source("turbo.json")) as {
      tasks: Record<string, { cache?: boolean }>;
    };
    const ci = source(".github/workflows/ci.yml");

    expect(rootPackage.scripts["build:artifacts"]).toContain("bun run mobile:web:export");
    expect(rootPackage.scripts["build:artifacts"].indexOf("apps/workbench run build"))
      .toBeLessThan(rootPackage.scripts["build:artifacts"].indexOf("mobile:web:export"));
    expect(mobilePackage.scripts["mobile-web-export"]).toBe("bun run export:web");
    expect(turbo.tasks["mobile-web-export"]).toEqual({ cache: false });
    expect(ci).toContain("bunx turbo run mobile-web-export --affected --filter=@nautilo/mobile");
  });

  test("keeps Mobile Web opt-in for dev-stack and out of server-start fallback", () => {
    const devStack = source("bin/nautilo-dev/src/commands/dev-stack.ts");
    const serverStart = source("bin/nautilo-dev/src/commands/server-start.ts");

    expect(devStack).toContain('flag: "--mobile-web"');
    expect(devStack).toContain('process.env["NAUTILO_MOBILE_WEB_DIST"] = MOBILE_WEB_DIST');
    expect(devStack).toContain('["bun", "run", "mobile:web:export"]');
    expect(serverStart).not.toContain("applyNautiloMobileWebDistEnvIfUnset");
    expect(serverStart).not.toContain("checkMobileWebDistForServerStart");
  });
});
