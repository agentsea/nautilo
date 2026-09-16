import { describe, expect, test } from "bun:test";
import type { RoomSilenceState } from "@nautilo/db";
import { resolveActiveSilence } from "@nautilo/trust";

const BOT_A = "00000000-0000-4000-8000-000000000010";
const BOT_B = "00000000-0000-4000-8000-000000000011";

function row(
  partial: Partial<RoomSilenceState> &
    Pick<RoomSilenceState, "kind" | "startedAt" | "expiresAt">,
): Pick<RoomSilenceState, "kind" | "botActorId" | "startedAt" | "expiresAt"> {
  return {
    kind: partial.kind,
    botActorId: partial.botActorId ?? null,
    startedAt: partial.startedAt,
    expiresAt: partial.expiresAt,
  };
}

describe("resolveActiveSilence", () => {
  const started = new Date("2026-06-01T10:00:00.000Z");
  const expires = new Date("2026-06-01T10:30:00.000Z");

  test("returns null when no rows match", () => {
    expect(
      resolveActiveSilence([], BOT_A, new Date("2026-06-01T10:15:00.000Z")),
    ).toBeNull();
  });

  test("room-wide mute matches every bot", () => {
    const now = new Date("2026-06-01T10:15:00.000Z");
    const rows = [row({ kind: "mute", startedAt: started, expiresAt: expires })];
    expect(resolveActiveSilence(rows, BOT_A, now)).toBe("mute");
    expect(resolveActiveSilence(rows, BOT_B, now)).toBe("mute");
  });

  test("per-bot mute matches only that bot", () => {
    const now = new Date("2026-06-01T10:15:00.000Z");
    const rows = [
      row({
        kind: "mute",
        botActorId: BOT_A,
        startedAt: started,
        expiresAt: expires,
      }),
    ];
    expect(resolveActiveSilence(rows, BOT_A, now)).toBe("mute");
    expect(resolveActiveSilence(rows, BOT_B, now)).toBeNull();
  });

  test("deaf takes precedence over mute for the same bot", () => {
    const now = new Date("2026-06-01T10:15:00.000Z");
    const rows = [
      row({ kind: "mute", startedAt: started, expiresAt: expires }),
      row({ kind: "deaf", startedAt: started, expiresAt: expires }),
    ];
    expect(resolveActiveSilence(rows, BOT_A, now)).toBe("deaf");
  });

  test("inclusive start boundary is active", () => {
    const rows = [row({ kind: "mute", startedAt: started, expiresAt: expires })];
    expect(resolveActiveSilence(rows, BOT_A, started)).toBe("mute");
  });

  test("inclusive expiry boundary is active", () => {
    const rows = [row({ kind: "mute", startedAt: started, expiresAt: expires })];
    expect(resolveActiveSilence(rows, BOT_A, expires)).toBe("mute");
  });

  test("one millisecond after expiry is inactive", () => {
    const rows = [row({ kind: "mute", startedAt: started, expiresAt: expires })];
    const after = new Date(expires.getTime() + 1);
    expect(resolveActiveSilence(rows, BOT_A, after)).toBeNull();
  });

  test("one millisecond before start is inactive", () => {
    const rows = [row({ kind: "mute", startedAt: started, expiresAt: expires })];
    const before = new Date(started.getTime() - 1);
    expect(resolveActiveSilence(rows, BOT_A, before)).toBeNull();
  });
});
