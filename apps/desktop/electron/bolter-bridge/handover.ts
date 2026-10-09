import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { BolterSpoolScope, BolterSpoolReceipt } from "./inbox-spool";

const unavailable = () => new Error("Bolter handover is unavailable.");
export interface BolterHandoverDescriptor {
  readonly version: 1;
  readonly socketPath: string;
  readonly generation: string;
  readonly nonce: string;
  readonly scope: BolterSpoolScope;
  readonly maxBatchBytes: number;
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function parseBolterHandoverDescriptor(text: string): BolterHandoverDescriptor | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const s = r["scope"];
    if (Object.keys(r).sort().join() !== "generation,maxBatchBytes,nonce,scope,socketPath,version"
      || r["version"] !== 1 || !nonempty(r["socketPath"]) || !isAbsolute(r["socketPath"])
      || !nonempty(r["generation"]) || !nonempty(r["nonce"]) || !/^[a-f0-9]{64}$/.test(r["nonce"])
      || typeof r["maxBatchBytes"] !== "number" || !Number.isSafeInteger(r["maxBatchBytes"]) || r["maxBatchBytes"] <= 0
      || !s || typeof s !== "object" || Array.isArray(s)) return null;
    const scope = s as Record<string, unknown>;
    if (Object.keys(scope).sort().join() !== "connectionId,serverId,userId"
      || !nonempty(scope["serverId"]) || !nonempty(scope["userId"]) || !nonempty(scope["connectionId"])) return null;
    return Object.freeze({ version: 1, socketPath: r["socketPath"], generation: r["generation"], nonce: r["nonce"],
      maxBatchBytes: r["maxBatchBytes"], scope: Object.freeze({ serverId: scope["serverId"], userId: scope["userId"], connectionId: scope["connectionId"] }) });
  } catch { return null; }
}
function header(descriptor: BolterHandoverDescriptor): Buffer {
  // A fixed header followed by raw UTF-8 stdin avoids JSON escape expansion of the batch.
  return Buffer.from(JSON.stringify({ version: descriptor.version, generation: descriptor.generation,
    nonce: descriptor.nonce, scope: descriptor.scope }) + "\n");
}

export interface BolterHandoverServer {
  readonly descriptor: BolterHandoverDescriptor;
  close(): Promise<void>;
}

