import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTO_APPROVE_SESSION_KEY,
  clearAutoApproveSession,
  readAutoApproveSession,
  writeAutoApproveSession,
} from "../../src/approval/auto-approve-session";

describe("Auto-Approve renderer session", () => {
  afterEach(() => sessionStorage.removeItem(AUTO_APPROVE_SESSION_KEY));

  test("survives a route remount for the same verified human", () => {
    expect(writeAutoApproveSession("user-1", true)).toBe(true);
    expect(readAutoApproveSession("user-1")).toBe(true);
  });

  test("fails closed and clears state for a different human", () => {
    writeAutoApproveSession("user-1", true);
    expect(readAutoApproveSession("user-2")).toBe(false);
    expect(sessionStorage.getItem(AUTO_APPROVE_SESSION_KEY)).toBeNull();
  });

  test("turning the mode off removes the session record", () => {
    writeAutoApproveSession("user-1", true);
    expect(writeAutoApproveSession("user-1", false)).toBe(false);
    expect(readAutoApproveSession("user-1")).toBe(false);
  });

  test("malformed state is discarded without throwing", () => {
    sessionStorage.setItem(AUTO_APPROVE_SESSION_KEY, "not-json");
    expect(readAutoApproveSession("user-1")).toBe(false);
    expect(sessionStorage.getItem(AUTO_APPROVE_SESSION_KEY)).toBeNull();
  });

  test("unavailable storage fails closed", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;
    expect(readAutoApproveSession("user-1", blocked)).toBe(false);
    expect(writeAutoApproveSession("user-1", true, blocked)).toBe(false);
    expect(() => clearAutoApproveSession(blocked)).not.toThrow();
  });
});
