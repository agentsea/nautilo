import { describe, expect, test } from "bun:test";

import { aggregateReactionRows } from "../../src/store/message-reactions-store";

function findEmoji(
  aggs: { emoji: string; count: number; actorIds: string[]; truncated: boolean }[],
  emoji: string,
) {
  const agg = aggs.find((a) => a.emoji === emoji);
  expect(agg).toBeDefined();
  return agg!;
}

describe("aggregateReactionRows", () => {
  test("empty input returns empty Map", () => {
    expect(aggregateReactionRows([]).size).toBe(0);
  });

  test("aggregates per message and emoji with actor lists", () => {
    const map = aggregateReactionRows([
      { messageId: 1, emoji: "👀", actorId: "actorA" },
      { messageId: 1, emoji: "👀", actorId: "actorB" },
      { messageId: 1, emoji: "🎉", actorId: "actorA" },
      { messageId: 2, emoji: "👍", actorId: "actorC" },
    ]);

    const msg1 = findEmoji(map.get(1)!, "👀");
    expect(msg1.count).toBe(2);
    expect(msg1.actorIds).toEqual(["actorA", "actorB"]);
    expect(msg1.truncated).toBe(false);

    const party = findEmoji(map.get(1)!, "🎉");
    expect(party.count).toBe(1);
    expect(party.actorIds).toEqual(["actorA"]);
    expect(party.truncated).toBe(false);

    const msg2 = findEmoji(map.get(2)!, "👍");
    expect(msg2.count).toBe(1);
    expect(msg2.actorIds).toEqual(["actorC"]);
    expect(msg2.truncated).toBe(false);
  });

  test("caps actorIds at 25 while count stays exact", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      messageId: 5,
      emoji: "🔥",
      actorId: `actor-${i}`,
    }));
    const map = aggregateReactionRows(rows);
    const agg = findEmoji(map.get(5)!, "🔥");
    expect(agg.count).toBe(30);
    expect(agg.actorIds).toHaveLength(25);
    expect(agg.truncated).toBe(true);
  });
});
