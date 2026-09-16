import { describe, expect, test } from "bun:test";
import {
  CLAUDE_EXECUTION_MAX_FRAME_BYTES,
  CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES,
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  parseRelayClaudeExecutionCommand,
  parseRelayClaudeExecutionDesktopEvent,
  parseRelayClaudeExecutionJsonFrame,
} from "../../src/index";

const scope = {
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-session-1",
  pairingGenerationRef: "pairing-1",
  selectedProtocolVersion: CLAUDE_EXECUTION_PROTOCOL_VERSION,
  capabilityRevision: 2,
};
const executionRef = "execution-1";

const command = {
  type: "relay:claude-execution-command",
  scope,
  executionRef,
  action: { kind: "start", prompt: "Summarize this repository", model: "claude-fable-5" },
} as const;

const question = {
  kind: "question",
  interactionRef: "interaction-1",
  questions: [{
    questionRef: "question-1",
    header: "Confirm",
    text: "Which change should be applied?",
    multiSelect: true,
    allowOther: true,
    options: [
      { optionRef: "option-1", label: "First", description: "First safe choice" },
      { optionRef: "option-2", label: "Second", description: "Second safe choice" },
    ],
  }],
};

function event(event: unknown) {
  return { type: "relay:claude-execution-event", scope, executionRef, event };
}

