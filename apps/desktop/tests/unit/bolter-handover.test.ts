import { expect, test as bunTest } from "bun:test";
import { mkdtemp, chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { renameWithWindowsRetry } from "@nautilo/config/private-filesystem";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { createBolterHandoverServer, handOverBolterBatch, parseBolterHandoverDescriptor } from "../../electron/bolter-bridge/handover";
import { runBolterHandover } from "../../electron/bolter-bridge/handover-main";

// Bolter is unsupported on Windows (the CLI contract refuses win32); the
// handover relies on Unix sockets and POSIX permission bits.
const test = bunTest.skipIf(process.platform === "win32");

const scope = { serverId: "synthetic-server", userId: "synthetic-human", connectionId: "synthetic-connection" };
async function directory() {
  const result = await mkdtemp(join(await realpath("/tmp"), "nb-"));
  await chmod(result, 0o700);
  return result;
}
async function* input(text = "Synthetic batch\n") { yield Buffer.from(text); }

test("fixed helper acknowledges only after durable store resolves", async () => {
  const path = await directory();
  let committed!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { committed = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const seen: string[] = [];
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation",
    maxBatchBytes: 1000, isCurrent: () => true, store: async text => { seen.push(text); reached(); await gate; return { id: "fixture", fingerprint: "fixture" }; } });
  try {
    let complete = false;
    const result = handOverBolterBatch(server.descriptor, input()).then(value => { complete = true; return value; });
    await entered;
    expect(complete).toBe(false);
    expect(seen).toEqual(["Synthetic batch\n"]);
    committed();
    expect(await result).toBe(true);
    expect(await runBolterHandover(input(), undefined)).toBe(1);
  } finally { committed(); await server.close(); await rm(path, { recursive: true, force: true }); }
});

test("wrong scope, generation, nonce, oversize and invalid UTF-8 never enter storage", async () => {
  const path = await directory();
  let stored = 0;
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation",
    maxBatchBytes: 1000, isCurrent: () => true, store: () => { stored++; return Promise.resolve({ id: "fixture", fingerprint: "fixture" }); } });
  try {
    for (const descriptor of [{ ...server.descriptor, generation: "other" },
      { ...server.descriptor, scope: { ...scope, connectionId: "other" } }, { ...server.descriptor, nonce: "0".repeat(64) }]) {
      expect(await handOverBolterBatch(descriptor, input())).toBe(false);
    }
    expect(await handOverBolterBatch(server.descriptor, input("x".repeat(1001)))).toBe(false);
    async function* invalid() { yield Buffer.from([0xff]); }
    expect(await handOverBolterBatch(server.descriptor, invalid())).toBe(false);
    expect(stored).toBe(0);
    expect(parseBolterHandoverDescriptor(JSON.stringify({ ...server.descriptor, maxBatchBytes: 0 }))).toBeNull();
  } finally { await server.close(); await rm(path, { recursive: true, force: true }); }
});

test("retirement during commit suppresses acknowledgement and drains admitted store", async () => {
  const path = await directory();
  let committed!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { committed = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation",
    maxBatchBytes: 1000, isCurrent: () => true, store: async () => { reached(); await gate; return { id: "fixture", fingerprint: "fixture" }; } });
  try {
    const result = handOverBolterBatch(server.descriptor, input());
    await entered;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    expect(await result).toBe(false);
    expect(closed).toBe(false);
    committed();
    await closing;
    expect(closed).toBe(true);
  } finally { committed(); await server.close(); await rm(path, { recursive: true, force: true }); }
});

