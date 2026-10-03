import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { invites } from "../schema/invites";

/** Match a new recoverable code or a historical hash-only invite. */
export function inviteTokenCondition(token: string) {
  const plaintext = eq(invites.token, token);
  const legacyHash = createHash("sha256").update(token, "utf8").digest("hex");
  return or(plaintext, eq(invites.tokenHash, legacyHash)) ?? plaintext;
}
