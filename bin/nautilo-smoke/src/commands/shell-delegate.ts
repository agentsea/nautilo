/**
 * `setup` and `teardown` commands — shell out to the equivalent scripts
 * under nautilo/scripts/security-test-env/. Streams child stdout/stderr
 * to the user.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ParsedArgs } from "../lib/args.ts";
import { repoRoot } from "../lib/factory.ts";

async function runScript(script: string, args: readonly string[]): Promise<number> {
  const path = join(repoRoot(), "scripts", "security-test-env", script);
  return new Promise<number>((resolve) => {
    const child = spawn(path, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(`failed to run ${script}: ${err.message}`);
      resolve(1);
    });
  });
}

export async function setupCommand(args: ParsedArgs): Promise<number> {
  const platformArg = typeof args.flags["platform"] === "string" ? `--${args.flags["platform"]}` : "--all";
  return runScript("setup.sh", [platformArg]);
}

export async function teardownCommand(args: ParsedArgs): Promise<number> {
  const platformArg = typeof args.flags["platform"] === "string" ? `--${args.flags["platform"]}` : "--all";
  return runScript("teardown.sh", [platformArg]);
}
