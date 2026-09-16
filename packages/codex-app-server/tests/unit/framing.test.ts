import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  JsonlFramer,
  JSONL_FRAME_STRUCTURE_LIMITS,
  MAX_JSONL_FRAME_BYTES,
  preflightJsonFrame,
  SerializedJsonlWriter,
  WRITER_LIMITS,
  discriminateEnvelope,
  serializeJsonl,
} from "../../src/framing";
import { CodexRpcError } from "../../src/rpc-types";

describe("JSONL framing", () => {
  test("handles multibyte chunk boundaries, CRLF, and string/number ids", () => {
    const framer = new JsonlFramer();
    const source = Buffer.from('{"id":"é","result":{"text":"🌊"}}\r\n{"id":1,"result":true}\n');
    const split = source.indexOf(Buffer.from("🌊")) + 2;
    expect(framer.push(source.subarray(0, split))).toEqual([]);
    expect(framer.push(source.subarray(split))).toEqual([
      { kind: "success", id: "é", result: { text: "🌊" } },
      { kind: "success", id: 1, result: true },
    ]);
    framer.finish();
  });

  test("enforces the byte ceiling before decode or parse", () => {
    const framer = new JsonlFramer();
    expect(() => framer.push(Buffer.alloc(MAX_JSONL_FRAME_BYTES + 1, 0x78))).toThrow(
      new CodexRpcError("frame_too_large").message,
    );
  });

  test("preflights inbound JSON depth and nodes at exact N and N+1", () => {
    const encode = (value: string) => Buffer.from(value);
    expect(() =>
      preflightJsonFrame(encode("[[0]]"), { maxDepth: 2, maxNodes: 3 }),
    ).not.toThrow();
    expect(() =>
      preflightJsonFrame(encode("[[[0]]]"), { maxDepth: 2, maxNodes: 4 }),
    ).toThrow("invalid");
    expect(() =>
      preflightJsonFrame(encode("[0,1]"), { maxDepth: 1, maxNodes: 3 }),
    ).not.toThrow();
    expect(() =>
      preflightJsonFrame(encode("[0,1,2]"), { maxDepth: 1, maxNodes: 3 }),
    ).toThrow("invalid");

    const tooDeepEnvelope =
      `${"[".repeat(130)}{"method":"x"}${"]".repeat(130)}\n`;
    expect(() => new JsonlFramer().push(Buffer.from(tooDeepEnvelope)))
      .toThrow("invalid");

    const depthN =
      `${"[".repeat(JSONL_FRAME_STRUCTURE_LIMITS.maxDepth)}0${
        "]".repeat(JSONL_FRAME_STRUCTURE_LIMITS.maxDepth)
      }`;
    expect(() => preflightJsonFrame(Buffer.from(depthN))).not.toThrow();
    expect(() => preflightJsonFrame(Buffer.from(`[${depthN}]`)))
      .toThrow("invalid");

    const nodeN = `[${"0,".repeat(
      JSONL_FRAME_STRUCTURE_LIMITS.maxNodes - 2,
    )}0]`;
    expect(() => preflightJsonFrame(Buffer.from(nodeN))).not.toThrow();
    const nodeNPlusOne = `[${"0,".repeat(
      JSONL_FRAME_STRUCTURE_LIMITS.maxNodes - 1,
    )}0]`;
    expect(() => preflightJsonFrame(Buffer.from(nodeNPlusOne)))
      .toThrow("invalid");
  });

  test("accepts the exact inbound limit and classifies invalid JSON", () => {
    const empty = Buffer.byteLength('{"method":"x","params":""}', "utf8");
    const exact = `{"method":"x","params":"${"x".repeat(
      MAX_JSONL_FRAME_BYTES - empty,
    )}"}\n`;
    expect(new JsonlFramer().push(Buffer.from(exact))).toHaveLength(1);

    try {
      new JsonlFramer().push(Buffer.from("{broken}\n"));
      throw new Error("expected invalid JSON");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_json" });
    }
  });

  test("rejects invalid UTF-8, truncated EOF, and ambiguous envelopes", () => {
    expect(() => new JsonlFramer().push(Buffer.from([0xff, 0x0a]))).toThrow(
      "valid UTF-8",
    );
    const truncated = new JsonlFramer();
    truncated.push(Buffer.from('{"id":1'));
    expect(() => truncated.finish()).toThrow("truncated frame");
    expect(() => discriminateEnvelope({ id: 1, result: {}, error: {} })).toThrow(
      "frame was invalid",
    );
    expect(() => discriminateEnvelope({ id: Number.NaN, result: {} })).toThrow(
      "frame was invalid",
    );
  });

  test("bounds outbound serialization", () => {
    expect(serializeJsonl({ method: "initialized" }).at(-1)).toBe(0x0a);
    expect(() => serializeJsonl({ value: "x".repeat(MAX_JSONL_FRAME_BYTES) })).toThrow(
      "size limit",
    );
  });

  test("serializes writes and gives queued control responses priority", async () => {
    const writes: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(Buffer.from(chunk).toString("utf8"));
        if (writes.length === 1) releaseFirst = callback;
        else callback();
      },
    });
    const writer = new SerializedJsonlWriter(writable);
    const first = writer.write({ id: "regular-1" });
    const second = writer.write({ id: "regular-2" });
    const control = writer.write({ id: "control" }, true);
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second, control]);
    expect(
      writes.map(
        (line) => (JSON.parse(line) as unknown as { id: string }).id,
      ),
    ).toEqual([
      "regular-1",
      "control",
      "regular-2",
    ]);
  });

  test("locks count and byte ceilings while reserving control capacity", async () => {
    let release: (() => void) | undefined;
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const writer = new SerializedJsonlWriter(writable);
    const pending: Promise<void>[] = [];
    for (let index = 0; index < WRITER_LIMITS.dataFrames; index += 1) {
      pending.push(writer.write({ index }));
    }
    await writer.write({ overflow: true }).catch((error: unknown) =>
      expect(error).toMatchObject({ code: "queue_full" }),
    );
    for (let index = 0; index < WRITER_LIMITS.controlFrames; index += 1) {
      pending.push(writer.write({ control: index }, true));
    }
    await writer.write({ controlOverflow: true }, true).catch((error: unknown) =>
      expect(error).toMatchObject({ code: "queue_full" }),
    );
    writer.abort(new CodexRpcError("closed"));
    release?.();
    await Promise.allSettled(pending);

    const byteWritable = new Writable({ write() {} });
    const byteWriter = new SerializedJsonlWriter(byteWritable);
    const emptySize = serializeJsonl({ value: "" }).byteLength;
    const halfData = WRITER_LIMITS.dataBytes / 2;
    const exactHalfData = { value: "x".repeat(halfData - emptySize) };
    const dataOne = byteWriter.write(exactHalfData);
    const dataTwo = byteWriter.write(exactHalfData);
    await byteWriter.write({ oneByteTooMany: true }).catch((error: unknown) =>
      expect(error).toMatchObject({ code: "queue_full" }),
    );
    byteWriter.abort(new CodexRpcError("closed"));
    await Promise.allSettled([dataOne, dataTwo]);

    const controlWriter = new SerializedJsonlWriter(new Writable({ write() {} }));
    const halfControl = WRITER_LIMITS.controlBytes / 2;
    const exactHalfControl = { value: "x".repeat(halfControl - emptySize) };
    const controlOne = controlWriter.write(exactHalfControl, true);
    const controlTwo = controlWriter.write(exactHalfControl, true);
    await controlWriter.write({ oneByteTooMany: true }, true).catch((error: unknown) =>
      expect(error).toMatchObject({ code: "queue_full" }),
    );
    controlWriter.abort(new CodexRpcError("closed"));
    await Promise.allSettled([controlOne, controlTwo]);
  });

  test("bounded close drains an already accepted control response", async () => {
    let release: (() => void) | undefined;
    const writer = new SerializedJsonlWriter(
      new Writable({
        write(_chunk, _encoding, callback) {
          release = callback;
        },
      }),
    );
    const control = writer.write({ id: "server-request", result: {} }, true);
    const closing = writer.close(50);
    release?.();
    await Promise.all([control, closing]);
  });
});
