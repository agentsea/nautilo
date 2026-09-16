import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../../..");

function source(path: string): string {
  return readFileSync(resolve(repo, path), "utf8");
}

describe("M260 Invite redemption production inventory", () => {
  test("all supported redemption and recovery paths use invite_redemptions", () => {
    for (const path of [
      "packages/server/src/lib/redeem-invite.ts",
      "packages/server/src/lib/owner-claim-control.ts",
      "packages/server/src/lib/provision-member.ts",
      "packages/server/src/routes/invites.ts",
      "bin/nautilo-dev/src/commands/qualify-owner-claim.ts",
    ]) {
      expect(source(path), path).toContain("inviteRedemptions");
    }
  });

  test("application code no longer reads or writes the legacy singleton binding", () => {
    for (const path of [
      "packages/server/src/lib/redeem-invite.ts",
      "packages/server/src/lib/owner-claim-control.ts",
      "packages/server/src/lib/provision-member.ts",
      "packages/server/src/routes/invites.ts",
      "bin/nautilo-dev/src/commands/qualify-owner-claim.ts",
    ]) {
      expect(source(path), path).not.toMatch(/halfRedeemed(?:At|UserId)/);
    }
  });

  test("completion owns membership publication and exactly-once consumption", () => {
    const redemption = source("packages/server/src/lib/redeem-invite.ts");
    const bindStart = redemption.indexOf("export async function redeemInviteWithLogtoSub");
    const completionStart = redemption.indexOf("export async function completeInviteProfile");
    const bind = redemption.slice(bindStart, completionStart);
    const completion = redemption.slice(completionStart);

    expect(bind).not.toContain(".insert(groupMembers)");
    expect(bind).not.toContain("resolveInviteLandingRoomInTx");
    expect(completion).toContain(".insert(groupMembers)");
    expect(completion).toContain("resolveInviteLandingRoomInTx");
    expect(completion).toContain("usedCount: locked.usedCount + 1");
    expect(completion).toContain("completedAt: profileNow");
  });
});
