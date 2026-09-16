/**
 * D359 — pre_model quote-reply pointer injection.
 *
 * Verifies the wiring: when the latest human HumanMessage carries
 * `additional_kwargs.nautilo_reply_to_message_id`, pre_model injects a
 * `## Reply target` block into the assembled system prompt with the
 * integer id. The block is a lightweight POINTER — the replied-to
 * message's full body is never re-injected (pre_model has no
 * room-message-by-id read path, and the helper only emits the id).
 *
 * Mirrors the `pre-model-roster` / `pre-model-skills` test shape: zero
 * DB, deterministic given state + catalog. Inspects the first
 * `preparedMessages` entry (the SystemMessage).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { preModelNode } from "./pre-model";
import { registerAllTools } from "../tools/register-all";
import type { NautiloState } from "../agent/state";
import { MAX_SUBAGENT_DEPTH } from "../agent/state";

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

function makeState(overrides: Partial<NautiloState>): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "owner-1",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
    ...overrides,
  };
}

async function systemPromptOf(state: NautiloState): Promise<string> {
  const patch = await preModelNode(state);
  const prepared = patch.preparedMessages ?? [];
  const first = prepared[0];
  if (!first || !(first instanceof SystemMessage)) {
    throw new Error(
      `expected first prepared message to be SystemMessage, got ${first?.constructor.name ?? "undefined"}`,
    );
  }
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}

describe("preModelNode — D359 quote-reply pointer", () => {
  test("injects `## Reply target` with the id when the latest human message carries the kwarg", async () => {
    const prompt = await systemPromptOf(
      makeState({
        messages: [
          new HumanMessage("earlier turn"),
          new AIMessage("sure, here's the plan"),
          new HumanMessage({
            content: "and what about the budget?",
            additional_kwargs: { nautilo_reply_to_message_id: 4242 },
          }),
        ],
      }),
    );
    expect(prompt).toContain("## Reply target");
    expect(prompt).toContain("(#4242)");
  });

  test("no kwarg on the latest human message → no `## Reply target` block", async () => {
    const prompt = await systemPromptOf(
      makeState({
        messages: [
          new HumanMessage("earlier turn"),
          new AIMessage("sure"),
          new HumanMessage("plain follow-up with no reply fk"),
        ],
      }),
    );
    expect(prompt).not.toContain("## Reply target");
  });

  test("kwarg only on an OLDER human message (not the latest) → no block (we point at the turn being replied to, not history)", async () => {
    const prompt = await systemPromptOf(
      makeState({
        messages: [
          new HumanMessage({
            content: "earlier with a stale reply fk",
            additional_kwargs: { nautilo_reply_to_message_id: 11 },
          }),
          new AIMessage("response"),
          new HumanMessage("fresh turn with no reply fk"),
        ],
      }),
    );
    // The pointer tracks the CURRENT turn's reply target. A stale fk on
    // an older human message would be confusing context, so we only read
    // the latest human message's kwargs.
    expect(prompt).not.toContain("## Reply target");
    expect(prompt).not.toContain("(#11)");
  });

  test("non-integer / negative kwarg values are ignored (defense-in-depth; canonical guard lives in session-store.extractReplyToMessageId)", async () => {
    const cases: Array<{ raw: unknown; label: string }> = [
      { raw: 1.5, label: "float" },
      { raw: -1, label: "negative" },
      { raw: "42", label: "string" },
      { raw: null, label: "null" },
    ];
    for (const c of cases) {
      const prompt = await systemPromptOf(
        makeState({
          messages: [
            new HumanMessage({
              content: "turn",
              additional_kwargs: { nautilo_reply_to_message_id: c.raw },
            }),
          ],
        }),
      );
      expect(prompt).not.toContain("## Reply target");
    }
  });

  test("the replied-to message's full body is NOT re-injected — only the id pointer appears", async () => {
    // Simulate a quote-reply where the replied-to body would be a long
    // string the model should NOT see re-pasted by pre_model. The body
    // is in history (as an earlier AIMessage) already; pre_model must
    // not pull it into the system prompt as part of the pointer block.
    const repliedToBody = "ALL YOUR BASE ARE BELONG TO US — long body that must not be re-pasted.";
    const prompt = await systemPromptOf(
      makeState({
        messages: [
          new AIMessage(repliedToBody),
          new HumanMessage({
            content: "wait, what did you mean by that?",
            additional_kwargs: { nautilo_reply_to_message_id: 1234 },
          }),
        ],
      }),
    );
    expect(prompt).toContain("## Reply target");
    expect(prompt).toContain("(#1234)");
    // The replied-to body is in the AIMessage above (it stays in the
    // message history as-is); it must NOT leak into the SYSTEM PROMPT
    // via the pointer block. The block is bounded + id-only.
    expect(prompt).not.toContain("ALL YOUR BASE");
    expect(prompt).not.toContain("long body that must not be re-pasted");
  });

  test("guest turns skip the pointer block (no room/transcript context for a guest)", async () => {
    const prompt = await systemPromptOf(
      makeState({
        actorRole: "guest",
        messages: [
          new HumanMessage({
            content: "hello",
            additional_kwargs: { nautilo_reply_to_message_id: 5 },
          }),
        ],
      }),
    );
    // Guests have no room context; the `#<N>` pointer would be
    // meaningless. Block is owner-only, matching artifact-refs / roster.
    expect(prompt).not.toContain("## Reply target");
  });
});
