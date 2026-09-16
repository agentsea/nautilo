import { describe, test, expect } from "bun:test";
import {
  assembleCompositeContextBlock,
  dmTimePrefix,
  type RoomHistoryHit,
} from "@nautilo/runtime";

function msg(handle: string, display: string, content: string, ts: string): RoomHistoryHit {
  return {
    messageId: Math.floor(Math.random() * 100000),
    ts: new Date(ts),
    authorDisplayName: display,
    handle,
    authorActorId: `actor-${handle}`,
    snippet: content,
  };
}

describe("assembleCompositeContextBlock", () => {
  test("formats labelled lines with name + @handle + ISO UTC", () => {
    const block = assembleCompositeContextBlock({
      messages: [
        msg("sender", "Sender", "what's blocking deploy?", "2026-06-01T13:02:11Z"),
        msg("nova", "Nova", "auth callback failing", "2026-06-01T13:02:14Z"),
      ],
      maxLines: 10,
    });
    expect(block).toContain("[2026-06-01T13:02:11Z] Sender (@sender): what's blocking deploy?");
    expect(block).toContain("[2026-06-01T13:02:14Z] Nova (@nova): auth callback failing");
  });

  test("oldest-first truncation marker when over budget", () => {
    const block = assembleCompositeContextBlock({
      messages: [
        msg("a", "A", "one", "2026-06-01T13:00:01Z"),
        msg("a", "A", "two", "2026-06-01T13:00:02Z"),
        msg("a", "A", "three", "2026-06-01T13:00:03Z"),
      ],
      maxLines: 2,
    });
    expect(block).toContain("… earlier messages elided …");
    expect(block).not.toContain("one");
    expect(block).toContain("two");
    expect(block).toContain("three");
  });

  test("addressedBy marker appended when provided", () => {
    const block = assembleCompositeContextBlock({
      messages: [msg("sender", "Sender", "ping", "2026-06-01T13:00:01Z")],
      maxLines: 10,
      addressedBy: "Sender",
    });
    expect(block).toContain("--- you were addressed by: Sender ---");
  });

  test("idempotent: lines already in seenText are skipped", () => {
    const seenLine = "[2026-06-01T13:00:01Z] A (@a): one";
    const block = assembleCompositeContextBlock({
      messages: [
        msg("a", "A", "one", "2026-06-01T13:00:01Z"),
        msg("a", "A", "two", "2026-06-01T13:00:02Z"),
      ],
      maxLines: 10,
      seenText: `prior checkpoint content ${seenLine} more`,
    });
    expect(block).not.toContain("one");
    expect(block).toContain("two");
  });

  test("parallel burst from several authors: only the unseen tail is injected", () => {
    // Bot already saw m1 (its prior context); m2..m5 arrived from 3 people
    // in parallel while the bot was active. The block must carry the full
    // unseen diff, attributed per author, oldest-first.
    const m1 = msg("h1", "H1", "saw this before", "2026-06-01T13:00:01Z");
    const seen = "[2026-06-01T13:00:01Z] H1 (@h1): saw this before";
    const block = assembleCompositeContextBlock({
      messages: [
        m1,
        msg("h2", "H2", "parallel from two", "2026-06-01T13:00:02Z"),
        msg("h3", "H3", "parallel from three", "2026-06-01T13:00:03Z"),
        msg("h1", "H1", "and one more from one", "2026-06-01T13:00:04Z"),
      ],
      maxLines: 60,
      seenText: seen,
    });
    expect(block).not.toBeNull();
    expect(block).not.toContain("saw this before");
    expect(block).toContain("(@h2): parallel from two");
    expect(block).toContain("(@h3): parallel from three");
    expect(block).toContain("(@h1): and one more from one");
    // oldest-first order preserved among the unseen lines
    const idx2 = block!.indexOf("parallel from two");
    const idx4 = block!.indexOf("and one more from one");
    expect(idx2).toBeLessThan(idx4);
  });

  test("returns null when every line already seen", () => {
    const m = msg("a", "A", "one", "2026-06-01T13:00:01Z");
    const seen = "[2026-06-01T13:00:01Z] A (@a): one";
    const block = assembleCompositeContextBlock({ messages: [m], maxLines: 10, seenText: seen });
    expect(block).toBeNull();
  });
});

describe("dmTimePrefix", () => {
  test("prefixes ISO UTC time with no speaker label", () => {
    expect(dmTimePrefix(new Date("2026-06-01T13:02:11Z"), "hello")).toBe(
      "[2026-06-01T13:02:11Z] hello",
    );
  });
});
