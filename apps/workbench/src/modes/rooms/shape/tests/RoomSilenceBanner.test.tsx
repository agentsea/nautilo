import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSilenceBannerCopy } from "../use-room-silence";
import { RoomSilenceBanner } from "../RoomSilenceBanner";

mock.module("../../../../lib/api", () => ({
  apiClient: { getRoomSilence: async () => ({ silence: null, canManage: false }) },
}));
mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: () => undefined, dismiss: () => undefined, _current: null }),
}));

const NOW = new Date("2026-06-09T12:00:00.000Z").getTime();
const EXPIRES = new Date("2026-06-09T12:30:00.000Z").toISOString();

describe("buildSilenceBannerCopy — D190 MR3", () => {
  it("mute copy says bots are still listening", () => {
    const copy = buildSilenceBannerCopy(
      {
        id: "s1",
        kind: "mute",
        botActorId: null,
        botDisplayName: null,
        setByDisplayName: "Room Admin",
        expiresAt: EXPIRES,
      },
      NOW,
    );
    expect(copy?.headline).toBe("Room Admin muted bots · 30:00");
    expect(copy?.detail).toBe("Bots are muted but still listening");
  });

  it("deaf copy does not say listening", () => {
    const copy = buildSilenceBannerCopy(
      {
        id: "s2",
        kind: "deaf",
        botActorId: null,
        botDisplayName: null,
        setByDisplayName: "Room Admin",
        expiresAt: EXPIRES,
      },
      NOW,
    );
    expect(copy?.headline).toBe("Bots out of the room · 30:00");
    expect(copy?.detail).toBe("Room Admin put bots out of the room");
    expect(copy?.detail).not.toContain("listening");
  });
});

describe("RoomSilenceBanner — SSR smoke", () => {
  it("renders nothing when idle (no active silence)", () => {
    const html = renderToStaticMarkup(<RoomSilenceBanner roomId="room-1" />);
    expect(html).toBe("");
    expect(html).not.toContain("room-silence-idle");
    expect(html).not.toContain("room-silence-mute");
    expect(html).not.toContain("room-silence-deaf");
  });
});
