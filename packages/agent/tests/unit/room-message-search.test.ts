import { describe, expect, test } from "bun:test";
import { sql, type SQL } from "@nautilo/db";
import {
  normalizeRoomMessageSearchQuery,
  queryRoomMessageContentIndex,
  roomMessageCasePredicate,
  roomMessageSearchTsquery,
  type RoomMessageSearchDb,
} from "../../src/store/room-message-search";

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  const record = value as Record<string, unknown>;
  if (typeof record["value"] === "string") into.push(record["value"]);
  if (Array.isArray(record["value"])) {
    for (const item of record["value"]) collectStrings(item, into);
  }
  const chunks = record["queryChunks"];
  if (Array.isArray(chunks)) for (const chunk of chunks) collectStrings(chunk, into);
  return into;
}

function sqlText(query: SQL): string {
  return collectStrings(query).join(" ");
}

function fakeDb(rows: readonly Record<string, unknown>[], seen: SQL[]): RoomMessageSearchDb {
  return {
    async execute(query) {
      seen.push(query);
      return rows;
    },
  };
}

describe("normalizeRoomMessageSearchQuery", () => {
  test("case-folds English tokens while preserving accented Unicode lexemes", () => {
    expect(normalizeRoomMessageSearchQuery("  Launching CAFÉ plans  ")).toEqual({
      ok: true,
      query: {
        terms: ["launching", "café", "plans"],
        caseTerms: ["Launching", "CAFÉ", "plans"],
        wholeText: "Launching CAFÉ plans",
        pathPrefix: null,
      },
    });
  });

  test("rejects empty, punctuation-only, overlong, and over-term inputs", () => {
    expect(normalizeRoomMessageSearchQuery("   ")).toMatchObject({ ok: false, error: { code: "empty" } });
    expect(normalizeRoomMessageSearchQuery("!@#$%^&*()")).toMatchObject({
      ok: false,
      error: { code: "empty" },
    });
    expect(normalizeRoomMessageSearchQuery("a".repeat(257))).toMatchObject({
      ok: false,
      error: { code: "too_long" },
    });
    expect(normalizeRoomMessageSearchQuery(Array.from({ length: 17 }, (_, i) => `t${i}`).join(" "))).toMatchObject({
      ok: false,
      error: { code: "too_many_terms" },
    });
  });
});

describe("queryRoomMessageContentIndex", () => {
  test("builds a parameterized original-case residual without replacing indexed FTS", () => {
    const normalized = normalizeRoomMessageSearchQuery("Dark Stock");
    if (!normalized.ok) throw new Error("expected valid query");
    const whole = sqlText(roomMessageCasePredicate("whole", normalized.query));
    const prefix = sqlText(roomMessageCasePredicate("prefix", normalized.query));
    expect(whole).toContain("sm.content ~");
    expect(whole).toContain("Dark");
    expect(whole).toContain("Stock");
    expect(whole).toContain("[:alnum:]_");
    expect(prefix).toContain("Dark");
    expect(prefix).not.toContain("Dark($|");
  });

  test("uses parameterized whole-token FTS over content_search", async () => {
    const seen: SQL[] = [];
    const result = await queryRoomMessageContentIndex<{ message_id: number; content: string }>(
      fakeDb([{ message_id: 7, content: "The launching plan is ready." }], seen),
      {
        roomId: "room-1",
        query: "Launching plan",
        mode: "whole",
        limit: 99,
        visibilityPredicate: sql`AND sm.role IN ('user', 'assistant', 'tool')`,
      },
    );

    expect(result).toMatchObject({ ok: true, rows: [{ message_id: 7, content: "The launching plan is ready." }] });
    const text = sqlText(seen[0]!);
    expect(text).toContain("sm.content_search @@");
    expect(text).toContain("plainto_tsquery('english'");
    expect(text).toContain("Launching plan");
    expect(text).not.toContain("tool_calls");
    expect(text).toContain("LIMIT");
  });

  test("prefixes each normalized term, ANDs them, and cannot admit tsquery operators", async () => {
    const seen: SQL[] = [];
    await queryRoomMessageContentIndex(
      fakeDb([], seen),
      {
        roomId: "room-1",
        query: "Launch plans",
        mode: "prefix",
        limit: 4,
        visibilityPredicate: sql``,
      },
    );
    expect(sqlText(seen[0]!)).toContain("'launch':* & 'plans':*");

    const injectedSeen: SQL[] = [];
    await queryRoomMessageContentIndex(
      fakeDb([], injectedSeen),
      {
        roomId: "room-1",
        query: "launch':* | everything & !hidden",
        mode: "prefix",
        limit: 4,
        visibilityPredicate: sql``,
      },
    );
    const injectedText = sqlText(injectedSeen[0]!);
    expect(injectedText).toContain("'launch':* & 'everything':* & 'hidden':*");
    expect(injectedText).not.toContain(" | ");
    expect(injectedText).not.toContain("!");
  });

  test("preserves a safe slash-delimited path as one indexed prefix lexeme", async () => {
    const absolute = normalizeRoomMessageSearchQuery("/Users/w");
    if (!absolute.ok) throw new Error("expected valid path query");
    expect(absolute.query.pathPrefix).toBe("/users/w");
    expect(sqlText(roomMessageSearchTsquery("prefix", absolute.query))).toContain("'/users/w':*");

    const relative = normalizeRoomMessageSearchQuery("Users/w");
    if (!relative.ok) throw new Error("expected valid path query");
    const relativeSql = sqlText(roomMessageSearchTsquery("prefix", relative.query));
    expect(relativeSql).toContain("'users/w':* | '/users/w':*");
  });

  test("returns validation errors without executing the database", async () => {
    const seen: SQL[] = [];
    const result = await queryRoomMessageContentIndex(fakeDb([], seen), {
      roomId: "room-1",
      query: "---",
      mode: "prefix",
      limit: 4,
      visibilityPredicate: sql``,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "empty" } });
    expect(seen).toHaveLength(0);
  });

  test("preserves trimmed punctuation and accents for whole mode while prefix remains operator-free", async () => {
    const input = "  O'Reilly’s CAFÉ -- launch:* | plan  ";
    const wholeSeen: SQL[] = [];
    await queryRoomMessageContentIndex(fakeDb([], wholeSeen), {
      roomId: "room-1",
      query: input,
      mode: "whole",
      limit: 4,
      visibilityPredicate: sql``,
    });
    expect(sqlText(wholeSeen[0]!)).toContain("O'Reilly’s CAFÉ -- launch:* | plan");

    const prefixSeen: SQL[] = [];
    await queryRoomMessageContentIndex(fakeDb([], prefixSeen), {
      roomId: "room-1",
      query: input,
      mode: "prefix",
      limit: 4,
      visibilityPredicate: sql``,
    });
    const prefixText = sqlText(prefixSeen[0]!);
    expect(prefixText).toContain("'o':* & 'reilly':* & 's':* & 'café':* & 'launch':* & 'plan':*");
    expect(prefixText).not.toContain(" | ");
  });
});
