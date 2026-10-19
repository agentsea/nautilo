import { expect, test } from "bun:test";
import type { RelayBolterCommand, RelayBolterDesktopMessage, RelayBolterScope } from "@nautilo/relay";
import type { BolterConnectionObservation, BolterNativeCommand, BolterReceivedMessage } from "@nautilo/types";
import { createBolterNativeRelayPort, type BolterNativeConnectionDriver } from "../../electron/bolter-bridge/relay-port";

const id = "10000000-0000-4000-8000-000000000001";
const outboxId = "10000000-0000-4000-8000-000000000002";
const bindingId = "10000000-0000-4000-8000-000000000003";
const scope: RelayBolterScope = { relayId: "desktop", relaySessionId: "relay-session", desktopSessionId: "desktop-session",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 30, capabilityRevision: 1 };
const observation: BolterConnectionObservation = { runtime: "qualified", authentication: "confirmed",
  identity: { providerAgentId: "synthetic-agent", label: "Synthetic agent", identityFingerprint: "a".repeat(64) }, receiver: "running" };
function fixture(options: { failFirstFactory?: boolean; deferFirstSend?: boolean } = {}) {
  let factoryCalls = 0;
  let preparations = 0;
  const messages: RelayBolterDesktopMessage[] = [];
  const observations: ((value: BolterConnectionObservation) => void)[] = [];
  const drivers: { retired: boolean; current: () => boolean; generation: number }[] = [];
  let sends = 0;
  let intake: ((messages: readonly BolterReceivedMessage[], batchId: string) => Promise<boolean>) | undefined;
  const port = createBolterNativeRelayPort({ isCurrent: () => true, createConnection: input => {
    if (options.failFirstFactory && factoryCalls++ === 0) return Promise.reject(new Error("Synthetic unavailable runtime"));
    const state = { retired: false, current: input.isCurrent, generation: input.generation }; drivers.push(state);
    const driver: BolterNativeConnectionDriver = {
      connect: () => Promise.resolve(observation), check: () => Promise.resolve(observation),
      conversations: () => Promise.resolve({ kind: "conversations", conversations: [] }),
      start: (accept, onObservation) => { intake = accept; if (onObservation) observations.push(onObservation); return Promise.resolve(observation); }, pause: () => Promise.resolve({ ...observation, receiver: "stopped" }),
      prepareSend: () => Promise.resolve(options.deferFirstSend && preparations++ === 0 ? null : content => { sends++; return Promise.resolve({ kind: "sent", receipt: { messageId: "synthetic-reply",
        chatId: content.chatId, threadRootId: content.threadRootId } }); }),
      retire: () => { state.retired = true; return Promise.resolve(); },
    };
    return Promise.resolve(driver);
  } });
  port.onRegistered(scope, { send: message => { messages.push(message); return true; } });
  let sequence = 10;
  const envelope = (command: BolterNativeCommand): RelayBolterCommand => ({ type: "relay:bolter-command", version: 30,
    scope, correlationId: `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`, command });
  return { port, envelope, messages, drivers, observations, sends: () => sends,
    batch: (batchId: string) => { if (!intake) throw new Error("Synthetic receiver absent"); return intake([], batchId); } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("old server peers receive legacy observations while new peers can observe file support", async () => {
  for (const version of [30, 31]) {
    const selected = { ...scope, selectedProtocolVersion: version };
    const messages: RelayBolterDesktopMessage[] = [];
    const supported = { ...observation, attachments: true };
    const port = createBolterNativeRelayPort({ isCurrent: () => true, createConnection: async () => ({
      connect: async () => supported, check: async () => supported, pause: async () => supported,
      start: async () => supported, conversations: async () => ({ kind: "conversations", conversations: [] }),
      prepareSend: async () => null, retire: async () => {},
    }) });
    port.onRegistered(selected, { send: message => { messages.push(message); return true; } });
    await port.onCommand({ type: "relay:bolter-command", version: 30, scope: selected, correlationId: outboxId,
      command: { action: "check", connectionId: id, generation: 1 } });
    const last = messages.at(-1);
    expect(last?.type === "relay:bolter-result" && last.result.kind === "observation" ? last.result.observation.attachments : null)
      .toBe(version === 31 ? true : undefined);
    await port.retire();
  }
});

test("native send releases no text until exact one-shot authorization and never replays an outbox", async () => {
  const f = fixture();
  const command = f.envelope({ action: "send", connectionId: id, generation: 1, outboxId, bindingId, bindingRevision: 0 });
  const sending = f.port.onCommand(command); await tick();
  expect(f.sends()).toBe(0);
  expect(f.messages.at(-1)?.type).toBe("relay:bolter-authorize");
  f.port.onAuthorized({ type: "relay:bolter-authorized", version: 30, scope, correlationId: command.correlationId,
    outboxId: bindingId, content: { chatId: "wrong", threadRootId: null, content: "wrong" } });
  expect(f.sends()).toBe(0);
  const authorized = { type: "relay:bolter-authorized" as const, version: 30 as const, scope, correlationId: command.correlationId,
    outboxId, content: { chatId: "synthetic-chat", threadRootId: null, content: "Synthetic text" } };
  f.port.onAuthorized(authorized); f.port.onAuthorized(authorized); await sending;
  expect(f.sends()).toBe(1);
  await f.port.onCommand(f.envelope(command.command));
  expect(f.sends()).toBe(1);
  await f.port.retire();
});

test("new connection generation retires old receiver, settles its pending batch, and rejects stale commands", async () => {
  const f = fixture();
  await f.port.onCommand(f.envelope({ action: "start_receiver", connectionId: id, generation: 1 }));
  const batch = f.batch("10000000-0000-4000-8000-000000000004");
  await tick();
  await f.port.onCommand(f.envelope({ action: "pause", connectionId: id, generation: 2 }));
  expect(await batch).toBe(false);
  expect(f.drivers).toHaveLength(2);
  expect(f.drivers[0]?.retired).toBe(true);
  expect(f.drivers[0]?.current()).toBe(false);
  expect(f.drivers[1]?.current()).toBe(true);
  await f.port.onCommand(f.envelope({ action: "check", connectionId: id, generation: 1 }));
  expect(f.drivers).toHaveLength(2);
  const result = f.messages.at(-1);
  expect(result?.type === "relay:bolter-result" && result.result.kind).toBe("unavailable");
  await f.port.retire();
});

test("session replacement fences late send authorization and drains native drivers", async () => {
  const f = fixture();
  const command = f.envelope({ action: "send", connectionId: id, generation: 1, outboxId, bindingId, bindingRevision: 0 });
  const sending = f.port.onCommand(command); await tick();
  f.port.onRegistered({ ...scope, capabilityRevision: 2 }, { send: () => true });
  f.port.onAuthorized({ type: "relay:bolter-authorized", version: 30, scope, correlationId: command.correlationId, outboxId,
    content: { chatId: "synthetic-chat", threadRootId: null, content: "Synthetic text" } });
  await sending; await f.port.retire();
  expect(f.sends()).toBe(0);
  expect(f.drivers[0]?.retired).toBe(true);
});

test("receive handover waits exact durable batch acknowledgment", async () => {
  const f = fixture();
  await f.port.onCommand(f.envelope({ action: "start_receiver", connectionId: id, generation: 1 }));
  const batchId = "10000000-0000-4000-8000-000000000004";
  let settled = false;
  const batch = f.batch(batchId).then(value => { settled = true; return value; });
  await tick(); expect(settled).toBe(false);
  f.port.onBatchAck({ type: "relay:bolter-batch-ack", version: 30, scope, connectionId: id, generation: 2, batchId, status: "accepted" });
  await tick(); expect(settled).toBe(false);
  f.port.onBatchAck({ type: "relay:bolter-batch-ack", version: 30, scope, connectionId: id, generation: 1, batchId, status: "accepted" });
  expect(await batch).toBe(true);
  await f.port.retire();
});

test("failed connection creation can recover in the same session and generation", async () => {
  const f = fixture({ failFirstFactory: true });
  await f.port.onCommand(f.envelope({ action: "check", connectionId: id, generation: 1 }));
  expect(f.drivers).toHaveLength(0);
  await f.port.onCommand(f.envelope({ action: "check", connectionId: id, generation: 1 }));
  expect(f.drivers).toHaveLength(1);
  const result = f.messages.at(-1);
  expect(result?.type === "relay:bolter-result" && result.result.kind).toBe("observation");
  await f.port.retire();
});

test("proven-not-dispatched send can recover the same outbox after qualification", async () => {
  const f = fixture({ deferFirstSend: true });
  const command = { action: "send" as const, connectionId: id, generation: 1, outboxId, bindingId, bindingRevision: 0 };
  await f.port.onCommand(f.envelope(command));
  expect(f.sends()).toBe(0);
  const retry = f.envelope(command);
  const sending = f.port.onCommand(retry); await tick();
  expect(f.messages.at(-1)?.type).toBe("relay:bolter-authorize");
  f.port.onAuthorized({ type: "relay:bolter-authorized", version: 30, scope, correlationId: retry.correlationId, outboxId,
    content: { chatId: "synthetic-chat", threadRootId: null, content: "Synthetic text" } });
  await sending;
  expect(f.sends()).toBe(1);
  await f.port.retire();
});


test("failed newer generation cannot restore a stale receiver generation", async () => {
  const f = fixture({ failFirstFactory: true });
  await f.port.onCommand(f.envelope({ action: "check", connectionId: id, generation: 2 }));
  await f.port.onCommand(f.envelope({ action: "start_receiver", connectionId: id, generation: 1 }));
  expect(f.drivers).toHaveLength(0);
  await f.port.onCommand(f.envelope({ action: "check", connectionId: id, generation: 2 }));
  expect(f.drivers).toHaveLength(1);
  expect(f.drivers[0]?.generation).toBe(2);
  await f.port.retire();
});


test("receiver observations reach only the exact active connection generation", async () => {
  const f = fixture();
  await f.port.onCommand(f.envelope({ action: "start_receiver", connectionId: id, generation: 1 }));
  f.observations[0]!({ ...observation, receiver: "listening" });
  expect(f.messages.at(-1)).toMatchObject({ type: "relay:bolter-observation", connectionId: id, generation: 1,
    observation: { receiver: "listening" } });
  await f.port.onCommand(f.envelope({ action: "start_receiver", connectionId: id, generation: 2 }));
  const count = f.messages.length;
  f.observations[0]!({ ...observation, receiver: "listening" });
  expect(f.messages).toHaveLength(count);
  f.observations[1]!({ ...observation, receiver: "stopped" });
  expect(f.messages.at(-1)).toMatchObject({ type: "relay:bolter-observation", generation: 2, observation: { receiver: "stopped" } });
  await f.port.retire();
  const retiredCount = f.messages.length;
  f.observations[1]!({ ...observation, receiver: "listening" });
  expect(f.messages).toHaveLength(retiredCount);
});
