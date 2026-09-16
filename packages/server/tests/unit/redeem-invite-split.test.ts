import { describe, test, expect } from "bun:test";
import {
  redeemInviteWithLogtoSub,
  completeInviteProfile,
} from "../../src/lib/redeem-invite";

const VALID_TOKEN = "inv_" + "a".repeat(20); // shape-only; never reaches DB
const VALID_SUB = "logto-sub-1";
const VALID_HANDLE = "alice";

describe("redeemInviteWithLogtoSub — validation early returns (M105 / M107)", () => {
  test("rejects empty handle with code invalid_handle (M107: was invalid_email pre-M107)", async () => {
    const r = await redeemInviteWithLogtoSub(
      VALID_TOKEN,
      VALID_SUB,
      { handle: "", displayName: "Alice" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_handle");
      expect(r.httpStatus).toBe(400);
    }
  });

  test("rejects malformed handle (special chars) with code invalid_handle", async () => {
    // Uppercase is tolerated (normalized) but special chars are not.
    const r = await redeemInviteWithLogtoSub(
      VALID_TOKEN,
      VALID_SUB,
      { handle: "alice!", displayName: "Alice" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_handle");
  });

  test("rejects leading-digit handle with code invalid_handle", async () => {
    const r = await redeemInviteWithLogtoSub(
      VALID_TOKEN,
      VALID_SUB,
      { handle: "1alice", displayName: "Alice" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_handle");
  });

  test("rejects display name longer than 200 chars with code invalid_display_name", async () => {
    const r = await redeemInviteWithLogtoSub(
      VALID_TOKEN,
      VALID_SUB,
      { handle: VALID_HANDLE, displayName: "x".repeat(201) },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_display_name");
  });

  test("rejects empty logtoSub with code invalid_logto_sub", async () => {
    const r = await redeemInviteWithLogtoSub(
      VALID_TOKEN,
      "",
      { handle: VALID_HANDLE, displayName: "Alice" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_logto_sub");
      expect(r.httpStatus).toBe(400);
    }
  });

  test("accepts empty displayName (Logto user may have no name)", async () => {
    // This case must PASS validation and then proceed toward DB. Without a
    // DB it will throw — we just confirm the validation gate doesn't reject
    // empty displayName. We catch any post-validation throw and ignore it.
    let validationRejected = false;
    try {
      const r = await redeemInviteWithLogtoSub(
        VALID_TOKEN,
        VALID_SUB,
        { handle: VALID_HANDLE, displayName: "" },
        {},
      );
      if (
        !r.ok &&
        (r.code === "invalid_display_name" || r.code === "invalid_handle")
      ) {
        validationRejected = true;
      }
    } catch {
      // Post-validation DB error — expected without a real DB.
    }
    expect(validationRejected).toBe(false);
  });
});

describe("completeInviteProfile — validation early returns (M105 / M107)", () => {
  // M107 Phase 2c: `handle` removed from CompleteInviteProfileArgs (set
  // at bind time now). The route-layer back-compat that accepts a body
  // `handle` field and returns 409 handle_mismatch lives in invites.ts;
  // these lib-level tests only cover displayName + pin validation.

  test("rejects empty displayName with code invalid_display_name", async () => {
    const r = await completeInviteProfile(
      VALID_TOKEN,
      VALID_SUB,
      { displayName: "   ", pin: "123456" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_display_name");
  });

  test("rejects PIN shorter than 6 digits with code invalid_pin", async () => {
    const r = await completeInviteProfile(
      VALID_TOKEN,
      VALID_SUB,
      { displayName: "Alice", pin: "12345" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_pin");
  });

  test("rejects PIN containing non-digits with code invalid_pin", async () => {
    const r = await completeInviteProfile(
      VALID_TOKEN,
      VALID_SUB,
      { displayName: "Alice", pin: "12345a" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_pin");
  });

  test("rejects PIN longer than 8 digits with code invalid_pin", async () => {
    const r = await completeInviteProfile(
      VALID_TOKEN,
      VALID_SUB,
      { displayName: "Alice", pin: "123456789" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_pin");
  });
});
