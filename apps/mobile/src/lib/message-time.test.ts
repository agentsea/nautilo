import { describe, expect, test } from "bun:test";
import { applyStreamEvent, fromHistoryMessages, makeOptimisticUserItem, type ChatItem } from "./messages";
import { messageDay, messageDayLabels, messageSentDate } from "./message-time";

const sentAt = "2026-09-07T08:32:00.000Z";
const laneKey = "room:00000000-0000-4000-8000-000000000001";
describe("authoritative mobile message time", () => {
  test("rejects absent/invalid dates instead of inventing now", () => {
    for (const value of [undefined, null, "", "broken", 123]) expect(messageSentDate(value)).toBeNull();
    expect(messageSentDate(sentAt)?.toISOString()).toBe(sentAt);
  });
  test("uses history time and retains it when a legacy echo has no date", () => {
    const history = fromHistoryMessages([{ id: "1", role: "user", content: "hello", createdAt: sentAt }]);
    expect(history[0]).toMatchObject({ sentAt });
    const echoed = applyStreamEvent(history, { type: "message.new", laneKey, messageId: "1", role: "user", content: "hello" });
    expect(echoed[0]).toMatchObject({ sentAt });
  });
  test("new realtime messages display server time and undated events stay unknown", () => {
    const dated = applyStreamEvent([], { type: "message.new", laneKey, messageId: "2", role: "ai", content: "hello", createdAt: sentAt });
    expect(dated[0]).toMatchObject({ sentAt });
    const legacy = applyStreamEvent([], { type: "message.new", laneKey, messageId: "2", role: "ai", content: "hello" });
    expect(legacy[0]).not.toHaveProperty("sentAt", expect.any(String));
  });
  test("optimistic and streaming receipt times do not masquerade as sent time", () => {
    const optimistic = makeOptimisticUserItem("local-1", "hello", "2026-09-07T09:00:00Z");
    expect(optimistic).not.toHaveProperty("sentAt");
    const echoed = applyStreamEvent([optimistic], { type: "message.new", laneKey, messageId: "3", role: "user", content: "hello", createdAt: sentAt });
    expect(echoed[0]).toMatchObject({ sentAt, id: "3" });
    const streaming = applyStreamEvent([], { type: "message.tokens", laneKey, turnId: "t", content: "hello", chunkSequence: 0, done: false });
    expect(streaming[0]).not.toHaveProperty("sentAt");
    const final = applyStreamEvent(streaming, { type: "message.new", laneKey, messageId: "4", role: "ai", content: "hello", createdAt: sentAt });
    expect(final[0]).toMatchObject({ sentAt, id: "4" });
  });
  test("marks chronological day starts in the inverted list and skips undated rows", () => {
    const row = (id: string, date?: string): ChatItem => ({ kind: "message", id, role: "user", text: id, createdAt: date ?? sentAt, sentAt: date, status: "sent" });
    const labels = messageDayLabels([row("next", "2026-09-08T12:00:00Z"), row("later", sentAt), row("unknown"), row("first", sentAt)]);
    expect([...labels.keys()]).toEqual(["first", "next"]);
    expect(messageDay(sentAt)).toBe(messageDay("2026-09-07T08:33:00Z"));
  });
});
