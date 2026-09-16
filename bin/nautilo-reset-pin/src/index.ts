/**
 * nautilo-reset-pin — physical access PIN reset tool
 *
 * Bypasses the Nautilo server entirely and operates directly on the DB.
 * Requires running as the same OS user who owns ~/.nautilo.
 *
 * Usage:
 *   bun run reset-pin -- --new-pin <6-8 digit pin>
 *
 * What it does:
 *   1. Verifies caller UID matches ~/.nautilo owner (physical access check)
 *   2. Validates the new PIN (6-8 digits, not a known weak pattern)
 *   3. Finds the owner actor via seedDefaultOwner + findActorByOwnerId
 *   4. Deletes old PIN credential from DB
 *   5. Deletes all recovery codes from DB
 *   6. Inserts new hashed PIN
 *   7. Clears lockout state from ~/.nautilo/lockout.json
 */

import { statSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seedDefaultOwner, createDirectDb, credentials, recoveryCodes, eq, and } from "@nautilo/db";
import { hashPin } from "@nautilo/trust";

const NAUTILO_RUNTIME_ROOT = join(homedir(), ".nautilo");
const LOCKOUT_FILE = join(NAUTILO_RUNTIME_ROOT, "lockout.json");

const WEAK_PINS = new Set([
  "123456", "000000", "111111", "222222", "333333", "444444",
  "555555", "666666", "777777", "888888", "999999",
  "123123", "121212", "112233", "654321", "012345", "987654",
  "12345678", "00000000", "11111111",
]);

function parseArgs(): { newPin: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--new-pin");
  if (idx === -1 || !args[idx + 1]) {
    console.error("Usage: bun run reset-pin -- --new-pin <6-8 digit pin>");
    process.exit(1);
  }
  return { newPin: args[idx + 1]! };
}

function checkPhysicalAccess(): void {
  let nautiloStat: ReturnType<typeof statSync> | null = null;
  try {
    nautiloStat = statSync(NAUTILO_RUNTIME_ROOT);
  } catch {
    console.error(`Cannot access ${NAUTILO_RUNTIME_ROOT}. Is Nautilo installed?`);
    process.exit(1);
  }

  const callerUid = process.getuid?.();
  if (callerUid === undefined) {
    console.error("Cannot determine caller UID. Are you on a POSIX system?");
    process.exit(1);
  }

  // Root (0) is always allowed; otherwise must match the directory owner
  if (callerUid !== 0 && callerUid !== nautiloStat.uid) {
    console.error(
      `Permission denied. This tool must be run as the user who owns ${NAUTILO_RUNTIME_ROOT} (uid ${nautiloStat.uid}).`
    );
    process.exit(1);
  }
}

function validatePin(pin: string): void {
  if (pin.length < 6 || pin.length > 8) {
    console.error("Error: PIN must be 6–8 digits.");
    process.exit(1);
  }
  if (!/^\d+$/.test(pin)) {
    console.error("Error: PIN must be numeric digits only.");
    process.exit(1);
  }
  if (WEAK_PINS.has(pin)) {
    console.error("Error: PIN is too predictable — choose something less obvious.");
    process.exit(1);
  }
}

async function resetPin(newPin: string): Promise<void> {
  console.log("Connecting to database…");
  const db = createDirectDb(1);

  try {
    // 1. Find owner. M043: PIN credentials + recovery codes FK
    //    directly to users.id, so we key on ownerId (the seed's
    //    canonical return value) — no separate actor lookup needed.
    const ownerId = await seedDefaultOwner();
    console.log(`Found owner user: ${ownerId}`);

    // 2. Delete existing PIN
    const deleted = await db
      .delete(credentials)
      .where(and(eq(credentials.userId, ownerId), eq(credentials.type, "pin")))
      .returning({ id: credentials.id });
    console.log(`Deleted ${deleted.length} existing PIN credential(s).`);

    // 3. Delete all recovery codes
    const deletedCodes = await db
      .delete(recoveryCodes)
      .where(eq(recoveryCodes.userId, ownerId))
      .returning({ id: recoveryCodes.id });
    console.log(`Deleted ${deletedCodes.length} recovery code(s).`);

    // 4. Insert new PIN hash
    const hash = await hashPin(newPin);
    await db.insert(credentials).values({ userId: ownerId, type: "pin", value: hash });
    console.log("New PIN credential inserted.");
  } finally {
    await db.end();
  }

  // 5. Clear lockout state
  if (existsSync(LOCKOUT_FILE)) {
    unlinkSync(LOCKOUT_FILE);
    console.log("Lockout state cleared.");
  }
}

async function main(): Promise<void> {
  const { newPin } = parseArgs();

  console.log("\n=== Nautilo PIN Reset (Physical Access) ===\n");

  checkPhysicalAccess();
  validatePin(newPin);

  await resetPin(newPin);

  console.log("\n✓ PIN reset successfully.");
  console.log("✓ Lockout state cleared.");
  console.log("✓ Recovery codes invalidated.\n");
  console.log("Next steps:");
  console.log("  1. Start the Nautilo server:   bun run server:start");
  console.log("  2. Sign in through Workbench or the Desktop app and authenticate with your new PIN.");
  console.log("  3. Generate new recovery codes:");
  console.log("     POST /api/auth/recovery-codes/regenerate  (requires Bearer token)\n");
}

main().catch((err: unknown) => {
  console.error("Reset failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
