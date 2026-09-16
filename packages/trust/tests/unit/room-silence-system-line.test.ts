import { describe, expect, test } from "bun:test";
import {
  clampSilenceDurationMs,
  formatRoomSilenceSystemLine,
  formatSilenceDurationLabel,
  MAX_SILENCE_DURATION_MS,
  DEFAULT_SILENCE_DURATION_MS,
} from "../../src/room-silence";

describe("room silence system lines (D190 MR4)", () => {
  test("mute room-wide set line", () => {
    expect(
      formatRoomSilenceSystemLine({
        kind: "silence_set",
        silenceKind: "mute",
        setByDisplayName: "Room Admin",
        durationLabel: "30m",
      }),
    ).toBe("Room Admin muted bots for 30m");
  });

  test("deaf room-wide set line does not say listening", () => {
    expect(
      formatRoomSilenceSystemLine({
        kind: "silence_set",
        silenceKind: "deaf",
        setByDisplayName: "Room Admin",
        durationLabel: "30m",
      }),
    ).toBe("Room Admin put bots out of the room for 30m");
  });

  test("per-bot mute line", () => {
    expect(
      formatRoomSilenceSystemLine({
        kind: "silence_set",
        silenceKind: "mute",
        setByDisplayName: "Room Admin",
        durationLabel: "1h",
        botDisplayName: "Genie",
      }),
    ).toBe("Room Admin muted Genie for 1h");
  });

  test("cleared line", () => {
    expect(
      formatRoomSilenceSystemLine({
        kind: "silence_cleared",
        reason: "expired",
      }),
    ).toBe("Bots returned to the room");
  });
});

describe("silence duration clamp (D190 MR6)", () => {
  test("defaults to 30 minutes", () => {
    expect(clampSilenceDurationMs(undefined)).toBe(DEFAULT_SILENCE_DURATION_MS);
  });

  test("caps at 24 hours", () => {
    expect(clampSilenceDurationMs(MAX_SILENCE_DURATION_MS + 1)).toBe(MAX_SILENCE_DURATION_MS);
  });

  test("formats minutes and hours", () => {
    expect(formatSilenceDurationLabel(30 * 60_000)).toBe("30m");
    expect(formatSilenceDurationLabel(2 * 60 * 60_000)).toBe("2h");
  });
});
