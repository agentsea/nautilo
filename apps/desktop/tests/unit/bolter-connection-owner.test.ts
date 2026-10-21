import { expect, spyOn, test as bunTest } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, chmod, realpath, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getBolterProductionDecoders } from "../../electron/bolter-bridge/production-contract";
import { BolterConnectionOwner } from "../../electron/bolter-bridge/connection-owner";
import { BolterInboxSpool, createBolterSpoolDirectory } from "../../electron/bolter-bridge/inbox-spool";
import { handOverBolterBatch, parseBolterHandoverDescriptor } from "../../electron/bolter-bridge/handover";
import type { BolterCliInvocation, BolterQualifiedDecoders } from "../../electron/bolter-bridge/cli-contract";

// Bolter is unsupported on Windows (the CLI contract refuses win32); the owner
// relies on Unix-socket handover and POSIX permission bits.
const test = bunTest.skipIf(process.platform === "win32");

const scope = { serverId: "synthetic-server", userId: "synthetic-human", connectionId: "synthetic-connection" };
const runtime = { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home", platform: "linux" as const, version: "synthetic-v1" };
const productionVersion = "0123456789abcdef0123456789abcdef01234567";
const selection = { origin: "https://bolter.chat", agentId: "synthetic-agent", cliSelector: "synthetic-agent" };
const destination = { chatId: "synthetic-chat", threadRootId: null };
const message = { type: "message", messageId: "synthetic-input", ...destination, senderId: "synthetic-visitor", senderType: "user",
  senderLabel: "Visitor", content: "Synthetic external text", createdAt: "2026-01-01T00:00:00.000Z", addressed: false, truncated: false, redelivered: false };
// Only internal adapter fixtures, not production provider decoders or limits.
const decoders: BolterQualifiedDecoders = { version: runtime.version, identity: raw => raw, receiveItem: raw => raw,
  receipt: raw => raw, authLink: text => JSON.parse(text) as unknown };
const qualification = { version: runtime.version, maxOutputBytes: 1000, maxBatchBytes: 1000 };
function fake() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null, kills: 0,
    kill() { this.kills++; return true; } });
  return { process: child as unknown as ChildProcessWithoutNullStreams, value: child,
    finish(code = 0) { child.exitCode = code; child.emit("close", code); } };
}
function fixture(options: { decoders?: BolterQualifiedDecoders | undefined; attest?: (p: BolterCliInvocation) => Promise<boolean>;
  attestHelper?: (p: string) => Promise<boolean>; onIgnoredEvent?: (kind: string | null) => void } = {}) {
  let current = true;
  let bound = true;
  const calls: BolterCliInvocation[] = [];
  const children: ReturnType<typeof fake>[] = [];
  let sendResponse = JSON.stringify({ ...destination, messageId: "synthetic-reply" });
  const owner = new BolterConnectionOwner({ scope, runtime, selection, decoders, qualification,
    isCurrent: () => current, isBound: binding => bound && binding.chatId === destination.chatId && binding.threadRootId === destination.threadRootId,
    attest: () => Promise.resolve(true), attestHelper: () => Promise.resolve(true), ...options,
    spawn: plan => {
      calls.push(plan);
      const child = fake(); children.push(child);
      if (plan.args[0] === "me" || plan.args[0] === "call") queueMicrotask(() => {
        child.value.stdout.write(plan.args[0] === "me" ? JSON.stringify(selection) : sendResponse);
        child.finish();
      });
      return child.process;
    } });
  return { owner, calls, children, revoke() { current = false; }, withdraw() { bound = false; },
    response(text: string) { sendResponse = text; } };
}
async function directory() {
  const path = await mkdtemp(join(await realpath("/tmp"), "nb-"));
  await chmod(path, 0o700);
  return path;
}

test("unqualified production outputs cannot claim connection or start native auth", async () => {
  const f = fixture({ decoders: undefined });
  expect((await f.owner.confirmIdentity()).status).toBe("unavailable");
  expect(await f.owner.login(() => { throw new Error("Unexpected synthetic link"); })).toEqual({ status: "unavailable", reason: "unsupported-output" });
  expect(f.owner.state).toBe("unavailable");
  expect(f.calls.length).toBe(0);
  await f.owner.retire();
});

