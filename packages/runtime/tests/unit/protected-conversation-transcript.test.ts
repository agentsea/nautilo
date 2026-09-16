import { describe, expect, test } from "bun:test";

import type {
  ActiveConversationTranscriptMessage,
  ProtectedConversationProductReadAuthorization,
} from "../../src/conversation/active-conversation-repository";
import {
  protectedTranscriptMessagesToHistoryHits,
  protectedTranscriptSearchUnavailable,
  withProtectedAgentTranscriptHistory,
} from "../../src/conversation/protected-conversation-transcript";

const PRODUCT_READ_AUTHORIZATION =
  Object.freeze({}) as ProtectedConversationProductReadAuthorization;

function transcriptMessage(
  overrides: Partial<ActiveConversationTranscriptMessage> = {},
): ActiveConversationTranscriptMessage {
  return {
    messageId: 7,
    revision: 2,
    createdAt: new Date("2026-08-03T09:10:11.000Z"),
    author: {
      actorId: "actor-alice",
      handle: "alice",
      displayName: "Alice",
    },
    payload: {
      role: "user",
      content: "private room message",
    },
    ...overrides,
  };
}

describe("protected conversation transcript context", () => {
  test("preserves reviewed routing facts while lending decrypted content", () => {
    const hits = protectedTranscriptMessagesToHistoryHits([
      transcriptMessage(),
      transcriptMessage({
        messageId: 8,
        revision: 0,
        createdAt: new Date("2026-08-03T09:10:12.000Z"),
        author: {
          actorId: "actor-genie",
          handle: "genie",
          displayName: "Genie",
        },
        payload: {
          role: "assistant",
          content: "I will inspect that.",
          toolCalls: [{
            id: "call-1",
            name: "inspect",
            args: { target: "report" },
          }],
        },
        reactions: [{ emoji: "👍", count: 2 }],
      }),
      transcriptMessage({
        messageId: 9,
        revision: 0,
        createdAt: new Date("2026-08-03T09:10:13.000Z"),
        author: {
          actorId: "actor-genie",
          handle: "genie",
          displayName: "Genie",
        },
        payload: {
          role: "tool",
          toolName: "inspect",
          content: "private tool result",
        },
      }),
    ]);

    expect(hits).toEqual([
      {
        messageId: 7,
        ts: new Date("2026-08-03T09:10:11.000Z"),
        role: "user",
        authorDisplayName: "Alice",
        handle: "alice",
        authorActorId: "actor-alice",
        snippet: "private room message",
      },
      {
        messageId: 8,
        ts: new Date("2026-08-03T09:10:12.000Z"),
        role: "assistant",
        authorDisplayName: "Genie",
        handle: "genie",
        authorActorId: "actor-genie",
        snippet: "I will inspect that.",
        reactions: [{ emoji: "👍", count: 2 }],
      },
      {
        messageId: 9,
        ts: new Date("2026-08-03T09:10:13.000Z"),
        role: "tool",
        authorDisplayName: "Genie",
        handle: "genie",
        authorActorId: "actor-genie",
        snippet: "tool:inspect private tool result",
      },
    ]);
  });

  test("does not mutate the decrypted payload or public metadata", () => {
    const message = transcriptMessage({
      payload: {
        role: "tool",
        toolName: "lookup",
        content: "result",
      },
    });
    const before = structuredClone(message);

    protectedTranscriptMessagesToHistoryHits([message]);

    expect(message).toEqual(before);
  });

  test("rejects duplicate reaction aggregates", () => {
    expect(() =>
      protectedTranscriptMessagesToHistoryHits([
        transcriptMessage({
          reactions: [
            { emoji: "👍", count: 1 },
            { emoji: "👍", count: 2 },
          ],
        }),
      ])
    ).toThrow("duplicate");
  });

  test.each([
    ["duplicate coordinate", [
      transcriptMessage(),
      transcriptMessage(),
    ]],
    ["reverse timestamp", [
      transcriptMessage({ messageId: 8 }),
      transcriptMessage({
        messageId: 9,
        createdAt: new Date("2026-08-03T09:10:10.000Z"),
      }),
    ]],
    ["reverse id at the same timestamp", [
      transcriptMessage({ messageId: 8 }),
      transcriptMessage({ messageId: 7 }),
    ]],
  ])("rejects %s instead of silently repairing repository order", (_name, input) => {
    expect(() => protectedTranscriptMessagesToHistoryHits(input)).toThrow(
      "strictly oldest-first",
    );
  });

  test.each([
    transcriptMessage({ messageId: 0 }),
    transcriptMessage({ revision: -1 }),
    transcriptMessage({ createdAt: new Date("invalid") }),
    transcriptMessage({
      author: {
        actorId: "",
        handle: "alice",
        displayName: "Alice",
      },
    }),
    transcriptMessage({
      author: {
        actorId: "actor-alice",
        handle: "",
        displayName: "Alice",
      },
    }),
    transcriptMessage({
      reactions: [{ emoji: "👍", count: 0 }],
    }),
    transcriptMessage({
      payload: {
        role: "invalid",
        content: "result",
      } as never,
    }),
  ])("rejects malformed protected transcript metadata %#", (message) => {
    expect(() => protectedTranscriptMessagesToHistoryHits([message])).toThrow();
  });

  test("reports protected transcript search as unavailable rather than no matches", () => {
    expect(protectedTranscriptSearchUnavailable()).toEqual({
      status: "unavailable",
      reason: "plaintext_fts_unavailable",
    });
  });

  test("maps transcript content only inside the repository authorization callback", async () => {
    const authorization = { opaque: "foreground-session" } as never;
    const signal = new AbortController().signal;
    let executeReturned = false;
    const result = await withProtectedAgentTranscriptHistory(
      {
        withAgentTranscript: async (input) => {
          expect(input).toMatchObject({
            sessionId: "session-1",
            namespaceId: "namespace-1",
            upToMessageId: 50,
            limit: 25,
            productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
            authorization,
            entrypointId: "foreground.main",
            signal,
          });
          const value = await input.execute([transcriptMessage()]);
          executeReturned = true;
          return { status: "executed", value };
        },
      },
      {
        sessionId: "session-1",
        namespaceId: "namespace-1",
        upToMessageId: 50,
        limit: 25,
        productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
        authorization,
        entrypointId: "foreground.main",
        signal,
        execute: (hits) => {
          expect(executeReturned).toBeFalse();
          expect(hits.map((hit) => hit.snippet)).toEqual([
            "private room message",
          ]);
          return "assembled context";
        },
      },
    );

    expect(result).toEqual({
      status: "executed",
      value: "assembled context",
    });
  });

  test("passes authorization failures through without invoking the consumer", async () => {
    let consumed = false;
    const result = await withProtectedAgentTranscriptHistory(
      {
        withAgentTranscript: async () => ({
          status: "unavailable",
          reason: "authorization_unavailable",
        }),
      },
      {
        sessionId: "session-1",
        namespaceId: "namespace-1",
        limit: 25,
        productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
        authorization: {} as never,
        entrypointId: "foreground.main",
        execute: () => {
          consumed = true;
        },
      },
    );

    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(consumed).toBeFalse();
  });

  test("rejects a repository page larger than the authorized request bound", async () => {
    const error = await withProtectedAgentTranscriptHistory(
      {
        withAgentTranscript: async (input) => ({
          status: "executed",
          value: await input.execute([
            transcriptMessage(),
            transcriptMessage({
              messageId: 8,
              createdAt: new Date("2026-08-03T09:10:12.000Z"),
            }),
          ]),
        }),
      },
      {
        sessionId: "session-1",
        namespaceId: "namespace-1",
        limit: 1,
        productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
        authorization: {} as never,
        entrypointId: "foreground.main",
        execute: () => "must not run",
      },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "exceeded the requested limit",
    );
  });

  test.each([0, 5_001, 1.5])(
    "rejects an invalid protected transcript limit %p before repository access",
    async (limit) => {
      let called = false;
      const error = await withProtectedAgentTranscriptHistory(
        {
          withAgentTranscript: async () => {
            called = true;
            return { status: "unavailable", reason: "content_unavailable" };
          },
        },
        {
          sessionId: "session-1",
          namespaceId: "namespace-1",
          limit,
          productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
          authorization: {} as never,
          entrypointId: "foreground.main",
          execute: () => undefined,
        },
      ).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("limit is out of bounds");
      expect(called).toBeFalse();
    },
  );
});
