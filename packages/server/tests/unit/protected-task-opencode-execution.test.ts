import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { actors, rooms, roomMembers } from "@nautilo/db";
import { AcpSemanticRelay } from "@nautilo/acp-host";
import { validateAcpInitializeCapabilityTruth } from "../../../acp-host/src/capability-truth";
import { OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS, type HarnessExecutionOutput, type ProtectedTaskRunningOccurrence } from "@nautilo/runtime";
import type { AcpExecutionScope, RelayAcpSemanticEvent, RelayAcpTerminalEvent } from "@nautilo/relay";
import { createProtectedTaskOpenCodeProvider } from "../../src/routes/protected-task-opencode-execution";
import { parseProtectedTaskOpenCodeSelection } from "../../src/routes/protected-task-opencode-selection";

const readiness = { relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pairing", desktopSessionId: "desktop",
  selectedProtocolVersion: 15, capabilityRevision: 3 };
const selection = parseProtectedTaskOpenCodeSelection({ execution: { version: 1, harnessId: "opencode-acp",
  source: "genie", executionProfile: "autonomous", readiness } })!;
const occurrence: ProtectedTaskRunningOccurrence = {
  task: { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", callingRoomId: "room", scheduleKind: "now",
    contentRepresentation: "protected", contentNamespaceId: "namespace", contentRevision: 1, cryptoObjectId: "definition",
    cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: new Uint8Array(32) },
  run: { id: "run", taskId: "task", jobId: "job", graphThreadId: "thread", status: "running", startedAt: new Date() },
};
const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "session", turnGeneration: 1, turnRef: "turn" };
type Input = Parameters<typeof createProtectedTaskOpenCodeProvider>[0];
type Event = RelayAcpSemanticEvent | RelayAcpTerminalEvent;
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
function fixture(options: { pause?: "prepare" | "start" | "next"; corrupt?: "registration" | "requests" | "process"; missingOwner?: boolean } = {}) {
  const calls: string[] = [];
  const gate = deferred();
  const pending = deferred();
  const abort = new AbortController();
  let current = true;
  let session = { ...readiness, userId: "owner" };
  let cursor = 0;
  const events: Event[] = [];
  const db = { select: () => ({ from: (table: unknown) => {
    const rows = table === rooms ? [{ id: "room" }] : table === actors
      ? [{ ownerId: options.missingOwner ? "foreign" : "owner" }] : table === roomMembers ? [{ actorId: "actor" }] : [];
    const where = () => ({ limit: async () => rows });
    return { where, innerJoin: () => ({ where }) };
  } }) } as unknown as Input["db"];
  const pause = async (stage: string) => { calls.push(stage); if (options.pause === stage) { pending.resolve(); await gate.promise; } };
  const capabilities = { requests: "unsupported" as const };
  const providerCapabilities = validateAcpInitializeCapabilityTruth({ protocolVersion: 1, agentCapabilities: {} });
  const relay: Input["relay"] = {
    listConnected: async () => ["relay", "other-relay"],
    getAcpSessionForRegistration: (id, owner, registration) => { expect(registration).toBe("opencode-acp"); return owner === "owner" && id === "relay" ? session : null; },
    requestAcpReadiness: async input => { expect(input.registrationId).toBe("opencode-acp"); calls.push("readiness"); return "ready"; },
    requestAcpPrepare: async input => { expect(input.registrationId).toBe("opencode-acp"); await pause("prepare");
      return { workspaceReceiptId: "workspace", workspaceRevision: "1", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2099-01-01T00:00:00Z" }; },
    requestAcpStart: async input => {
      expect(input.registrationId).toBe("opencode-acp"); expect(input.executionProfile).toBe("autonomous");
      expect(input.timeoutMs).toBe(OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS);
      expect(input.prompt).toBe("private prompt"); expect(input.scope.binding).toMatchObject({ taskId: "task", taskRunId: "run", jobId: "job", ownerId: "owner" });
      await pause("start");
      const scope = input.scope;
      let sequence = 1;
      // The actual ACP semantic owner promotes streamed text only after end_turn.
      const producer = new AcpSemanticRelay({ scope: { ...scope.socket, ...scope.binding, ...scope.workspace }, process,
        roomId: null, capabilities: providerCapabilities, mintRequestId: () => "request",
        emit: frame => {
          const payload = frame.payload;
          const base = { registrationId: "opencode-acp" as const, scope, process, eventId: `event-${++sequence}`, eventSequence: sequence };
          if (payload.kind === "terminal") events.push({ ...base, type: "relay:acp-terminal", status: payload.status,
            ...(payload.code === undefined ? {} : { code: payload.code }) });
          else if (payload.kind === "output_delta" || payload.kind === "assistant_completed") events.push({ ...base,
            type: "relay:acp-semantic", capabilities, payload: { kind: payload.kind, text: payload.text, vendorItemId: payload.attribution.vendorItemId } });
          else throw new Error("unexpected synthetic producer event");
        },
      });
      await producer.project({ kind: "agent_text_chunk", sessionId: process.acpSessionId, messageId: "message", text: "private answer" });
      const status = (state: "healthy" | "possibly_stalled"): RelayAcpSemanticEvent => ({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process,
        capabilities, payload: { kind: "runtime_status", state }, eventId: `status-${state}`, eventSequence: ++sequence });
      events.push(status("possibly_stalled"), status("healthy"));
      await producer.complete({ sessionId: process.acpSessionId, stopReason: "end_turn" });
      if (options.corrupt === "registration") events[0] = { ...events[0]!, registrationId: "hermes-acp" };
      if (options.corrupt === "process") events[0] = { ...events[0]!, process: { ...process, turnRef: "foreign" } };
      return { type: "relay:acp-started", registrationId: "opencode-acp", scope, process,
        capabilities: { requests: options.corrupt === "requests" ? "supported" : "unsupported" }, eventId: "start", eventSequence: 1 };
    },
    subscribeAcpExecution: (_scope, _process, registration) => { expect(registration).toBe("opencode-acp"); calls.push("subscribe"); return {
      next: async () => { await pause("next"); return events[cursor++] ?? null; },
      acknowledge: () => { calls.push("ack"); }, close: () => { calls.push("close"); },
    }; },
    containAcpExecution: (_scope: AcpExecutionScope, exactProcess, registration) => {
      expect(registration).toBe("opencode-acp"); expect(exactProcess).toEqual(process); calls.push("contain"); return false;
    },
  };
  const provider = createProtectedTaskOpenCodeProvider({ db, relay });
  const start = async () => {
    const admission = await provider.admit("owner", selection);
    if (admission === null) throw new Error("unavailable");
    return provider.start({ occurrence, reference: { kind: "protected_task_run_v1", taskId: "task", taskRunId: "run",
      inputObjectId: "definition", resultObjectId: "result", authorizationRequestId: "request", policyRevision: 1, executionSegment: 1 },
      jobId: "job", signal: abort.signal, assertCurrent: async () => { calls.push("current"); if (!current) throw new Error("authority changed"); },
      admission, payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null, protectedMetadata: {} } });
  };
  return { provider, start, calls, gate, pending, abort, loseAuthority: () => { current = false; },
    replaceSession: (change: Partial<typeof session> = {}) => { session = { ...session, relaySessionId: "replacement", ...change }; } };
}

describe("protected autonomous OpenCode", () => {
  test("real ACP semantic completion and both runtime statuses remain private provider outputs", async () => {
    const f = fixture(); const session = await f.start(); const outputs: HarnessExecutionOutput[] = [];
    for await (const output of session.outputs) outputs.push(output);
    expect(outputs.map(output => output.kind)).toEqual(["output_delta", "progress", "progress", "assistant_completed", "terminal"]);
    expect(outputs[3]).toMatchObject({ text: "private answer", attribution: { taskId: "task", roomId: "room" } });
    expect(outputs[4]).toMatchObject({ status: "completed" });
    expect(f.calls).not.toContain("contain"); expect(f.calls.filter(call => call === "ack")).toHaveLength(5);
    expect(session.hasLiveRequest("anything", "owner")).toBe(false);
  });
  test("unsupported profiles, foreign owner and changed pairing cannot acquire admission", async () => {
    const f = fixture();
    for (const executionProfile of ["interactive", "plan"] as const) {
      expect(await f.provider.admit("owner", { execution: { ...selection.execution, executionProfile } })).toBeNull();
    }
    expect(await f.provider.admit("foreign", selection)).toBeNull();
    f.replaceSession({ pairingGenerationRef: "repaired" }); expect(await f.provider.admit("owner", selection)).toBeNull(); expect(f.calls).toEqual([]);
  });
  test("reconnect before effects refreshes only the selected machine admission", async () => {
    const f = fixture(); f.replaceSession({ desktopSessionId: "relaunched", capabilityRevision: 9, selectedProtocolVersion: 31 });
    const admission = await f.provider.admit("owner", selection);
    expect(admission).toMatchObject({ relayId: "relay", pairingGenerationRef: readiness.pairingGenerationRef,
      relaySessionId: "replacement", desktopSessionId: "relaunched", capabilityRevision: 9 });
    const outputs: HarnessExecutionOutput[] = []; const session = await f.start();
    for await (const output of session.outputs) outputs.push(output);
    expect(outputs.at(-1)).toMatchObject({ kind: "terminal", status: "completed" });
    expect(f.calls.filter(call => call === "start")).toHaveLength(1);
  });
  test("reconnect during a started attempt contains that exact process without retry", async () => {
    const f = fixture({ pause: "start" }); const starting = f.start(); await f.pending.promise;
    f.replaceSession(); f.gate.resolve(); await rejects(starting, /admission changed/u);
    expect(f.calls.filter(call => call === "start")).toHaveLength(1);
    expect(f.calls.filter(call => call === "contain")).toHaveLength(1); expect(f.calls).not.toContain("subscribe");
  });
  test("current Room Agent ownership is required before preparing a workspace", async () => {
    const f = fixture({ missingOwner: true }); await rejects(f.start(), /identity changed/u); expect(f.calls).not.toContain("readiness");
  });
  for (const change of ["grant", "socket"] as const) test(`${change} drift while preparing prevents prompt disclosure`, async () => {
    const f = fixture({ pause: "prepare" }); const starting = f.start(); await f.pending.promise;
    if (change === "grant") f.loseAuthority(); else f.replaceSession(); f.gate.resolve();
    await rejects(starting); expect(f.calls).not.toContain("start");
  });
  test("expiry during start contains only the exact late process without replay", async () => {
    const f = fixture({ pause: "start" }); const starting = f.start(); await f.pending.promise; f.abort.abort();
    await rejects(starting); f.gate.resolve();
    for (let i = 0; i < 20 && !f.calls.includes("contain"); i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.filter(call => call === "contain")).toHaveLength(1); expect(f.calls).not.toContain("subscribe");
  });
  for (const corrupt of ["registration", "process", "requests"] as const) test(`rejects substituted ${corrupt} without a successful result`, async () => {
    const f = fixture({ corrupt }); const outputs: HarnessExecutionOutput[] = [];
    await rejects((async () => { const session = await f.start(); for await (const output of session.outputs) outputs.push(output); })());
    expect(outputs).toEqual([]); expect(f.calls.filter(call => call === "contain")).toHaveLength(1);
  });
  test("grant loss while awaiting output prevents acknowledgement and closes custody", async () => {
    const f = fixture({ pause: "next" }); const session = await f.start(); const next = session.outputs[Symbol.asyncIterator]().next();
    await f.pending.promise; f.loseAuthority(); f.gate.resolve(); await rejects(next, /authority changed/u);
    expect(f.calls).not.toContain("ack"); expect(f.calls.filter(call => call === "contain")).toHaveLength(1); expect(f.calls).toContain("close");
  });
});
