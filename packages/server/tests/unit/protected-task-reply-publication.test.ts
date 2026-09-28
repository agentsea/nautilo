import { describe, expect, test } from "bun:test";
import {
  notifyProtectedTaskReplyAfterSharedAgentPublication,
} from "../../src/routes/live-shadow-message-composition";

describe("protected Task reply publication boundary", () => {
  const message = { operationId: "shared-human:reply-1", messageId: 41 };

  test("passes only immutable Message coordinates after publication or replay", async () => {
    const seen: unknown[] = [];
    const accept = async (input: unknown) => { seen.push(input); };

    await notifyProtectedTaskReplyAfterSharedAgentPublication(
      "published", message, accept,
    );
    await notifyProtectedTaskReplyAfterSharedAgentPublication(
      "replayed", message, accept,
    );

    expect(seen).toEqual([message, message]);
    expect(seen[0]).not.toBe(message);
  });

  test("never accepts a conflicted publication", async () => {
    let calls = 0;
    await notifyProtectedTaskReplyAfterSharedAgentPublication(
      "conflict", message, async () => { calls++; },
    );
    expect(calls).toBe(0);
  });

  test("a Task acceptance failure cannot reverse a published Human send", async () => {
    await notifyProtectedTaskReplyAfterSharedAgentPublication(
      "published", message, async () => { throw new Error("store unavailable"); },
    );
  });
});
