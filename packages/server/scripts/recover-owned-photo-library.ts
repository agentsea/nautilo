import { homedir } from "node:os";
import { join } from "node:path";
import { createDirectDb } from "@nautilo/db";
import {
  applyPhotoLibraryRecovery,
  previewPhotoLibraryRecovery,
  type PhotoLibraryRecoveryTarget,
} from "../src/photo-library/operator-photo-recovery";
import { writePhotoLibraryRecoveryAuditEvent } from "../src/photo-library/operator-photo-recovery-audit";

const args = process.argv.slice(2).filter((argument) => argument !== "--");

function usage(): void {
  console.log("Usage: bun run photo-library:recover -- --server-instance-id <uuid> --operator-user-id <uuid> --owner-user-id <uuid> --agent-id <uuid> --kind generated|uploaded --blob-id <opaque-id> [--dry-run | --apply --confirm <token>]");
  console.log("Dry-run is the default. The command targets one exact blob and never scans or prints a filesystem path.");
}

function readValue(flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required ${flag} value`);
  return value;
}

if (args.includes("--help")) {
  usage();
  process.exit(0);
}

const valueFlags = new Set([
  "--server-instance-id",
  "--operator-user-id",
  "--owner-user-id",
  "--agent-id",
  "--kind",
  "--blob-id",
  "--confirm",
]);
const booleanFlags = new Set(["--apply", "--dry-run"]);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (valueFlags.has(argument)) {
    index += 1;
    if (index >= args.length) throw new Error(`Missing required ${argument} value`);
  } else if (!booleanFlags.has(argument)) {
    throw new Error(`Unknown photo-library recovery argument: ${argument}`);
  }
}

const apply = args.includes("--apply");
if (apply && args.includes("--dry-run")) throw new Error("Choose either --dry-run or --apply, not both");
if (!apply && args.includes("--confirm")) throw new Error("--confirm is accepted only with --apply");

const target: PhotoLibraryRecoveryTarget = {
  serverInstanceId: readValue("--server-instance-id"),
  operatorUserId: readValue("--operator-user-id"),
  ownerUserId: readValue("--owner-user-id"),
  agentId: readValue("--agent-id"),
  kind: readValue("--kind") as PhotoLibraryRecoveryTarget["kind"],
  blobId: readValue("--blob-id"),
};

const db = createDirectDb();
try {
  const dependencies = {
    db,
    audit: (event: Parameters<typeof writePhotoLibraryRecoveryAuditEvent>[1]) =>
      writePhotoLibraryRecoveryAuditEvent(
        join(homedir(), ".nautilo", "logs", "photo-library-recovery-audit.log"),
        event,
      ),
  };
  const result = apply
    ? await applyPhotoLibraryRecovery(dependencies, target, readValue("--confirm"))
    : await previewPhotoLibraryRecovery(dependencies, target);
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "refused") process.exitCode = 2;
} finally {
  await db.end();
}
