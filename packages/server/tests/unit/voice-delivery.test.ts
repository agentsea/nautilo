import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { VoiceDelivery } from "../../src/realtime/voice-delivery";
import { ClientActionBindingRegistry } from "../../src/realtime/client-action-binding-registry";
import type { VoiceStreamStart } from "@nautilo/types";

class Socket extends EventEmitter {
  OPEN = 1; readyState = 1; bufferedAmount = 0;
  sent: unknown[] = [];
  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit("close"); }
  get ws() { return this as unknown as WebSocket; }
}
const start: VoiceStreamStart = { type: "voice.stream.start", streamId: "11111111-1111-4111-8111-111111111111", version: 1, turnId: "turn", roomId: "room", agentId: "agent", model: "eleven_v3", channels: 1, sampleRate: 24000, encoding: "pcm_s16le" };
const frame = (sequence: number) => ({ streamId: start.streamId, sequence, pcm: new Uint8Array(48000) });
function add(delivery: VoiceDelivery, userId = "owner", protocol = true) {
  const socket = new Socket();
  const membership = { userId, roomIds: new Set(["room"]) };
  delivery.register(socket.ws, membership, protocol);
  if (protocol) delivery.update(socket.ws, { type: "voice.listen", version: 1, roomId: "room", enabled: true });
  return { socket, membership };
}

describe("private voice delivery", () => {
  test("requires opt-in, membership and exact owner; late listeners cannot join a live turn", async () => {
    const delivery = new VoiceDelivery();
    const { socket } = add(delivery);
    const foreign = add(delivery, "other").socket;
    expect(delivery.update(socket.ws, { type: "voice.listen", version: 1, roomId: "unowned", enabled: true })).toBe(false);
    const audience = delivery.admit("owner", "room")!;
    expect(audience.format).toBe("pcm_24000");
    const late = add(delivery).socket;
    audience.control(start); await audience.audio(frame(0));
    expect(socket.sent.length).toBe(2);
    expect(foreign.sent).toHaveLength(0); expect(late.sent).toHaveLength(0);
    delivery.update(socket.ws, { type: "voice.listen", version: 1, roomId: null, enabled: false });
    expect(audience.signal.aborted).toBe(true);
    audience.dispose();
  });
  test("mixed clients select one legacy generation; revocation stops admission", () => {
    const delivery = new VoiceDelivery();
    const current = add(delivery);
    const old = add(delivery, "owner", false);
    const audience = delivery.admit("owner", "room", old.socket.ws)!;
    expect(audience.format).toBe("mp3_44100_128");
    audience.legacy({ type: "voice.audio", data: "AAAA", chunkIndex: 0, sentenceIndex: 0, final: true });
    expect(current.socket.sent).toEqual(old.socket.sent);
    current.membership.roomIds.clear(); old.membership.roomIds.clear(); delivery.refresh();
    expect(audience.signal.aborted).toBe(true);
    expect(delivery.admit("owner", "room")).toBeNull();
    audience.dispose();
  });
  test("bounds unconsumed audio and requires authentic monotonic credits", async () => {
    const delivery = new VoiceDelivery();
    const { socket } = add(delivery);
    const foreign = add(delivery, "other").socket;
    const audience = delivery.admit("owner", "room")!;
    audience.control(start);
    for (let i = 0; i < 4; i++) await audience.audio(frame(i));
    let resolved = false;
    const pending = audience.audio(frame(4)).then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    expect(delivery.consumed(foreign.ws, { streamId: start.streamId, samples: 24000 })).toBe(false);
    expect(delivery.consumed(socket.ws, { streamId: start.streamId, samples: 999999 })).toBe(false);
    expect(delivery.consumed(socket.ws, { streamId: start.streamId, samples: 24000 })).toBe(true);
    await pending; expect(resolved).toBe(true);
    expect(delivery.consumed(socket.ws, { streamId: start.streamId, samples: 0 })).toBe(false);
    audience.dispose();
  });
  test("detach cancels a producer waiting for consumption", async () => {
    const delivery = new VoiceDelivery(); const { socket } = add(delivery);
    const audience = delivery.admit("owner", "room")!; audience.control(start);
    for (let i = 0; i < 4; i++) await audience.audio(frame(i));
    const pending = audience.audio(frame(4)); socket.close();
    let rejected = false;
    try { await pending; } catch (error) { rejected = error instanceof Error && error.message.includes("detached"); }
    expect(rejected).toBe(true); audience.dispose();
  });
  test("provider end retains playback credits until the final samples are consumed", async () => {
    const delivery = new VoiceDelivery(); const { socket } = add(delivery);
    const audience = delivery.admit("owner", "room")!; audience.control(start);
    await audience.audio(frame(0));
    audience.control({ type: "voice.stream.end", streamId: start.streamId, sequence: 1 });
    let done = false;
    const draining = audience.drained().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    delivery.consumed(socket.ws, { streamId: start.streamId, samples: 23999 });
    await Promise.resolve(); expect(done).toBe(false);
    delivery.consumed(socket.ws, { streamId: start.streamId, samples: 24000 });
    await draining; expect(done).toBe(true);
    audience.dispose();
  });
});

