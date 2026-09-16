import { afterEach, describe, expect, test } from "bun:test";

import {
  foregroundRecordContextPortForRoom,
  hasForegroundRecordContextPortFactory,
  installForegroundRecordContextPortFactory,
  uninstallForegroundRecordContextPortFactory,
} from "../../src/reflection/foreground-record-context";

afterEach(() => uninstallForegroundRecordContextPortFactory());

describe("foreground initial Record-context composition", () => {
  test("is absent until Server installs the exact Room binding", () => {
    expect(hasForegroundRecordContextPortFactory()).toBe(false);
    expect(foregroundRecordContextPortForRoom("room-1")).toBeUndefined();
  });

  test("forwards the invocation Room without retaining per-turn state", () => {
    const rooms: string[] = [];
    installForegroundRecordContextPortFactory((roomId) => {
      rooms.push(roomId);
      return {
        representation: "ordinary",
        select: async () => ({
          status: "available",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          candidateCount: 0,
          records: [],
        }),
      };
    });
    expect(foregroundRecordContextPortForRoom("child-room")?.representation)
      .toBe("ordinary");
    expect(rooms).toEqual(["child-room"]);
  });

  test("refuses a second competing owner", () => {
    installForegroundRecordContextPortFactory(() => undefined);
    expect(() => installForegroundRecordContextPortFactory(() => undefined))
      .toThrow("foreground_record_context_factory_already_installed");
  });
});