test("foreign directory permissions prevent creating an endpoint", async () => {
  const path = await directory();
  try {
    await chmod(path, 0o755);
    await Promise.resolve(expect(createBolterHandoverServer({ directory: path, scope, generation: "synthetic", maxBatchBytes: 1000,
      isCurrent: () => true, store: () => Promise.resolve({ id: "fixture", fingerprint: "fixture" }) })).rejects.toThrow("unavailable"));
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("one handover owns admission through commit and close, then releases it", async () => {
  const path = await directory();
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stores = 0;
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation", maxBatchBytes: 1000,
    isCurrent: () => true, store: async () => { stores++; if (stores === 1) { reached(); await gate; } return { id: "fixture", fingerprint: "fixture" }; } });
  try {
    const first = handOverBolterBatch(server.descriptor, input());
    await entered;
    expect(await handOverBolterBatch(server.descriptor, input())).toBe(false);
    expect(stores).toBe(1);
    release();
    expect(await first).toBe(true);
    expect(await handOverBolterBatch(server.descriptor, input())).toBe(true);
    expect(stores).toBe(2);
  } finally { release(); await server.close(); await rm(path, { recursive: true, force: true }); }
});

test("peer disconnect cannot release admission while its durable store is pending", async () => {
  const path = await directory();
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stores = 0;
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation", maxBatchBytes: 1000,
    isCurrent: () => true, store: async () => { stores++; reached(); await gate; return { id: "fixture", fingerprint: "fixture" }; } });
  const socket = createConnection(server.descriptor.socketPath);
  socket.on("error", () => socket.destroy());
  try {
    const d = server.descriptor;
    const body = Buffer.from("Synthetic batch\n");
    const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(body.length));
    await new Promise<void>(resolve => socket.on("connect", resolve));
    socket.write(Buffer.concat([Buffer.from(JSON.stringify({ version: d.version, generation: d.generation, nonce: d.nonce, scope: d.scope }) + "\n"), size, body]));
    await entered;
    const closed = new Promise<void>(resolve => socket.on("close", resolve));
    socket.destroy();
    await closed;
    expect(await handOverBolterBatch(server.descriptor, input())).toBe(false);
    expect(stores).toBe(1);
    let retired = false;
    const closing = server.close().then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);
    release();
    await closing;
    expect(retired).toBe(true);
  } finally { socket.destroy(); release(); await server.close(); await rm(path, { recursive: true, force: true }); }
});


test("deep managed storage uses a short private endpoint and removes it after quiescence", async () => {
  const root = await directory();
  const path = join(root, "synthetic-managed-storage-".repeat(5), "connection", "handover");
  await mkdir(path, { recursive: true, mode: 0o700 });
  let stored = 0;
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation",
    maxBatchBytes: 4, isCurrent: () => true, store: () => { stored++; return Promise.resolve({ id: "fixture", fingerprint: "fixture" }); } });
  const endpoint = dirname(server.descriptor.socketPath);
  try {
    expect(Buffer.byteLength(path)).toBeGreaterThan(104);
    expect(server.descriptor.socketPath.startsWith(path)).toBe(false);
    expect(Buffer.byteLength(server.descriptor.socketPath)).toBeLessThan(process.platform === "darwin" ? 104 : 108);
    const stat = await lstat(endpoint);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await handOverBolterBatch(server.descriptor, input("éé"))).toBe(true);
    expect(await handOverBolterBatch(server.descriptor, input("ééx"))).toBe(false);
    expect(stored).toBe(1);
    await server.close();
    await Promise.resolve(expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" }));
    expect((await lstat(path)).isDirectory()).toBe(true);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("replaced storage anchor rejects handover without removing replacement directories", async () => {
  const root = await directory();
  const path = join(root, "anchor");
  await mkdir(path, { mode: 0o700 });
  let stored = 0;
  const server = await createBolterHandoverServer({ directory: path, scope, generation: "synthetic-generation",
    maxBatchBytes: 1000, isCurrent: () => true, store: () => { stored++; return Promise.resolve({ id: "fixture", fingerprint: "fixture" }); } });
  const endpoint = dirname(server.descriptor.socketPath);
  try {
    await renameWithWindowsRetry(path, join(root, "original"));
    await mkdir(path, { mode: 0o700 });
    expect(await handOverBolterBatch(server.descriptor, input())).toBe(false);
    expect(stored).toBe(0);
    await server.close();
    expect((await lstat(path)).isDirectory()).toBe(true);
    await Promise.resolve(expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" }));
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});


test("an OS temporary root beyond the native socket path fails closed without residue", async () => {
  const root = await directory();
  const temporary = join(root, "synthetic-temporary-root-".repeat(5));
  await mkdir(temporary, { mode: 0o700 });
  const previous = process.env["TMPDIR"];
  try {
    process.env["TMPDIR"] = temporary;
    await Promise.resolve(expect(createBolterHandoverServer({ directory: root, scope, generation: "synthetic-generation",
      maxBatchBytes: 1000, isCurrent: () => true, store: () => Promise.reject(new Error("No store")) })).rejects.toThrow("unavailable"));
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});


test("authority loss after binding removes the owned temporary endpoint before rejecting startup", async () => {
  const root = await directory();
  const anchor = join(root, "anchor");
  await mkdir(anchor, { mode: 0o700 });
  const previous = process.env["TMPDIR"];
  let checks = 0;
  try {
    process.env["TMPDIR"] = root;
    await Promise.resolve(expect(createBolterHandoverServer({ directory: anchor, scope, generation: "synthetic-generation",
      maxBatchBytes: 1000, isCurrent: () => ++checks === 1, store: () => Promise.reject(new Error("No store")) })).rejects.toThrow("unavailable"));
    expect(await readdir(root)).toEqual(["anchor"]);
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
