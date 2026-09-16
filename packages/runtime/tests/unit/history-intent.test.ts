import { describe, test, expect } from "bun:test";
import { extractHistoryIntent } from "@nautilo/runtime";

describe("extractHistoryIntent (D299 P2)", () => {
  describe("accepted v1 shapes", () => {
    test("who was I talking with about X", () => {
      const match = extractHistoryIntent(
        "who was I talking with about the report last week?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("who-talking-about");
      expect(match!.searchQuery).toBe("report last week");
      expect(match!.reason).toBe("who was I talking with/to about X");
    });

    test("who was I talking to about X", () => {
      const match = extractHistoryIntent(
        "who was I talking to about the deploy pipeline",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("who-talking-about");
      expect(match!.searchQuery).toBe("deploy pipeline");
    });

    test("what did we decide about X", () => {
      const match = extractHistoryIntent(
        "what did we decide about the budget?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("what-decide-about");
      expect(match!.searchQuery).toBe("budget");
      expect(match!.reason).toBe("what did we decide about X");
    });

    test("where were we discussing X", () => {
      const match = extractHistoryIntent(
        "where were we discussing the auth callback?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("where-discussing");
      expect(match!.searchQuery).toBe("auth callback");
      expect(match!.reason).toBe("where were we discussing X");
    });

    test("strips leading article from topic for conservative query", () => {
      const match = extractHistoryIntent(
        "what did we decide about the staging fix",
      );
      expect(match!.searchQuery).toBe("staging fix");
    });

    test("allows leading hey as discourse filler before bounded intent", () => {
      const match = extractHistoryIntent(
        "Hey who was I talking to about this report last week?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("who-talking-about");
      expect(match!.searchQuery).toBe("this report last week");
    });

    test("allows bounded emphasis before who-was-I intent", () => {
      const match = extractHistoryIntent(
        "Who the fuck was I talking to about the stock crash earlier?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("who-talking-about");
      expect(match!.searchQuery).toBe("stock crash");
    });

    test("drops topic expletives that poison full-text search", () => {
      const match = extractHistoryIntent(
        "Who was I talking to about the damn stock crash?",
      );
      expect(match).not.toBeNull();
      expect(match!.shape).toBe("who-talking-about");
      expect(match!.searchQuery).toBe("stock crash");
    });
  });

  describe("rejected — not bounded past-context intent", () => {
    test("generic greeting", () => {
      expect(extractHistoryIntent("hello everyone")).toBeNull();
      expect(extractHistoryIntent("hey there")).toBeNull();
    });

    test("direct-address message", () => {
      expect(extractHistoryIntent("Jeannie, are you around?")).toBeNull();
      expect(extractHistoryIntent("hey Jeannie, are you around?")).toBeNull();
    });

    test("ambient chatter / mid-sentence past reference", () => {
      expect(
        extractHistoryIntent("I was talking about Jeannie yesterday"),
      ).toBeNull();
      expect(extractHistoryIntent("we talked about the report yesterday")).toBeNull();
    });

    test("shape without a topic fragment", () => {
      expect(extractHistoryIntent("what did we decide?")).toBeNull();
      expect(extractHistoryIntent("who was I talking with?")).toBeNull();
    });

    test("empty or whitespace-only content", () => {
      expect(extractHistoryIntent("")).toBeNull();
      expect(extractHistoryIntent("   ")).toBeNull();
    });
  });
});
