import { describe, expect, test } from "bun:test";
import { protectedTaskHumanContinuationAcceptanceId, type AcceptProtectedTaskHumanContinuationInput, type DirectDatabase } from "@nautilo/db";
import {
  acceptPublishedProtectedTaskReply,
} from "../../src/messaging/protected-task-reply-acceptance";

const db = {} as DirectDatabase;
const message = { operationId: "shared-human:reply-1", messageId: 41 };

function candidate() {
  return {
    taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "20000000-0000-4000-8000-000000000002",
    priorJobId: "30000000-0000-4000-8000-000000000003", executionSegment: 2,
    acceptance: { acceptedAt: new Date(100),
      acceptedBy: { userId: "40000000-0000-4000-8000-000000000004",
        humanActorId: "50000000-0000-4000-8000-000000000005" },
      interrupt: { kind: "await_reply", id: "interrupt:reply" },
      response: { kind: "await_reply", message: {
        roomId: "60000000-0000-4000-8000-000000000006",
        sessionId: "70000000-0000-4000-8000-000000000007",
        namespaceId: "80000000-0000-4000-8000-000000000008",
        sourceUserId: "40000000-0000-4000-8000-000000000004",
        messageId: "41", editRevision: 0, cryptoObjectId: "message:41",
      } },
    },
  } as AcceptProtectedTaskHumanContinuationInput;
}

describe("protected Task reply acceptance composition", () => {
  test("does not accept an unmatched or ambiguous protected Message", async () => {
    let accepts = 0;
    for (const status of ["no_match", "ambiguous"] as const) {
      const result = await acceptPublishedProtectedTaskReply(db, message, {
        resolve: async () => ({ status }),
        accept: async (_db, input) => { accepts++; return { status: "accepted", acceptance: input.acceptance }; },
      });
      expect(result).toBe(status);
    }
    expect(accepts).toBe(0);
  });

  test("passes the exact content-free candidate to the acceptance CAS", async () => {
    const input = candidate();
    let acceptedInput: unknown;
    const result = await acceptPublishedProtectedTaskReply(db, message, {
      resolve: async (_db, coordinate) => {
        expect(coordinate).toEqual(message);
        return { status: "resolved", input };
      },
      accept: async (_db, candidate) => {
        acceptedInput = candidate;
        return { status: "exact_replay", acceptance: candidate.acceptance };
      },
    });
    expect(result).toBe("exact_replay");
    expect(acceptedInput).toEqual({ ...input, acceptance: {
      ...input.acceptance, acceptanceId: protectedTaskHumanContinuationAcceptanceId({
        ...input, ...input.acceptance,
      }),
    } });
  });

  test("preserves a stale CAS rejection for retry or inspection", async () => {
    const result = await acceptPublishedProtectedTaskReply(db, message, {
      resolve: async () => ({ status: "resolved", input: candidate() }),
      accept: async () => ({ status: "rejected", reason: "stale" }),
    });
    expect(result).toBe("stale");
  });
});
