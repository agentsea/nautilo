import type { CommandModule } from "yargs";

import type { BundleVerificationReport } from "@nautilo/compose-driver";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const backupModule: CommandModule = {
  command: "backup [path] [verifyPath]",
  describe:
    "Back up the compose stack. With <path>: full self-sufficient bundle. Without: legacy single-DB dump (deprecated).",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Bundle output directory (omit for legacy single-DB dump)",
      })
      .positional("verifyPath", {
        type: "string",
        describe: "Bundle directory for `backup verify <path>`",
      })
      .option("no-operator-files", { type: "boolean", default: false })
      .option("tarball", { type: "boolean", default: false })
      .option("stream", {
        type: "boolean",
        default: false,
        describe:
          "Remote disk-constrained fallback: live-pipe over SSH (NOT resumable)",
      })
      .example("$0 backup ./nautilo-backup", "Create a self-sufficient recovery bundle.")
      .example("$0 backup verify ./nautilo-backup", "Verify a recovery bundle before relying on it."),
  handler: async (argv) => {
    const path = typeof argv["path"] === "string" ? argv["path"].trim() : "";
    if (path === "verify") {
      const verifyPath =
        typeof argv["verifyPath"] === "string" ? argv["verifyPath"].trim() : "";
      await handleBackupVerify(argv, verifyPath);
      return;
    }
    await runComposeVerb(argv, async (_profile, _driver, lifecycle) => {
      const opts = path
        ? {
            toPath: path,
            noOperatorFiles: argv["no-operator-files"] === true,
            tarball: argv["tarball"] === true,
            stream: argv["stream"] === true,
          }
        : undefined;
      const out = await lifecycle.backup(opts);
      process.stdout.write(`${out.backupPath}\n`);
    });
  },
};

/**
 * D427 Wave 1 (task 1.1.2) — read-only recovery-bundle verification.
 * `nautilo backup verify <path>` validates mandatory members, per-file
 * checksums/inventory, DB-dump integrity, manifest image identity, and
 * restrictive local permissions. It never prints secret material; only the
 * structural report from the driver is written to stdout.
 */
export const backupVerifyModule: CommandModule = {
  command: "backup verify <path>",
  describe: "Verify a recovery bundle directory without printing secrets",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      describe: "Path to a backup bundle directory",
    }),
  handler: async (argv) => {
    const path = typeof argv["path"] === "string" ? argv["path"].trim() : "";
    await handleBackupVerify(argv, path);
  },
};

async function handleBackupVerify(argv: Record<string, unknown>, path: string): Promise<void> {
    if (!path) {
      process.stderr.write("backup verify requires <path>\n");
      process.exitCode = 2;
      return;
    }
    await runComposeVerb(argv, async (profile, driver) => {
      const report = await driver.verifyBundle(profile, path);
      process.stdout.write(formatVerifyReport(report) + "\n");
      if (!report.ok) {
        // runComposeVerb resets exitCode to 0 on success, so surface failure
        // as a thrown error to get a nonzero exit code without leaking secret
        // material (the report is already printed; this message is structural).
        throw new Error("backup verify: bundle failed verification");
      }
    });
}

function formatVerifyReport(report: BundleVerificationReport): string {
  const lines: string[] = [];
  lines.push(`bundle: ${report.bundlePath}`);
  lines.push(`manifest: v${report.manifestVersion}`);
  lines.push(`profile: ${report.profileName}`);
  lines.push(`instanceId: ${report.instanceId}`);
  lines.push(`composeProject: ${report.composeProjectName}`);
  lines.push(`transport: ${report.transport}`);
  lines.push(`createdAt: ${report.createdAt}`);
  const imgRef =
    report.image.mode === "registry"
      ? report.image.repoDigest ?? ""
      : report.image.imageId ?? report.image.backupTag ?? report.image.tag ?? "";
  lines.push(`image: ${report.image.mode} ${imgRef}`);
  lines.push(`checks:`);
  for (const c of report.checks) {
    lines.push(`  ${c.status.toUpperCase().padEnd(4)} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  lines.push(`result: ${report.ok ? "OK" : "FAIL"}`);
  if (report.provenance) {
    lines.push(`provenance:`);
    lines.push(`  manifestSha256: ${report.provenance.manifestSha256}`);
    lines.push(`  bundleCreatedAt: ${report.provenance.createdAt}`);
    lines.push(`  verifiedAt: ${report.provenance.verifiedAt}`);
    lines.push(`  image: ${report.provenance.imageMode} ${report.provenance.imageReference}`);
  }
  return lines.join("\n");
}
