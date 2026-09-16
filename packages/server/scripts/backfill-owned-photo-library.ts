import { createDirectDb } from "@nautilo/db";
import { backfillLegacyCurrentPhotoReferences } from "../src/photo-library/legacy-current-reference-backfill";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const dryRun = !rawArgs.includes("--apply");
const exclusiveMaintenance = rawArgs.includes("--exclusive-maintenance");
const confirmIndex = rawArgs.indexOf("--confirm-server");
const expectedServerInstanceId = confirmIndex >= 0 ? rawArgs[confirmIndex + 1] : undefined;
const allowed = new Set(["--apply", "--help", "--confirm-server", "--exclusive-maintenance"]);
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index]!;
  if (index === confirmIndex + 1) continue;
  if (!allowed.has(arg)) throw new Error(`Unknown photo-library backfill argument: ${arg}`);
}

if (rawArgs.includes("--help")) {
  console.log("Usage: bun run photo-library:backfill -- [--apply --confirm-server <server-uuid> --exclusive-maintenance]");
  console.log("Defaults to dry-run. The command only considers canonical current DB references; it never scans media roots.");
  process.exit(0);
}

const db = createDirectDb();
try {
  const report = await backfillLegacyCurrentPhotoReferences(
    { db },
    {
      dryRun,
      exclusiveMaintenance,
      ...(expectedServerInstanceId ? { expectedServerInstanceId } : {}),
    },
  );
  // Report contains opaque IDs and media facts only; never a filesystem path,
  // image payload, prompt, or provider credential.
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