test("exact destination withdrawal during attestation prevents sends; ambiguity sends once", async () => {
  const f = fixture({ attest: plan => { if (plan.args[0] === "call") f.withdraw(); return Promise.resolve(true); } });
  expect((await f.owner.confirmIdentity()).status).toBe("confirmed");
  const withdrawn = await f.owner.send(destination, "Synthetic reply");
  expect(withdrawn.status).toBe("uncertain"); // No provider success is manufactured across the async fence.
  expect(f.calls.filter(p => p.args[0] === "call").length).toBe(0);
  await f.owner.retire();
  const other = fixture();
  await other.owner.confirmIdentity();
  expect((await other.owner.send({ ...destination, chatId: "other" }, "Text")).status).toBe("unavailable");
  other.response("Unobserved synthetic output");
  expect((await other.owner.send(destination, "Text")).status).toBe("uncertain");
  expect(other.calls.filter(p => p.args[0] === "call").length).toBe(1);
  await other.owner.retire();
});

test("receiver uses encrypted durable handover, no listening claim, and drains before retirement", async () => {
  const path = await directory();
  const f = fixture();
  // Codec spy verifies ownership/composition; it is not cryptographic qualification.
  const spool = new BolterInboxSpool({ directory: await createBolterSpoolDirectory(path), scope,
    isCurrent: () => f.owner.state !== "retired", cipher: { isAvailable: () => true,
      seal: text => Promise.resolve(Buffer.from(text).reverse()), open: bytes => Promise.resolve(Buffer.from(bytes).reverse().toString()) } });
  try {
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(false);
    await f.owner.confirmIdentity();
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(true);
    expect(f.owner.state).toBe("receiver-running");
    expect(f.owner.listening).toBe(false);
    expect(await f.owner.startReceiver({ handoverExecutable: "/different", directory: path, spool })).toBe(true);
    expect(f.calls.filter(p => p.args[0] === "serve").length).toBe(1);
    const serve = f.calls.find(p => p.args[0] === "serve")!;
    const descriptor = parseBolterHandoverDescriptor(serve.env["NAUTILO_BOLTER_HANDOVER"]!)!;
    expect(serve.args.join()).not.toContain(descriptor.nonce);
    async function* input() { yield Buffer.from(JSON.stringify(message) + "\n"); }
    expect(await handOverBolterBatch(descriptor, input())).toBe(true);
    expect((await spool.pending()).length).toBe(1);
    expect(f.owner.listening).toBe(true);
    let accepted = 0;
    expect(await f.owner.flushInbox((items) => { accepted++; expect(items[0]).toEqual(message); return Promise.resolve(true); })).toBe("accepted");
    expect(accepted).toBe(1);
    expect(await spool.pending()).toEqual([]);
    const receiver = f.children[f.children.length - 1]!;
    // Lifetime provider logs are drained rather than accumulated/capped as protocol output.
    receiver.value.stdout.write("x".repeat(qualification.maxOutputBytes * 2));
    receiver.value.stderr.write("Synthetic private diagnostic");
    expect(receiver.value.kills).toBe(0);
    let retired = false;
    const retiring = f.owner.retire().then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(receiver.value.kills).toBe(1);
    receiver.finish();
    await retiring;
    expect(f.owner.state).toBe("retired");
    expect((await readdir(path)).some(name => name.endsWith(".sock"))).toBe(false);
  } finally {
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("receiver helper attestation rejects setup and retirement before server acceptance preserves spool", async () => {
  const path = await directory();
  const f = fixture({ attestHelper: () => Promise.resolve(false) });
  const records = [{ id: "synthetic-record", fingerprint: "synthetic-fingerprint", jsonl: JSON.stringify(message) }];
  let acknowledges = 0;
  const spool = { store: () => Promise.resolve(records[0]!), pending: () => Promise.resolve(records.map(r => r.id)),
    read: () => Promise.resolve(records[0]!), acknowledge: () => { acknowledges++; return Promise.resolve(); } };
  try {
    await f.owner.confirmIdentity();
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(false);
    expect(f.calls.filter(p => p.args[0] === "serve").length).toBe(0);
    expect(await readdir(path)).toEqual([]);
  } finally { await f.owner.retire(); await rm(path, { recursive: true, force: true }); }
  const path2 = await directory();
  const other = fixture();
  try {
    await other.owner.confirmIdentity();
    expect(await other.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path2, spool })).toBe(true);
    expect(await other.owner.flushInbox(() => { other.revoke(); return Promise.resolve(true); })).toBe("unavailable");
    expect(acknowledges).toBe(0);
  } finally {
    for (const child of other.children) if (child.value.exitCode === null) child.finish();
    await other.owner.retire(); await rm(path2, { recursive: true, force: true });
  }
});

test("retirement during receiver attestation creates no replacement child or orphan endpoint", async () => {
  const path = await directory();
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ attest: async p => { if (p.args[0] === "serve") { reached(); await gate; } return true; } });
  const spool = { store: () => Promise.resolve({ id: "fixture", fingerprint: "fixture" }), pending: () => Promise.resolve([]),
    read: () => Promise.reject(new Error("No synthetic record")), acknowledge: () => Promise.resolve() };
  try {
    await f.owner.confirmIdentity();
    const starting = f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool });
    await entered;
    const retiring = f.owner.retire();
    release();
    expect(await starting).toBe(false);
    await retiring;
    expect(f.calls.filter(p => p.args[0] === "serve").length).toBe(0);
    expect(await readdir(path)).toEqual([]);
  } finally { release(); await f.owner.retire(); await rm(path, { recursive: true, force: true }); }
});