test("idle legacy connections do not downgrade an opted-in PCM listener", async () => {
  const delivery = new VoiceDelivery(); const current = add(delivery); const old = add(delivery, "owner", false);
  const audience = delivery.admit("owner", "room", current.socket.ws)!;
  expect(audience.format).toBe("pcm_24000"); audience.control(start); await audience.audio(frame(0));
  expect(old.socket.sent).toEqual([]); expect(current.socket.sent).toHaveLength(2); audience.dispose();
});
test("legacy-only clients still receive compatible audio", () => {
  const delivery = new VoiceDelivery(); add(delivery, "owner", false);
  const audience = delivery.admit("owner", "room")!;
  expect(audience.format).toBe("mp3_44100_128"); audience.dispose();
});

test("a legacy initiator still selects MP3 after guidance consumes its UI binding", () => {
  const delivery = new VoiceDelivery(); const current = add(delivery); const old = add(delivery, "owner", false);
  const registry = new ClientActionBindingRegistry();
  const clientActionSessionId = "A".repeat(22);
  registry.registerLiveSession({ socket: old.socket, clientActionSessionId, actorId: "owner" });
  registry.bind(registry.reserve({ clientActionSessionId, actorId: "owner" })!, "turn");
  registry.consumeOnce("turn");
  const audience = delivery.admit("owner", "room", registry.inspectTurnSocket("turn"))!;
  expect(audience.format).toBe("mp3_44100_128");
  audience.legacy({ type: "voice.audio", data: "AAAA", chunkIndex: 0, sentenceIndex: 0, final: true });
  expect(old.socket.sent).toHaveLength(1); expect(current.socket.sent).toEqual(old.socket.sent);
  expect(registry.consumeOnce("turn")).toBeNull(); audience.dispose();
});

test("reconnect and permission restoration cannot rejoin an admitted stream", async () => {
  const delivery = new VoiceDelivery(); const original = add(delivery); const other = add(delivery);
  const audience = delivery.admit("owner", "room")!; audience.control(start);
  original.socket.close(); const replacement = add(delivery);
  other.membership.roomIds.clear(); delivery.refresh();
  expect(audience.signal.aborted).toBe(true);
  other.membership.roomIds.add("room"); delivery.refresh();
  let rejected = false;
  try { await audience.audio(frame(0)); } catch (error) { rejected = error instanceof Error && error.message.includes("detached"); }
  expect(rejected).toBe(true);
  expect(replacement.socket.sent).toHaveLength(0); audience.dispose();
});

test("different native playback clocks do not truncate a healthy listener", async () => {
  const delivery = new VoiceDelivery(); const fast = add(delivery).socket; const slow = add(delivery).socket;
  const audience = delivery.admit("owner", "room")!; audience.control(start);
  for (let i = 0; i < 4; i++) await audience.audio(frame(i));
  delivery.consumed(fast.ws, { streamId: start.streamId, samples: 24000 });
  let delivered = false;
  const pending = audience.audio(frame(4)).then(() => { delivered = true; });
  await Promise.resolve(); expect(delivered).toBe(false);
  delivery.consumed(slow.ws, { streamId: start.streamId, samples: 24000 });
  await pending;
  expect(fast.sent).toEqual(slow.sent); expect(slow.sent).toHaveLength(6); audience.dispose();
});
test("a listener stalled for its whole audio window detaches without stopping the healthy device", async () => {
  let now = 0;
  const delivery = new VoiceDelivery(() => now); const fast = add(delivery).socket; const stalled = add(delivery).socket;
  const audience = delivery.admit("owner", "room")!; audience.control(start);
  for (let i = 0; i < 4; i++) await audience.audio(frame(i));
  delivery.consumed(fast.ws, { streamId: start.streamId, samples: 24000 });
  const pending = audience.audio(frame(4)); now = 4000; delivery.refresh(); await pending;
  expect(stalled.sent.at(-1)).toBe(JSON.stringify({ type: "voice.stream.abort", streamId: start.streamId, reason: "overflow" }));
  expect(fast.sent.at(-1)).toBeInstanceOf(Uint8Array); expect(audience.signal.aborted).toBe(false); audience.dispose();
});