describe("D452 Claude execution v18 protocol", () => {
  test("permission detail is strictly parsed only on v20 peers and remains frame bounded", () => {
    const frame = { type: "relay:claude-execution-event", executionRef, event: { kind: "interaction", interaction: { kind: "permission", interactionRef: "permission", toolName: "Bash", allowSession: false, detail: { state: "shown", text: "Bash\nnode --test" } } }, scope: { ...scope, selectedProtocolVersion: 20 } } as const;
    expect(parseRelayClaudeExecutionDesktopEvent(frame)).toEqual(frame);
    expect(parseRelayClaudeExecutionDesktopEvent({ ...frame, scope })).toBeNull();
    let getters = 0;
    expect(parseRelayClaudeExecutionDesktopEvent({ ...frame, event: { kind: "interaction", interaction: { ...frame.event.interaction, detail: { state: "shown", get text() { getters++; return "private"; } } } } })).toBeNull();
    expect(getters).toBe(0);
    for (const detail of [{ state: "shown", text: "bad\ud800" }, { state: "shown", text: "a".repeat(CLAUDE_EXECUTION_MAX_FRAME_BYTES) }, { state: "shown", text: "okay", extra: true }]) {
      expect(parseRelayClaudeExecutionDesktopEvent({ ...frame, event: { kind: "interaction", interaction: { ...frame.event.interaction, detail } } })).toBeNull();
    }
  });
  test("canonicalizes all command actions and bounded Desktop event families", () => {
    const parsedCommand = parseRelayClaudeExecutionCommand(command);
    expect(parsedCommand).not.toBeNull();
    expect(Object.isFrozen(parsedCommand)).toBe(true);
    expect(Object.isFrozen(parsedCommand?.scope)).toBe(true);
    expect(parseRelayClaudeExecutionCommand({
      ...command,
      action: {
        kind: "respond",
        interactionRef: "interaction-1",
        response: { kind: "answers", answers: { "question-1": ["option-1", "A local alternative"] } },
      },
    })).not.toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, action: { kind: "interrupt" } })).not.toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, action: { kind: "steer", steerRef: "steer-1", prompt: "Change direction" } })).not.toBeNull();

    const families = [
      { kind: "started" },
      { kind: "unavailable" },
      { kind: "activity", activity: "setup", state: "started" },
      { kind: "activity", activity: "tool", state: "progress", toolName: "Edit" },
      { kind: "initialized", claudeCodeVersion: "2.1.235", servingModel: "claude-fable-5" },
      { kind: "output_delta", text: "Hello\nworld" },
      { kind: "result", outcome: "success", text: null },
      { kind: "result", outcome: "failed", text: null },
      { kind: "result", outcome: "interrupted", text: null },
      { kind: "settled", outcome: "eof" },
      { kind: "settled", outcome: "rejected" },
      { kind: "interaction", interaction: { kind: "permission", interactionRef: "permission-1", toolName: "Edit", allowSession: false } },
      { kind: "interaction", interaction: question },
      { kind: "interaction_accepted", interactionRef: "interaction-1" },
      { kind: "interaction_rejected", interactionRef: "interaction-1" },
      { kind: "steer_receipt", steerRef: "steer-1", outcome: "accepted" },
      { kind: "steer_receipt", steerRef: "steer-1", outcome: "rejected" },
      { kind: "interrupt_receipt", outcome: "acknowledged" },
      { kind: "interrupt_receipt", outcome: "uncertain" },
    ];
    for (const family of families) {
      const parsed = parseRelayClaudeExecutionDesktopEvent(event(family));
      expect(parsed).not.toBeNull();
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed?.scope)).toBe(true);
      expect(Object.isFrozen(parsed?.event)).toBe(true);
    }
  });

  test("rejects wrong scope/version, cross-family secrets, and malformed interaction algebra", () => {
    expect(parseRelayClaudeExecutionCommand({ ...command, scope: { ...scope, selectedProtocolVersion: 17 } })).toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, taskId: "not-on-this-wire" })).toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, action: { kind: "start", prompt: "x", model: "m", path: "/private" } })).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "activity", activity: "setup", state: "started", toolName: "Edit" }))).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "interaction", interaction: { ...question, questions: [] } }))).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "result", outcome: "success", text: "private duplicate" }))).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "result", outcome: "failed", text: "private diagnostic" }))).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "output_delta", text: "x".repeat(CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES + 1) }))).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "output_delta", text: "private\u0001" }))).toBeNull();
    expect(parseRelayClaudeExecutionCommand({
      ...command,
      action: { kind: "respond", interactionRef: "interaction-1", response: { kind: "allow_session" } },
    })).toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, action: { kind: "steer", steerRef: "steer-1", prompt: "x".repeat(16 * 1024 + 1) } })).toBeNull();
    expect(parseRelayClaudeExecutionDesktopEvent(event({ kind: "steer_receipt", steerRef: "steer-1", outcome: "accepted", detail: "private" }))).toBeNull();
  });

  test("keeps the maximum escaped delta inside the v18 frame budget", () => {
    const parsed = parseRelayClaudeExecutionDesktopEvent(event({
      kind: "output_delta",
      text: "\n".repeat(CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES),
    }));
    expect(parsed).not.toBeNull();
  });

  test("rejects accessors, prototypes, symbols, mutation, and oversized raw frames", () => {
    let reads = 0;
    const hostile: object = {};
    Object.defineProperty(hostile, "type", {
      enumerable: true,
      get: () => { reads++; return command.type; },
    });
    expect(parseRelayClaudeExecutionCommand(hostile)).toBeNull();
    expect(reads).toBe(0);
    expect(parseRelayClaudeExecutionCommand(Object.assign(Object.create(null), command))).toBeNull();
    expect(parseRelayClaudeExecutionCommand({ ...command, [Symbol("private")]: "no" })).toBeNull();

    const parsed = parseRelayClaudeExecutionDesktopEvent(event({ kind: "interaction", interaction: question }));
    if (parsed === null) throw new Error("missing parsed question event");
    question.questions[0]!.options[0]!.label = "mutated";
    if (parsed.event.kind !== "interaction" || parsed.event.interaction.kind !== "question") throw new Error("missing parsed question interaction");
    expect(parsed.event.interaction.questions[0]!.options[0]!.label).toBe("First");

    const raw = `${JSON.stringify(command)}${" ".repeat(CLAUDE_EXECUTION_MAX_FRAME_BYTES)}`;
    expect(parseRelayClaudeExecutionJsonFrame(raw, "server").ok).toBe(false);
    expect(parseRelayClaudeExecutionJsonFrame(JSON.stringify(command), "client").ok).toBe(false);
  });
});