/** One fixed Electron-owned endpoint per receiver generation, inside an owned 0700 directory. */
export async function createBolterHandoverServer(options: {
  readonly directory: string;
  readonly generation: string;
  readonly scope: BolterSpoolScope;
  readonly maxBatchBytes: number;
  readonly isCurrent: () => boolean;
  readonly store: (jsonl: string) => Promise<BolterSpoolReceipt>;
}): Promise<BolterHandoverServer> {
  const currentCallback = options.isCurrent;
  const store = options.store;
  let retired = false;
  const current = () => { try { return !retired && currentCallback() === true; } catch { return false; } };
  const descriptor = parseBolterHandoverDescriptor(JSON.stringify({ version: 1,
    socketPath: join(options.directory, `${randomUUID()}.sock`), generation: options.generation,
    nonce: randomBytes(32).toString("hex"), scope: { ...options.scope }, maxBatchBytes: options.maxBatchBytes }));
  if (!descriptor || !isAbsolute(options.directory) || !current()) throw unavailable();
  const directoryPath = options.directory;
  const directory = await lstat(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || (process.getuid && directory.uid !== process.getuid()) || await realpath(directoryPath) !== resolve(directoryPath)) throw unavailable();
  const validDirectory = async () => {
    const now = await lstat(directoryPath);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== directory.dev || now.ino !== directory.ino
      || (now.mode & 0o077) !== 0 || await realpath(directoryPath) !== resolve(directoryPath)) throw unavailable();
  };
  const expectedHeader = header(descriptor);
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let activeSocket: Socket | null = null;
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on("error", () => socket.destroy());
    // One receiver generation has one admitted handover, held through commit and close.
    // Extra helper attempts fail so the provider can redeliver; they never buffer here.
    if (!current() || activeSocket !== null) { socket.resume(); socket.end("rejected\n", () => socket.destroy()); return; }
    activeSocket = socket;
    let closed = false;
    let storing = false;
    let storeFinished = false;
    const release = () => {
      if (closed && (!storing || storeFinished) && activeSocket === socket) activeSocket = null;
    };
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); closed = true; release(); });
    let offset = 0;
    const lengthFrame = Buffer.alloc(8);
    let lengthOffset = 0;
    let expectedBytes: number | null = null;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const commit = () => {
      storing = true;
      const work = (async () => {
        try {
          if (!current() || socket.destroyed || bytes === 0) throw unavailable();
          await validDirectory();
          if (!current() || socket.destroyed) throw unavailable();
          const jsonl = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
          if (!jsonl.trim()) throw unavailable();
          // The complete raw batch is durably owned even if later decoding blocks admission.
          await store(jsonl);
          await validDirectory();
          if (!current() || socket.destroyed) throw unavailable();
          socket.end("committed\n");
        } catch { socket.destroy(); }
        finally { chunks.length = 0; storeFinished = true; release(); }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    socket.on("data", (chunk: Buffer) => {
      if (!current() || storing) { socket.destroy(); return; }
      const prefixBytes = Math.min(expectedHeader.length - offset, chunk.length);
      if (!chunk.subarray(0, prefixBytes).equals(expectedHeader.subarray(offset, offset + prefixBytes))) {
        socket.destroy(); return;
      }
      offset += prefixBytes;
      let remaining = chunk.subarray(prefixBytes);
      if (offset !== expectedHeader.length) return;
      const lengthBytes = Math.min(lengthFrame.length - lengthOffset, remaining.length);
      remaining.copy(lengthFrame, lengthOffset, 0, lengthBytes);
      lengthOffset += lengthBytes;
      remaining = remaining.subarray(lengthBytes);
      if (lengthOffset !== lengthFrame.length) return;
      if (expectedBytes === null) {
        const declared = lengthFrame.readBigUInt64BE();
        if (declared === 0n || declared > BigInt(descriptor.maxBatchBytes)) { socket.destroy(); return; }
        expectedBytes = Number(declared);
      }
      bytes += remaining.length;
      if (bytes > expectedBytes) { socket.destroy(); return; }
      if (remaining.length) chunks.push(remaining);
      if (bytes === expectedBytes) commit();
    });
    socket.on("end", () => {
      if (!storing) socket.destroy();
    });
  });
  let socketStat: Awaited<ReturnType<typeof lstat>> | undefined;
  const stopServer = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await Promise.allSettled([...pending]);
  };
  try {
    await new Promise<void>((success, reject) => {
      const fail = () => reject(unavailable());
      server.once("error", fail);
      server.listen(descriptor.socketPath, () => { server.off("error", fail); success(); });
    });
    server.on("error", () => { retired = true; for (const socket of sockets) socket.destroy(); });
    await validDirectory();
    if (!current()) throw unavailable();
    socketStat = await lstat(descriptor.socketPath);
    if (!socketStat.isSocket() || (process.getuid && socketStat.uid !== process.getuid())) throw unavailable();
  } catch {
    retired = true;
    await stopServer();
    throw unavailable();
  }
  const ownedSocket = socketStat;
  let closing: Promise<void> | undefined;
  return Object.freeze({ descriptor, close() {
    retired = true;
    for (const socket of sockets) socket.destroy();
    closing ??= (async () => {
      await stopServer();
      try {
        await validDirectory();
        const stat = await lstat(descriptor.socketPath);
        if (stat.isSocket() && stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino) await unlink(descriptor.socketPath);
      } catch { /* Explicit fallback never removes a replaced path; Node close may unlink its bound pathname. */ }
    })();
    return closing;
  } });
}

/** Fixed helper client: stdin is read completely; only the committed reply permits success. */
export async function handOverBolterBatch(descriptor: BolterHandoverDescriptor,
  input: AsyncIterable<Uint8Array>): Promise<boolean> {
  const pinned = parseBolterHandoverDescriptor(JSON.stringify(descriptor));
  if (!pinned) return false;
  try {
    // Bound collection by the separately qualified producer batch size, not a new default.
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      bytes += chunk.byteLength;
      if (bytes > pinned.maxBatchBytes) return false;
      chunks.push(Buffer.from(chunk));
    }
    if (bytes === 0) return false;
    return await new Promise<boolean>(resolveResult => {
      const socket = createConnection(pinned.socketPath);
      const expected = Buffer.from("committed\n");
      let response = Buffer.alloc(0);
      let ended = false;
      socket.on("error", () => socket.destroy());
      // Stdin EOF precedes connection. Explicit framing does not depend on half-close support.
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes));
      socket.on("connect", () => socket.write(Buffer.concat([header(pinned), length, ...chunks])));
      socket.on("data", (chunk: Buffer) => {
        if (response.length + chunk.length > expected.length) { socket.destroy(); return; }
        response = Buffer.concat([response, chunk]);
      });
      socket.on("end", () => { ended = true; socket.destroy(); });
      socket.on("close", () => resolveResult(ended && response.equals(expected)));
    });
  } catch { return false; }
}