test("native login exposes only validated links and completion still requires identity confirmation", async () => {
  const f = fixture();
  const links: unknown[] = [];
  const login = f.owner.login(link => { links.push(link); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const child = f.children[0]!;
  const link = { url: "https://bolter.chat/verify?request=synthetic", code: "BCDF-GHJK" };
  child.value.stdout.write(JSON.stringify({ ...link, token: "discard-synthetic-token" }));
  expect(links).toEqual([link]);
  expect(f.owner.state).toBe("unavailable");
  child.finish();
  expect(await login).toEqual({ status: "awaiting-identity-confirmation" });
  expect(f.owner.state).toBe("unavailable");
  expect((await f.owner.confirmIdentity()).status).toBe("confirmed");
  expect(f.owner.state).toBe("connected");
  await f.owner.retire();
});

test("retirement while confirming identity returns no stale confirmation", async () => {
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ attest: async () => { reached(); await gate; return true; } });
  const confirming = f.owner.confirmIdentity();
  await entered;
  const retiring = f.owner.retire();
  release();
  expect((await confirming).status).toBe("unavailable");
  await retiring;
  expect(f.calls.length).toBe(0);
  expect(f.owner.state).toBe("retired");
});

test("pause while receiver attestation is pending prevents a late receiver spawn", async () => {
  const path = await directory();
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ attest: async p => { if (p.args[0] === "serve") { reached(); await gate; } return true; } });
  const spool = { store: () => Promise.resolve({ id: "fixture", fingerprint: "fixture" }), pending: () => Promise.resolve([]),
    read: () => Promise.reject(new Error("No synthetic record")), acknowledge: () => Promise.resolve() };
  try {
    await f.owner.confirmIdentity();
    const starting = f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool });
    await entered;
    const pausing = f.owner.pauseReceiver();
    release();
    expect(await starting).toBe(false);
    await pausing;
    expect(f.calls.filter(p => p.args[0] === "serve")).toHaveLength(0);
    expect(f.owner.state).toBe("connected");
    expect(await readdir(path)).toEqual([]);
  } finally { release(); await f.owner.retire(); await rm(path, { recursive: true, force: true }); }
});


