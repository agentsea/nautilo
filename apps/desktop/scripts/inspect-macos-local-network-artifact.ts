#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const EXPECTED_LOCAL_NETWORK_USAGE =
  "Nautilo looks for Nautilo servers on your local network when you open the server picker.";
export const EXPECTED_BONJOUR_SERVICES = ["_nautilo._tcp"] as const;
export const EXPECTED_BUNDLE_ID = "com.nautilo.desktop";

export type MacSignatureMode = "unsigned" | "adhoc" | "developer-id" | "other";

type MacInfoPlist = {
  CFBundleIdentifier?: unknown;
  CFBundleExecutable?: unknown;
  NSLocalNetworkUsageDescription?: unknown;
  NSBonjourServices?: unknown;
};

export type MacLocalNetworkArtifactEvidence = {
  appPath: string;
  commit: string;
  bundleId: string;
  localNetworkUsageDescription: string;
  bonjourServices: string[];
  signatureMode: MacSignatureMode;
  signatureIdentifier: string | null;
  teamIdentifier: string | null;
  cdHash: string | null;
  executableUuids: string[];
};

function fail(message: string): never {
  throw new Error(`[inspect-macos-local-network-artifact] ${message}`);
}

function runChecked(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { encoding: "utf8", cwd });
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? (result.stderr.trim() || `${command} exited ${result.status}`));
  }
  return result.stdout.trim();
}

export function validateMacLocalNetworkInfo(info: MacInfoPlist): {
  bundleId: string;
  localNetworkUsageDescription: string;
  bonjourServices: string[];
  bundleExecutable: string;
} {
  if (info.CFBundleIdentifier !== EXPECTED_BUNDLE_ID) {
    fail(`CFBundleIdentifier must be ${EXPECTED_BUNDLE_ID}`);
  }
  if (info.NSLocalNetworkUsageDescription !== EXPECTED_LOCAL_NETWORK_USAGE) {
    fail("NSLocalNetworkUsageDescription does not match the canonical picker-scoped purpose string");
  }
  if (typeof info.CFBundleExecutable !== "string" || info.CFBundleExecutable.length === 0) {
    fail("CFBundleExecutable must be present");
  }
  if (
    !Array.isArray(info.NSBonjourServices) ||
    info.NSBonjourServices.length !== 1 ||
    info.NSBonjourServices[0] !== EXPECTED_BONJOUR_SERVICES[0]
  ) {
    fail("NSBonjourServices must contain exactly _nautilo._tcp");
  }
  return {
    bundleId: info.CFBundleIdentifier,
    localNetworkUsageDescription: info.NSLocalNetworkUsageDescription,
    bonjourServices: [...EXPECTED_BONJOUR_SERVICES],
    bundleExecutable: info.CFBundleExecutable,
  };
}

export function classifyMacSignatureDetails(status: number | null, details: string): {
  signatureMode: MacSignatureMode;
  signatureIdentifier: string | null;
  teamIdentifier: string | null;
  cdHash: string | null;
} {
  if (status !== 0) {
    return { signatureMode: "unsigned", signatureIdentifier: null, teamIdentifier: null, cdHash: null };
  }
  const signatureIdentifier = details.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? null;
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  const cdHash = details.match(/^CDHash=([a-fA-F0-9]+)$/m)?.[1]?.toLowerCase() ?? null;
  if (/^Signature=adhoc$/m.test(details)) {
    return { signatureMode: "adhoc", signatureIdentifier, teamIdentifier: null, cdHash };
  }
  if (/^Authority=Developer ID Application:/m.test(details)) {
    return {
      signatureMode: "developer-id",
      signatureIdentifier,
      teamIdentifier: teamIdentifier === "not set" ? null : teamIdentifier,
      cdHash,
    };
  }
  return {
    signatureMode: "other",
    signatureIdentifier,
    teamIdentifier: teamIdentifier === "not set" ? null : teamIdentifier,
    cdHash,
  };
}

export function inspectMacLocalNetworkArtifact(appBundlePath: string): MacLocalNetworkArtifactEvidence {
  const appPath = resolve(appBundlePath);
  const infoPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPath)) fail(`missing packaged Info.plist: ${infoPath}`);
  const info = JSON.parse(runChecked("plutil", ["-convert", "json", "-o", "-", infoPath])) as MacInfoPlist;
  const validated = validateMacLocalNetworkInfo(info);
  const signature = spawnSync("codesign", ["-d", "--verbose=4", appPath], { encoding: "utf8" });
  if (signature.status === 0) {
    const verification = spawnSync("codesign", ["--verify", "--strict", "--verbose=4", appPath], {
      encoding: "utf8",
    });
    if (verification.error || verification.status !== 0) {
      fail(
        verification.error?.message ??
        (verification.stderr.trim() || `codesign verification exited ${verification.status}`),
      );
    }
  }
  const signatureEvidence = classifyMacSignatureDetails(
    signature.status,
    `${signature.stdout}\n${signature.stderr}`,
  );
  if (signature.status === 0 && signatureEvidence.signatureIdentifier !== EXPECTED_BUNDLE_ID) {
    fail(`code-signing identifier must be ${EXPECTED_BUNDLE_ID}`);
  }
  if (signature.status === 0 && signatureEvidence.cdHash === null) {
    fail("signed artifact must expose a CDHash");
  }
  const executable = join(appPath, "Contents", "MacOS", validated.bundleExecutable);
  const uuidOutput = runChecked("dwarfdump", ["--uuid", executable]);
  const executableUuids = [...uuidOutput.matchAll(/^UUID: ([A-Fa-f0-9-]{36}) \(/gm)]
    .map((match) => match[1]!.toUpperCase());
  if (executableUuids.length === 0) fail("packaged executable must expose at least one Mach-O UUID");
  const commit = runChecked("git", ["rev-parse", "HEAD"]);
  return {
    appPath,
    commit,
    bundleId: validated.bundleId,
    localNetworkUsageDescription: validated.localNetworkUsageDescription,
    bonjourServices: validated.bonjourServices,
    ...signatureEvidence,
    executableUuids,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const expectIndex = args.indexOf("--expect-signature");
  const expectedSignature = expectIndex >= 0 ? args[expectIndex + 1] : undefined;
  if (expectIndex >= 0) args.splice(expectIndex, 2);
  const appPath = args[0];
  if (!appPath || args.length !== 1) {
    fail("usage: inspect-macos-local-network-artifact.ts <Nautilo.app> [--expect-signature unsigned|adhoc|developer-id|other]");
  }
  const evidence = inspectMacLocalNetworkArtifact(appPath);
  if (expectedSignature !== undefined && evidence.signatureMode !== expectedSignature) {
    fail(`expected ${expectedSignature} signature, found ${evidence.signatureMode}`);
  }
  if (expectedSignature === "developer-id") {
    const expectedTeam = process.env["APPLE_TEAM_ID"];
    if (!expectedTeam || !/^[A-Z0-9]{10}$/.test(expectedTeam)) {
      fail("APPLE_TEAM_ID must identify the expected Developer ID team");
    }
    if (evidence.teamIdentifier !== expectedTeam) {
      fail(`Developer ID team mismatch: expected ${expectedTeam}, found ${evidence.teamIdentifier ?? "none"}`);
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
