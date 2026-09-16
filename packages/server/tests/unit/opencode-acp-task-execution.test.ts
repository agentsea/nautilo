import { describe, expect, test } from "bun:test";
import { ACP_TOTAL_TEARDOWN_TIMEOUT_MS, OPENCODE_ACP_INITIALIZE_TIMEOUT_MS } from "@nautilo/acp-host";
import { OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS, type DelegatedTaskFailureReceipt, type TaskExecutionRouteFacts } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { OPENCODE_ACP_RELAY_PROTOCOL_VERSION, type AcpExecutionScope, type AcpProcessScope, type RelayAcpSemanticEvent, type RelayAcpTerminalEvent } from "@nautilo/relay";
import { ACP_EXECUTION_FAILED } from "../../src/acp/task-run-lifecycle";
import { OpenCodeAcpTaskExecutionFailure, OpenCodeAcpTaskExecutionRouteSelector, parseOpenCodeAcpExecutionMetadata, type OpenCodeAcpTaskExecutionDeps } from "../../src/acp/opencode-task-execution";

const facts: TaskExecutionRouteFacts = { taskId: "task", taskRunId: "run", parentTaskId: null, ownerId: "owner", requestorId: "owner", agentId: "agent", roomId: "room", laneKey: "lane", graphThreadId: "graph" };
const readiness = { relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pair", desktopSessionId: "desktop", selectedProtocolVersion: OPENCODE_ACP_RELAY_PROTOCOL_VERSION, capabilityRevision: 1 };
const metadata = { execution: { version: 1, harnessId: "opencode-acp", source: "genie", executionProfile: "autonomous", readiness } } as const;
const process: AcpProcessScope = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
type Event = RelayAcpSemanticEvent | RelayAcpTerminalEvent;
type Stage = "readiness" | "prepare" | "start" | "next" | "assert" | "projector" | "complete" | "fail";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function observed(calls: readonly string[], call: string) { for (let i = 0; i < 100 && !calls.includes(call); i += 1) await new Promise<void>((done) => setTimeout(done, 1)); expect(calls).toContain(call); }
function task(overrides: Record<string, unknown> = {}) { return { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", parentTaskId: null, targetRoomId: "room", prompt: "answer this", metadata, ...overrides }; }
function session(overrides: Record<string, unknown> = {}) { return { ...readiness, userId: "owner", ...overrides }; }
function started(scope: AcpExecutionScope, overrides: Record<string, unknown> = {}) { return { type: "relay:acp-started" as const, registrationId: "opencode-acp" as const, scope, process, capabilities: { requests: "unsupported" as const }, eventId: "started", eventSequence: 1, ...overrides }; }
function semantic(scope: AcpExecutionScope, payload: RelayAcpSemanticEvent["payload"], overrides: Record<string, unknown> = {}): Event { return { type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, payload, eventId: "semantic", eventSequence: 2, ...overrides } as Event; }
function terminal(scope: AcpExecutionScope, status: "completed" | "failed" | "interrupted" = "completed"): Event { return { type: "relay:acp-terminal", registrationId: "opencode-acp", scope, process, status, ...(status === "failed" ? { code: "upstream_failure" as const } : status === "interrupted" ? { code: "user_stop" as const } : {}), eventId: "terminal", eventSequence: 3 }; }
function completed(scope: AcpExecutionScope): readonly Event[] { return [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "answer" }), terminal(scope)]; }

function build(input: Partial<{ events: (scope: AcpExecutionScope) => readonly Event[]; stage: Stage; reloadAt: number; subscribeNull: boolean; nextNever: boolean; dropRelayAt: "start" | "next"; started: (scope: AcpExecutionScope) => ReturnType<typeof started>; startFailureAfter: "accepted" | "launch_admitted" | "initialized" | "session_started" | "prompt_admitted"; relayFailures: Partial<Record<"readiness" | "prepare" | "start", string>>; readinessState: "ready" | "missing" | "incompatible" | "authentication_required" | "unavailable"; projected: readonly ServerEvent[] | null; projectorThrows: boolean; completeThrows: boolean; failThrows: boolean; containThrows: boolean; closeThrows: boolean; assertThrows: boolean; assertThrowsAt: number; sessions: readonly ReturnType<typeof session>[]; roomExists: boolean; agentOwner: string | null; member: boolean; taskMissing: boolean; selectionReject: "task" | "room" | "agent_owner" | "membership" | "relay_snapshot" | "relay_lookup" }> = {}) {
  const calls: string[] = []; const registrations: string[] = []; const failures: DelegatedTaskFailureReceipt[] = []; const gate = deferred<void>(); let cursor = 0; let taskReads = 0; let assertions = 0; let scope: AcpExecutionScope | null = null; let startTimeoutMs: number | undefined; let currentTask = task(); let currentSessions = input.sessions ?? [session()]; let authorized = true; let pauseUsed = false;
  const pause = async (stage: Stage) => { if (input.stage === stage && !pauseUsed) { pauseUsed = true; calls.push(`pending:${stage}`); await gate.promise; } };
  const deps: OpenCodeAcpTaskExecutionDeps = {
    tasks: { getTask: async () => { taskReads += 1; if (input.selectionReject === "task") throw new Error("private task failure"); if (input.reloadAt === taskReads) { calls.push("pending:reload"); await gate.promise; } return input.taskMissing ? null : currentTask; } },
    facts: {
      roomExists: async () => { if (input.selectionReject === "room") throw new Error("private room failure"); return authorized && (input.roomExists ?? true); },
      getAgentOwner: async () => { if (input.selectionReject === "agent_owner") throw new Error("private owner failure"); return authorized ? (input.agentOwner === undefined ? "owner" : input.agentOwner) : "other"; },
      isAgentMember: async () => { if (input.selectionReject === "membership") throw new Error("private membership failure"); return authorized && (input.member ?? true); },
    },
    relay: {
      listConnected: async () => { if (input.selectionReject === "relay_snapshot") throw new Error("private relay failure"); return currentSessions.map((item) => item.relayId); }, getAcpSessionForRegistration: (id, _userId, registrationId) => { if (input.selectionReject === "relay_lookup") throw new Error("private lookup failure"); registrations.push(`lookup:${registrationId}`); return currentSessions.find((item) => item.relayId === id) ?? null; },
      requestAcpReadiness: async ({ registrationId }) => { registrations.push(`readiness:${registrationId}`); calls.push("readiness"); await pause("readiness"); if (input.relayFailures?.readiness) throw new Error(input.relayFailures.readiness); return input.readinessState ?? "ready"; },
      requestAcpPrepare: async ({ registrationId }) => { registrations.push(`prepare:${registrationId}`); calls.push("prepare"); await pause("prepare"); if (input.relayFailures?.prepare) throw new Error(input.relayFailures.prepare); return { workspaceReceiptId: "workspace", workspaceRevision: "1", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2099-01-01T00:00:00.000Z" }; },
      requestAcpStart: async ({ scope: received, registrationId, executionProfile, timeoutMs }) => { registrations.push(`start:${registrationId}:${executionProfile}`); calls.push("start"); scope = received; startTimeoutMs = timeoutMs; await pause("start"); if (input.startFailureAfter) throw Object.assign(new Error("ACP_START_FAILED"), { acpStartFailureStage: input.startFailureAfter }); if (input.relayFailures?.start) throw new Error(input.relayFailures.start); if (input.dropRelayAt === "start") currentSessions = []; return input.started?.(received) ?? started(received); },
      subscribeAcpExecution: (_scope, _process, registrationId) => { registrations.push(`subscribe:${registrationId}`); calls.push("subscribe"); return input.subscribeNull ? null : { next: async () => { calls.push("next"); if (input.nextNever) return new Promise<Event | null>(() => {}); await pause("next"); if (input.dropRelayAt === "next") currentSessions = []; return input.events?.(scope!)[cursor++] ?? null; }, acknowledge: () => { calls.push("ack"); }, close: () => { calls.push("close"); if (input.closeThrows) throw new Error("private close"); } }; },
      containAcpExecution: (_scope, _process, registrationId) => { registrations.push(`contain:${registrationId}`); calls.push("contain"); if (input.containThrows) throw new Error("private contain"); return true; },
    },
    taskRuns: { linkJob: async () => { calls.push("link"); }, assertCurrent: async () => { calls.push("assert"); assertions += 1; await pause("assert"); if (input.assertThrows || input.assertThrowsAt === assertions) throw new Error("stale lifecycle"); }, complete: async () => { calls.push("complete"); await pause("complete"); if (input.completeThrows) throw new Error("report-back rejected"); }, fail: async (failure) => { calls.push("fail"); if (failure.failureReceipt) failures.push(failure.failureReceipt); await pause("fail"); if (input.failThrows) throw new Error("report-back rejected"); } },
    projector: { project: async () => { calls.push("project"); await pause("projector"); if (input.projectorThrows) throw new Error("private projector"); return input.projected ?? ({ type: "message" } as never); } },
    diagnostics: { onFailureStage: (stage) => { calls.push(`diagnostic:${stage}`); }, onStartFailureAfter: (stage) => { calls.push(`start-failure:${stage}`); }, onSetupFailureAfter: (checkpoint, code) => { calls.push(`setup-failure:${checkpoint}:${code}`); }, onSelectionFailure: (checkpoint, code) => { calls.push(`selection-failure:${checkpoint}:${code}`); } },
    mintOpaqueId: (() => { let id = 0; return () => `opaque-${++id}`; })(),
  };
  return { selector: new OpenCodeAcpTaskExecutionRouteSelector(deps), calls, registrations, failures, gate, setTask: (value: ReturnType<typeof task>) => { currentTask = value; }, setSessions: (value: readonly ReturnType<typeof session>[]) => { currentSessions = value; }, setAuthorized: (value: boolean) => { authorized = value; }, scope: () => scope, startTimeoutMs: () => startTimeoutMs };
}
async function iterator(selector: OpenCodeAcpTaskExecutionRouteSelector, controller = new AbortController()) { const route = await selector.select(facts); if (!route) throw new Error("missing route"); return { iterator: route.executor({}, "job", "lane", controller.signal), controller }; }
async function run(selector: OpenCodeAcpTaskExecutionRouteSelector) { const current = await iterator(selector); for await (const _ of current.iterator) { /* assertions consume outputs */ } }
async function rejected(runPromise: Promise<unknown>): Promise<OpenCodeAcpTaskExecutionFailure> { try { await runPromise; throw new Error("expected rejection"); } catch (error) { expect(error).toBeInstanceOf(OpenCodeAcpTaskExecutionFailure); expect(error).toMatchObject({ code: ACP_EXECUTION_FAILED }); return error as OpenCodeAcpTaskExecutionFailure; } }

describe("OpenCode ACP private Task execution", () => {
  test("parses only exact v1 OpenCode metadata and six bounded readiness fields", () => {
    expect(OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS).toBeGreaterThanOrEqual(OPENCODE_ACP_INITIALIZE_TIMEOUT_MS + ACP_TOTAL_TEARDOWN_TIMEOUT_MS + 5_000);
    expect(parseOpenCodeAcpExecutionMetadata(metadata)).not.toBeNull();
    for (const value of [{ ...metadata, extra: true }, { execution: { ...metadata.execution, extra: true } }, { execution: { ...metadata.execution, executionProfile: "unsealed" } }, { execution: { ...metadata.execution, readiness: { ...readiness, extra: true } } }, { execution: { ...metadata.execution, readiness: { ...readiness, relayId: "\0bad" } } }, { execution: { ...metadata.execution, readiness: { ...readiness, selectedProtocolVersion: 14 } } }]) expect(parseOpenCodeAcpExecutionMetadata(value)).toBeNull();
  });

  test.each(["interactive", "plan"] as const)("rejects sealed %s before any relay call", async (executionProfile) => {
    const harness = build();
    harness.setTask(task({ metadata: { execution: { ...metadata.execution, executionProfile } } }));
    try { await harness.selector.select(facts); throw new Error("expected reject"); } catch (error) {
      expect(error).toMatchObject({ code: "ACP_HARNESS_UNAVAILABLE" });
    }
    expect(harness.calls).toEqual(["selection-failure:profile:unsupported"]);
    expect(harness.registrations).toEqual([]);
  });

  test("diagnoses missing task and malformed metadata while preserving selector decline", async () => {
    const missing = build({ taskMissing: true });
    expect(await missing.selector.select(facts)).toBeUndefined();
    expect(missing.calls).toEqual(["selection-failure:task:missing"]);

    const malformed = build();
    malformed.setTask(task({ metadata: { execution: { version: 2 } } }));
    expect(await malformed.selector.select(facts)).toBeUndefined();
    expect(malformed.calls).toEqual(["selection-failure:metadata:invalid"]);
  });

  test("collapses unexpected selection dependency failures after one active-checkpoint internal marker", async () => {
    for (const [failure, checkpoint] of [["task", "task"], ["room", "room"], ["agent_owner", "agent_owner"], ["membership", "membership"], ["relay_snapshot", "relay_snapshot"], ["relay_lookup", "relay_snapshot"]] as const) {
      const harness = build({ selectionReject: failure });
      try { await harness.selector.select(facts); throw new Error("expected reject"); } catch (error) { expect(error).toMatchObject({ code: "ACP_HARNESS_UNAVAILABLE" }); }
      expect(harness.calls.filter((call) => call.startsWith("selection-failure:"))).toEqual([`selection-failure:${checkpoint}:internal`]);
      expect(JSON.stringify(harness.calls)).not.toContain("private");
    }
  });

  test("classifies each initial selection authority boundary with only fixed checkpoint and code", async () => {
    const cases: ReadonlyArray<Readonly<{
      harness: ReturnType<typeof build>;
      configure?: (harness: ReturnType<typeof build>) => void;
      selectionFacts?: TaskExecutionRouteFacts;
      diagnostic: string;
      publicCode: "ACP_HARNESS_UNAVAILABLE" | typeof ACP_EXECUTION_FAILED;
    }>> = [
      { harness: build(), configure: (harness) => harness.setTask(task({ id: "other" })), diagnostic: "selection-failure:task:mismatch", publicCode: ACP_EXECUTION_FAILED },
      { harness: build(), configure: (harness) => harness.setTask(task({ agentId: "other" })), diagnostic: "selection-failure:facts:mismatch", publicCode: ACP_EXECUTION_FAILED },
      { harness: build(), configure: (harness) => harness.setTask(task({ requestorId: "delegate" })), selectionFacts: { ...facts, requestorId: "delegate" }, diagnostic: "selection-failure:delegation:unsupported", publicCode: ACP_EXECUTION_FAILED },
      { harness: build(), configure: (harness) => harness.setTask(task({ prompt: " " })), diagnostic: "selection-failure:prompt:invalid", publicCode: ACP_EXECUTION_FAILED },
      { harness: build({ roomExists: false }), diagnostic: "selection-failure:room:missing", publicCode: ACP_EXECUTION_FAILED },
      { harness: build({ agentOwner: "other" }), diagnostic: "selection-failure:agent_owner:mismatch", publicCode: ACP_EXECUTION_FAILED },
      { harness: build({ member: false }), diagnostic: "selection-failure:membership:missing", publicCode: ACP_EXECUTION_FAILED },
      { harness: build({ sessions: [] }), diagnostic: "selection-failure:relay_snapshot:missing", publicCode: "ACP_HARNESS_UNAVAILABLE" },
      { harness: build({ sessions: [session(), session({ relayId: "second", relaySessionId: "second-socket" })] }), diagnostic: "selection-failure:relay_snapshot:ambiguous", publicCode: "ACP_HARNESS_UNAVAILABLE" },
      { harness: build({ sessions: [session({ capabilityRevision: 2 })] }), diagnostic: "selection-failure:relay_snapshot:stale", publicCode: "ACP_HARNESS_UNAVAILABLE" },
    ];
    for (const { harness, configure, selectionFacts = facts, diagnostic, publicCode } of cases) {
      configure?.(harness);
      try { await harness.selector.select(selectionFacts); throw new Error("expected reject"); } catch (error) { expect(error).toMatchObject({ code: publicCode }); }
      expect(harness.calls.filter((call) => call.startsWith("selection-failure:"))).toEqual([diagnostic]);
      expect(harness.calls.some((call) => call.startsWith("setup-failure:") || call.startsWith("start-failure:") || call.startsWith("diagnostic:"))).toBeFalse();
      expect(JSON.stringify(harness.calls)).not.toContain("other");
      expect(JSON.stringify(harness.calls)).not.toContain("delegate");
    }
  });

  test("emits no selection diagnostic after successful selection or from later executor fencing", async () => {
    const success = build({ events: completed });
    await run(success.selector);
    expect(success.calls.some((call) => call.startsWith("selection-failure:"))).toBeFalse();

    const stale = build({ events: completed });
    const current = await iterator(stale.selector);
    stale.setAuthorized(false);
    await rejected(current.iterator.next());
    expect(stale.calls.some((call) => call.startsWith("selection-failure:"))).toBeFalse();
  });

  test("links real identities, emits opaque binding-only authority, and completes only after terminal ack", async () => {
    const harness = build({ events: completed }); await run(harness.selector);
    expect(harness.calls).toEqual(["link", "assert", "readiness", "assert", "prepare", "assert", "assert", "start", "assert", "subscribe", "next", "assert", "assert", "ack", "next", "assert", "assert", "complete", "ack"]);
    expect(harness.scope()?.binding.ownerId).toBe("owner"); expect(harness.scope()?.binding.profileId).toStartWith("opaque-");
    expect(harness.registrations.filter((value) => !value.startsWith("lookup:"))).toEqual([
      "readiness:opencode-acp", "prepare:opencode-acp", "start:opencode-acp:autonomous", "subscribe:opencode-acp",
    ]);
    expect(harness.registrations.filter((value) => value.startsWith("lookup:")).every((value) => value === "lookup:opencode-acp")).toBeTrue();
    expect(harness.startTimeoutMs()).toBe(50_000);
  });

  test("keeps an exact start-failure stage private while returning the stable public failure", async () => {
    const harness = build({ startFailureAfter: "initialized" });
    const failure = await rejected(run(harness.selector));
    expect(failure).toMatchObject({ code: ACP_EXECUTION_FAILED, stage: "setup" });
    expect(harness.calls.filter((call) => call === "start-failure:initialized")).toHaveLength(1);
    expect(harness.calls.filter((call) => call === "diagnostic:setup")).toHaveLength(0);
    expect(harness.calls.some((call) => call.startsWith("setup-failure:"))).toBeFalse();
    expect(harness.calls).not.toContain("subscribe");
  });

  test.each(["start", "next"] as const)("terminalizes one linked TaskRun when the exact relay session disappears at %s", async (dropRelayAt) => {
    const harness = build({
      dropRelayAt,
      events: (scope) => [terminal(scope, "failed")],
    });

    await rejected(run(harness.selector));

    expect(harness.calls.filter((call) => call === "fail")).toHaveLength(1);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toMatchObject({ reason: "desktop_disconnected", phase: "running", processStarted: true });
    expect(harness.calls).not.toContain("complete");
    if (dropRelayAt === "start") expect(harness.calls).not.toContain("subscribe");
    else expect(harness.calls.filter((call) => call === "subscribe")).toHaveLength(1);
  });

  test("classifies each pre-host setup boundary with only fixed checkpoint and code", async () => {
    const cases = [
      [build({ readinessState: "missing" }), "readiness_requested", "not_ready"],
      [build({ relayFailures: { readiness: "ACP_RELAY_UNAVAILABLE" } }), "readiness_requested", "relay_unavailable"],
      [build({ relayFailures: { prepare: "ACP_TIMEOUT" } }), "prepare_requested", "timeout"],
      [build({ relayFailures: { start: "ACP_CONTEXT_STALE" } }), "start_request", "context_stale"],
      [build({ relayFailures: { start: "ACP_TIMEOUT" } }), "start_wait", "timeout"],
      [build({ relayFailures: { start: "ACP_SOCKET_GENERATION_LOST" } }), "start_wait", "socket_generation_lost"],
      [build({ started: (scope) => started(scope, { registrationId: "hermes-acp" }) }), "start_wait", "response_invalid"],
      [build({ subscribeNull: true }), "started", "subscription_unavailable"],
    ] as const;
    for (const [harness, checkpoint, code] of cases) {
      const failure = await rejected(run(harness.selector));
      expect(failure).toMatchObject({ code: ACP_EXECUTION_FAILED, stage: "setup" });
      expect(harness.calls.filter((call) => call.startsWith("setup-failure:"))).toEqual([`setup-failure:${checkpoint}:${code}`]);
      expect(harness.calls.some((call) => call === "diagnostic:setup" || call.startsWith("start-failure:"))).toBeFalse();
      expect(JSON.stringify(harness.calls)).not.toContain("private");
    }
  });

  test("consumes 177 rapid semantic events; the observed failed terminal is classified without leaking a cause", async () => {
    const burst = build({ events: (scope) => [
      ...Array.from({ length: 177 }, (_, index) => semantic(
        scope,
        { kind: "output_delta", vendorItemId: `burst-${index}`, text: `progress ${index}` },
        { eventId: `semantic-${index}`, eventSequence: index + 2 },
      )),
      terminal(scope, "failed"),
    ] });

    const failure = await rejected(run(burst.selector));
    expect(failure).toMatchObject({ code: ACP_EXECUTION_FAILED, stage: "terminal" });
    expect(burst.calls.filter((call) => call === "project")).toHaveLength(177);
    expect(burst.calls.filter((call) => call === "ack")).toHaveLength(178);
    expect(burst.calls.filter((call) => call === "fail")).toHaveLength(1);
    expect(burst.calls.filter((call) => call === "diagnostic:terminal")).toHaveLength(1);
    expect(burst.calls).not.toContain("complete");
  });

  test("reports a bounded durable outcome from observed execution facts", async () => {
    const harness = build({ events: (scope) => [
      semantic(scope, { kind: "output_delta", vendorItemId: "output", text: "partial output" }, { eventId: "output", eventSequence: 2 }),
      semantic(scope, { kind: "command_summary", vendorItemId: "command", commands: [{ summary: "Checked repository", status: "completed" }] }, { eventId: "command", eventSequence: 3 }),
      terminal(scope, "failed"),
    ] });

    await rejected(run(harness.selector));

    expect(harness.failures).toEqual([{
      provider: "OpenCode",
      reason: "ended_without_result",
      phase: "running",
      processStarted: true,
      commandActivityCount: 1,
      outputObserved: true,
      containmentRequested: false,
    }]);
  });

  test("rejects zero, two, and duplicate valid owner v15 relay sessions", async () => {
    expect(OPENCODE_ACP_RELAY_PROTOCOL_VERSION).toBe(15);
    for (const sessions of [[], [session(), session({ relayId: "second", relaySessionId: "second-socket" })], [session(), session()]]) {
      try { await build({ sessions }).selector.select(facts); throw new Error("expected reject"); } catch (error) { expect(error).toMatchObject({ code: "ACP_HARNESS_UNAVAILABLE" }); }
    }
  });

  test("aborts each pending host await without a later side effect; a returned process is contained", async () => {
    const cases: ReadonlyArray<readonly [Stage, string | null, boolean]> = [["readiness", "prepare", false], ["prepare", "start", false], ["start", "subscribe", true], ["next", "ack", true]];
    for (const [stage, forbidden, hasProcess] of cases) {
      const harness = build({ stage, events: completed }); const controller = new AbortController(); const current = await iterator(harness.selector, controller); const pending = current.iterator.next();
      await observed(harness.calls, `pending:${stage}`); controller.abort(); harness.gate.resolve(); await pending;
      if (forbidden) expect(harness.calls).not.toContain(forbidden);
      expect(harness.calls.filter((call) => call === "contain")).toHaveLength(hasProcess ? 1 : 0);
      expect(harness.calls.filter((call) => call === "close")).toHaveLength(stage === "next" ? 1 : 0);
      expect(harness.calls).not.toContain("complete"); expect(harness.calls).not.toContain("fail");
    }
  });

  test("consumer return while suspended after a provisional yield closes and contains exactly once", async () => {
    const harness = build({ events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "preview" }), ...completed(scope)] }); const current = await iterator(harness.selector);
    await current.iterator.next(); await current.iterator.return?.(undefined);
    expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1);
    expect(harness.calls).not.toContain("complete"); expect(harness.calls).not.toContain("fail");
  });

  test("fences each projected-array yield and its resumed consumer before the event acknowledgement", async () => {
    const outputs = [{ type: "one" }, { type: "two" }, { type: "three" }] as unknown as readonly ServerEvent[];
    for (const stop of ["abort", "stale"] as const) {
      const harness = build({ events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "preview" })], projected: outputs }); const controller = new AbortController(); const current = await iterator(harness.selector, controller);
      expect((await current.iterator.next()).value).toBe(outputs[0]);
      if (stop === "abort") controller.abort(); else harness.setAuthorized(false);
      if (stop === "abort") expect((await current.iterator.next()).done).toBeTrue(); else await rejected(current.iterator.next());
      expect(harness.calls).not.toContain("ack"); expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1);
    }
  });

  test("aborts a permanently pending subscription.next without relying on close to wake it", async () => {
    const harness = build({ nextNever: true, closeThrows: true }); const controller = new AbortController(); const current = await iterator(harness.selector, controller); const pending = current.iterator.next(); await observed(harness.calls, "next"); controller.abort();
    expect((await pending).done).toBeTrue(); expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1); expect(harness.calls).not.toContain("ack");
  });

  test("revalidates authority, session, prompt, and metadata drift after every gated readiness, prepare, and start await", async () => {
    const stages: ReadonlyArray<readonly [Stage, string, boolean]> = [["readiness", "prepare", false], ["prepare", "start", false], ["start", "subscribe", true]];
    const drifts: ReadonlyArray<readonly [(h: ReturnType<typeof build>) => void, boolean]> = [
      [(h) => h.setAuthorized(false), false], [(h) => h.setSessions([session({ capabilityRevision: 2 })]), true], [(h) => h.setTask(task({ prompt: "mutated" })), false], [(h) => h.setTask(task({ metadata: { execution: { ...metadata.execution, readiness: { ...readiness, relaySessionId: "rotated" } } } })), false],
    ];
    for (const [stage, forbidden, hasProcess] of stages) for (const [drift, expectRelayTerminal] of drifts) {
      const harness = build({ stage, events: completed }); const current = await iterator(harness.selector); const pending = current.iterator.next(); await observed(harness.calls, `pending:${stage}`); drift(harness); harness.gate.resolve(); await rejected(pending);
      expect(harness.calls).not.toContain(forbidden); expect(harness.calls).not.toContain("complete"); expect(harness.calls.filter((call) => call === "fail")).toHaveLength(expectRelayTerminal ? 1 : 0);
      expect(harness.calls.filter((call) => call === "contain")).toHaveLength(hasProcess ? 1 : 0);
    }
  });

  test("rejects stale TaskRun or Job assertion gates before the next host side effect", async () => {
    const harness = build({ stage: "assert", assertThrows: true }); const current = await iterator(harness.selector); const pending = current.iterator.next(); await observed(harness.calls, "pending:assert"); harness.gate.resolve(); await rejected(pending);
    expect(harness.calls).not.toContain("readiness"); expect(harness.calls).not.toContain("fail"); expect(harness.calls).not.toContain("complete");
    for (const [stage, assertion, forbidden] of [["readiness", 2, "prepare"], ["prepare", 3, "start"], ["start", 5, "subscribe"]] as const) {
      const gated = build({ stage, assertThrowsAt: assertion }); const next = await iterator(gated.selector); const pendingNext = next.iterator.next(); await observed(gated.calls, `pending:${stage}`); gated.gate.resolve(); await rejected(pendingNext);
      expect(gated.calls).not.toContain(forbidden); expect(gated.calls).not.toContain("fail"); expect(gated.calls).not.toContain("complete");
    }
  });

  test("fences aborts after assertion, projector, completion, and failure awaits before any next side effect", async () => {
    const assertHarness = build({ stage: "assert" }); const assertController = new AbortController(); const initial = await iterator(assertHarness.selector, assertController); const pendingAssert = initial.iterator.next(); await observed(assertHarness.calls, "pending:assert"); assertController.abort(); assertHarness.gate.resolve(); await pendingAssert;
    expect(assertHarness.calls).not.toContain("readiness");
    const cases: ReadonlyArray<readonly [Stage, (scope: AcpExecutionScope) => readonly Event[], number]> = [
      ["projector", (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "preview" })], 0],
      ["complete", completed, 1], ["fail", (scope) => [terminal(scope, "failed")], 0],
    ];
    for (const [stage, events, expectedAcks] of cases) {
      const harness = build({ stage, events }); const controller = new AbortController(); const current = await iterator(harness.selector, controller); const pending = current.iterator.next(); await observed(harness.calls, `pending:${stage}`); controller.abort(); harness.gate.resolve();
      if (stage === "fail") await rejected(pending); else await pending;
      expect(harness.calls.filter((call) => call === "ack")).toHaveLength(expectedAcks); expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1);
    }
  });

  test("rejects stale authority and terminalizes an exact lost session observed after subscription.next before project, yield, ack, or report-back", async () => {
    for (const [drift, expectRelayTerminal] of [[(h: ReturnType<typeof build>) => h.setAuthorized(false), false], [(h: ReturnType<typeof build>) => h.setSessions([session({ capabilityRevision: 2 })]), true]] as const) {
      const harness = build({ stage: "next", events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "preview" })] }); const current = await iterator(harness.selector); const pending = current.iterator.next(); await observed(harness.calls, "pending:next"); drift(harness); harness.gate.resolve(); await rejected(pending);
      expect(harness.calls).not.toContain("project"); expect(harness.calls).not.toContain("ack"); expect(harness.calls).not.toContain("complete"); expect(harness.calls.filter((call) => call === "fail")).toHaveLength(expectRelayTerminal ? 1 : 0);
    }
  });

  test("halts at a deferred nth reload before projecting a now-stale subscription event", async () => {
    const harness = build({ reloadAt: 7, events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "preview" })] }); const current = await iterator(harness.selector); const pending = current.iterator.next(); await observed(harness.calls, "pending:reload"); harness.setTask(task({ prompt: "rotated" })); harness.gate.resolve(); await rejected(pending);
    expect(harness.calls).not.toContain("project"); expect(harness.calls).not.toContain("ack"); expect(harness.calls).not.toContain("complete"); expect(harness.calls).not.toContain("fail");
  });

  test("normalizes teardown and fail report-back throws without terminal acknowledgements or private details", async () => {
    const completion = build({ events: completed, completeThrows: true, containThrows: true, closeThrows: true }); await rejected(run(completion.selector));
    expect(completion.calls.filter((call) => call === "ack")).toHaveLength(1); expect(completion.calls.filter((call) => call === "close")).toHaveLength(1); expect(completion.calls.filter((call) => call === "contain")).toHaveLength(1);
    const failure = build({ events: (scope) => [terminal(scope, "failed")], failThrows: true, containThrows: true, closeThrows: true }); await rejected(run(failure.selector));
    expect(failure.calls).not.toContain("ack"); expect(failure.calls.filter((call) => call === "close")).toHaveLength(1); expect(failure.calls.filter((call) => call === "contain")).toHaveLength(1);
    const aborted = build({ stage: "next", events: completed, containThrows: true, closeThrows: true }); const controller = new AbortController(); const current = await iterator(aborted.selector, controller); const pending = current.iterator.next(); await observed(aborted.calls, "pending:next"); controller.abort(); aborted.gate.resolve(); await pending;
    expect(aborted.calls.filter((call) => call === "close")).toHaveLength(1); expect(aborted.calls.filter((call) => call === "contain")).toHaveLength(1); expect(aborted.calls).not.toContain("ack");
  });

  test("fails closed for subscribe, start scope/process/capability mismatches, and candidate/terminal matrix", async () => {
    const badProcess = { ...process, turnRef: "wrong" };
    const cases: ReadonlyArray<ReturnType<typeof build>> = [
      build({ subscribeNull: true }),
      build({ started: (scope) => started(scope, { registrationId: "hermes-acp" }) }),
      build({ started: (scope) => started({ ...scope, binding: { ...scope.binding, jobId: "wrong" } }) }),
      build({ started: (scope) => started(scope, { capabilities: { requests: "supported" } }) }),
      build({ events: (scope) => [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: " " })] }),
      build({ events: (scope) => [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "answer" }), semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "again" })] }),
      build({ events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "wrong process" }, { process: badProcess })] }),
      build({ events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "wrong provider" }, { registrationId: "hermes-acp" })] }),
      ...(["completed", "failed", "interrupted"] as const).map((status) => build({ events: (scope) => [terminal(scope, status)] })),
    ];
    for (const harness of cases) { await rejected(run(harness.selector)); expect(harness.calls).not.toContain("complete"); }
  });

  test("does not acknowledge a terminal after report-back rejection and contains it exactly once", async () => {
    const harness = build({ events: completed, completeThrows: true }); await rejected(run(harness.selector));
    expect(harness.calls.filter((call) => call === "ack")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1); expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls).not.toContain("fail");
  });
});
