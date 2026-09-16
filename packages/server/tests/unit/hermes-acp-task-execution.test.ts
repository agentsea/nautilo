import { describe, expect, test } from "bun:test";
import type { TaskExecutionRouteFacts } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { ACP_RELAY_PROTOCOL_VERSION, type AcpExecutionScope, type AcpProcessScope, type RelayAcpSemanticEvent, type RelayAcpTerminalEvent } from "@nautilo/relay";
import { ACP_EXECUTION_FAILED } from "../../src/acp/task-run-lifecycle";
import { HermesAcpTaskExecutionFailure, HermesAcpTaskExecutionRouteSelector, parseHermesAcpExecutionMetadata, type HermesAcpTaskExecutionDeps } from "../../src/acp/task-execution";

const facts: TaskExecutionRouteFacts = { taskId: "task", taskRunId: "run", parentTaskId: null, ownerId: "owner", requestorId: "owner", agentId: "agent", roomId: "room", laneKey: "lane", graphThreadId: "graph" };
const readiness = { relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pair", desktopSessionId: "desktop", selectedProtocolVersion: ACP_RELAY_PROTOCOL_VERSION, capabilityRevision: 1 };
const metadata = { execution: { version: 1, harnessId: "hermes-acp", source: "genie", readiness } } as const;
const process: AcpProcessScope = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" };
type Event = RelayAcpSemanticEvent | RelayAcpTerminalEvent;
type Stage = "readiness" | "prepare" | "start" | "next" | "assert" | "projector" | "complete" | "fail";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function observed(calls: readonly string[], call: string) { for (let i = 0; i < 100 && !calls.includes(call); i += 1) await new Promise<void>((done) => setTimeout(done, 1)); expect(calls).toContain(call); }
function task(overrides: Record<string, unknown> = {}) { return { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", parentTaskId: null, targetRoomId: "room", prompt: "answer this", metadata, ...overrides }; }
function session(overrides: Record<string, unknown> = {}) { return { ...readiness, userId: "owner", ...overrides }; }
function started(scope: AcpExecutionScope, overrides: Record<string, unknown> = {}) { return { type: "relay:acp-started" as const, registrationId: "hermes-acp" as const, scope, process, capabilities: { requests: "unsupported" as const }, eventId: "started", eventSequence: 1, ...overrides }; }
function semantic(scope: AcpExecutionScope, payload: RelayAcpSemanticEvent["payload"], overrides: Record<string, unknown> = {}): Event { return { type: "relay:acp-semantic", registrationId: "hermes-acp", scope, process, capabilities: { requests: "unsupported" }, payload, eventId: "semantic", eventSequence: 2, ...overrides } as Event; }
function terminal(scope: AcpExecutionScope, status: "completed" | "failed" | "interrupted" = "completed"): Event { return { type: "relay:acp-terminal", registrationId: "hermes-acp", scope, process, status, ...(status === "failed" ? { code: "upstream_failure" as const } : status === "interrupted" ? { code: "user_stop" as const } : {}), eventId: "terminal", eventSequence: 3 }; }
function completed(scope: AcpExecutionScope): readonly Event[] { return [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "answer" }), terminal(scope)]; }

function build(input: Partial<{ events: (scope: AcpExecutionScope) => readonly Event[]; stage: Stage; reloadAt: number; subscribeNull: boolean; nextNever: boolean; dropRelayAt: "start" | "next"; started: (scope: AcpExecutionScope) => ReturnType<typeof started>; projected: readonly ServerEvent[] | null; projectorThrows: boolean; completeThrows: boolean; failThrows: boolean; containThrows: boolean; closeThrows: boolean; assertThrows: boolean; assertThrowsAt: number; sessions: readonly ReturnType<typeof session>[] }> = {}) {
  const calls: string[] = []; const readinessTimeouts: number[] = []; const gate = deferred<void>(); let cursor = 0; let taskReads = 0; let assertions = 0; let scope: AcpExecutionScope | null = null; let currentTask = task(); let currentSessions = input.sessions ?? [session()]; let authorized = true; let pauseUsed = false;
  const pause = async (stage: Stage) => { if (input.stage === stage && !pauseUsed) { pauseUsed = true; calls.push(`pending:${stage}`); await gate.promise; } };
  const deps: HermesAcpTaskExecutionDeps = {
    tasks: { getTask: async () => { taskReads += 1; if (input.reloadAt === taskReads) { calls.push("pending:reload"); await gate.promise; } return currentTask; } },
    facts: { roomExists: async () => authorized, getAgentOwner: async () => authorized ? "owner" : "other", isAgentMember: async () => authorized },
    relay: {
      listConnected: async () => currentSessions.map((item) => item.relayId), getAcpSession: (id) => currentSessions.find((item) => item.relayId === id) ?? null,
      requestAcpReadiness: async ({ timeoutMs }) => { calls.push("readiness"); if (timeoutMs !== undefined) readinessTimeouts.push(timeoutMs); await pause("readiness"); return "ready"; },
      requestAcpPrepare: async () => { calls.push("prepare"); await pause("prepare"); return { workspaceReceiptId: "workspace", workspaceRevision: "1", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2099-01-01T00:00:00.000Z" }; },
      requestAcpStart: async ({ scope: received }) => { calls.push("start"); scope = received; await pause("start"); if (input.dropRelayAt === "start") currentSessions = []; return input.started?.(received) ?? started(received); },
      subscribeAcpExecution: () => { calls.push("subscribe"); return input.subscribeNull ? null : { next: async () => { calls.push("next"); if (input.nextNever) return new Promise<Event | null>(() => {}); await pause("next"); if (input.dropRelayAt === "next") currentSessions = []; return input.events?.(scope!)[cursor++] ?? null; }, acknowledge: () => { calls.push("ack"); }, close: () => { calls.push("close"); if (input.closeThrows) throw new Error("private close"); } }; },
      containAcpExecution: () => { calls.push("contain"); if (input.containThrows) throw new Error("private contain"); return true; },
    },
    taskRuns: { linkJob: async () => { calls.push("link"); }, assertCurrent: async () => { calls.push("assert"); assertions += 1; await pause("assert"); if (input.assertThrows || input.assertThrowsAt === assertions) throw new Error("stale lifecycle"); }, complete: async () => { calls.push("complete"); await pause("complete"); if (input.completeThrows) throw new Error("report-back rejected"); }, fail: async () => { calls.push("fail"); await pause("fail"); if (input.failThrows) throw new Error("report-back rejected"); } },
    projector: { project: async () => { calls.push("project"); await pause("projector"); if (input.projectorThrows) throw new Error("private projector"); return input.projected ?? ({ type: "message" } as never); } },
    diagnostics: { onFailureStage: (stage) => { calls.push(`diagnostic:${stage}`); } },
    mintOpaqueId: (() => { let id = 0; return () => `opaque-${++id}`; })(),
  };
  return { selector: new HermesAcpTaskExecutionRouteSelector(deps), calls, readinessTimeouts, gate, setTask: (value: ReturnType<typeof task>) => { currentTask = value; }, setSessions: (value: readonly ReturnType<typeof session>[]) => { currentSessions = value; }, setAuthorized: (value: boolean) => { authorized = value; }, scope: () => scope };
}
async function iterator(selector: HermesAcpTaskExecutionRouteSelector, controller = new AbortController()) { const route = await selector.select(facts); if (!route) throw new Error("missing route"); return { iterator: route.executor({}, "job", "lane", controller.signal), controller }; }
async function run(selector: HermesAcpTaskExecutionRouteSelector) { const current = await iterator(selector); for await (const _ of current.iterator) { /* assertions consume outputs */ } }
async function rejected(runPromise: Promise<unknown>): Promise<HermesAcpTaskExecutionFailure> { try { await runPromise; throw new Error("expected rejection"); } catch (error) { expect(error).toBeInstanceOf(HermesAcpTaskExecutionFailure); expect(error).toMatchObject({ code: ACP_EXECUTION_FAILED }); return error as HermesAcpTaskExecutionFailure; } }

describe("Hermes ACP private Task execution", () => {
  test("parses only exact v1 Hermès metadata and six bounded readiness fields", () => {
    expect(parseHermesAcpExecutionMetadata(metadata)).not.toBeNull();
    for (const value of [{ ...metadata, extra: true }, { execution: { ...metadata.execution, readiness: { ...readiness, extra: true } } }, { execution: { ...metadata.execution, readiness: { ...readiness, relayId: "\0bad" } } }, { execution: { ...metadata.execution, readiness: { ...readiness, selectedProtocolVersion: 13 } } }]) expect(parseHermesAcpExecutionMetadata(value)).toBeNull();
  });

  test("links real identities, emits opaque binding-only authority, and completes only after terminal ack", async () => {
    const harness = build({ events: completed }); await run(harness.selector);
    expect(harness.calls).toEqual(["link", "assert", "readiness", "assert", "prepare", "assert", "assert", "start", "assert", "subscribe", "next", "assert", "assert", "ack", "next", "assert", "assert", "complete", "ack"]);
    expect(harness.scope()?.binding.ownerId).toBe("owner"); expect(harness.scope()?.binding.profileId).toStartWith("opaque-");
    expect(harness.readinessTimeouts).toEqual([10_000]);
  });

  test.each(["start", "next"] as const)("terminalizes one linked TaskRun when the exact relay session disappears at %s", async (dropRelayAt) => {
    const harness = build({
      dropRelayAt,
      events: (scope) => [terminal(scope, "failed")],
    });

    await rejected(run(harness.selector));

    expect(harness.calls.filter((call) => call === "fail")).toHaveLength(1);
    expect(harness.calls).not.toContain("complete");
    if (dropRelayAt === "start") expect(harness.calls).not.toContain("subscribe");
    else expect(harness.calls.filter((call) => call === "subscribe")).toHaveLength(1);
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

  test("rejects zero, two, and duplicate valid owner v14 relay sessions", async () => {
    expect(ACP_RELAY_PROTOCOL_VERSION).toBe(14);
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
      build({ started: (scope) => started({ ...scope, binding: { ...scope.binding, jobId: "wrong" } }) }),
      build({ started: (scope) => started(scope, { capabilities: { requests: "supported" } }) }),
      build({ events: (scope) => [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: " " })] }),
      build({ events: (scope) => [semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "answer" }), semantic(scope, { kind: "assistant_completed", vendorItemId: null, text: "again" })] }),
      build({ events: (scope) => [semantic(scope, { kind: "output_delta", vendorItemId: null, text: "wrong process" }, { process: badProcess })] }),
      ...(["completed", "failed", "interrupted"] as const).map((status) => build({ events: (scope) => [terminal(scope, status)] })),
    ];
    for (const harness of cases) { await rejected(run(harness.selector)); expect(harness.calls).not.toContain("complete"); }
  });

  test("does not acknowledge a terminal after report-back rejection and contains it exactly once", async () => {
    const harness = build({ events: completed, completeThrows: true }); await rejected(run(harness.selector));
    expect(harness.calls.filter((call) => call === "ack")).toHaveLength(1); expect(harness.calls.filter((call) => call === "contain")).toHaveLength(1); expect(harness.calls.filter((call) => call === "close")).toHaveLength(1); expect(harness.calls).not.toContain("fail");
  });
});
