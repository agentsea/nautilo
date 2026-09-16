#!/usr/bin/env bun
/** Run D490's pinned scanners against one immutable image manifest. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runExactImageAudit, ExactImageAuditError } from "./exact-image-audit.ts";
import { parseExactImageAuditToolManifest } from "./exact-image-audit-tools.ts";
import { assertRuntimeImageEvidenceManifest } from "./runtime-image-evidence.ts";
import { parseVulnerabilityDatabaseIdentity } from "./vulnerability-db-identity.ts";
import { parseBoundedDisclosurePolicy } from "./bounded-disclosure.ts";
import { parseVulnerabilityPolicy } from "./vulnerability-policy.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const names = ["manifest", "database-identity", "disclosure-policy", "vulnerability-policy", "tools-directory", "grype-cache-directory", "trivy-cache-directory", "output-root"] as const;
type Name = typeof names[number];

function usage(): string {
  return `usage: bun packaging/docker/exact-image-audit-cli.ts ${names.map((name) => `--${name} <value>`).join(" ")}`;
}

function parseArgs(argv: readonly string[]): Record<Name, string> {
  const values: Partial<Record<Name, string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    const name = argument?.startsWith("--") ? argument.slice(2) as Name : undefined;
    if (name === undefined || !names.includes(name) || value === undefined || value.startsWith("--") || values[name] !== undefined) throw new ExactImageAuditError(usage());
    values[name] = value;
  }
  if (names.some((name) => values[name] === undefined)) throw new ExactImageAuditError(usage());
  return values as Record<Name, string>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8")) as unknown;
  assertRuntimeImageEvidenceManifest(manifest);
  const toolManifest = parseExactImageAuditToolManifest(readFileSync(resolve(scriptDirectory, "exact-image-audit-tools.manifest.json"), "utf8"));
  const databaseIdentity = parseVulnerabilityDatabaseIdentity(readFileSync(args["database-identity"], "utf8"));
  const disclosurePolicy = parseBoundedDisclosurePolicy(readFileSync(args["disclosure-policy"], "utf8"));
  const vulnerabilityPolicy = parseVulnerabilityPolicy(readFileSync(args["vulnerability-policy"], "utf8"));
  const result = await runExactImageAudit({
    manifest,
    toolManifest,
    databaseIdentity,
    disclosurePolicy,
    vulnerabilityPolicy,
    toolsDirectory: args["tools-directory"],
    grypeCacheDirectory: args["grype-cache-directory"],
    trivyCacheDirectory: args["trivy-cache-directory"],
    outputRoot: args["output-root"],
  });
  process.stdout.write(`[d490:exact-image-audit] evidence=${result.directory}\n`);
  process.stdout.write(`[d490:exact-image-audit] index=${result.indexPath}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[d490:exact-image-audit] FATAL ${message}\n`);
  process.exitCode = 1;
});
