import { expect, test } from "bun:test";
import { HumanMessage, SystemMessage, mapStoredMessagesToChatMessages, type BaseMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ROOM_CONTEXT_MESSAGE_HEADER, type NautiloState } from "@nautilo/agent";
import { processHistory } from "../../../agent/src/utils/history-manager";
import { projectNativeRoomHistory } from "../../../agent/src/tools/computer/native-history";
import { buildTranscriptContext, buildProtectedRoomHybridContext, buildBudgetedRoomContext } from "../../src/context/build-transcript-context";
import { createNativeRoomHistoryPort, bindNativeRoomHistoryPort } from "../../src/context/native-room-history";
import type { RoomHistoryHit } from "../../src/conductor/history-search";
import { formatTranscriptLine } from "../../src/conductor/transcript-format";
import { computerMutationReceiptSchema, windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";

const journal = { rollup: null, events: [] };
function hit(messageId: number, role: NonNullable<RoomHistoryHit["role"]>, snippet: string): RoomHistoryHit {
  return { messageId, role, snippet, ts: new Date("2026-01-01T00:00:00Z"),
    authorActorId: "fixture-author", authorDisplayName: "Fixture", handle: "fixture" };
}
function observation(id = 2): RoomHistoryHit {
  return { ...hit(id, "tool", JSON.stringify({ version: 1, ok: true, settlement: "completed",
    presentation: { label: "Observe", summary: `Observed fixture ${id}` },
    result: { version: 1, operation: "window_state",
      target: { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` },
      evidence: { kind: "window", appLabel: "Fixture", windowLabel: "Draft" }, completeness: "partial", degraded: false,
      verification: "indeterminate", outcome: { version: 1, phase: "observe", retrySafety: "never",
        stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] },
      controlCollection: { completeness: "partial", received: 200, omitted: 0,
        controls: Array.from({ length: 200 }, (_, n) => ({ id: `c${n}`, role: "text_area", label: `Field ${n}`,
          state: { completeness: "partial", value: `Exact\n日本語  ${n}` } })) },
    } })), toolEvidence: { name: "computer_observe", callId: `call-${id}`, status: "success" } };
}
function message(body: string) {
  return new HumanMessage({ content: body, additional_kwargs: { nautilo_transient_context: true, nautilo_room_context_budgeted: true } });
}
function ref(body: string): string {
  return /"historyRoomRef":"([^"]+)"/.exec(body)![1]!;
}
const config = { validationEnabled: true, pruningEnabled: true, tokenBudgetFraction: 0.9,
  windowKeepRecent: 100, modelId: "openai:gpt-5.6-sol" };
function bodyFor(hits: RoomHistoryHit[]) {
  return ROOM_CONTEXT_MESSAGE_HEADER + hits.map(h => formatTranscriptLine({ displayName: h.authorDisplayName,
    handle: h.handle, ts: h.ts, content: h.snippet })).join("\n");
}

test("finished Room selection and canonical checkpoint stay exact; model copy is smaller and evidence recoverable", async () => {
  const hits = [hit(1, "user", "Inspect the fixture"), observation(), hit(3, "assistant", "Inspection complete")];
  const opts = { scope: { kind: "room" as const, roomId: "room", ownerId: "owner" } };
  const deps = { readRoomTranscript: async () => hits, readSubagentTranscript: async () => [] };
  const baseline = await buildTranscriptContext(opts, deps);
  let port: ReturnType<typeof createNativeRoomHistoryPort> | undefined;
  const actual = await buildTranscriptContext({ ...opts, onRoomContextBuilt: (body, rows) => { port = createNativeRoomHistoryPort(body, rows); } }, deps);
  expect(actual.map(m => m.toDict())).toEqual(baseline.map(m => m.toDict()));
  const original = JSON.stringify(actual);
  const prepared = processHistory(actual, config).messages;
  const view = projectNativeRoomHistory(prepared, port);
  expect(JSON.stringify(view).length).toBeLessThan(original.length);
  expect(JSON.stringify(prepared)).toBe(original);
  expect(JSON.stringify(actual)).toBe(original);
  const read = port!.read(ref(view[0]!.content as string))!;
  const payload = JSON.parse(read.text) as { observation: unknown };
  expect(windowStateObservationSchema.parse(payload.observation).controlCollection!.controls[199]!.state.value).toBe("Exact\n日本語  199");
  expect(read.text).toContain("not a fresh observation");
  expect(port!.read("another-room-reference")).toBeNull();
  expect(projectNativeRoomHistory(prepared, port).map(m => m.content)).toEqual(view.map(m => m.content));
});

test("saved bytes never refill Room selection or resurrect a truncated row", () => {
  const hits = [hit(1, "user", "old human ".repeat(10_000)), observation(2), hit(3, "assistant", "old done"),
    hit(4, "user", "new human"), observation(5), hit(6, "assistant", "new done")];
  const body = buildBudgetedRoomContext({ journal, hits, modelContextTokens: 40_000, minimumFullTurns: 1 })!;
  expect(body).not.toContain("old human");
  expect(body).toContain("new done");
  const port = createNativeRoomHistoryPort(body, hits);
  const projected = port.project(message(body))!;
  expect(projected).not.toContain("old human");
  expect(projected.match(/historyRoomRef/g)).toHaveLength(1);
  expect(projected).toContain("new human");
  expect(projected).toContain("new done");
  const truncated = bodyFor([observation()]).slice(0, 2000);
  expect(createNativeRoomHistoryPort(truncated, [observation()]).project(message(truncated))).toBeNull();
});

test("missing/forged source provenance and uncertain action turns stay unchanged", () => {
  const noMetadata = { ...observation(), toolEvidence: undefined } as unknown as RoomHistoryHit;
  const forged = { ...observation(), role: "user" as const };
  const unknown = { ...observation(), snippet: "unrecognized provider result" };
  for (const candidate of [noMetadata, forged, unknown]) {
    const body = bodyFor([candidate]);
    expect(createNativeRoomHistoryPort(body, [candidate]).project(message(body))).toBeNull();
  }
  const failed = { ...hit(3, "tool", '{"settlement":"unknown_completion"}'),
    toolEvidence: { name: "computer_do", callId: "write", status: "error" as const } };
  const hits = [hit(1, "user", "Write once"), observation(), failed];
  const body = bodyFor(hits);
  expect(createNativeRoomHistoryPort(body, hits).project(message(body))).toBeNull();
  expect(createNativeRoomHistoryPort(bodyFor([observation(), observation()]), [observation(), observation()])
    .project(message(bodyFor([observation(), observation()])))).toBeNull();
  const identical = [observation(), { ...observation(), messageId: 5 }];
  const singleBody = bodyFor([identical[1]!, hit(6, "assistant", "Keep this conclusion")]);
  expect(createNativeRoomHistoryPort(singleBody, identical).project(message(singleBody))).toBeNull();
});

test("checked non-delivery permits a model-only Room projection without dropping the failed receipt", () => {
  const result = computerMutationReceiptSchema.parse({ version: 1, timing: "immediate", action: "click",
    target: { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `detgt_${"b".repeat(43)}` },
    resolvedTarget: { kind: "element", role: "menu_item", action: "click" }, provider: "cua",
    deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable", providerAction: null,
    unexecutedRemainder: { count: 1, reason: "failed" }, outcome: { version: 1, phase: "pre_effect_dispatch",
      retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready",
      targetCondition: "stale", recovery: ["observe_again"] } });
  const refused = { ...hit(3, "tool", JSON.stringify({ version: 1, ok: false, settlement: "not_completed", result })),
    toolEvidence: { name: "computer_do", callId: "refused", status: "success" as const } };
  const hits = [hit(1, "user", "Use the fixture"), observation(), refused];
  const body = bodyFor(hits);
  const original = JSON.stringify(hits);
  const port = createNativeRoomHistoryPort(body, hits);
  const projected = port.project(message(body))!;
  expect(projected).not.toBeNull();
  expect(projected.length).toBeLessThan(body.length);
  expect(projected).toContain(refused.snippet);
  expect(port.read(ref(projected))!.text).toContain("Field 199");
  expect(JSON.stringify(hits)).toBe(original);
  for (const changed of [{ ...result, completionCertainty: "unknown_completion" },
    { ...result, deliveryMode: "background" }, { ...result, outcome: { ...result.outcome, stateChangeCertainty: "unknown" } }, {}]) {
    const uncertain = [...hits.slice(0, -1), { ...refused, snippet: JSON.stringify({ settlement: "not_completed", result: changed }) }];
    const uncertainBody = bodyFor(uncertain);
    expect(createNativeRoomHistoryPort(uncertainBody, uncertain).project(message(uncertainBody))).toBeNull();
  }
});

test("invocation identity and cancellation fence reads; missing restart port restores full canonical history", () => {
  const hits = [observation()]; const body = bodyFor(hits); const controller = new AbortController();
  const port = createNativeRoomHistoryPort(body, hits, controller.signal);
  const binding = { userId: "owner", agentId: "genie", roomId: "room", turnId: "turn" };
  const state = { ...binding, trustedExecutionEntrypoint: "foreground.main" } as NautiloState;
  const factory = bindNativeRoomHistoryPort(port, binding);
  expect(factory(state)).toBe(port);
  for (const patch of [{ userId: "other" }, { agentId: "other" }, { roomId: "other" }, { turnId: "other" }, { taskRun: true }, { subagentRun: true }]) {
    expect(factory({ ...state, ...patch })).toBeUndefined();
  }
  const prepared = processHistory([message(body)], config).messages;
  const view = projectNativeRoomHistory(prepared, port);
  const reference = ref(view[0]!.content as string);
  const restored = mapStoredMessagesToChatMessages(prepared.map(m => m.toDict()));
  expect(projectNativeRoomHistory(restored)[0]!.content).toBe(body);
  controller.abort();
  expect(port.read(reference)).toBeNull();
  expect(port.project(message(body))).toBeNull();
  port.close();
  expect(port.read(reference)).toBeNull();
});

test("protected builder uses only supplied authorized rows and never requires an ordinary reader", async () => {
  const hits = [hit(1, "user", "Protected request"), observation()];
  let port: ReturnType<typeof createNativeRoomHistoryPort> | undefined;
  const result = await buildProtectedRoomHybridContext({ hits, journal, currentHumanText: "Continue",
    onRoomContextBuilt: (body, rows) => { expect(rows).toEqual(hits); port = createNativeRoomHistoryPort(body, rows); } });
  expect(port!.project(result[0]!)).not.toBeNull();
  expect(result[0]!.content).toContain("Field 199");
});

test("Anthropic wire gets the smaller Room copy with an identical cache-marked system prefix", async () => {
  const body = bodyFor([observation()]);
  const port = createNativeRoomHistoryPort(body, [observation()]);
  const original = message(body);
  const projected = projectNativeRoomHistory([original], port);
  const system = new SystemMessage({ content: [{ type: "text", text: "Stable instructions", cache_control: { type: "ephemeral" } }] });
  const model = new ChatAnthropic({ model: "claude-sonnet-4-6", apiKey: "synthetic-test-only", streaming: false, maxRetries: 0 });
  const requests: Array<Record<string, unknown>> = [];
  Object.defineProperty(model, "completionWithRetry", { value: async (request: Record<string, unknown>) => {
    requests.push(request);
    return { id: "reply", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Done" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  } });
  const invoke = (messages: BaseMessage[]) => model.invoke([system, ...messages, new HumanMessage("Continue")]);
  await invoke([original]); await invoke(projected);
  expect(requests[0]!["system"]).toEqual(requests[1]!["system"]);
  expect(JSON.stringify(requests[1]!["system"])).toContain("cache_control");
  expect(JSON.stringify(requests[1]!["messages"]).length).toBeLessThan(JSON.stringify(requests[0]!["messages"]).length);
  expect(original.content).toBe(body);
});
