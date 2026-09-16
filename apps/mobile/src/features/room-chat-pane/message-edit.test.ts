import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../lib/messages";
import { canEditMobileMessage, saveMobileMessageEdit } from "./message-edit";

type Message = Extract<ChatItem, { kind: "message" }>;
const own: Message = {
  kind: "message", id: "12", role: "user", text: "Original", createdAt: "2026-01-01",
  sourceUserId: "viewer", logicalMessageKey: "logical", editRevision: 0,
};

describe("mobile message edit admission", () => {
  test("allows only persisted own Human text with known edit identity", () => {
    expect(canEditMobileMessage(own, "viewer")).toBe(true);
    expect(canEditMobileMessage({ ...own, sourceUserId: undefined }, "viewer")).toBe(true);
    for (const patch of [
      { role: "assistant" as const }, { sourceUserId: "other" }, { clientId: "pending" },
      { id: "streaming:1" }, { status: "failed" as const }, { status: "pending" as const },
      { logicalMessageKey: undefined }, { editRevision: undefined }, { editRevision: -1 },
      { editRevision: 0.5 }, { text: "  " },
    ]) expect(canEditMobileMessage({ ...own, ...patch }, "viewer")).toBe(false);
    expect(canEditMobileMessage(own, null)).toBe(false);
  });

  test("checks authoritative text, not a display-only projection", () => {
    expect(canEditMobileMessage({ ...own, editContent: " " }, "viewer")).toBe(false);
  });

  test("saves exactly once after plaintext admission", async () => {
    let saves = 0;
    expect(await saveMobileMessageEdit({
      content: "Edited", filterContent: true, isCurrent: () => true,
      getPolicy: async () => ({ requiresCryptoDevice: false }),
      save: async () => { saves++; return "saved"; },
    })).toBe("saved");
    expect(saves).toBe(1);
  });

  test("never transmits a draft on protected/unknown policy or stale scope", async () => {
    let saves = 0;
    const base = {
      content: "Edited", filterContent: true, isCurrent: () => true,
      save: async () => { saves++; },
    };
    expect(saveMobileMessageEdit({ ...base,
      getPolicy: async () => ({ requiresCryptoDevice: true }),
    })).rejects.toThrow("Encryption");
    expect(saveMobileMessageEdit({ ...base,
      getPolicy: async () => { throw new Error("Unavailable"); },
    })).rejects.toThrow("Unavailable");
    let current = true;
    expect(saveMobileMessageEdit({ ...base, isCurrent: () => current,
      getPolicy: async () => { current = false; return { requiresCryptoDevice: false }; },
    })).rejects.toThrow("no longer active");
    expect(saves).toBe(0);
  });

  test("blank and filtered edits are rejected before network access", async () => {
    let reads = 0;
    for (const content of ["  ", "I will kill you"]) {
      expect(saveMobileMessageEdit({ content, filterContent: true, isCurrent: () => true,
        getPolicy: async () => { reads++; return { requiresCryptoDevice: false }; },
        save: async () => { throw new Error("must not save"); },
      })).rejects.toThrow();
    }
    expect(reads).toBe(0);
  });
});
