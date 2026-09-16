import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256HexOfBytes } from "@nautilo/config/vendored-binary";
import { ensureServerAgentBrowserProvisioned } from "../../src/lib/agent-browser-preflight";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(target = "darwin-arm64") {
  const root = mkdtempSync(join(tmpdir(), "server-browser-preflight-"));
  roots.push(root);
  const vendor = join(root, "packages/server/vendor/agent-browser");
  mkdirSync(join(vendor, target), { recursive: true });
  const bytes = Buffer.from("test executable bytes");
  const binary = join(vendor, target, "agent-browser");
  writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ "agent-browser": {
    version: "0.35.2", binaryName: "agent-browser", artifacts: { [target]: { sha256: sha256HexOfBytes(bytes) } },
  } }));
  const install = () => { writeFileSync(binary, bytes); chmodSync(binary, 0o755); };
  return { root, binary, install };
}

describe("server browser provisioning", () => {
  test.each(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])("provisions missing %s bytes with the canonical vendor script", async (target) => {
    const f = fixture(target);
    const [platform, arch] = target.split("-");
    const calls: unknown[] = [];
    const result = await ensureServerAgentBrowserProvisioned(f.root, {
      platform: platform as NodeJS.Platform, arch: arch!,
      spawn: (exe, args, opts) => { calls.push([exe, args, opts]); f.install(); return { status: 0 }; },
    });
    expect(result).toBe(true);
    expect(calls).toEqual([[process.execPath, [join(f.root, "dev/scripts/vendor-agent-browser.ts"), target], { stdio: "inherit", cwd: f.root }]]);
  });

  test("verified warm startup does not download", async () => {
    const f = fixture(); f.install();
    let spawned = false;
    expect(await ensureServerAgentBrowserProvisioned(f.root, { platform: "darwin", arch: "arm64",
      spawn: () => { spawned = true; return { status: 1 }; },
    })).toBe(true);
    expect(spawned).toBe(false);
  });

  test.each(["corrupt", "non-executable"])("repairs a %s cached executable", async (condition) => {
    const f = fixture(); f.install();
    if (condition === "corrupt") writeFileSync(f.binary, "bad bytes");
    else chmodSync(f.binary, 0o644);
    let calls = 0;
    expect(await ensureServerAgentBrowserProvisioned(f.root, { platform: "darwin", arch: "arm64",
      spawn: () => { calls++; f.install(); return { status: 0 }; },
    })).toBe(true);
    expect(calls).toBe(1);
  });

  test.each([0, 1, null])("refuses missing bytes after installer status %s", async (status) => {
    const f = fixture();
    expect(await ensureServerAgentBrowserProvisioned(f.root, { platform: "darwin", arch: "arm64",
      spawn: () => ({ status }),
    })).toBe(false);
  });

  test("reports spawn failure and unsupported platforms without throwing", async () => {
    const f = fixture();
    expect(await ensureServerAgentBrowserProvisioned(f.root, { platform: "darwin", arch: "arm64",
      spawn: () => { throw new Error("spawn failed"); },
    })).toBe(false);
    expect(await ensureServerAgentBrowserProvisioned(f.root, { platform: "win32", arch: "x64",
      spawn: () => { throw new Error("must not spawn"); },
    })).toBe(false);
  });
});
