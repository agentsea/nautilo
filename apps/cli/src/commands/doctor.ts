import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "yargs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hasAdminUser, type DirectDatabase } from "@nautilo/db";
import * as dbSchema from "@nautilo/db/schema";
import { runDoctorMigrateConfig } from "../lib/doctor-migrate-config.ts";
import { runDoctorPurgeConsumedBootstrap } from "../lib/doctor-purge-consumed-bootstrap.ts";
import { loadProfile } from "../lib/profile-schema.ts";
import { runRemoteDoctorChecks } from "../lib/remote-doctor.ts";

function readHome(argv: Record<string, unknown>): string {
  const fromArgv = argv["home"];
  if (typeof fromArgv === "string" && fromArgv.trim() !== "") {
    return fromArgv.trim();
  }
  const h = process.env["HOME"];
  if (!h || h.trim() === "") {
    throw new Error("HOME is not set");
  }
  return h;
}

async function defaultCheckInstanceClaimed(
  instanceRoot: string,
  _instanceId: string,
): Promise<boolean> {
  const path = join(instanceRoot, "instance.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error("no instance.json or no db.directConnection");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("no instance.json or no db.directConnection");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("no instance.json or no db.directConnection");
  }
  const db = (parsed as { db?: unknown }).db;
  if (!db || typeof db !== "object") {
    throw new Error("no instance.json or no db.directConnection");
  }
  const direct = (db as { directConnection?: unknown }).directConnection;
  if (typeof direct !== "string" || direct.trim() === "") {
    throw new Error("no instance.json or no db.directConnection");
  }
  const sql = postgres(direct.trim(), { max: 1 });
  const drizzleDb = drizzle(sql, { schema: dbSchema });
  const directDb = Object.assign(drizzleDb, { end: () => sql.end({ timeout: 5 }) });
  try {
    return await hasAdminUser(directDb as unknown as DirectDatabase);
  } finally {
    await directDb.end();
  }
}

const migrateConfigCmd: CommandModule = {
  command: "migrate-config",
  describe:
    "doctor migrate-config — split operator secrets into deploy.toml.example + per-instance .bootstrap/",
  builder: (y) =>
    y
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Log planned writes without mutating disk",
      })
      .option("home", { type: "string", hidden: true, describe: "Override HOME (tests)" }),
  handler: async (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const dryRun = Boolean(argv["dry-run"]);
    const res = await runDoctorMigrateConfig({
      home,
      dryRun,
      checkInstanceClaimedFn: defaultCheckInstanceClaimed,
    });
    for (const w of res.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }
    if (dryRun && res.dryRunWrites) {
      for (const w of res.dryRunWrites) {
        process.stdout.write(`[dry-run] would write ${w.path} (${w.bytes} bytes)\n`);
      }
    }
    process.stdout.write(
      `doctor migrate-config: status=${res.status} operator=${res.operatorFilePath} deployExample=${res.deployTomlExamplePath}\n`,
    );
    if (res.operatorFileBackupPath) {
      process.stdout.write(`doctor migrate-config: backup=${res.operatorFileBackupPath}\n`);
    }
    for (const sweep of res.profileEnvSweep) {
      const r = sweep.result;
      const summary = r.migrated
        ? `migrated → backup=${r.backupPath ?? "?"}`
        : `${r.reason ?? "skipped"}${r.legacyArchived ? ` (legacy archived: ${r.backupPath ?? "?"})` : ""}`;
      process.stdout.write(
        `doctor migrate-config: profile-env ${sweep.profileName}.env — ${summary}\n`,
      );
    }
    process.exitCode = 0;
  },
};

const remoteCmd: CommandModule = {
  command: "remote <profile>",
  describe: "Pre-flight checks for a remote SSH Docker Compose profile",
  builder: (y) =>
    y
      .positional("profile", { type: "string", demandOption: true })
      .option("accept-new-host-key", {
        type: "boolean",
        default: false,
        describe:
          "Trust an unseen SSH host key (TOFU); changed keys remain rejected",
      })
      .option("home", { type: "string", hidden: true }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const name = String(argv["profile"]).trim();
    const profile = loadProfile(name, home);
    if (profile.transport !== "remote" || profile.lifecycle !== "compose") {
      process.stderr.write(`'${name}' is not a remote+compose profile.\n`);
      process.exitCode = 2;
      return;
    }
    const checks = runRemoteDoctorChecks(
      profile as Parameters<typeof runRemoteDoctorChecks>[0],
      { home },
      { acceptNewHostKey: argv["accept-new-host-key"] === true },
    );
    const failures = checks.filter((c) => c.status === "fail");
    for (const c of checks) {
      const sym = c.status === "ok" ? "✓" : c.status === "warn" ? "•" : "✗";
      process.stdout.write(`${sym} ${c.name}: ${c.message}\n`);
    }
    process.exitCode = failures.length > 0 ? 1 : 0;
  },
};

const purgeConsumedBootstrapCmd: CommandModule = {
  command: "purge-consumed-bootstrap",
  describe:
    "doctor purge-consumed-bootstrap — remove .bootstrap trees whose .used sentinel is older than 24h",
  builder: (y) =>
    y
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Report eligible dirs without deleting",
      })
      .option("home", { type: "string", hidden: true, describe: "Override HOME (tests)" }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const dryRun = Boolean(argv["dry-run"]);
    const res = runDoctorPurgeConsumedBootstrap({ home, dryRun });
    for (const row of res.scanned) {
      process.stdout.write(
        `doctor purge-consumed-bootstrap: ${row.instanceRoot} — ${row.reason}\n`,
      );
    }
    process.stdout.write(
      `doctor purge-consumed-bootstrap: purgedCount=${res.purgedCount} scanned=${res.scanned.length}\n`,
    );
    process.exitCode = 0;
  },
};

export const doctorModule: CommandModule = {
  command: "doctor",
  describe: "doctor — operator-config migration + cleanup utilities",
  builder: (y) =>
    y
      .command(migrateConfigCmd)
      .command(remoteCmd)
      .command(purgeConsumedBootstrapCmd)
      .demandCommand(1, "Specify a doctor subcommand."),
  handler: () => {
    process.stderr.write("Specify a doctor subcommand.\n");
    process.exitCode = 2;
  },
};
