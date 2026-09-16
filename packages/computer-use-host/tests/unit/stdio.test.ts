import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";
import {
  AttachmentFrameDecoder,
  ControlFrameDecoder,
  encodeControlFrame,
  type ComputerUseHostControlMessage,
} from "@nautilo/computer-use-host-protocol/node";

import { ComputerUseHost } from "../../src/runtime.ts";
import { runComputerUseHostStdio } from "../../src/stdio.ts";

const authority = { authorityLeaseId: "lease-1", authorityGeneration: 1 } as const;
const fence = { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 } as const;
const contract = {
  contractNamespace: "nautilo.computer_use",
  contractId: "fixture.operation",
  contractVersion: 1,
  schemaDigest: `sha256:${"a".repeat(64)}`,
  effectClass: "mutate",
  replayClass: "at_most_once",
  authorityClass: "standing_computer_use",
  attachmentClass: "png",
  disclosureClass: "semantic_and_visual",
} as const;

const request = (requestId: string, operation: string) => ({
  kind: "request",
  protocol: { major: 3, minor: 0 },
  requestId,
  authority,
  fence,
  contract,
  arguments: { operation },
} as const);
const cancel = (requestId: string) => ({
  kind: "cancel",
  protocol: { major: 3, minor: 0 },
  requestId,
  authority,
  fence,
} as const);

function decodeControl(chunks: readonly Uint8Array[]): ComputerUseHostControlMessage[] {
  const decoder = new ControlFrameDecoder();
  const messages = chunks.flatMap((chunk) => decoder.push(chunk));
  decoder.finish();
  return messages;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  new DataView(output.buffer).setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function onePixelPng(): Uint8Array {
  const chunks = [
    pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", new Uint8Array([0x78, 1, 1, 5, 0, 250, 255, 0, 0, 0, 0, 0, 0, 5, 0, 1])),
    pngChunk("IEND"),
  ];
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const output = new Uint8Array(signature.length + chunks.reduce((length, chunk) => length + chunk.length, 0));
  output.set(signature);
  let offset = signature.length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

describe("Computer Use Host stdio", () => {
  test("decodes cancel while a request is blocked and keeps the same Host generation healthy", async () => {
    const host = new ComputerUseHost({
      hostGeneration: "host-1",
      driverGeneration: "driver-1",
      handlers: [{
        contract,
        async execute(argumentsValue, context) {
          if (argumentsValue["operation"] === "block") {
            await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("cancelled");
          }
          return { settlement: "completed", result: { status: "ok" } };
        },
      }],
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Uint8Array.from(chunk)));
    const running = runComputerUseHostStdio({ host, input, output });

    input.write(encodeControlFrame(request("request-1", "block")));
    input.write(encodeControlFrame(cancel("request-1")));
    input.write(encodeControlFrame(cancel("request-1"))); // duplicate is a quiet no-op
    input.write(encodeControlFrame(request("request-2", "next")));
    input.write(encodeControlFrame(cancel("request-missing"))); // late/unknown is a quiet no-op
    await Bun.sleep(20);
    input.end();
    await running;

    const messages = decodeControl(chunks);
    expect(messages[0]).toMatchObject({ kind: "ready", hostGeneration: "host-1", driverGeneration: "driver-1" });
    expect(messages.filter((message) => message.kind === "result")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "result", requestId: "request-1", settlement: "cancelled" }),
      expect.objectContaining({ kind: "result", requestId: "request-2", settlement: "completed" }),
    ]));
    expect(messages.filter((message) => message.kind === "result")).toHaveLength(2);
  });

  test("serializes concurrent result and attachment publications without cross-request pairing", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const host = new ComputerUseHost({
      hostGeneration: "host-1",
      driverGeneration: "driver-1",
      handlers: [{
        contract,
        async execute(argumentsValue) {
          if (argumentsValue["operation"] === "first") await first;
          const marker = argumentsValue["operation"] === "first" ? 1 : 2;
          return {
            settlement: "completed",
            result: { status: "ok", marker },
            attachment: { bytes: onePixelPng(), width: 1, height: 1, coordinateSpace: "desktop_pixels" as const },
          };
        },
      }],
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const attachmentOutput = new PassThrough();
    const controlChunks: Uint8Array[] = [];
    const attachmentChunks: Uint8Array[] = [];
    output.on("data", (chunk: Buffer) => controlChunks.push(Uint8Array.from(chunk)));
    attachmentOutput.on("data", (chunk: Buffer) => attachmentChunks.push(Uint8Array.from(chunk)));
    const running = runComputerUseHostStdio({ host, input, output, attachmentOutput });

    input.write(encodeControlFrame(request("request-1", "first")));
    input.write(encodeControlFrame(request("request-2", "second")));
    await Bun.sleep(10);
    releaseFirst();
    await Bun.sleep(20);
    input.end();
    await running;

    const results = decodeControl(controlChunks).filter((message) => message.kind === "result");
    const decoder = new AttachmentFrameDecoder();
    const attachments = attachmentChunks.flatMap((chunk) => decoder.push(chunk));
    decoder.finish();
    expect(results.map((result) => result.requestId)).toEqual(["request-2", "request-1"]);
    expect(attachments.map((attachment) => attachment.metadata.requestId)).toEqual(["request-2", "request-1"]);
    for (const result of results) {
      const attachment = attachments.find((candidate) => candidate.metadata.requestId === result.requestId);
      expect(attachment?.metadata).toEqual(result.attachment);
    }
  });
});
