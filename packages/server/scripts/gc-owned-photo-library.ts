import { createDirectDb, eq, nautiloInstanceIdentity } from "@nautilo/db";
import { OwnedPhotoGarbageCollector } from "../src/photo-library/owned-photo-gc";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const dryRun = !args.includes("--apply");
const batchIndex = args.indexOf("--batch-size");
const confirmIndex = args.indexOf("--confirm-server");
const batchSize = batchIndex >= 0 ? Number(args[batchIndex + 1]) : 25;
const expectedServerInstanceId = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
const allowed = new Set(["--apply", "--help", "--batch-size", "--confirm-server"]);
for (let index = 0; index < args.length; index += 1) {
  if (index === batchIndex + 1 || index === confirmIndex + 1) continue;
  if (!allowed.has(args[index]!)) throw new Error(`Unknown photo-library GC argument: ${args[index]}`);
}

if (args.includes("--help")) {
  console.log("Usage: bun run photo-library:gc -- [--batch-size 1..25] [--apply --confirm-server <server-uuid>]");
  console.log("Defaults to dry-run. GC considers owned database rows only and never sweeps a directory.");
  process.exit(0);
}
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25) {
  throw new Error("--batch-size must be an integer from 1 to 25");
}

const db = createDirectDb();
try {
  const [identity] = await db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) throw new Error("The connected database has no Nautilo server identity");
  if (!dryRun && expectedServerInstanceId !== identity.serverInstanceId) {
    throw new Error("Apply requires --confirm-server matching the connected database identity");
  }
  const report = await new OwnedPhotoGarbageCollector({ db }).run({ dryRun, batchSize });
  // The report is deliberately path/content free: opaque entry ids, bounded
  // counters, and lifecycle outcomes are the complete operator evidence.
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
