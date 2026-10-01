import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import {
  acceptPublishedProtectedTaskReply,
} from "../../src/messaging/protected-task-reply-acceptance";

const db = {} as DirectDatabase;
const message = { operationId: "shared-human:reply-1", messageId: 41 };

describe("protected Task reply acceptance composition", () => {
  test("does not accept an unmatched or ambiguous protected Message", async () => {
    let accepts = 0;
    for (const status of ["no_match", "ambiguous"] as const) {
      const result = await acceptPublishedProtectedTaskReply(db, message, {
        resolve: async () => ({ status }),
        accept: async () => { accepts++; return { status: "accepted" }; },
      });
      expect(result).toBe(status);
    }
    expect(accepts).toBe(0);
  });

  test("passes the exact content-free candidate to the acceptance CAS", async () => {
    const input = { acceptance: { acceptanceId: message.operationId } } as never;
    let acceptedInput: unknown;
    const result = await acceptPublishedProtectedTaskReply(db, message, {
      resolve: async (_db, coordinate) => {
        expect(coordinate).toEqual(message);
        return { status: "resolved", input };
      },
      accept: async (_db, candidate) => {
        acceptedInput = candidate;
        return { status: "exact_replay" };
      },
    });
    expect(result).toBe("exact_replay");
    expect(acceptedInput).toBe(input);
  });

  test("preserves a stale CAS rejection for retry or inspection", async () => {
    const result = await acceptPublishedProtectedTaskReply(db, message, {
      resolve: async () => ({ status: "resolved", input: {} as never }),
      accept: async () => ({ status: "rejected", reason: "stale" }),
    });
    expect(result).toBe("stale");
  });
});
