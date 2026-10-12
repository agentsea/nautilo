import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, chmod, realpath, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BolterConnectionOwner } from "../../electron/bolter-bridge/connection-owner";
import { BolterInboxSpool, createBolterSpoolDirectory } from "../../electron/bolter-bridge/inbox-spool";
import { handOverBolterBatch, parseBolterHandoverDescriptor } from "../../electron/bolter-bridge/handover";
import type { BolterCliInvocation, BolterQualifiedDecoders } from "../../electron/bolter-bridge/cli-contract";

const scope = { serverId: "synthetic-server", userId: "synthetic-human", connectionId: "synthetic-connection" };
const runtime = { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home", platform: "linux" as const, version: "synthetic-v1" };
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
  attestHelper?: (p: string) => Promise<boolean> } = {}) {
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
