import { describe, expect, test } from "bun:test";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  ROOM_CONTEXT_MESSAGE_HEADER,
  type NautiloState,
} from "@nautilo/agent";
import {
  buildProtectedRoomHybridContext,
  buildTranscriptContext,
  type BuildTranscriptContextDeps,
} from "../../src/context/build-transcript-context";
import { buildForegroundHistoryMessages } from "../../src/context/foreground-history";
import type { RoomHistoryHit } from "../../src/conductor/history-search";
import {
  createForegroundContextRebuilder,
  ForegroundContextReceipts,
} from "../../src/executors/foreground-context-refresh";

const TRIGGER = 10;
const CURRENT_AGENT = "agent-current";
const CURRENT_EXECUTION = "execution-current";

function row(
  messageId: number,
  role: NonNullable<RoomHistoryHit["role"]>,
  snippet: string,
  overrides: Partial<RoomHistoryHit> = {},
): RoomHistoryHit {
  const sourceOrderTimestamp = new Date(messageId * 1_000).toISOString();
  return {
    messageId,
    role,
    snippet,
    ts: new Date(sourceOrderTimestamp),
    sourceOrderTimestamp,
    authorDisplayName: role === "user" ? "Human" : "Current agent",
    handle: role === "user" ? "human" : "current-agent",
    authorActorId: role === "user" ? "actor-human" : "actor-current-agent",
    ...(role === "user"
      ? {}
      : {
          authorAgentId: CURRENT_AGENT,
          foregroundExecutionId: CURRENT_EXECUTION,
        }),
    ...overrides,
  };
}

function text(messages: readonly BaseMessage[]): string {
  return messages.map((message) =>
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content)
  ).join("\n");
}

function retentionTimeline(): RoomHistoryHit[] {
  return [
    row(11, "assistant", "OWN PROGRESS BEFORE STEERING"),
    row(12, "tool", "OWN RECEIPT BEFORE STEERING"),
    row(14, "assistant", `OTHER AGENT PRESSURE ${"other ".repeat(500)}`, {
      authorAgentId: "agent-other",
      foregroundExecutionId: "execution-other",
      authorDisplayName: "Other agent",
      handle: "other-agent",
      authorActorId: "actor-other-agent",
    }),
    row(15, "user", "UNACCEPTED HUMAN OBSERVATION"),
    row(16, "user", "ACCEPTED STEERING"),
    row(17, "tool", `FORK PRESSURE ${"fork ".repeat(500)}`, {
      foregroundExecutionId: "execution-fork",
    }),
    row(18, "assistant", `LATEST OTHER AGENT PRESSURE ${"latest ".repeat(500)}`, {
      authorAgentId: "agent-other",
      foregroundExecutionId: "execution-other",
      authorDisplayName: "Other agent",
      handle: "other-agent",
      authorActorId: "actor-other-agent",
    }),
    row(19, "tool", `LATEST FORK PRESSURE ${"fork ".repeat(500)}`, {
      foregroundExecutionId: "execution-fork",
    }),
    row(20, "assistant", "OWN PROGRESS AFTER STEERING"),
  ];
}

function assertRetainedChronology(
  messages: readonly BaseMessage[],
  steering: HumanMessage,
): void {
  const rendered = text(messages);
  expect(rendered).toContain("OWN PROGRESS BEFORE STEERING");
  expect(rendered).toContain("OWN RECEIPT BEFORE STEERING");
  expect(rendered).toContain("OWN PROGRESS AFTER STEERING");
  expect(messages.some((message) =>
    HumanMessage.isInstance(message)
    && message !== steering
    && message.content === "UNACCEPTED HUMAN OBSERVATION"
  )).toBe(false);
  expect(messages.filter((message) => message === steering)).toHaveLength(1);
  expect(rendered.match(/ACCEPTED STEERING/g)).toHaveLength(1);
  expect(rendered.indexOf("OWN RECEIPT BEFORE STEERING"))
    .toBeLessThan(rendered.indexOf("ACCEPTED STEERING"));
  expect(rendered.indexOf("ACCEPTED STEERING"))
    .toBeLessThan(rendered.indexOf("OWN PROGRESS AFTER STEERING"));
  const budgetedNarrativeFragments = messages.filter((message) =>
    message.additional_kwargs["nautilo_room_context_budgeted"] === true);
  expect(budgetedNarrativeFragments.length).toBeGreaterThan(0);
  for (const fragment of budgetedNarrativeFragments) {
    expect(fragment.content).toBeString();
    expect(fragment.content as string).toStartWith(
      ROOM_CONTEXT_MESSAGE_HEADER.trimEnd(),
    );
  }
}

