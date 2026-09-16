/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import {
  canOpenSharedTextDraft,
  consumeSharedTextIntent,
  parseSharedTextIntent,
  SHARED_TEXT_INTENT_MAX_BYTES,
  stageNativeSharedTextIntent,
} from "./share-handoff";
import { saveRoomDraft } from "./room-drafts";

test("share handoff validates and clears before exposing a one-shot intent", async () => {
  let clear = 0;
  const value = { version: 1, id: "12345678-abcd", kind: "text", value: "hello", createdAt: "2026-08-09T12:00:00.000Z" };
  const store = { get: async () => value, clear: async () => { clear += 1; } };
  expect(await consumeSharedTextIntent(store, Date.parse("2026-08-09T12:01:00.000Z"))).toEqual({
    id: value.id,
    kind: "text",
    value: "hello",
    createdAt: value.createdAt,
  });
  expect(clear).toBe(1);
});

test("native custody is acknowledged only after encrypted staging commits", async () => {
  const raw = { version: 1, id: "share-12345678", kind: "text" as const, value: "hello", createdAt: new Date(100).toISOString() };
  const calls: string[] = [];
  const native = {
    peekAsync: async () => raw,
    ackAsync: async (id: string) => { calls.push(`ack:${id}`); return true; },
    clearAsync: async () => { calls.push("clear"); },
  };
  let failure: unknown;
  try {
    await stageNativeSharedTextIntent(async () => {
      calls.push("save");
      throw new Error("SecureStore unavailable");
    }, 100, native);
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("SecureStore unavailable");
  expect(calls).toEqual(["save"]);

  calls.length = 0;
  expect(await stageNativeSharedTextIntent(async () => { calls.push("save"); }, 100, native)).toEqual({
    id: raw.id,
    kind: raw.kind,
    value: raw.value,
    createdAt: raw.createdAt,
  });
  expect(calls).toEqual(["save", `ack:${raw.id}`]);
});

test("an unacknowledged native receipt remains retryable and is not opened", async () => {
  const raw = { version: 1, id: "share-12345678", kind: "text" as const, value: "hello", createdAt: new Date(100).toISOString() };
  const calls: string[] = [];
  const native = {
    peekAsync: async () => raw,
    ackAsync: async () => { calls.push("ack"); return false; },
    clearAsync: async () => { calls.push("clear"); },
  };
  let failure: unknown;
  try {
    await stageNativeSharedTextIntent(async () => { calls.push("save"); }, 100, native);
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Native share handoff acknowledgement did not commit");
  expect(calls).toEqual(["save", "ack"]);
});

test("native, pending, and ordinary draft custody accept the same exact 1 KiB boundary", async () => {
  const atLimit = "a".repeat(SHARED_TEXT_INTENT_MAX_BYTES);
  const overLimit = "a".repeat(SHARED_TEXT_INTENT_MAX_BYTES + 1);
  const base = { version: 1, id: "share-12345678", kind: "text" as const, createdAt: new Date(100).toISOString() };
  expect(parseSharedTextIntent({ ...base, value: atLimit }, 100)).not.toBeNull();
  expect(parseSharedTextIntent({ ...base, value: overLimit }, 100)).toBeNull();
  const values = new Map<string, string>();
  const store = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
  const scope = { serverId: "server-a", viewerId: "viewer-a", roomId: "room-a" };
  expect(await saveRoomDraft(scope, atLimit, store, 100)).toBe("saved");
  expect(await saveRoomDraft(scope, overLimit, store, 100)).toBe("too-large");
});

test("a share becomes actionable only for the freshly verified server, identity, and Room", () => {
  const intent = { id: "share-12345678", kind: "text" as const, value: "hello", createdAt: new Date(100).toISOString() };
  const accepted = {
    pending: intent,
    owner: { serverId: "server-a", viewerId: "viewer-a" },
    currentServerId: "server-a",
    currentViewerId: "viewer-a",
    roomId: "room-a",
    authorizedRoomIds: new Set(["room-a"]),
    switchingServer: false,
  };
  expect(canOpenSharedTextDraft(accepted)).toBe(true);
  expect(canOpenSharedTextDraft({ ...accepted, currentServerId: "server-b" })).toBe(false);
  expect(canOpenSharedTextDraft({ ...accepted, currentViewerId: "viewer-b" })).toBe(false);
  expect(canOpenSharedTextDraft({ ...accepted, authorizedRoomIds: new Set<string>() })).toBe(false);
  expect(canOpenSharedTextDraft({ ...accepted, switchingServer: true })).toBe(false);
});
