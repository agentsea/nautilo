import { PassThrough } from "node:stream";

export interface JsonlTestPeer {
  readonly clientReadable: PassThrough;
  readonly clientWritable: PassThrough;
  nextClientFrame(): Promise<Record<string, unknown>>;
  queuedClientFrameCount(): number;
  send(message: unknown, crlf?: boolean): void;
  sendBytes(bytes: Buffer): void;
  end(bytes?: Buffer): void;
}

export function createJsonlTestPeer(): JsonlTestPeer {
  const clientReadable = new PassThrough();
  const clientWritable = new PassThrough();
  let buffered = Buffer.alloc(0);
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];

  clientWritable.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const lf = buffered.indexOf(0x0a);
      if (lf < 0) break;
      let line = buffered.subarray(0, lf);
      buffered = buffered.subarray(lf + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const value = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else frames.push(value);
    }
  });

  return {
    clientReadable,
    clientWritable,
    nextClientFrame: () => {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve) => waiters.push(resolve));
    },
    queuedClientFrameCount: () => frames.length,
    send: (message, crlf = false) => {
      clientReadable.write(`${JSON.stringify(message)}${crlf ? "\r\n" : "\n"}`);
    },
    sendBytes: (bytes) => clientReadable.write(bytes),
    end: (bytes) => clientReadable.end(bytes),
  };
}
