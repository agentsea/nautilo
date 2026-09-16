import { describe, expect, test } from "bun:test";
import {
  AcpSemanticRelay,
  AcpSemanticRelayError,
  ACP_CANCELLATION_TERMINAL_WAIT_MS,
  ACP_DEFAULT_INITIALIZE_TIMEOUT_MS,
  ACP_TOTAL_TEARDOWN_TIMEOUT_MS,
  decodeAcpRelayFrame,
  type AcpHostScope,
  type AcpProcessScope,
  type AcpRelayClock,
  type AcpRelayFrame,
  type AcpRelayPermissionResponse,
} from "../../src/index.js";
import { validateAcpInitializeCapabilityTruth } from "../../src/capability-truth.js";

const HOST_SCOPE: AcpHostScope = Object.freeze({
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-session-1",
  pairingGenerationRef: "pairing-1",
  selectedProtocolVersion: 1,
  capabilityRevision: 4,
  bindingId: "binding-1",
  bindingGeneration: "binding-generation-2",
  ownerId: "owner-1",
  taskId: "task-1",
  taskRunId: "task-run-1",
  jobId: "job-1",
  workspaceReceiptId: "receipt-1",
  workspaceRevision: "workspace-revision-1",
  workspaceFingerprint: "workspace-fingerprint-1",
  workspaceExpiresAt: "2030-01-01T00:00:00.000Z",
  profileId: "profile-1",
  profileGeneration: "profile-generation-1",
  postureId: "posture-1",
  postureGeneration: "posture-generation-1",
});

const PROCESS_SCOPE: AcpProcessScope = Object.freeze({
  connectionId: "connection-1",
  processGeneration: 7,
  acpSessionId: "acp-session-1",
  turnGeneration: 3,
  turnRef: "turn-ref-1",
});

const CAPABILITIES = validateAcpInitializeCapabilityTruth({ protocolVersion: 1, agentCapabilities: {} });

class FakeClock implements AcpRelayClock {
  #now = Date.parse("2026-08-09T00:00:00.000Z");
  #next = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.#now; }
  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.#next;
    this.timers.set(id, { at: this.#now + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.#now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function fixture(overrides: Partial<ConstructorParameters<typeof AcpSemanticRelay>[0]> = {}) {
  const frames: AcpRelayFrame[] = [];
  let request = 0;
  const clock = new FakeClock();
  const relay = new AcpSemanticRelay({
    scope: HOST_SCOPE,
    process: PROCESS_SCOPE,
    roomId: "room-1",
    capabilities: CAPABILITIES,
    emit: (frame) => { frames.push(frame); },
    mintRequestId: () => `request-${++request}`,
    clock,
    permissionLifetimeMs: 100,
    ...overrides,
  });
  return { relay, frames, clock };
}

function permission() {
  return {
    sessionId: PROCESS_SCOPE.acpSessionId,
    toolCallId: "tool-1",
    tool: { title: "Edit file", kind: "edit" },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  } as const;
}

function response(requestId: string, overrides: Partial<AcpRelayPermissionResponse> = {}): AcpRelayPermissionResponse {
  return {
    scope: HOST_SCOPE,
    process: PROCESS_SCOPE,
    requestId,
    ownerId: HOST_SCOPE.ownerId,
    outcome: { kind: "selected", optionId: "allow_once" },
    ...overrides,
  };
}

async function expectRelayError(action: () => unknown, code: AcpSemanticRelayError["code"]): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AcpSemanticRelayError);
  expect(thrown).toMatchObject({ code });
}

