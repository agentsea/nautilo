import { describe, expect, mock, test } from "bun:test";

import { createOoxmlLoadOwner } from "../src/ooxml/lifecycle";
import {
  createOoxmlByteSource,
  runOoxmlLoadWithParserBytes,
  type OoxmlByteSource,
} from "../src/ooxml/source";

const archivePreflight = {
  maxEntries: 0,
  maxDeclaredTotalUncompressedBytes: 0n,
  maxDeclaredPerEntryUncompressedBytes: 0n,
};

/** A conventional empty ZIP: EOCD signature plus zero entries/directory/comment. */
function emptyZip(): ArrayBuffer {
  const bytes = new Uint8Array(22);
  new DataView(bytes.buffer).setUint32(0, 0x06054b50, true);
  return bytes.buffer;
}

function source(bytes = emptyZip()) {
  const result = createOoxmlByteSource({
    bytes,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
    archivePreflight,
  });
  if (result.kind !== "ready") throw new Error("fixture source rejected");
  return result.source;
}

describe("opaque OOXML parser source", () => {
  test("keeps the exact master private and unmutated through internal preflight", () => {
    const bytes = emptyZip();
    const before = [...new Uint8Array(bytes)];
    const result = createOoxmlByteSource({
      bytes,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      archivePreflight,
    });

    expect(result).toMatchObject({ kind: "ready" });
    if (result.kind !== "ready") return;
    expect(result.source).toMatchObject({ byteLength: bytes.byteLength });
    expect("buffer" in result.source).toBe(false);
    expect("clone" in result.source).toBe(false);
    expect([...new Uint8Array(bytes)]).toEqual(before);
  });

  test("rejects malformed archives before source capture", () => {
    expect(createOoxmlByteSource({
      bytes: new ArrayBuffer(1),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      archivePreflight,
    })).toEqual({ kind: "invalid_archive" });
  });

  test("has no callback preflight bypass", async () => {
    const implementation = await Bun.file(
      new URL("../src/ooxml/source.ts", import.meta.url),
    ).text();
    expect(implementation).toContain("preflightOoxmlArchive(options.bytes, options.archivePreflight)");
    expect(implementation).not.toContain("OoxmlByteSourcePreflight");
  });

  test("hands the lifecycle owner one disposable parser clone", async () => {
    const master = emptyZip();
    const parserLoads: ArrayBuffer[] = [];
    const viewer = { destroy: mock(() => {}) };
    const owner = createOoxmlLoadOwner({ timeoutMs: 1_000 });

    runOoxmlLoadWithParserBytes(
      owner,
      source(master),
      viewer,
      async (_viewer, parserBytes) => {
        parserLoads.push(parserBytes);
      },
      { onReady: () => {}, onError: () => {} },
    );
    await Promise.resolve();

    expect(parserLoads).toHaveLength(1);
    expect(parserLoads[0]).not.toBe(master);
    expect([...new Uint8Array(parserLoads[0]!)]).toEqual([...new Uint8Array(master)]);
    new Uint8Array(parserLoads[0]!)[0] = 9;
    expect(new Uint8Array(master)[0]).toBe(0x50);
  });

  test("routes a forged opaque source through the lifecycle-safe failure path", async () => {
    const destroy = mock(() => {});
    const onError = mock(() => {});
    const owner = createOoxmlLoadOwner({
      timeoutMs: 1_000,
      sanitizeError: () => "Document preview failed.",
    });
    const forged = Object.freeze({
      byteLength: 1,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    }) as OoxmlByteSource;

    runOoxmlLoadWithParserBytes(
      owner,
      forged,
      { destroy },
      async () => {},
      { onReady: () => {}, onError },
    );
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith("Document preview failed.");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
