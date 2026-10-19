import { expect, test } from "bun:test";
import type { BolterBindingContext, BolterPublicationContent } from "@nautilo/db";
import { createBolterPublicationService, type BolterPublicationTransport } from "../../src/messaging/bolter-publication";

const receiver: BolterBindingContext = { userId: "owner", connectionId: "connection", connectionGeneration: 1,
  relayId: "relay", desktopSessionId: "desktop", pairingGenerationRef: "pairing", bindingId: "binding", bindingRevision: 0 };
const content: BolterPublicationContent = { origin: "https://bolter.chat", providerAgentId: "agent",
  chatId: "chat", threadRootId: "thread", content: "Synthetic final reply" };
const receipt = { messageId: "provider-reply", chatId: "chat", threadRootId: "thread" };

function fixture() {
  const state = { current: true, claimed: false, loads: 0, sends: 0, claims: 0,
    settleFails: false, settlementMissing: false, content: content as BolterPublicationContent | null,
    settlements: [] as { state: string; outboxId: string; claimToken: string; providerMessageId?: string }[] };
  const store = {
    async claim(context: BolterBindingContext, id: string) {
      expect(context).toEqual(receiver); expect(id).toBe("outbox"); state.claims++;
      if (state.claimed) return null;
      state.claimed = true; return { claimToken: "claim" };
    },
    async load(context: BolterBindingContext, claim: { outboxId: string; claimToken: string }) {
      expect(context).toEqual(receiver); expect(claim).toEqual({ outboxId: "outbox", claimToken: "claim" });
      state.loads++; return state.content;
    },
    async settle(_context: BolterBindingContext, input: typeof state.settlements[number]) {
      state.settlements.push(input);
      if (state.settleFails) throw new Error("Synthetic private diagnostic must remain contained");
      return state.settlementMissing ? null : { ...input };
    },
  };
  const transport: BolterPublicationTransport = {
    isCurrent: () => state.current,
    async send(request) {
      state.sends++;
      const authorized = await request.authorize();
      if (!authorized) return { status: "unavailable" };
      expect(authorized).toEqual(content);
      return { status: "sent", receipt };
    },
  };
  return { state, store, transport, service: () => createBolterPublicationService({ store, transport }) };
}

test("only one durable claim sends the canonical final reply to its exact thread", async () => {
  const f = fixture(); const service = f.service();
  const outcomes = await Promise.all([service.publish(receiver, "outbox"), service.publish(receiver, "outbox")]);
  expect(outcomes).toEqual([{ status: "published", providerMessageId: receipt.messageId }, { status: "unavailable" }]);
  expect(f.state.sends).toBe(1); expect(f.state.loads).toBe(1);
  expect(f.state.settlements).toEqual([{ outboxId: "outbox", claimToken: "claim", state: "published", providerMessageId: receipt.messageId }]);
});

test("offline receiver cannot claim; retirement while claiming cannot load or dispatch", async () => {
  const offline = fixture(); offline.state.current = false;
  expect(await offline.service().publish(receiver, "outbox")).toEqual({ status: "unavailable" });
  expect(offline.state.claims).toBe(0); expect(offline.state.sends).toBe(0);
  const retired = fixture(); const claim = retired.store.claim;
  retired.store.claim = async (...args) => { const result = await claim(...args); retired.state.current = false; return result; };
  expect(await retired.service().publish(receiver, "outbox")).toEqual({ status: "cancelled" });
  expect(retired.state.sends).toBe(0); expect(retired.state.loads).toBe(0);
});

test("fresh authorization is one-shot and does not return content after retirement during load", async () => {
  const once = fixture();
  once.transport.send = async request => {
    const values = await Promise.all([request.authorize(), request.authorize()]);
    expect(values).toEqual([content, null]); return { status: "sent", receipt };
  };
  expect(await once.service().publish(receiver, "outbox")).toEqual({ status: "published", providerMessageId: receipt.messageId });
  expect(once.state.loads).toBe(1);
  const retired = fixture(); const load = retired.store.load;
  retired.store.load = async (...args) => { const result = await load(...args); retired.state.current = false; return result; };
  expect(await retired.service().publish(receiver, "outbox")).toEqual({ status: "cancelled" });
  expect(retired.state.settlements.at(-1)?.state).toBe("cancelled");
});

test("withdrawn canonical publication is cancelled without a provider send", async () => {
  const f = fixture(); f.state.content = null;
  expect(await f.service().publish(receiver, "outbox")).toEqual({ status: "cancelled" });
  expect(f.state.loads).toBe(1);
});