test("listening requires current durable qualified handover; unknown packets remain blocked", async () => {
  const path = await directory();
  const f = fixture();
  const records: { id: string; fingerprint: string; jsonl: string }[] = [];
  let committed!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { committed = resolve; });
  const durable = new Promise<void>(resolve => { release = resolve; });
  const states: boolean[] = [];
  const spool = {
    store: async (jsonl: string) => { committed(); await durable; const record = { id: String(records.length), fingerprint: "synthetic", jsonl }; records.push(record); return record; },
    pending: () => Promise.resolve(records.map(record => record.id)),
    read: (id: string) => Promise.resolve(records.find(record => record.id === id)!),
    acknowledge: () => Promise.reject(new Error("Unknown packets must remain durable")),
  };
  try {
    await f.owner.confirmIdentity();
    await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool,
      onStateChange: () => { states.push(f.owner.listening); } });
    const descriptor = parseBolterHandoverDescriptor(f.calls.find(plan => plan.args[0] === "serve")!.env["NAUTILO_BOLTER_HANDOVER"]!)!;
    async function* packet(value: unknown) { yield Buffer.from(JSON.stringify(value) + "\n"); }
    const unknown = handOverBolterBatch(descriptor, packet({ type: "unexpected" }));
    await entered;
    expect(f.owner.listening).toBe(false);
    expect(records).toHaveLength(0);
    release();
    expect(await unknown).toBe(true); // Native ACK means durable storage, not semantic acceptance.
    expect(f.owner.listening).toBe(false);
    expect(await f.owner.flushInbox(() => Promise.reject(new Error("Must not admit unknown packet")))).toBe("blocked");
    expect(records).toHaveLength(1);
    expect(await handOverBolterBatch(descriptor, packet({ type: "control", kind: "connected" }))).toBe(true);
    expect(f.owner.listening).toBe(true);
    expect(states).toEqual([true]);
    expect(records).toHaveLength(2);
    const pausing = f.owner.pauseReceiver();
    expect(f.owner.listening).toBe(false);
    f.children.at(-1)!.finish();
    await pausing;
    expect(states.at(-1)).toBe(false);
  } finally {
    release();
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("late durable handover cannot restore readiness after authority withdrawal", async () => {
  const path = await directory();
  const f = fixture();
  let entered!: () => void; let release!: () => void;
  const storing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stored = false;
  const states: boolean[] = [];
  const spool = { store: async () => { entered(); await gate; stored = true; return { id: "synthetic", fingerprint: "synthetic" }; },
    pending: () => Promise.resolve([]), read: () => Promise.reject(new Error("No read")), acknowledge: () => Promise.resolve() };
  try {
    await f.owner.confirmIdentity();
    await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool,
      onStateChange: () => { states.push(f.owner.listening); } });
    const descriptor = parseBolterHandoverDescriptor(f.calls.find(plan => plan.args[0] === "serve")!.env["NAUTILO_BOLTER_HANDOVER"]!)!;
    async function* input() { yield Buffer.from(JSON.stringify({ type: "control", kind: "connected" }) + "\n"); }
    const handing = handOverBolterBatch(descriptor, input());
    await storing;
    f.revoke(); release();
    expect(await handing).toBe(false);
    expect(stored).toBe(true);
    expect(f.owner.listening).toBe(false);
    expect(states).toEqual([]);
  } finally {
    release(); for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});


