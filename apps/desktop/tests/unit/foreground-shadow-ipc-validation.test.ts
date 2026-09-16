import { describe, expect, test } from "bun:test";

import {
  assertForegroundShadowHistoryShape,
  boundedForegroundShadowValue,
  foregroundShadowString,
  parseForegroundShadowEdit,
  parseForegroundShadowPendingAttention,
} from "../../electron/foreground-shadow-ipc-validation";

describe("Desktop foreground Shadow IPC validation", () => {
  test("edits accept only text plus an exact safe revision", () => {
    const valid = { roomId: "room", messageId: "123", body: { content: "edited", expectedRevision: 0 } };
    expect(parseForegroundShadowEdit(valid)).toEqual(valid);
    for (const body of [null, [], {}, { content: "", expectedRevision: 0 },
      { content: "edited", expectedRevision: -1 },
      { content: "edited", expectedRevision: 1.5 },
      { content: "edited", expectedRevision: "0" },
      { content: "edited", expectedRevision: 0, signingKey: "untrusted" }]) {
      expect(() => parseForegroundShadowEdit({ ...valid, body })).toThrow();
    }
  });
  test("clones an admitted payload and rejects cyclic or oversized values", () => {
    const original = { roomId: "room-m300", body: { content: "hello" } };
    const cloned = boundedForegroundShadowValue(original, "request", 128);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => boundedForegroundShadowValue(cyclic, "request", 128))
      .toThrow("request is not serializable");
    expect(() => boundedForegroundShadowValue({ value: "x".repeat(128) }, "request", 32))
      .toThrow("request exceeds its byte limit");
    expect(() => boundedForegroundShadowValue(undefined, "request", 32))
      .toThrow("request is not serializable");
  });

  test("bounds content-free coordinates", () => {
    expect(foregroundShadowString("room-m300", "Room id", 32))
      .toBe("room-m300");
    expect(() => foregroundShadowString("", "Room id", 32))
      .toThrow("Room id is invalid");
    expect(() => foregroundShadowString("x".repeat(33), "Room id", 32))
      .toThrow("Room id is invalid");
  });

  test("admits only exact pending-attention coordinates", () => {
    const valid = { roomId: "room-1", clientActionSessionId: "session-1" };
    expect(parseForegroundShadowPendingAttention(valid)).toEqual(valid);
    expect(() => parseForegroundShadowPendingAttention({
      ...valid,
      authorizationBytesBase64url: "secret",
    })).toThrow("input is invalid");
    expect(() => parseForegroundShadowPendingAttention({
      ...valid,
      clientActionSessionId: "",
    })).toThrow("Session id is invalid");
  });

  test("admits only a bounded history page with acknowledgement metadata", () => {
    const valid = { readerInput: { records: [] }, acknowledgement: {} };
    expect(() => assertForegroundShadowHistoryShape(valid)).not.toThrow();
    expect(() => assertForegroundShadowHistoryShape({
      readerInput: { records: Array.from({ length: 65 }, () => ({})) },
      acknowledgement: {},
    })).toThrow("Foreground Shadow history input is invalid");
    expect(() => assertForegroundShadowHistoryShape({
      readerInput: { records: [{
        representationMode: "protected-only",
        selectedSource: { role: "user" },
      }] },
      acknowledgement: {},
    })).not.toThrow();
    expect(() => assertForegroundShadowHistoryShape({
      readerInput: { records: [{
        representationMode: "protected-only",
        selectedSource: { role: "user" },
        ordinarySibling: { payload: { role: "user", content: "leak" } },
      }] },
      acknowledgement: {},
    })).toThrow("contains an ordinary sibling");
    expect(() => assertForegroundShadowHistoryShape({
      readerInput: { records: [] },
      acknowledgement: null,
    })).toThrow("Foreground Shadow history input is invalid");
  });
});
