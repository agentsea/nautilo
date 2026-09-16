import { describe, expect, test } from "bun:test";
import { createAcpStableV1LiveSessionConnector } from "../../src/index.js";

type Json = Record<string, unknown>;

function streams() {
  const outbound = new TransformStream<Uint8Array, Uint8Array>();
  const inbound = new TransformStream<Uint8Array, Uint8Array>();
  return { input: inbound.readable, output: outbound.writable, peerIn: outbound.readable, peerOut: inbound.writable };
}

async function readOne(source: ReadableStream<Uint8Array>): Promise<Json> {
  const reader = source.getReader();
  try {
    const value = await reader.read();
    return JSON.parse(new TextDecoder().decode(value.value).trim()) as Json;
  } finally { reader.releaseLock(); }
}
async function send(target: WritableStream<Uint8Array>, value: Json): Promise<void> {
  const writer = target.getWriter();
  try { await writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`)); } finally { writer.releaseLock(); }
}

describe("AcpStableV1LiveSession", () => {
  test("does not publish its binding until the one initialize and session/new handshake completes", async () => {
    const wire = streams();
    let initialized = 0;
    let created = 0;
    const connector = createAcpStableV1LiveSessionConnector(() => ({
      prompt: "one prompt",
      onNegotiated: () => undefined,
      onSessionStarted: () => undefined,
      onEvent: () => undefined,
    }));
    const connecting = connector.connect({ ...wire, input: wire.input, output: wire.output, cwd: "/tmp", signal: new AbortController().signal, bindingId: "binding", registrationId: "hermes-acp", generation: 1 });
    const initialize = await readOne(wire.peerIn);
    expect(initialize["method"]).toBe("initialize");
    initialized += 1;
    let settled = false;
    void connecting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse();
    await send(wire.peerOut, { jsonrpc: "2.0", id: initialize["id"], result: { protocolVersion: 1, agentInfo: { name: "fake", version: "1" } } });
    const sessionNew = await readOne(wire.peerIn);
    expect(sessionNew["method"]).toBe("session/new");
    created += 1;
    await send(wire.peerOut, { jsonrpc: "2.0", id: sessionNew["id"], result: { sessionId: "session-1" } });
    const prompt = await readOne(wire.peerIn);
    expect(prompt["method"]).toBe("session/prompt");
    const binding = await connecting;
    expect([initialized, created]).toEqual([1, 1]);
    await send(wire.peerOut, { jsonrpc: "2.0", id: prompt["id"], result: { stopReason: "end_turn" } });
    expect(binding.turn).toBeDefined();
    const result = await binding.turn!();
    expect(result).toMatchObject({ sessionId: "session-1" });
  });

  test("aborts a stalled pre-session handshake without leaving a live connector", async () => {
    const wire = streams();
    const controller = new AbortController();
    const connector = createAcpStableV1LiveSessionConnector(() => ({
      prompt: "one prompt", onNegotiated: () => undefined, onSessionStarted: () => undefined, onEvent: () => undefined,
    }));
    const connecting = connector.connect({ ...wire, input: wire.input, output: wire.output, cwd: "/tmp", signal: controller.signal, bindingId: "binding", registrationId: "hermes-acp", generation: 1 });
    const initialize = await readOne(wire.peerIn);
    expect(initialize["method"]).toBe("initialize");
    controller.abort();
    try {
      await connecting;
      throw new Error("expected connector rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "closed" });
    }
  });
});