test("retained system notices drain with later Human messages only after server acceptance", async () => {
  const path = await directory();
  const children: ReturnType<typeof fake>[] = [];
  const agentId = "abcdef01";
  const providerSelection = { origin: "https://bolter.chat", agentId, cliSelector: agentId };
  const owner = new BolterConnectionOwner({ scope,
    runtime: { ...runtime, version: productionVersion }, selection: providerSelection,
    decoders: getBolterProductionDecoders(productionVersion),
    qualification: { ...qualification, version: productionVersion },
    isCurrent: () => true, isBound: () => true, attest: () => Promise.resolve(true), attestHelper: () => Promise.resolve(true),
    spawn: plan => {
      const child = fake(); children.push(child);
      if (plan.args[0] === "me") queueMicrotask(() => {
        child.value.stdout.write(JSON.stringify({ agentId, client: { harness: "fixture", host: "fixture.example.com" },
          handle: "fixture-agent", name: "Fixture agent", owner: { chat: "abcdef02", id: "abcdef03", name: "Fixture owner" },
          workspace: { id: "abcdef04", name: "Fixture workspace" } }));
        child.finish();
      });
      return child.process;
    } });
  // Codec spy tests durable queue ownership; production encryption is qualified separately.
  const spool = new BolterInboxSpool({ directory: await createBolterSpoolDirectory(path), scope,
    isCurrent: () => owner.state !== "retired", cipher: { isAvailable: () => true,
      seal: text => Promise.resolve(Buffer.from(text).reverse()), open: bytes => Promise.resolve(Buffer.from(bytes).reverse().toString()) } });
  const human = { type: "message", addressed: false, chat: "abcdef02", chatName: "Fixture chat", conversation: {},
    createdAt: "2026-01-01T00:00:00.000Z", cursor: "synthetic-cursor", messageId: "abcdef05", replyToId: null,
    sender: { id: "abcdef06", name: "Fixture person", outside: true, type: "user" }, text: "Synthetic Human input", threadRootId: null };
  const system = { ...human, messageId: "abcdef07", sender: { id: "system", name: "Fixture system", outside: false, type: "system" },
    text: "Untrusted system notice must not become model input" };
  let timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = spyOn(Date, "now").mockImplementation(() => timestamp++);
  try {
    const first = await spool.store(JSON.stringify(system));
    const second = await spool.store(JSON.stringify(human));
    const third = await spool.store([system, { ...human, messageId: "abcdef08" }].map(item => JSON.stringify(item)).join("\n"));
    clock.mockRestore();
    expect((await owner.confirmIdentity()).status).toBe("confirmed");
    expect(await owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(true);
    let rejectedCalls = 0;
    expect(await owner.flushInbox(items => {
      rejectedCalls++; expect(items).toEqual([{ type: "control", kind: "system_message" }]);
      return Promise.resolve(false);
    })).toBe("blocked");
    expect(rejectedCalls).toBe(1);
    expect(await spool.pending()).toEqual([first.id, second.id, third.id]);
    const accepted: string[] = [];
    const messageContents: string[] = [];
    expect(await owner.flushInbox((items, receipt) => {
      accepted.push(receipt.id);
      for (const item of items) {
        if (item.type === "message") { expect(item.senderType).toBe("user"); messageContents.push(item.content); }
        else expect(item).toEqual({ type: "control", kind: "system_message" });
      }
      return Promise.resolve(true);
    })).toBe("accepted");
    expect(accepted).toEqual([first.id, second.id, third.id]);
    expect(messageContents).toEqual([human.text, human.text]);
    expect(await spool.pending()).toEqual([]);
    const unknown = await spool.store(JSON.stringify({ ...system, sender: { ...system.sender, type: "unknown" } }));
    expect(await owner.flushInbox(() => { throw new Error("Unknown sender must not reach server admission"); })).toBe("blocked");
    expect(await spool.pending()).toEqual([unknown.id]);
  } finally {
    clock.mockRestore();
    for (const child of children) if (child.value.exitCode === null) child.finish();
    await owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("ignored-event-only records drain without admission and a throwing diagnostic cannot block the next Human message", async () => {
  const path = await directory();
  const ignored = { type: "control", kind: "ignored_event", eventKind: "profile_requested",
    payload: "Untrusted event prose must be discarded" };
  const records = new Map([
    ["ignored", { id: "ignored", fingerprint: "ignored-fingerprint", jsonl: JSON.stringify(ignored) }],
    ["human", { id: "human", fingerprint: "human-fingerprint", jsonl: JSON.stringify(message) }],
  ]);
  const acknowledgements: string[] = [];
  const diagnostics: Array<string | null> = [];
  const f = fixture({ onIgnoredEvent: kind => { diagnostics.push(kind); throw new Error("Synthetic logging failure"); } });
  const spool = {
    store: () => Promise.reject(new Error("No handover expected")),
    pending: () => Promise.resolve([...records.keys()]),
    read: (id: string) => Promise.resolve(records.get(id)!),
    acknowledge: (receipt: { id: string }) => { acknowledgements.push(receipt.id); records.delete(receipt.id); return Promise.resolve(); },
  };
  try {
    expect((await f.owner.confirmIdentity()).status).toBe("confirmed");
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(true);
    const admissions: unknown[][] = [];
    expect(await f.owner.flushInbox(items => { admissions.push([...items]); return Promise.resolve(true); })).toBe("accepted");
    expect(admissions).toEqual([[message]]);
    expect(diagnostics).toEqual(["profile_requested"]);
    expect(acknowledgements).toEqual(["ignored", "human"]);
    expect([...records.keys()]).toEqual([]);
  } finally {
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("mixed ignored events stay durable with rejected Human admission and never reach accepted items", async () => {
  const path = await directory();
  const later = { ...message, messageId: "synthetic-later-input", content: "Later synthetic external text" };
  const ignored = { type: "control", kind: "ignored_event", eventKind: "future_event",
    eventText: "Untrusted event prose", data: { secret: "Untrusted event metadata" } };
  const connected = { type: "control", kind: "connected" };
  const records = new Map([
    ["mixed", { id: "mixed", fingerprint: "mixed-fingerprint",
      jsonl: [ignored, connected, message].map(item => JSON.stringify(item)).join("\n") }],
    ["later", { id: "later", fingerprint: "later-fingerprint", jsonl: JSON.stringify(later) }],
  ]);
  const acknowledgements: string[] = [];
  const diagnostics: Array<string | null> = [];
  const f = fixture({ onIgnoredEvent: kind => { diagnostics.push(kind); } });
  const spool = {
    store: () => Promise.reject(new Error("No handover expected")),
    pending: () => Promise.resolve([...records.keys()]),
    read: (id: string) => Promise.resolve(records.get(id)!),
    acknowledge: (receipt: { id: string }) => { acknowledgements.push(receipt.id); records.delete(receipt.id); return Promise.resolve(); },
  };
  try {
    expect((await f.owner.confirmIdentity()).status).toBe("confirmed");
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(true);
    const rejected: unknown[][] = [];
    expect(await f.owner.flushInbox(items => { rejected.push([...items]); return Promise.resolve(false); })).toBe("blocked");
    expect(rejected).toEqual([[connected, message]]);
    expect(acknowledgements).toEqual([]);
    expect([...records.keys()]).toEqual(["mixed", "later"]);

    const accepted: unknown[][] = [];
    expect(await f.owner.flushInbox(items => { accepted.push([...items]); return Promise.resolve(true); })).toBe("accepted");
    expect(accepted).toEqual([[connected, message], [later]]);
    expect(diagnostics).toEqual(["future_event", "future_event"]);
    expect(acknowledgements).toEqual(["mixed", "later"]);
    expect([...records.keys()]).toEqual([]);
  } finally {
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("default ignored-event logging escapes the kind and never includes discarded payload fields", async () => {
  const path = await directory();
  const eventKind = "future_event\nforged: true";
  const record = { id: "ignored", fingerprint: "ignored-fingerprint", jsonl: JSON.stringify({
    type: "control", kind: "ignored_event", eventKind, payload: "PRIVATE_EVENT_PAYLOAD",
  }) };
  let pending = true;
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const f = fixture();
  const spool = {
    store: () => Promise.reject(new Error("No handover expected")),
    pending: () => Promise.resolve(pending ? [record.id] : []),
    read: () => Promise.resolve(record),
    acknowledge: () => { pending = false; return Promise.resolve(); },
  };
  try {
    expect((await f.owner.confirmIdentity()).status).toBe("confirmed");
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool })).toBe(true);
    expect(await f.owner.flushInbox(() => { throw new Error("Ignored-only record must bypass admission"); })).toBe("accepted");
    expect(warning).toHaveBeenCalledTimes(1);
    const output = warning.mock.calls[0]!.map(value => String(value)).join(" ");
    expect(output).toContain(JSON.stringify({ kind: eventKind }));
    expect(output).not.toContain("PRIVATE_EVENT_PAYLOAD");
    expect(output).not.toContain("\n");
  } finally {
    warning.mockRestore();
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});


test("ignored events alone do not establish listening while a mixed connected batch does", async () => {
  const path = await directory();
  const f = fixture();
  const states: boolean[] = [];
  const stored: string[] = [];
  const spool = {
    store: (jsonl: string) => { stored.push(jsonl); return Promise.resolve({ id: String(stored.length), fingerprint: "synthetic" }); },
    pending: () => Promise.resolve([]),
    read: () => Promise.reject(new Error("No queue read expected")),
    acknowledge: () => Promise.reject(new Error("No server acceptance expected")),
  };
  try {
    await f.owner.confirmIdentity();
    expect(await f.owner.startReceiver({ handoverExecutable: "/opt/nautilo/handover", directory: path, spool,
      onStateChange: () => { states.push(f.owner.listening); } })).toBe(true);
    const descriptor = parseBolterHandoverDescriptor(f.calls.find(plan => plan.args[0] === "serve")!.env["NAUTILO_BOLTER_HANDOVER"]!)!;
    async function* packet(items: readonly unknown[]) {
      yield Buffer.from(items.map(item => JSON.stringify(item)).join("\n") + "\n");
    }
    const ignored = { type: "control", kind: "ignored_event", eventKind: "profile_requested" };
    expect(await handOverBolterBatch(descriptor, packet([ignored]))).toBe(true);
    expect(f.owner.listening).toBe(false);
    expect(states).toEqual([]);
    expect(await handOverBolterBatch(descriptor, packet([ignored, { type: "control", kind: "connected" }]))).toBe(true);
    expect(f.owner.listening).toBe(true);
    expect(states).toEqual([true]);
    expect(stored).toHaveLength(2);
  } finally {
    for (const child of f.children) if (child.value.exitCode === null) child.finish();
    await f.owner.retire(); await rm(path, { recursive: true, force: true });
  }
});

test("selected files use chat-scoped provider storage and one final send, with reauthorization before every dispatch", async () => {
  const { createHash } = await import("node:crypto");
  const body = Buffer.from("\ufeffSynthetic file\n");
  for (const [filename, storageName] of [["brief.txt", "brief.txt"], ["Saturday résumé.txt", "Saturday-resume.txt"], ["行程.txt", "attachment.txt"]] as const) {
    const file = { id: "10000000-0000-4000-8000-000000000001", filename, mimeType: "text/plain", sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"), base64: body.toString("base64") };
    for (const denyAfterUpload of [false, true]) {
      const calls: BolterCliInvocation[] = [];
      const owner = new BolterConnectionOwner({ scope, runtime, selection, qualification,
        decoders: { ...decoders, fileCreated: raw => raw as { url: string } },
        isCurrent: () => true, isBound: () => true, attest: async () => true,
        spawn: plan => {
          calls.push(plan); const child = fake();
          queueMicrotask(() => {
            child.value.stdout.write(JSON.stringify(plan.args[0] === "me" ? selection : plan.args[1] === "files_create_file"
              ? { url: "https://bolter.chat/files/synthetic/brief.txt" } : { ...destination, messageId: "synthetic-reply" }));
            child.finish();
          }); return child.process;
        },
      });
      try {
        await owner.confirmIdentity();
        const prepared = await owner.prepareSend();
        let checks = 0;
        const result = await prepared!.send(destination, "Synthetic message", [file], async () => ++checks !== 2 || !denyAfterUpload);
        const uploads = calls.filter(call => call.args[1] === "files_create_file");
        const sends = calls.filter(call => call.args[1] === "bolter_send_message");
        expect(uploads).toHaveLength(1); expect(checks).toBe(2);
        const upload = JSON.parse(uploads[0]!.stdin) as Record<string, string>;
        expect(upload).toEqual({ path: `/nautilo/${file.id}/${storageName}`, mime_type: "text/plain", content: body.toString("utf8") });
        expect(uploads[0]!.args.slice(-2)).toEqual(["--chat", destination.chatId]);
        expect(uploads[0]!.args.join(" ")).not.toContain("Synthetic file");
        expect(sends).toHaveLength(denyAfterUpload ? 0 : 1);
        if (denyAfterUpload) expect(result.status).toBe("uncertain");
        else {
          expect(result.status).toBe("sent");
          expect(JSON.parse(sends[0]!.stdin)).toEqual({ content: `Synthetic message\n\n- [${file.filename}](<https://bolter.chat/files/synthetic/brief.txt>)` });
        }
      } finally { await owner.retire(); }
    }
  }
});
