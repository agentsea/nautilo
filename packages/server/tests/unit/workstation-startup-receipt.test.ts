import { describe, expect, test } from "bun:test";
import {
  mintWorkstationStartupReceipt,
  verifyWorkstationStartupReceipt,
} from "../../src/workstation-startup-receipt";

const SECRET = "workstation-startup-receipt-test-secret-32";
const CLAIMS = {
  userId: "human-1",
  instanceId: "instance-1",
  serverBindingId: "server-1",
  pairingGeneration: "pairing-1",
  profileId: "profile-1",
  profileRevision: 7,
};

describe("Workstation startup receipt", () => {
  test("round-trips only the strict versioned binding claims", () => {
    const receipt = mintWorkstationStartupReceipt(SECRET, CLAIMS);
    expect(receipt).toStartWith("wsr1.");
    expect(receipt).not.toContain("PIN");
    expect(verifyWorkstationStartupReceipt(SECRET, receipt)).toEqual(CLAIMS);
  });

  test("rejects a different secret, tampering, and unsupported version", () => {
    const receipt = mintWorkstationStartupReceipt(SECRET, CLAIMS);
    expect(verifyWorkstationStartupReceipt("other-stable-secret-material-32", receipt)).toBeNull();
    expect(verifyWorkstationStartupReceipt(SECRET, `${receipt}x`)).toBeNull();

    const payload = Buffer.from(
      JSON.stringify({ v: 2, u: "human-1", i: "instance-1", s: "server-1", g: "pairing-1", p: "profile-1", r: 7 }),
    ).toString("base64url");
    expect(verifyWorkstationStartupReceipt(SECRET, `wsr1.${payload}.signature`)).toBeNull();
  });

  test("refuses malformed or unbounded claims before signing", () => {
    expect(mintWorkstationStartupReceipt(SECRET, { ...CLAIMS, profileRevision: 0 })).toBeNull();
    expect(mintWorkstationStartupReceipt(SECRET, { ...CLAIMS, userId: "x".repeat(513) })).toBeNull();
    expect(verifyWorkstationStartupReceipt(SECRET, "x".repeat(4097))).toBeNull();
  });
});
