#!/usr/bin/env bun
/**
 * D103 P4.3 — Electron fuse flipper.
 *
 * Run as a post-pack step (see `electron-builder.yml` `afterPack`) on
 * the packaged Electron binary. Each fuse is a single-bit flag baked
 * into the Electron binary that gates a runtime capability. Once
 * disabled, that capability is unavailable in the shipped binary —
 * code-signing locks the bits, so flipping them is a one-shot
 * production-hardening pass that cannot be reversed by a runtime
 * attacker without invalidating the signature.
 *
 * Decisions per `apps/desktop/PRODUCTION.md` §7:
 *   RunAsNode                              = DISABLED  (no node-as-binary)
 *   EnableNodeOptionsEnvironmentVariable   = DISABLED  (NODE_OPTIONS ignored)
 *   EnableNodeCliInspectArguments          = DISABLED  (no --inspect)
 *   EnableCookieEncryption                 = ENABLED   (safeStorage cookies)
 *   EnableEmbeddedAsarIntegrityValidation  = ENABLED   (asar tamper check)
 *   OnlyLoadAppFromAsar                    = DEFERRED  (extraResources blocker — vendored Bun)
 *
 * The OnlyLoadAppFromAsar fuse is intentionally NOT enabled because
 * `electron-builder.yml`'s `extraResources` ships the vendored Bun
 * binary outside the asar. Re-evaluate if the desktop no longer needs
 * that extra resource.
 *
 * Usage:
 *   bun scripts/flip-fuses.ts <path-to-built-app>
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

async function main(): Promise<number> {
  const rawPath = process.argv[2];
  if (!rawPath) {
    process.stderr.write("usage: flip-fuses.ts <path-to-built-app>\n");
    return 2;
  }
  const appPath = resolve(rawPath);
  if (!existsSync(appPath)) {
    process.stderr.write(`[flip-fuses] no such app: ${appPath}\n`);
    return 1;
  }

  process.stderr.write(`[flip-fuses] flipping fuses on ${appPath}\n`);
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    // OnlyLoadAppFromAsar: deferred — see file header.
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });
  process.stderr.write("[flip-fuses] done\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[flip-fuses] error: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
