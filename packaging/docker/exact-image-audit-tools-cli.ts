#!/usr/bin/env bun
/** Install D490's three checksum-pinned exact-image audit tools. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExactImageAuditToolsError,
  installExactImageAuditTools,
  parseExactImageAuditToolManifest,
} from "./exact-image-audit-tools.ts";

interface CliArgs {
  readonly destination: string;
  readonly manifestPath: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return "usage: bun packaging/docker/exact-image-audit-tools-cli.ts --destination <absolute-directory> [--manifest <path>]";
}

function parseArgs(argv: readonly string[]): CliArgs {
  let destination: string | undefined;
  let manifestPath = resolve(scriptDirectory, "exact-image-audit-tools.manifest.json");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--destination" || argument === "--manifest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ExactImageAuditToolsError(usage());
      if (argument === "--destination") destination = value;
      else manifestPath = value;
      index += 1;
      continue;
    }
    throw new ExactImageAuditToolsError(usage());
  }
  if (destination === undefined) throw new ExactImageAuditToolsError(usage());
  return { destination, manifestPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = parseExactImageAuditToolManifest(readFileSync(args.manifestPath, "utf8"));
  const installed = await installExactImageAuditTools({ manifest, destination: args.destination });
  process.stdout.write(`[d490:audit-tools] platform=${installed.platformKey}\n`);
  for (const tool of installed.tools) {
    process.stdout.write(`[d490:audit-tools] ${tool.name}=${tool.version} path=${tool.path} archive-sha256=${tool.archiveSha256}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[d490:audit-tools] FATAL ${message}\n`);
  process.exitCode = 1;
});
