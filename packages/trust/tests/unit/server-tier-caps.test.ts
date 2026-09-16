/**
 * D219 — server-tier capability substrate replaces `users.server_role`.
 *
 * Pure import-shape test: no DB, no network.
 */
import { describe, test, expect } from "bun:test";
import * as trust from "@nautilo/trust";

describe("D219 — @nautilo/trust public surface", () => {
  test("exports userHasCapability and not legacy serverRole helpers", () => {
    expect(typeof trust.userHasCapability).toBe("function");
    expect("isUserAdmin" in trust).toBe(false);
    expect("userHasServerAdminRole" in trust).toBe(false);
  });
});
