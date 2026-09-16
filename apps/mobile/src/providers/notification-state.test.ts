import { describe, expect, test } from "bun:test";
import type { NotificationStateResponse } from "@nautilo/types";

import {
  applyMobileNotificationLoad,
  canApplyMobileNotificationRequest,
  pruneMobileNotificationSnapshots,
} from "@/lib/mobile-notification-attention";

function snapshot(unreadCount: number, importantUnreadCount: number): NotificationStateResponse {
  return {
    generatedAt: "2026-08-09T00:00:00.000Z",
    preferences: { defaultLevel: "direct", roomOverrides: [] },
    totals: { unreadCount, importantUnreadCount },
    rooms: [],
    subthreads: [],
  };
}

describe("Mobile notification-state lifecycle projection", () => {
  test("preserves inactive last-known state, refreshes it on lifecycle recovery, and clears signed-out or removed rows", () => {
    let state = applyMobileNotificationLoad(new Map(), "alpha", { kind: "fresh", snapshot: snapshot(3, 0) }, "human-a");
    state = applyMobileNotificationLoad(state, "beta", { kind: "fresh", snapshot: snapshot(9, 2) }, "human-a");

    // Switching to beta leaves alpha available as inactive last-known state.
    state = pruneMobileNotificationSnapshots(state, new Set(["alpha", "beta"]), "beta", true);
    state = applyMobileNotificationLoad(state, "alpha", { kind: "unavailable" });
    expect(state.get("alpha")).toMatchObject({ stale: true, snapshot: { totals: { unreadCount: 3 } } });

    // Reconnect/app activation has authoritative fresh data and clears stale.
    state = applyMobileNotificationLoad(state, "alpha", { kind: "fresh", snapshot: snapshot(4, 1) });
    expect(state.get("alpha")).toMatchObject({ stale: false, snapshot: { totals: { unreadCount: 4, importantUnreadCount: 1 } } });

    // The active-server sign-out clears beta; registry removal clears alpha.
    state = pruneMobileNotificationSnapshots(state, new Set(["alpha", "beta"]), "beta", false);
    expect(state.has("beta")).toBe(false);
    state = pruneMobileNotificationSnapshots(state, new Set(), null, false);
    expect(state.size).toBe(0);
  });

  test("a same-server Human switch clears old state and fences a late prior-Human response", () => {
    const state = applyMobileNotificationLoad(new Map(), "alpha", { kind: "fresh", snapshot: snapshot(5, 2) }, "human-a");
    expect(state.get("alpha")?.viewerId).toBe("human-a");
    expect(canApplyMobileNotificationRequest({
      requestGeneration: 1,
      currentGeneration: 2,
      requestIdentityKey: "alpha:human-a",
      currentIdentityKey: "alpha:human-b",
    })).toBe(false);
    expect(canApplyMobileNotificationRequest({
      requestGeneration: 2,
      currentGeneration: 2,
      requestIdentityKey: "alpha:human-b",
      currentIdentityKey: "alpha:human-b",
    })).toBe(true);
  });

  test("keeps the UI contracts for active-only tab attention, inactive-only drawer attention, and canonical fallback", async () => {
    const provider = await Bun.file(new URL("./notification-state.tsx", import.meta.url)).text();
    const tabs = await Bun.file(new URL("../app/(drawer)/(tabs)/_layout.tsx", import.meta.url)).text();
    const chats = await Bun.file(new URL("../app/(drawer)/(tabs)/index.tsx", import.meta.url)).text();
    const drawer = await Bun.file(new URL("../components/drawer-content.tsx", import.meta.url)).text();

    expect(provider).toContain("activeIdentityKey");
    expect(provider).toContain("canApplyMobileNotificationRequest");
    expect(provider).toContain("loadMobileNotificationStateBatch(inactive, loaderRef.current!)");
    expect(tabs).toContain('activeAttention?.hasUnread ? "•" : undefined');
    expect(tabs).toContain("backgroundColor: t.color.brand.accent");
    expect(tabs).toContain("color: t.color.text.onPrimary");
    expect(tabs).not.toMatch(/fontSize:\s*0\b/);
    expect(tabs).toContain("color: t.color.brand.accent");
    expect(tabs).toContain("fontSize: 1");
    expect(tabs).toContain("tabBarAccessibilityLabel: activeAttention?.accessibilityLabel");
    expect(chats).toContain("activeSnapshot === null && (item.unreadCount ?? 0) > 0");
    expect(drawer).toContain("const attention = active ? null : serverAttention");
    expect(drawer).toContain("attention?.accessibilityLabel");
  });
});
