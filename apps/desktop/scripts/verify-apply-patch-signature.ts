#!/usr/bin/env bun
/**
 * D448 1.2 package-time Darwin boundary.
 *
 * Source-build output is SHA-256 checked before electron-builder re-signs it.
 * This script intentionally performs no hash comparison: signatures alter
 * Mach-O bytes. Instead it verifies each nested executable's strict signature
 * and designated requirement, then the completed app's stapled notarization
 * ticket and Gatekeeper assessment.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_IDENTIFIER = 'identifier "nautilo-apply-patch"';

function fail(message: string): never {
  process.stderr.write(`[verify-apply-patch-signature] FATAL ${message}\n`);
  process.exit(1);
}

function runCodesign(args: string[]): string {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(result.error?.message ?? (result.stderr.trim() || `codesign exited ${result.status}`));
  return `${result.stdout}\n${result.stderr}`;
}

function runChecked(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(result.error?.message ?? (result.stderr.trim() || `${command} exited ${result.status}`));
  return `${result.stdout}\n${result.stderr}`;
}

/** Pure DR parser so tests can cover codesign's quoted/unquoted renderings. */
export function hasExpectedDesignatedRequirement(requirement: string, teamId: string): boolean {
  const teamClause = new RegExp(`certificate\\s+leaf\\[subject\\.OU\\]\\s*=\\s*["']?${teamId}["']?`);
  return requirement.includes(EXPECTED_IDENTIFIER) && requirement.includes("anchor apple generic") && teamClause.test(requirement);
}

export function verifyPackagedApplyPatchSignature(appBundlePath: string): void {
  const teamId = process.env["APPLE_TEAM_ID"];
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) fail("APPLE_TEAM_ID must be the expected 10-character Developer ID team identifier");
  const app = resolve(appBundlePath);
  for (const platformKey of ["darwin-arm64", "darwin-x64"] as const) {
    const binaryPath = join(app, "Contents", "Resources", "tools-apply-patch", platformKey, "nautilo-apply-patch");
    if (!existsSync(binaryPath)) fail(`missing packaged ${platformKey} apply-patch binary`);
    runCodesign(["--verify", "--strict", "--verbose=4", binaryPath]);
    const requirement = runCodesign(["-d", "-r-", binaryPath]);
    if (!hasExpectedDesignatedRequirement(requirement, teamId)) {
      fail(`${platformKey} designated requirement does not bind the expected Developer ID team and ${EXPECTED_IDENTIFIER}`);
    }
  }
  // electron-builder's normal signed path notarizes the completed app. Check
  // the final artifact here rather than trusting that a credential was merely
  // present during packaging.
  runChecked("xcrun", ["stapler", "validate", app]);
  runChecked("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
}

if (import.meta.main) {
  const appBundlePath = process.argv[2];
  if (!appBundlePath) fail("usage: verify-apply-patch-signature.ts <Nautilo.app>");
  verifyPackagedApplyPatchSignature(appBundlePath);
}