test("lost provider response remains uncertain and cannot automatically resend", async () => {
  const f = fixture();
  f.transport.send = async request => { f.state.sends++; await request.authorize(); throw new Error("Synthetic transport response loss"); };
  const service = f.service();
  expect(await service.publish(receiver, "outbox")).toEqual({ status: "uncertain" });
  expect(await service.publish(receiver, "outbox")).toEqual({ status: "unavailable" });
  expect(f.state.sends).toBe(1); expect(f.state.settlements.at(-1)?.state).toBe("uncertain");
});

test("claimed success without authorization, exact destination or a valid ID never records delivery", async () => {
  const unauthenticated = fixture(); unauthenticated.transport.send = async () => ({ status: "sent", receipt });
  expect(await unauthenticated.service().publish(receiver, "outbox")).toEqual({ status: "uncertain" });
  for (const patch of [{ chatId: "other" }, { threadRootId: null }, { messageId: "" }, { messageId: "private\nvalue" }]) {
    const f = fixture(); f.transport.send = async request => { await request.authorize(); return { status: "sent", receipt: { ...receipt, ...patch } }; };
    expect(await f.service().publish(receiver, "outbox")).toEqual({ status: "uncertain" });
    expect(f.state.settlements.some(row => row.state === "published")).toBe(false);
  }
});

test("provider success with lost durable settlement or stale receiver stays uncertain", async () => {
  for (const missing of [false, true]) {
    const f = fixture(); f.state.settleFails = !missing; f.state.settlementMissing = missing;
    expect(await f.service().publish(receiver, "outbox")).toEqual({ status: "uncertain" });
  }
  const stale = fixture(); stale.transport.send = async request => { await request.authorize(); stale.state.current = false; return { status: "sent", receipt }; };
  expect(await stale.service().publish(receiver, "outbox")).toEqual({ status: "uncertain" });
  expect(stale.state.settlements.at(-1)?.state).toBe("uncertain");
});

test("caller mutation cannot replace receiver identity, stored ports or final content", async () => {
  const f = fixture(); const input = { ...receiver }; const loaded = { ...content };
  f.state.content = loaded;
  f.transport.send = async request => {
    input.bindingId = "other";
    expect(request.receiver.bindingId).toBe(receiver.bindingId);
    expect(Object.isFrozen(request.receiver)).toBe(true);
    const result = await request.authorize(); loaded.chatId = "other";
    expect(result?.chatId).toBe(content.chatId); expect(Object.isFrozen(result)).toBe(true);
    return { status: "sent", receipt };
  };
  const service = f.service(); f.transport.isCurrent = () => false;
  expect(await service.publish(input, "outbox")).toEqual({ status: "published", providerMessageId: receipt.messageId });
});

test("retained authorization cannot release text after the transport attempt ends", async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let authorize: (() => Promise<BolterPublicationContent | null>) | undefined;
    f.transport.send = async request => { authorize = request.authorize;
      if (fail) throw new Error("Synthetic response loss");
      return { status: "unavailable" };
    };
    expect(await f.service().publish(receiver, "outbox")).toEqual({ status: fail ? "uncertain" : "cancelled" });
    expect(await authorize!()).toBeNull(); expect(f.state.loads).toBe(0);
  }
});

test("an in-flight content read finishing after send returns or throws releases no text", async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let finishRead!: () => void;
    const pending = new Promise<void>(resolve => { finishRead = resolve; });
    const load = f.store.load;
    f.store.load = async (...args) => { await pending; return load(...args); };
    let authorization: Promise<BolterPublicationContent | null> | undefined;
    f.transport.send = async request => {
      authorization = request.authorize();
      if (fail) throw new Error("Synthetic response loss");
      return { status: "unavailable" };
    };
    expect(await f.service().publish(receiver, "outbox")).toEqual({ status: fail ? "uncertain" : "cancelled" });
    finishRead(); expect(await authorization).toBeNull();
  }
});

test("rejected content authorization returns no text and contains private diagnostics", async () => {
  const f = fixture();
  f.store.load = async () => { throw new Error("Synthetic private read diagnostic"); };
  expect(await f.service().publish(receiver, "outbox")).toEqual({ status: "cancelled" });
  expect(f.state.settlements.at(-1)?.state).toBe("cancelled");
});

test("file preparation must revalidate the same claim and immutable content before later dispatch", async () => {
  const f = fixture();
  f.transport.send = async request => {
    expect(await request.reauthorize()).toBe(false);
    expect(await request.authorize()).toEqual(content);
    expect(await request.reauthorize()).toBe(true);
    f.state.content = { ...content, chatId: "other-chat" };
    expect(await request.reauthorize()).toBe(false);
    f.state.content = content;
    f.state.current = false;
    expect(await request.reauthorize()).toBe(false);
    return { status: "uncertain" };
  };
  expect(await f.service().publish(receiver, "outbox")).toEqual({ status: "uncertain" });
});
