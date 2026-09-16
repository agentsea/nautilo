/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { consumeRoomDraft, consumeRoomDraftSnapshot, roomDraftKey, saveRoomDraft, saveRoomDraftSnapshot } from "./room-drafts";
const scope = { serverId: "server-a", viewerId: "user-a", roomId: "room-a" };
function store() { const values = new Map<string, string>(); return { values, getItemAsync: async (key: string) => values.get(key) ?? null, setItemAsync: async (key: string, value: string) => { values.set(key, value); }, deleteItemAsync: async (key: string) => { values.delete(key); } }; }
describe("room draft custody", () => {
  test("recovers only the exact encrypted-store identity and discards explicitly", async () => { const s = store(); await saveRoomDraft(scope, "hello", s, 100); expect(await consumeRoomDraft(scope, s, 101)).toBe("hello"); expect(await consumeRoomDraft({ ...scope, roomId: "room-b" }, s, 101)).toBe(""); await saveRoomDraft(scope, "", s, 102); expect(await consumeRoomDraft(scope, s, 103)).toBe(""); });
  test("clears expired and corrupt records rather than replaying them", async () => { const s = store(); s.values.set(roomDraftKey(scope), "not-json"); expect(await consumeRoomDraft(scope, s, 100)).toBe(""); await saveRoomDraft(scope, "old", s, 0); expect(await consumeRoomDraft(scope, s, 8 * 24 * 60 * 60 * 1000)).toBe(""); expect(s.values.has(roomDraftKey(scope))).toBe(false); });
  test("snapshot recovery retains only opaque attachment custody metadata", async () => {
    const s = store();
    const attachment = { kind: "custody" as const, custodyId: "native-12345678", filename: "photo.png", mimeType: "image/png", sizeBytes: 42 };
    expect(await saveRoomDraftSnapshot(scope, { text: "review me", attachments: [attachment] }, s, 100)).toBe("saved");
    expect(s.values.get(roomDraftKey(scope))).not.toMatch(/uri|path|base64/i);
    expect(await consumeRoomDraftSnapshot(scope, s, 101)).toEqual({ text: "review me", attachments: [attachment] });
    expect(await saveRoomDraftSnapshot(scope, { text: "", attachments: [{ ...attachment, path: "/private/file" } as typeof attachment] }, s, 102)).toBe("too-large");
    expect(await consumeRoomDraftSnapshot(scope, s, 103)).toEqual({ text: "", attachments: [] });
  });
  test("recovers a server-side pending attachment without retaining a device URI", async () => {
    const s = store();
    const attachment = { kind: "server" as const, attachmentId: "attach-12345678", filename: "photo.png", mimeType: "image/png", sizeBytes: 42 };
    expect(await saveRoomDraftSnapshot(scope, { text: "", attachments: [attachment] }, s, 100)).toBe("saved");
    expect(await consumeRoomDraftSnapshot(scope, s, 101)).toEqual({ text: "", attachments: [attachment] });
    expect(s.values.get(roomDraftKey(scope))).not.toMatch(/uri|path|base64/i);
  });
});