describe("current foreground run retention", () => {
  test("pages past oversized surrounding activity to rebuild accepted steering in order", async () => {
    const original = new HumanMessage("ORIGINAL ACCEPTED REQUEST");
    const steering = new HumanMessage("ACCEPTED STEERING");
    const hits = retentionTimeline();
    const pages = [
      hits.filter((hit) => hit.messageId >= 18),
      hits.filter((hit) => hit.messageId >= 14 && hit.messageId <= 17),
      hits.filter((hit) => hit.messageId <= 12),
    ];
    let pageCalls = 0;
    const authorizedIds: number[][] = [];
    const deps: BuildTranscriptContextDeps = {
      readRoomTranscript: async () => {
        throw new Error("refresh must use the source pager");
      },
      readRoomTranscriptSourcePage: async () => {
        const page = pages[pageCalls++] ?? [];
        const first = page[0];
        return {
          fixedPrefix: [],
          page,
          ...(pageCalls < pages.length && first !== undefined
            ? {
                nextBefore: {
                  orderTimestamp: first.sourceOrderTimestamp!,
                  messageId: first.messageId,
                },
              }
            : {}),
        };
      },
      readSubagentTranscript: async () => [],
      readRoomContextPolicy: async () => ({
        recentConversationLimit: 10,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
        passiveRecallEnabled: true,
        reflectionSleepEnabled: false,
        memoryReviewEnabled: null,
      }),
    };
    const receipts = new ForegroundContextReceipts(TRIGGER);
    receipts.recordIds([20]);
    const rebuild = createForegroundContextRebuilder({
      roomId: "room",
      ownerId: "owner",
      agentId: CURRENT_AGENT,
      receipts,
      onAuthorizedHistory: (authorized) => {
        authorizedIds.push(authorized.map((hit) => hit.messageId));
      },
    }, {
      readHistory: async (args) => {
        const { modelId: _modelId, ...historyArgs } = args;
        return buildForegroundHistoryMessages(historyArgs, deps);
      },
    });

    const rebuilt = await rebuild({
      state: {
        messages: [original, steering],
        foregroundContextRefreshSource: {
          acceptedMessages: [original, steering],
          acceptedMessageCoordinates: [{ acceptedMessageIndex: 1, messageId: 16 }],
          triggerMessageId: TRIGGER,
          throughMessageIdInclusive: 16,
          executionId: CURRENT_EXECUTION,
        },
      } as unknown as NautiloState,
      request: {
        kind: "foreground_context_refresh",
        status: "ready",
        reason: "visible_assistant_text",
        modelId: "test-model",
        maximumContextCharacters: 1_000,
        projectionFingerprint: "retention-regression",
      },
    });

    expect(Array.isArray(rebuilt)).toBe(false);
    if (Array.isArray(rebuilt)) throw new Error("expected source-aware rebuild");
    expect(pageCalls).toBe(3);
    expect(authorizedIds).toEqual([[11, 12, 14, 15, 16, 17, 18, 19, 20]]);
    expect(rebuilt.messages[0]).toBe(original);
    expect(rebuilt.messages.filter((message) => message === original)).toHaveLength(1);
    assertRetainedChronology(rebuilt.messages, steering);
  });

  test.each(["ordinary", "protected"] as const)(
    "%s builder spends the current-run envelope only on matching execution and agent rows",
    async (representation) => {
      const steering = new HumanMessage("ACCEPTED STEERING");
      const hits = retentionTimeline();
      const messages = representation === "ordinary"
        ? await buildTranscriptContext({
            scope: {
              kind: "room",
              roomId: "room",
              ownerId: "owner",
              agentId: CURRENT_AGENT,
              excludeMessageId: TRIGGER,
              throughMessageIdInclusive: 20,
              foregroundExecutionId: CURRENT_EXECUTION,
            },
            acceptedHumanMessages: [{ messageId: 16, message: steering }],
            maximumContextCharacters: 1_000,
          }, {
            readRoomTranscript: async () => hits,
            readSubagentTranscript: async () => [],
          })
        : await buildProtectedRoomHybridContext({
            hits,
            journal: { rollup: null, events: [] },
            currentHumanText: "ACCEPTED STEERING",
            activeTurnAfterMessageId: TRIGGER,
            foregroundAgentId: CURRENT_AGENT,
            foregroundExecutionId: CURRENT_EXECUTION,
            acceptedHumanMessages: [{ messageId: 16, message: steering }],
            maximumContextCharacters: 1_000,
          });

      assertRetainedChronology(messages, steering);
    },
  );

  test("does not spend the paging envelope on same-execution progress from another agent", async () => {
    const pages = [
      [row(13, "assistant", `WRONG AGENT PRESSURE ${"other ".repeat(500)}`, {
        authorAgentId: "agent-other",
        foregroundExecutionId: CURRENT_EXECUTION,
      })],
      [row(11, "assistant", "OLDER OWN PROGRESS")],
    ];
    let pageCalls = 0;
    let authorizedIds: number[] = [];
    await buildForegroundHistoryMessages({
      roomId: "room",
      transcriptOwnerId: "owner",
      agentId: CURRENT_AGENT,
      currentMessageId: TRIGGER,
      throughMessageIdInclusive: 13,
      foregroundExecutionId: CURRENT_EXECUTION,
      maximumContextCharacters: 500,
      onAuthorizedHistory: (hits) => {
        authorizedIds = hits.map((hit) => hit.messageId);
      },
    }, {
      readRoomTranscript: async () => {
        throw new Error("refresh must use the source pager");
      },
      readRoomTranscriptSourcePage: async () => {
        const page = pages[pageCalls++] ?? [];
        return pageCalls === 1
          ? {
              fixedPrefix: [],
              page,
              nextBefore: {
                orderTimestamp: page[0]!.sourceOrderTimestamp!,
                messageId: page[0]!.messageId,
              },
            }
          : { fixedPrefix: [], page };
      },
      readSubagentTranscript: async () => [],
    });

    expect(pageCalls).toBe(2);
    expect(authorizedIds).toEqual([11, 13]);
  });

  test("reads a pending accepted steering anchor after the own-run envelope is full", async () => {
    const steering = new HumanMessage("LATE ACCEPTED STEERING");
    const pages = [
      [row(13, "assistant", `OWN OVERSIZED PROGRESS ${"own ".repeat(500)}`)],
      [row(12, "user", "LATE ACCEPTED STEERING")],
    ];
    let pageCalls = 0;
    const messages = await buildForegroundHistoryMessages({
      roomId: "room",
      transcriptOwnerId: "owner",
      agentId: CURRENT_AGENT,
      currentMessageId: TRIGGER,
      throughMessageIdInclusive: 13,
      foregroundExecutionId: CURRENT_EXECUTION,
      maximumContextCharacters: 500,
      acceptedHumanMessages: [{ messageId: 12, message: steering }],
    }, {
      readRoomTranscript: async () => {
        throw new Error("refresh must use the source pager");
      },
      readRoomTranscriptSourcePage: async () => {
        const page = pages[pageCalls++] ?? [];
        return pageCalls === 1
          ? {
              fixedPrefix: [],
              page,
              nextBefore: {
                orderTimestamp: page[0]!.sourceOrderTimestamp!,
                messageId: page[0]!.messageId,
              },
            }
          : { fixedPrefix: [], page };
      },
      readSubagentTranscript: async () => [],
    });

    expect(pageCalls).toBe(2);
    expect(messages.filter((message) => message === steering)).toHaveLength(1);
  });

  test("preserves legacy envelope accounting when the run has no execution identity", async () => {
    const latest = row(13, "assistant", `LEGACY PRESSURE ${"legacy ".repeat(500)}`, {
      authorAgentId: "agent-other",
      foregroundExecutionId: "execution-other",
    });
    let pageCalls = 0;
    await buildForegroundHistoryMessages({
      roomId: "room",
      transcriptOwnerId: "owner",
      agentId: CURRENT_AGENT,
      currentMessageId: TRIGGER,
      throughMessageIdInclusive: 13,
      maximumContextCharacters: 500,
    }, {
      readRoomTranscript: async () => {
        throw new Error("refresh must use the source pager");
      },
      readRoomTranscriptSourcePage: async () => {
        pageCalls += 1;
        return pageCalls === 1
          ? {
              fixedPrefix: [],
              page: [latest],
              nextBefore: {
                orderTimestamp: latest.sourceOrderTimestamp!,
                messageId: latest.messageId,
              },
            }
          : { fixedPrefix: [], page: [row(11, "assistant", "OLDER LEGACY ROW")] };
      },
      readSubagentTranscript: async () => [],
    });

    expect(pageCalls).toBe(1);
  });
});
