import { describe, test, expect } from "bun:test";
import { pickDefaultRoomFromPrivateMemberCandidates } from "../../src/queries";

describe("pickDefaultRoomFromPrivateMemberCandidates (M065 Risk #1)", () => {
  test("prefers app:default graph thread when present among candidates", () => {
    const d2020 = new Date("2020-01-01");
    const d2021 = new Date("2021-01-01");
    const picked = pickDefaultRoomFromPrivateMemberCandidates([
      { id: "b-newer", type: "private", graphThreadId: "room:b", createdAt: d2021 },
      { id: "a-legacy", type: "private", graphThreadId: "app:default", createdAt: d2020 },
    ]);
    expect(picked?.id).toBe("a-legacy");
    expect(picked?.graphThreadId).toBe("app:default");
  });

  test("without legacy thread, picks oldest createdAt then id ascending", () => {
    const d1 = new Date("2020-06-01");
    const d2 = new Date("2019-12-31");
    const d3 = new Date("2019-12-31");
    const picked = pickDefaultRoomFromPrivateMemberCandidates([
      { id: "zzz", type: "private", graphThreadId: "room:zzz", createdAt: d1 },
      { id: "aaa", type: "private", graphThreadId: "room:aaa", createdAt: d2 },
      { id: "bbb", type: "private", graphThreadId: "room:bbb", createdAt: d3 },
    ]);
    expect(picked?.id).toBe("aaa");
  });

  test("same createdAt breaks ties by id lexicographic ascending", () => {
    const same = new Date("2021-03-15");
    const picked = pickDefaultRoomFromPrivateMemberCandidates([
      { id: "room-m", type: "private", graphThreadId: "room:m", createdAt: same },
      { id: "room-a", type: "private", graphThreadId: "room:a", createdAt: same },
      { id: "room-z", type: "private", graphThreadId: "room:z", createdAt: same },
    ]);
    expect(picked?.id).toBe("room-a");
  });

  test("empty list returns null", () => {
    expect(pickDefaultRoomFromPrivateMemberCandidates([])).toBeNull();
  });
});
