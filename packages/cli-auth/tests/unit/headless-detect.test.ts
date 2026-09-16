/**
 * Unit tests for `detectHeadless` / `detectHeadlessForPlatform` (M102).
 */

import { describe, expect, test } from "bun:test";
import {
  detectHeadlessForPlatform,
} from "../../src/headless-detect";

describe("detectHeadlessForPlatform", () => {
  test("empty env on darwin → not headless", () => {
    const r = detectHeadlessForPlatform({}, "darwin");
    expect(r.headless).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("empty env on linux → no-display", () => {
    const r = detectHeadlessForPlatform({}, "linux");
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["no-display"]);
  });

  test("linux with DISPLAY=:0 → not headless (display present)", () => {
    const r = detectHeadlessForPlatform(
      { DISPLAY: ":0" },
      "linux",
    );
    expect(r.headless).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("linux with WAYLAND_DISPLAY=wayland-0 → not headless", () => {
    const r = detectHeadlessForPlatform(
      { WAYLAND_DISPLAY: "wayland-0" },
      "linux",
    );
    expect(r.headless).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("darwin with SSH_CONNECTION set → ssh-session", () => {
    const r = detectHeadlessForPlatform(
      { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 33" },
      "darwin",
    );
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["ssh-session"]);
  });

  test("SSH_TTY set → ssh-session", () => {
    const r = detectHeadlessForPlatform({ SSH_TTY: "/dev/pts/0" }, "darwin");
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["ssh-session"]);
  });

  test("SSH_CLIENT set → ssh-session", () => {
    const r = detectHeadlessForPlatform(
      { SSH_CLIENT: "1.2.3.4 12345 22" },
      "darwin",
    );
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["ssh-session"]);
  });

  test("darwin with NAUTILO_FORCE_DEVICE_FLOW=1 → env-force", () => {
    const r = detectHeadlessForPlatform(
      { NAUTILO_FORCE_DEVICE_FLOW: "1" },
      "darwin",
    );
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["env-force"]);
  });

  test("linux: ssh + force + no display → all three reasons (order fixed)", () => {
    const r = detectHeadlessForPlatform(
      {
        SSH_CONNECTION: "x",
        NAUTILO_FORCE_DEVICE_FLOW: "1",
      },
      "linux",
    );
    expect(r.headless).toBe(true);
    expect(r.reasons).toEqual(["ssh-session", "no-display", "env-force"]);
  });

  test("NAUTILO_FORCE_DEVICE_FLOW=0 does not add env-force", () => {
    const r = detectHeadlessForPlatform(
      { NAUTILO_FORCE_DEVICE_FLOW: "0" },
      "darwin",
    );
    expect(r.headless).toBe(false);
    expect(r.reasons).toEqual([]);
  });
});
