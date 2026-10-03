import { getSharedDirectDb } from "@nautilo/db";
import { assertOwnedAvatarProtocolUpgradeReady } from "./owned-avatar-protocol-upgrade";

const db = getSharedDirectDb();
try {
  await assertOwnedAvatarProtocolUpgradeReady(db);
  console.log("Photo protocol upgrade is ready; existing owned media IDs remain unchanged.");
} finally {
  await db.end();
}