describe("AcpSemanticRelay", () => {
  test("keeps chunks provisional and promotes one candidate only after matching end_turn", async () => {
    const { relay, frames } = fixture();
    await relay.project({
      kind: "agent_text_chunk",
      sessionId: PROCESS_SCOPE.acpSessionId,
      messageId: null,
      text: "hello ",
    });
    await relay.project({
      kind: "agent_text_chunk",
      sessionId: PROCESS_SCOPE.acpSessionId,
      messageId: "message-1",
      text: "world",
    });
    await relay.project({
      kind: "tool_call",
      sessionId: PROCESS_SCOPE.acpSessionId,
      toolCallId: "tool-1",
      title: "Inspect repository",
      status: "completed",
    });

    expect(frames.map((frame) => frame.payload.kind)).toEqual([
      "output_delta", "output_delta", "command_summary",
    ]);
    expect(frames.every((frame) => frame.scope === HOST_SCOPE)).toBe(false);
    expect(frames[0]).toMatchObject({
      process: PROCESS_SCOPE,
      capabilities: CAPABILITIES,
      payload: {
        kind: "output_delta",
        attribution: { vendorSessionId: "acp-session-1", vendorTurnId: null, vendorItemId: null },
      },
    });

    await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "end_turn" });
    const completed = frames.at(-2)?.payload;
    const terminal = frames.at(-1)?.payload;
    expect(completed?.kind).toBe("assistant_completed");
    if (completed?.kind !== "assistant_completed") throw new Error("missing completion candidate");
    expect(completed.text).toBe("hello world");
    expect(terminal?.kind).toBe("terminal");
    if (terminal?.kind !== "terminal") throw new Error("missing terminal");
    expect(terminal.status).toBe("completed");
    await expectRelayError(() => relay.project({
      kind: "agent_text_chunk", sessionId: PROCESS_SCOPE.acpSessionId, messageId: null, text: "late",
    }), "stale_scope");
  });

  test("classifies non-success stop reasons without promoting provisional output or diagnostics", async () => {
    const { relay, frames } = fixture();
    await relay.project({
      kind: "agent_text_chunk", sessionId: PROCESS_SCOPE.acpSessionId, messageId: null, text: "not final",
    });
    await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "refusal" });
    expect(frames.map((frame) => frame.payload.kind)).toEqual(["output_delta", "terminal"]);
    const terminal = frames.at(-1)?.payload;
    expect(terminal?.kind).toBe("terminal");
    if (terminal?.kind !== "terminal") throw new Error("missing terminal");
    expect(terminal).toEqual({
      kind: "terminal",
      attribution: terminal.attribution,
      status: "failed",
      code: "upstream_failure",
      message: "The external agent could not complete this task.",
    });
    expect(JSON.stringify(frames)).not.toContain("jsonrpc");
    expect(JSON.stringify(frames)).not.toContain("_meta");
  });

  test("fails closed when an end_turn has no final assistant candidate", async () => {
    const { relay, frames } = fixture();
    await relay.project({
      kind: "tool_call",
      sessionId: PROCESS_SCOPE.acpSessionId,
      toolCallId: "tool-1",
      title: "Inspect repository",
      status: "completed",
    });

    await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "end_turn" });

    expect(frames.map((frame) => frame.payload.kind)).toEqual(["command_summary", "terminal"]);
    const terminal = frames.at(-1)?.payload;
    expect(terminal?.kind).toBe("terminal");
    if (terminal?.kind !== "terminal") throw new Error("missing terminal");
    expect(terminal).toEqual({
      kind: "terminal",
      attribution: terminal.attribution,
      status: "failed",
      code: "upstream_failure",
      message: "The external agent could not complete this task.",
    });
  });

  test("reports one closed terminal-failure reason for every non-success stop", async () => {
    const cases = [
      ["end_turn", "end_turn_without_candidate"],
      ["max_tokens", "max_tokens"],
      ["max_turn_requests", "max_turn_requests"],
      ["refusal", "refusal"],
      ["cancelled", "unowned_cancelled"],
    ] as const;
    for (const [stopReason, expected] of cases) {
      const observed: string[] = [];
      const { relay, frames } = fixture({ onTerminalFailure: (reason) => { observed.push(reason); } });
      await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason });
      expect(observed).toEqual([expected]);
      expect(frames.at(-1)?.payload).toMatchObject({
        kind: "terminal", status: "failed", code: "upstream_failure",
      });
    }
  });

  test("isolates a terminal-failure diagnostic callback exception from the failure terminal", async () => {
    const { relay, frames } = fixture({
      onTerminalFailure: () => { throw new Error("diagnostic sink unavailable"); },
    });
    await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "refusal" });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      kind: "terminal", status: "failed", code: "upstream_failure",
    });
  });

  test("round-trips only an offered opaque permission option exactly once", async () => {
    const { relay, frames } = fixture();
    const selection = relay.permission(permission());
    await Promise.resolve();
    const projected = frames.at(-1)?.payload;
    expect(projected).toMatchObject({
      kind: "permission_selection_required",
      requestId: "request-1",
      vendorRequestId: null,
      ownerId: "owner-1",
      tool: { title: "Edit file", kind: "edit" },
      options: [
        { id: "allow_once", label: "Allow once", semanticHint: "allow_once" },
        { id: "reject_once", label: "Reject", semanticHint: "reject_once" },
      ],
    });
    relay.respond(response("request-1"));
    expect(await selection).toEqual({ outcome: "selected", optionId: "allow_once" });
    await expectRelayError(() => relay.respond(response("request-1")), "already_settled");
  });

  test("rejects wrong owner, every wrong host/process identity, and unoffered options without consuming the request", async () => {
    const identityMutations: readonly (readonly [keyof AcpHostScope | keyof AcpProcessScope, "host" | "process"])[] = [
      ...Object.keys(HOST_SCOPE).map((key) => [key as keyof AcpHostScope, "host"] as const),
      ...Object.keys(PROCESS_SCOPE).map((key) => [key as keyof AcpProcessScope, "process"] as const),
    ];
    for (const [key, kind] of identityMutations) {
      const { relay } = fixture();
      const pending = relay.permission(permission());
      await Promise.resolve();
      const changed = kind === "host"
        ? response("request-1", { scope: { ...HOST_SCOPE, [key]: typeof HOST_SCOPE[key as keyof AcpHostScope] === "number" ? 99 : "wrong" } })
        : response("request-1", { process: { ...PROCESS_SCOPE, [key]: typeof PROCESS_SCOPE[key as keyof AcpProcessScope] === "number" ? 99 : "wrong" } });
      await expectRelayError(() => relay.respond(changed), "stale_scope");
      relay.respond(response("request-1", { outcome: { kind: "cancelled" } }));
      expect(await pending).toEqual({ outcome: "cancelled" });
    }

    const { relay } = fixture();
    const pending = relay.permission(permission());
    await Promise.resolve();
    await expectRelayError(() => relay.respond(response("request-1", { ownerId: "owner-2" })), "wrong_owner");
    await expectRelayError(() => relay.respond(response("request-1", {
      outcome: { kind: "selected", optionId: "not-offered" },
    })), "invalid_request");
    relay.respond(response("request-1", { outcome: { kind: "cancelled" } }));
    expect(await pending).toEqual({ outcome: "cancelled" });
  });

  test("expires a permission to ACP cancelled and rejects the late browser response", async () => {
    const { relay, clock } = fixture();
    const pending = relay.permission(permission());
    await Promise.resolve();
    clock.advance(100);
    expect(await pending).toEqual({ outcome: "cancelled" });
    await expectRelayError(() => relay.respond(response("request-1")), "already_settled");
  });

  test("rejects another session before any semantic frame or permission side effect", async () => {
    const { relay, frames } = fixture();
    await expectRelayError(() => relay.project({
      kind: "agent_text_chunk", sessionId: "other-session", messageId: null, text: "wrong",
    }), "stale_scope");
    await expectRelayError(() => relay.permission({ ...permission(), sessionId: "other-session" }), "stale_scope");
    expect(frames).toEqual([]);
  });

  test("requires a live receipt and bounds permission expiry by the receipt", async () => {
    const clock = new FakeClock();
    const receiptExpiry = new Date(clock.now() + 50).toISOString();
    const { relay, frames } = fixture({
      clock,
      scope: { ...HOST_SCOPE, workspaceExpiresAt: receiptExpiry },
    });
    const pending = relay.permission(permission());
    await Promise.resolve();
    const projected = frames.at(-1)?.payload;
    expect(projected?.kind).toBe("permission_selection_required");
    if (projected?.kind !== "permission_selection_required") throw new Error("missing permission");
    expect(projected.expiresAt).toBe(receiptExpiry);
    clock.advance(50);
    expect(await pending).toEqual({ outcome: "cancelled" });
    await expectRelayError(() => relay.project({
      kind: "agent_text_chunk", sessionId: PROCESS_SCOPE.acpSessionId, messageId: null, text: "late",
    }), "stale_scope");
  });

  test("attributes cancelled terminal to Human Stop only after exact beginStop", async () => {
    const spontaneous = fixture();
    await spontaneous.relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "cancelled" });
    expect(spontaneous.frames.at(-1)?.payload).toMatchObject({
      kind: "terminal", status: "failed", code: "upstream_failure",
    });

    const diagnostics: string[] = [];
    const stopped = fixture({ onTerminalFailure: (reason) => { diagnostics.push(reason); } });
    const pending = stopped.relay.permission(permission());
    await Promise.resolve();
    stopped.relay.beginStop(PROCESS_SCOPE);
    expect(await pending).toEqual({ outcome: "cancelled" });
    await expectRelayError(() => stopped.relay.respond(response("request-1")), "already_settled");
    await stopped.relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "cancelled" });
    expect(stopped.frames.at(-1)?.payload).toMatchObject({
      kind: "terminal", status: "interrupted", code: "user_stop",
    });
    expect(diagnostics).toEqual([]);
  });

  test("auto-cancels a permission arriving after Stop without emitting an answerable request", async () => {
    const { relay, frames } = fixture();
    relay.beginStop(PROCESS_SCOPE);
    const selection = await relay.permission(permission());
    expect(selection).toEqual({ outcome: "cancelled" });
    expect(frames).toEqual([]);

    await relay.complete({ sessionId: PROCESS_SCOPE.acpSessionId, stopReason: "cancelled" });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      kind: "terminal", status: "interrupted", code: "user_stop",
    });
  });

  test("projects sanitized process failure without accepting raw diagnostics", async () => {
    const { relay, frames } = fixture();
    await relay.fail("process_lost");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      kind: "terminal",
      status: "failed",
      code: "process_lost",
      message: "The external agent could not complete this task.",
    });
  });

  test("preserves a completed tool status when a later update omits status", async () => {
    const { relay, frames } = fixture();
    await relay.project({
      kind: "tool_call", sessionId: PROCESS_SCOPE.acpSessionId, toolCallId: "tool-1",
      title: "Inspect", status: "completed",
    });
    await relay.project({
      kind: "tool_call", sessionId: PROCESS_SCOPE.acpSessionId, toolCallId: "tool-1",
      title: "", status: null,
    });
    expect(frames.at(-1)?.payload).toMatchObject({
      kind: "command_summary", commands: [{ summary: "Inspect", status: "completed" }],
    });
  });

  test("admits exactly 128 queued semantic frames with a slow consumer", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const { relay } = fixture({ emit: async () => { sends += 1; await blocked; } });
    const operations = Array.from({ length: 128 }, (_, index) => relay.project({
      kind: "agent_text_chunk" as const,
      sessionId: PROCESS_SCOPE.acpSessionId,
      messageId: `message-${index}`,
      text: "x",
    }));
    await Promise.resolve();
    expect(sends).toBe(1);
    release?.();
    await Promise.all(operations);
    expect(sends).toBe(128);
  });

  test("bounds the serialized semantic queue including in-flight sends and suppresses queued frames after failure", async () => {
    let sends = 0;
    const { relay } = fixture({ emit: () => { sends += 1; } });
    const operations = Array.from({ length: 129 }, (_, index) => relay.project({
      kind: "agent_text_chunk" as const,
      sessionId: PROCESS_SCOPE.acpSessionId,
      messageId: `message-${index}`,
      text: "x",
    }).then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ));
    const results = await Promise.all(operations);
    expect(results.filter((result) => result === "rejected")).toHaveLength(129);
    expect(sends).toBe(0);
  });

  test("server decoder validates the entire expected scope and canonicalizes away extensions", async () => {
    const { relay, frames, clock } = fixture();
    await relay.project({
      kind: "agent_text_chunk",
      sessionId: PROCESS_SCOPE.acpSessionId,
      messageId: null,
      text: "preview",
    });
    const wire = {
      ...frames[0],
      privateExtension: { raw: "must not escape" },
      payload: { ...frames[0]?.payload, _meta: { secret: true } },
    };
    const decoded = decodeAcpRelayFrame(new TextEncoder().encode(JSON.stringify(wire)), {
      scope: HOST_SCOPE,
      process: PROCESS_SCOPE,
      capabilities: CAPABILITIES,
      roomId: "room-1",
      now: clock.now(),
    });
    expect(decoded).toEqual({
      kind: "output_delta",
      attribution: {
        bindingId: "binding-1",
        bindingGeneration: "binding-generation-2",
        taskId: "task-1",
        roomId: "room-1",
        vendorSessionId: "acp-session-1",
        vendorTurnId: null,
        vendorItemId: null,
      },
      text: "preview",
    });
    expect(JSON.stringify(decoded)).not.toContain("privateExtension");
    expect(JSON.stringify(decoded)).not.toContain("_meta");

    const wrong = { ...wire, process: { ...PROCESS_SCOPE, processGeneration: 8 } };
    await expectRelayError(() => decodeAcpRelayFrame(new TextEncoder().encode(JSON.stringify(wrong)), {
      scope: HOST_SCOPE,
      process: PROCESS_SCOPE,
      capabilities: CAPABILITIES,
      roomId: "room-1",
      now: clock.now(),
    }), "stale_scope");
  });

  test("decoder accepts an admitted execution receipt beyond the private prepare minute and rejects its exact expiry", async () => {
    const base = Date.parse("2029-01-01T00:00:00.000Z");
    const receiptLifetimeMs = 60_000 + ACP_DEFAULT_INITIALIZE_TIMEOUT_MS + 15 * 60_000 +
      ACP_CANCELLATION_TERMINAL_WAIT_MS + ACP_TOTAL_TEARDOWN_TIMEOUT_MS + 5_000;
    const executionScope: AcpHostScope = Object.freeze({
      ...HOST_SCOPE,
      // Electron mints this opaque authority for the private 60s prepare
      // window plus bounded launch, turn, cancellation and delivery time.
      workspaceExpiresAt: new Date(base + receiptLifetimeMs).toISOString(),
    });
    const frames: AcpRelayFrame[] = [];
    const relay = new AcpSemanticRelay({
      scope: executionScope,
      process: PROCESS_SCOPE,
      roomId: "room-1",
      capabilities: CAPABILITIES,
      emit: (frame) => { frames.push(frame); },
      mintRequestId: () => "request-1",
    });
    await relay.project({ kind: "agent_text_chunk", sessionId: PROCESS_SCOPE.acpSessionId, messageId: null, text: "late but admitted" });
    const encoded = new TextEncoder().encode(JSON.stringify(frames[0]));
    const expected = { scope: executionScope, process: PROCESS_SCOPE, capabilities: CAPABILITIES, roomId: "room-1" } as const;

    expect(decodeAcpRelayFrame(encoded, { ...expected, now: base + 60_001 })).toMatchObject({ kind: "output_delta", text: "late but admitted" });
    expect(decodeAcpRelayFrame(encoded, { ...expected, now: base + receiptLifetimeMs - 1 })).toMatchObject({ kind: "output_delta" });
    expect(() => decodeAcpRelayFrame(encoded, { ...expected, now: base + receiptLifetimeMs })).toThrow("workspace expiry must be a future ISO timestamp");
  });

  test("rejects unvalidated capability claims and incoherent decoded terminals", () => {
    expect(() => fixture({ capabilities: { ...CAPABILITIES } })).toThrow(
      "capability truth must come from validated initialization",
    );
    const expectation = {
      scope: HOST_SCOPE, process: PROCESS_SCOPE, capabilities: CAPABILITIES,
      roomId: "room-1", now: Date.parse("2026-08-09T00:00:00.000Z"),
    } as const;
    const base = {
      scope: HOST_SCOPE,
      process: PROCESS_SCOPE,
      capabilities: CAPABILITIES,
      payload: {
        kind: "terminal",
        attribution: {
          bindingId: HOST_SCOPE.bindingId,
          bindingGeneration: HOST_SCOPE.bindingGeneration,
          taskId: HOST_SCOPE.taskId,
          roomId: "room-1",
          vendorSessionId: PROCESS_SCOPE.acpSessionId,
          vendorTurnId: null,
          vendorItemId: null,
        },
        status: "failed",
        code: "user_stop",
      },
    };
    expect(() => decodeAcpRelayFrame(new TextEncoder().encode(JSON.stringify(base)), expectation)).toThrow(
      "failed ACP terminal lacks a stable failure code",
    );
    expect(() => decodeAcpRelayFrame(new Uint8Array(256 * 1024 + 1), expectation)).toThrow(
      "frame exceeds its bound",
    );
    expect(() => decodeAcpRelayFrame(new TextEncoder().encode("{"), expectation)).toThrow(
      "frame is malformed",
    );
  });

  test("enforces pending permission count and byte bounds without truncating options", async () => {
    const count = fixture();
    const pending = Array.from({ length: 16 }, () => count.relay.permission(permission()));
    await Promise.resolve();
    await expectRelayError(() => count.relay.permission(permission()), "relay_overflow");
    count.relay.close();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 16 }, () => ({ outcome: "cancelled" })));

    const bytes = fixture();
    const largeLabel = "x".repeat(64 * 1024);
    const large = {
      ...permission(),
      options: [
        { optionId: "one", name: largeLabel, kind: "allow_once" },
        { optionId: "two", name: largeLabel, kind: "reject_once" },
        { optionId: "three", name: largeLabel, kind: "reject_always" },
      ],
    } as const;
    const bytePending = Array.from({ length: 5 }, () => bytes.relay.permission(large));
    await Promise.resolve();
    await expectRelayError(() => bytes.relay.permission(large), "relay_overflow");
    bytes.relay.close();
    expect((await Promise.all(bytePending)).every((item) => item.outcome === "cancelled")).toBe(true);
  });
});
