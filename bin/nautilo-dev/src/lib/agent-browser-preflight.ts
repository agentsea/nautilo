import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256HexOfFile } from "@nautilo/config/vendored-binary";
import type { SpawnSyncFn } from "./officecli-preflight";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid server browser manifest");
  return value as Record<string, unknown>;
}

/** Provision the server's own pinned executable; Desktop's cache is unrelated. */
export async function ensureServerAgentBrowserProvisioned(
  repoRoot: string,
  options: { platform?: NodeJS.Platform; arch?: string; spawn?: SpawnSyncFn } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    process.stderr.write(`[server:start] agent-browser: unsupported host ${platform}/${arch}\n`);
    return false;
  }
  const target = `${platform}-${arch}`;
  const vendorRoot = join(repoRoot, "packages/server/vendor/agent-browser");
  const binary = join(vendorRoot, target, "agent-browser");
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(vendorRoot, "manifest.json"), "utf8"));
    const entry = record(record(manifest)["agent-browser"]);
    const digest = record(record(entry["artifacts"])[target])["sha256"];
    if (entry["binaryName"] !== "agent-browser" || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("invalid server browser manifest");
    }
    const verified = async (): Promise<boolean> => {
      try {
        accessSync(binary, constants.X_OK);
        return await sha256HexOfFile(binary) === digest;
      } catch {
        return false;
      }
    };
    if (await verified()) return true;
    process.stderr.write(`[server:start] agent-browser: provisioning ${target}…\n`);
    const result = (options.spawn ?? spawnSync)(process.execPath, [
      join(repoRoot, "dev/scripts/vendor-agent-browser.ts"), target,
    ], { stdio: "inherit", cwd: repoRoot });
    // A successful installer exit alone is not proof the required bytes exist.
    if (result.status === 0 && await verified()) return true;
  } catch {
    // The installer owns detailed download errors. Never dump arbitrary child
    // environments or malformed manifest contents into startup diagnostics.
  }
  process.stderr.write(`[server:start] agent-browser: provisioning failed; run bun run agent-browser:vendor ${target} and retry startup\n`);
  return false;
}
