import { describe, expect, test } from "bun:test";

import {
  InvalidMessageDeletionQuery,
  listMessageDeletionReceipts,
} from "../../src/lib/message-deletion-receipts";

describe("message deletion receipt lookup validation", () => {
  test.each([
    {},
    { roomId: "not-a-room" },
    { messageId: "0" },
    { messageId: "1.5" },
    { messageId: "42", limit: "101" },
    { messageId: "42", cursor: "not-a-cursor" },
  ])("rejects an unbounded or malformed query before touching the database", async (query) => {
    let failure: unknown;
    try {
      await listMessageDeletionReceipts(query);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvalidMessageDeletionQuery);
  });
});
