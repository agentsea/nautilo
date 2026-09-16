import { describe, expect, test } from "bun:test";
import {
  mintDesktopSessionId,
  getDesktopSessionId,
  resetDesktopSessionIdForTests,
} from "../../electron/workstation-access/desktop-session";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("D418 desktop-session identity", () => {
  test("mints one stable id per launch and survives reconnects", () => {
    resetDesktopSessionIdForTests();
    expect(getDesktopSessionId()).toBeNull();

    const first = mintDesktopSessionId();
    expect(first).toMatch(UUID_V4);
    expect(getDesktopSessionId()).toBe(first);

    // Subsequent calls (relay reconnects) return the SAME id — generation is
    // not re-run inside startRelay.
    const second = mintDesktopSessionId();
    const third = mintDesktopSessionId();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("a fresh launch mints a distinct id", () => {
    resetDesktopSessionIdForTests();
    const launchA = mintDesktopSessionId();
    resetDesktopSessionIdForTests();
    const launchB = mintDesktopSessionId();
    expect(launchA).not.toBe(launchB);
    expect(launchB).toMatch(UUID_V4);
  });

  test("getDesktopSessionId is null before the first mint", () => {
    resetDesktopSessionIdForTests();
    expect(getDesktopSessionId()).toBeNull();
  });
});
