/**
 * Wave 3 — format v2 streaming artifact-byte serializer/deserializer tests.
 *
 * Covers: bounded-memory multi-chunk round-trip (streaming from an async
 * iterable reader to an async writer, never reading a whole artifact into
 * memory), tamper / reorder / gap / finality / size / hash rejection, and v1
 * (avatar-only) read/write compatibility. The serializer/deserializer live in
 * `apps/cli/src/lib/profile-bundle.ts`; the underlying frame validators live
 * in `@nautilo/profile-portability` (covered in container.test.ts).
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  serializeArtifactStream,
  deserializeArtifactStream,
  createArgon2idDeriveFn,
  encryptProfileBundleFile,
  decryptProfileBundleFile,
  serializeProfileBundleFile,
  parseProfileBundleFile,
  type AsyncByteReader,
  type AsyncByteWriter,
  type ArtifactStreamSource,
  type ArtifactEntrySink,
  StreamingArtifactStageSink,
  type ArtifactStageClient,
  type ProfileBundleArtifactStageResult,
} from "../../src/lib/profile-bundle";
import { container, type semantic } from "@nautilo/profile-portability";

const PASSPHRASE = new TextEncoder().encode("correct horse battery staple");

describe("createArgon2idDeriveFn secret hygiene", () => {
  test("copies then wipes the native Argon2 output buffer", async () => {
    let nativeOutput: Buffer | undefined;
    const derive = createArgon2idDeriveFn({
      argon2id: 2,
      hash: async () => {
        nativeOutput = Buffer.from(new Uint8Array(32).fill(9));
        return nativeOutput;
      },
    });
    const derived = await derive({
      passphrase: new TextEncoder().encode("secret"),
      salt: new Uint8Array(16).fill(1),
      params: { memoryCostKiB: 19456, timeCost: 2, parallelism: 1, outputLength: 32 },
    });
    expect(derived).toEqual(new Uint8Array(32).fill(9));
    expect(nativeOutput).toEqual(Buffer.alloc(32));
  });
});

// Deterministic Argon2id stand-in (NOT real Argon2id) — matches the shape used
// in profile-portability framed-suite tests.
function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}
const testArgon2id = ({ passphrase, salt, params }: {
  readonly passphrase: Uint8Array;
  readonly salt: Uint8Array;
  readonly params: { readonly memoryCostKiB: number; readonly timeCost: number; readonly parallelism: number; readonly outputLength: number };
}): Uint8Array => {
  const h = createHash("sha256");
  h.update(passphrase);
  h.update(salt);
  h.update(u32be(params.memoryCostKiB));
  h.update(u32be(params.timeCost));
  h.update(u32be(params.parallelism));
  h.update(u32be(params.outputLength));
  return new Uint8Array(h.digest().subarray(0, 32));
};

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** An async iterable reader over a byte array that yields bounded chunks. */
function chunkedReader(bytes: Uint8Array, chunkSize: number): AsyncByteReader & { reads: number } {
  const obj = { reads: 0 } as AsyncByteReader & { reads: number };
  obj[Symbol.asyncIterator] = () => {
    let off = 0;
    return {
      async next(): Promise<IteratorResult<Uint8Array>> {
        if (off >= bytes.length) return { done: true, value: undefined };
        const end = Math.min(off + chunkSize, bytes.length);
        const chunk = bytes.subarray(off, end);
        off = end;
        obj.reads += 1;
        return { done: false, value: new Uint8Array(chunk) };
      },
      async return(): Promise<IteratorResult<Uint8Array>> {
        return { done: true, value: undefined };
      },
    };
  };
  return obj;
}

/** An async byte writer that collects framed wire bytes into one buffer. */
function collectingWriter(): AsyncByteWriter & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  const writer: AsyncByteWriter = {
    async write(chunk: Uint8Array): Promise<void> {
      parts.push(new Uint8Array(chunk));
    },
  };
  return Object.assign(writer, {
    bytes(): Uint8Array {
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
  });
}

/** A sink that collects plaintext chunks per entry into a single buffer. */
function collectingSink(): ArtifactEntrySink & { get(entryPath: string): Uint8Array | undefined; chunkCount(): number } {
  const collected = new Map<string, Uint8Array[]>();
  const sink: ArtifactEntrySink & { get(entryPath: string): Uint8Array | undefined; chunkCount(): number } = {
    async openEntry(_entryPath: string): Promise<void> {},
    async writeChunk(entryPath: string, plaintext: Uint8Array): Promise<void> {
      const list = collected.get(entryPath) ?? [];
      list.push(new Uint8Array(plaintext));
      collected.set(entryPath, list);
    },
    async closeEntry(_entryPath: string): Promise<void> {},
    get(entryPath: string): Uint8Array | undefined {
      const list = collected.get(entryPath);
      if (!list) return undefined;
      let total = 0;
      for (const p of list) total += p.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of list) { out.set(p, off); off += p.length; }
      return out;
    },
    chunkCount(): number {
      let n = 0;
      for (const list of collected.values()) n += list.length;
      return n;
    },
  };
  return sink;
}

function buildHeader(): container.ContainerHeaderV1 {
  return {
    containerVersion: 1,
    semanticVersion: { major: 1, minor: 0 },
    bundleId: "source-genie-001",
    payloadCodec: "genie-live-records",
    protectionSuite: "xchacha20poly1305-framed-v1",
    chunkSize: 64 * 1024,
    keySlots: [],
    frameCount: 1,
    totalPayloadBytes: 0,
  };
}

function makeArtifact(bytesEntry: string, bytes: Uint8Array): semantic.PortableArtifact {
  return {
    recordKind: "artifact",
    path: bytesEntry.replace("media/artifacts/", "notes/").replace(".bin", ".md"),
    mimeType: "application/octet-stream",
    size: bytes.length,
    sha256: sha256Hex(bytes),
    bytesEntry,
  };
}

async function expectReject(p: Promise<unknown>): Promise<Error> {
  let threw = false;
  let err: Error | undefined;
  try {
    await p;
  } catch (e) {
    threw = true;
    err = e instanceof Error ? e : new Error(String(e));
  }
  expect(threw).toBe(true);
  return err!;
}

function randomDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("serializeArtifactStream / deserializeArtifactStream round-trip", () => {
  test("multi-chunk round-trip of a large artifact via async iterable chunks", async () => {
    const dek = randomDek();
    const header = buildHeader();
    // 5 * 64KiB artifact — must be split into 5 bounded chunks, never read whole.
    const artifactBytes = crypto.getRandomValues(new Uint8Array(5 * 64 * 1024));
    const artifact = makeArtifact("media/artifacts/artifact-001.bin", artifactBytes);
    const reader = chunkedReader(artifactBytes, 64 * 1024);
    const sources: readonly ArtifactStreamSource[] = [{ artifact, reader }];

    const writer = collectingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const wire = writer.bytes();
    expect(wire.length).toBeGreaterThan(0);

    // The reader was iterated chunk-by-chunk (5 reads), proving no whole-file read.
    expect(reader.reads).toBe(5);

    const sink = collectingSink();
    await deserializeArtifactStream({ header, dek, reader: chunkedReader(wire, 64 * 1024), sink });
    const recovered = sink.get("media/artifacts/artifact-001.bin");
    expect(recovered).toBeDefined();
    expect(recovered!.length).toBe(artifactBytes.length);
    expect(sha256Hex(recovered!)).toBe(artifact.sha256);
    expect(sink.chunkCount()).toBe(5);
  });

  test("multiple artifacts round-trip with distinct opaque ids", async () => {
    const dek = randomDek();
    const header = buildHeader();
    const a = crypto.getRandomValues(new Uint8Array(100_000));
    const b = crypto.getRandomValues(new Uint8Array(70_000));
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-aaa.bin", a), reader: chunkedReader(a, 64 * 1024) },
      { artifact: makeArtifact("media/artifacts/artifact-bbb.bin", b), reader: chunkedReader(b, 64 * 1024) },
    ];
    const writer = collectingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const wire = writer.bytes();

    const sink = collectingSink();
    await deserializeArtifactStream({ header, dek, reader: chunkedReader(wire, 64 * 1024), sink });
    expect(sha256Hex(sink.get("media/artifacts/artifact-aaa.bin")!)).toBe(sha256Hex(a));
    expect(sha256Hex(sink.get("media/artifacts/artifact-bbb.bin")!)).toBe(sha256Hex(b));
  });

  test("a small artifact that fits in one chunk round-trips with final=true", async () => {
    const dek = randomDek();
    const header = buildHeader();
    const bytes = new TextEncoder().encode("hello artifact world");
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-one.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) },
    ];
    const writer = collectingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const sink = collectingSink();
    await deserializeArtifactStream({ header, dek, reader: chunkedReader(writer.bytes(), 64 * 1024), sink });
    expect(sink.get("media/artifacts/artifact-one.bin")).toEqual(bytes);
  });

  test("an empty (zero-byte) artifact round-trips as a single zero-length final chunk", async () => {
    const dek = randomDek();
    const header = buildHeader();
    const bytes = new Uint8Array(0);
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-empty.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) },
    ];
    const writer = collectingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const sink = collectingSink();
    await deserializeArtifactStream({ header, dek, reader: chunkedReader(writer.bytes(), 64 * 1024), sink });
    expect(sink.get("media/artifacts/artifact-empty.bin")).toEqual(bytes);
  });
});

/** Writer that captures each `write()` call as a separate frame buffer. */
function frameCapturingWriter(): AsyncByteWriter & { frames(): Uint8Array[] } {
  const parts: Uint8Array[] = [];
  const writer: AsyncByteWriter = {
    async write(chunk: Uint8Array): Promise<void> {
      parts.push(new Uint8Array(chunk));
    },
  };
  return Object.assign(writer, { frames: () => parts.map((p) => new Uint8Array(p)) });
}

function wireFromFrames(frames: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}

async function buildStream(
  dek: Uint8Array,
  bytes: Uint8Array,
  bytesEntry = "media/artifacts/artifact-001.bin",
): Promise<Uint8Array> {
  const header = buildHeader();
  const sources: readonly ArtifactStreamSource[] = [
    { artifact: makeArtifact(bytesEntry, bytes), reader: chunkedReader(bytes, 64 * 1024) },
  ];
  const writer = frameCapturingWriter();
  await serializeArtifactStream({ header, dek, sources, writer });
  return wireFromFrames(writer.frames());
}

async function runDeserialize(dek: Uint8Array, wire: Uint8Array): Promise<void> {
  const header = buildHeader();
  const sink = collectingSink();
  await deserializeArtifactStream({ header, dek, reader: chunkedReader(wire, 64 * 1024), sink });
}

describe("tamper / reorder / gap / finality rejection", () => {
  test("flipping a byte in a chunk ciphertext → AEAD authentication failure", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(200_000));
    const header = buildHeader();
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) },
    ];
    const writer = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const frames = writer.frames();
    // Flip the last byte of the first chunk frame (inside the Poly1305 tag).
    const tampered = new Uint8Array(frames[0]!);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    frames[0] = tampered;
    const err = await expectReject(runDeserialize(dek, wireFromFrames(frames)));
    expect(err.message).toMatch(/AEAD authentication failed/);
  });

  test("flipping a byte in the terminal-manifest frame → manifest AEAD failure", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(10_000));
    const header = buildHeader();
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) },
    ];
    const writer = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const frames = writer.frames();
    const terminal = new Uint8Array(frames[frames.length - 1]!);
    terminal[terminal.length - 1] = terminal[terminal.length - 1]! ^ 0x01;
    frames[frames.length - 1] = terminal;
    const err = await expectReject(runDeserialize(dek, wireFromFrames(frames)));
    expect(err.message).toMatch(/manifest AEAD authentication failed/);
  });

  test("reordering two chunk frames is rejected (ordinal / AEAD)", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(200_000)); // 4 chunks
    const header = buildHeader();
    const sources: readonly ArtifactStreamSource[] = [
      { artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) },
    ];
    const writer = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources, writer });
    const frames = writer.frames();
    // Swap the first two chunk frames (keep terminal last).
    const a = frames[0]!;
    frames[0] = frames[1]!;
    frames[1] = a;
    await expectReject(runDeserialize(dek, wireFromFrames(frames)));
  });

  test("dropping a middle chunk frame leaves an ordinal gap / missing entry", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(200_000)); // 4 chunks
    const wire = await buildStream(dek, bytes);
    const header = buildHeader();
    const writer = frameCapturingWriter();
    await serializeArtifactStream({
      header, dek,
      sources: [{ artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) }],
      writer,
    });
    const frames = writer.frames();
    // Drop the second chunk frame (frames[1]); terminal stays last.
    frames.splice(1, 1);
    const err = await expectReject(runDeserialize(dek, wireFromFrames(frames)));
    expect(err.message).toMatch(/ordinal gap|chunkCount mismatch|missing/i);
    void wire;
  });

  test("duplicating a chunk frame is rejected (duplicate ordinal)", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(200_000));
    const header = buildHeader();
    const writer = frameCapturingWriter();
    await serializeArtifactStream({
      header, dek,
      sources: [{ artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) }],
      writer,
    });
    const frames = writer.frames();
    // Insert a duplicate of the first chunk right after itself.
    frames.splice(1, 0, new Uint8Array(frames[0]!));
    const err = await expectReject(runDeserialize(dek, wireFromFrames(frames)));
    expect(err.message).toMatch(/duplicate ordinal/);
  });

  test("dropping the terminal-manifest frame is rejected (unexpected end of stream)", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(10_000));
    const header = buildHeader();
    const writer = frameCapturingWriter();
    await serializeArtifactStream({
      header, dek,
      sources: [{ artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) }],
      writer,
    });
    const frames = writer.frames();
    frames.splice(frames.length - 1, 1); // remove terminal
    await expectReject(runDeserialize(dek, wireFromFrames(frames)));
  });

  test("a chunk received after the final chunk is rejected", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(10_000)); // 1 final chunk
    const header = buildHeader();
    const writer = frameCapturingWriter();
    await serializeArtifactStream({
      header, dek,
      sources: [{ artifact: makeArtifact("media/artifacts/artifact-001.bin", bytes), reader: chunkedReader(bytes, 64 * 1024) }],
      writer,
    });
    const frames = writer.frames();
    // Insert an extra chunk (a copy of the first, with a new ordinal via raw
    // byte tweak is not needed — duplicate ordinal is caught, but here we
    // append it after the final chunk to hit the after-final guard).
    frames.splice(frames.length - 1, 0, new Uint8Array(frames[0]!));
    const err = await expectReject(runDeserialize(dek, wireFromFrames(frames)));
    expect(err.message).toMatch(/after final chunk|duplicate ordinal/);
  });
});

describe("size / hash mismatch rejection", () => {
  test("swapping in a terminal manifest for different-content bytes → sha256 mismatch", async () => {
    const dek = randomDek();
    const bytesX = crypto.getRandomValues(new Uint8Array(100_000));
    const bytesY = crypto.getRandomValues(new Uint8Array(100_000)); // same size, different content
    const entry = "media/artifacts/artifact-001.bin";
    const header = buildHeader();
    // Stream X chunks + X terminal.
    const wx = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources: [{ artifact: makeArtifact(entry, bytesX), reader: chunkedReader(bytesX, 64 * 1024) }], writer: wx });
    // Stream Y chunks + Y terminal.
    const wy = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources: [{ artifact: makeArtifact(entry, bytesY), reader: chunkedReader(bytesY, 64 * 1024) }], writer: wy });
    const xFrames = wx.frames();
    const yFrames = wy.frames();
    // X chunks (all but terminal) + Y terminal manifest.
    const spliced = [...xFrames.slice(0, xFrames.length - 1), yFrames[yFrames.length - 1]!];
    const err = await expectReject(runDeserialize(dek, wireFromFrames(spliced)));
    expect(err.message).toMatch(/sha256 mismatch/);
  });

  test("swapping in a terminal manifest for a different-size artifact → size mismatch", async () => {
    const dek = randomDek();
    const bytesX = crypto.getRandomValues(new Uint8Array(100_000)); // 2 chunks
    const bytesY = crypto.getRandomValues(new Uint8Array(90_000)); // 2 chunks, different size
    const entry = "media/artifacts/artifact-001.bin";
    const header = buildHeader();
    const wx = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources: [{ artifact: makeArtifact(entry, bytesX), reader: chunkedReader(bytesX, 64 * 1024) }], writer: wx });
    const wy = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources: [{ artifact: makeArtifact(entry, bytesY), reader: chunkedReader(bytesY, 64 * 1024) }], writer: wy });
    const xFrames = wx.frames();
    const yFrames = wy.frames();
    const spliced = [...xFrames.slice(0, xFrames.length - 1), yFrames[yFrames.length - 1]!];
    const err = await expectReject(runDeserialize(dek, wireFromFrames(spliced)));
    expect(err.message).toMatch(/size mismatch|sha256 mismatch/);
  });

  test("an orphan entry (chunks present, absent from manifest) is rejected", async () => {
    const dek = randomDek();
    const a = crypto.getRandomValues(new Uint8Array(10_000));
    const b = crypto.getRandomValues(new Uint8Array(10_000));
    const header = buildHeader();
    // Two-entry stream.
    const writer = frameCapturingWriter();
    await serializeArtifactStream({
      header, dek,
      sources: [
        { artifact: makeArtifact("media/artifacts/artifact-aaa.bin", a), reader: chunkedReader(a, 64 * 1024) },
        { artifact: makeArtifact("media/artifacts/artifact-bbb.bin", b), reader: chunkedReader(b, 64 * 1024) },
      ],
      writer,
    });
    const frames = writer.frames();
    // Replace the terminal with a terminal from a stream that omits bbb.
    const wo = frameCapturingWriter();
    await serializeArtifactStream({ header, dek, sources: [{ artifact: makeArtifact("media/artifacts/artifact-aaa.bin", a), reader: chunkedReader(a, 64 * 1024) }], writer: wo });
    const woFrames = wo.frames();
    const spliced = [...frames.slice(0, frames.length - 1), woFrames[woFrames.length - 1]!];
    const err = await expectReject(runDeserialize(dek, wireFromFrames(spliced)));
    expect(err.message).toMatch(/no manifest record|missing/i);
  });

  test("producer-side: a declared size that disagrees with the streamed bytes is rejected at serialize time", async () => {
    const dek = randomDek();
    const bytes = crypto.getRandomValues(new Uint8Array(10_000));
    const artifact: semantic.PortableArtifact = {
      ...makeArtifact("media/artifacts/artifact-001.bin", bytes),
      size: 99_999, // wrong declared size
    };
    const header = buildHeader();
    const writer = collectingWriter();
    const err = await expectReject(serializeArtifactStream({
      header, dek,
      sources: [{ artifact, reader: chunkedReader(bytes, 64 * 1024) }],
      writer,
    }));
    expect(err.message).toMatch(/size mismatch/);
  });
});

// ---------------------------------------------------------------------------
// v1 (avatar-only) read/write compatibility — legacy functions unchanged.
// ---------------------------------------------------------------------------

describe("v1 avatar-only bundle read/write compatibility", () => {
  test("encrypt → serialize → parse → decrypt round-trips an avatar-only v1 bundle", async () => {
    const avatarBytes = new TextEncoder().encode("avatar-png-bytes");
    const avatarSha = sha256Hex(avatarBytes);
    const records: readonly semantic.SemanticRecord[] = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "A calm, precise assistant." },
      {
        recordKind: "avatar",
        avatar: {
          mediaEntry: "media/avatar.bin",
          mimeType: "image/png",
          sha256: avatarSha,
          width: 8,
          height: 8,
        },
      },
    ];
    const avatarMedia = {
      mediaEntry: "media/avatar.bin",
      mimeType: "image/png",
      sha256: avatarSha,
    };
    const file = await encryptProfileBundleFile({
      records,
      bundleId: "source-genie-001",
      avatarBytes,
      avatarMedia,
      passphrase: PASSPHRASE,
      argon2id: testArgon2id,
    });
    expect(file.formatVersion).toBe(1);
    expect(file.media).not.toBeNull();

    const text = serializeProfileBundleFile(file);
    const parsed = parseProfileBundleFile(text);
    expect(parsed.formatVersion).toBe(1);

    const result = await decryptProfileBundleFile(parsed, PASSPHRASE, testArgon2id);
    expect(result.records.length).toBe(records.length);
    expect(result.avatarBytes).toEqual(avatarBytes);
  });

  test("a v1 bundle with no avatar media round-trips", async () => {
    const records: readonly semantic.SemanticRecord[] = [
      { recordKind: "identity", name: "Aria", handleIntent: null },
      { recordKind: "soul", text: null },
    ];
    const file = await encryptProfileBundleFile({
      records,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: PASSPHRASE,
      argon2id: testArgon2id,
    });
    expect(file.media).toBeNull();
    const text = serializeProfileBundleFile(file);
    const parsed = parseProfileBundleFile(text);
    const result = await decryptProfileBundleFile(parsed, PASSPHRASE, testArgon2id);
    expect(result.records.length).toBe(2);
    expect(result.avatarBytes).toBeNull();
  });

  test("a current bundle preserves the confidential Memory type", async () => {
    const records: readonly semantic.SemanticRecord[] = [
      {
        recordKind: "memory",
        scope: "private",
        type: "preference",
        content: "I prefer concise status updates.",
        createdAt: "2026-08-11T12:00:00.000Z",
      },
    ];
    const file = await encryptProfileBundleFile({
      records,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: PASSPHRASE,
      argon2id: testArgon2id,
    });

    const result = await decryptProfileBundleFile(
      parseProfileBundleFile(serializeProfileBundleFile(file)),
      PASSPHRASE,
      testArgon2id,
    );

    expect(result.bundle.semanticVersion).toEqual({ major: 1, minor: 1 });
    expect(result.records).toEqual(records);
  });

  test("a memory larger than the old CLI chunk size round-trips within the container frame contract", async () => {
    const records: readonly semantic.SemanticRecord[] = [{
      recordKind: "memory",
      scope: "private",
      type: "general",
      content: "m".repeat(70_000),
      createdAt: null,
    }];
    const file = await encryptProfileBundleFile({
      records,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: PASSPHRASE,
      argon2id: testArgon2id,
    });

    expect(file.header.chunkSize).toBe(container.LIMITS.chunkSize.max);
    const result = await decryptProfileBundleFile(
      parseProfileBundleFile(serializeProfileBundleFile(file)),
      PASSPHRASE,
      testArgon2id,
    );
    expect(result.records).toEqual(records);
  });

  test("current export rejects a legacy Memory without its confidential type", async () => {
    const legacyMemory: semantic.LegacyMemoryRecordV1_0 = {
      recordKind: "memory",
      scope: "private",
      content: "legacy",
      createdAt: null,
    };

    const error = await expectReject(encryptProfileBundleFile({
      records: [legacyMemory],
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: PASSPHRASE,
      argon2id: testArgon2id,
    }));
    expect(error.message).toMatch(/semantic record 0 validation failed/);
  });

  test("v1 parse rejects an unsupported formatVersion", () => {
    const file = {
      format: "nautilo-profile-bundle",
      formatVersion: 2,
      header: { containerVersion: 1, semanticVersion: { major: 1, minor: 0 }, bundleId: "source-genie-001", payloadCodec: "genie-live-records", protectionSuite: "xchacha20poly1305-framed-v1", chunkSize: 65536, keySlots: [], frameCount: 1, totalPayloadBytes: 0 },
      frames: [],
      media: null,
    };
    expect(() => parseProfileBundleFile(JSON.stringify(file))).toThrow(/unsupported formatVersion/);
  });
});

describe("StreamingArtifactStageSink (D425 Wave 3 streaming slice)", () => {
  /** A mock client that records each pulled chunk and the request bodies. */
  function mockClient(opts: { readonly failWith?: Error } = {}): ArtifactStageClient & {
    stageCalls: { planToken: string; bytesEntry: string; pulled: Uint8Array[] }[];
    abortCalls: string[];
  } {
    const stageCalls: { planToken: string; bytesEntry: string; pulled: Uint8Array[] }[] = [];
    const abortCalls: string[] = [];
    const client: ArtifactStageClient & {
      stageCalls: typeof stageCalls;
      abortCalls: typeof abortCalls;
    } = {
      stageCalls,
      abortCalls,
      async stageProfileBundleArtifactStream(input): Promise<ProfileBundleArtifactStageResult> {
        const pulled: Uint8Array[] = [];
        stageCalls.push({ planToken: input.planToken, bytesEntry: input.bytesEntry, pulled });
        // Drain the body via the same pull-based path the real client uses:
        // one chunk per pull, so the sink's queue is bounded.
        const iter = (input.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        let res: IteratorResult<Uint8Array>;
        while (true) {
          res = await iter.next();
          if (res.done === true) break;
          pulled.push(new Uint8Array(res.value));
        }
        if (opts.failWith) throw opts.failWith;
        return {
          planToken: input.planToken,
          bytesEntry: input.bytesEntry,
          artifactId: "fresh-" + input.bytesEntry,
          sha256: "a".repeat(64),
          size: pulled.reduce((s, c) => s + c.length, 0),
          staged: true,
        };
      },
      async abortProfileBundleArtifactStaging(input): Promise<unknown> {
        abortCalls.push(input.planToken);
        return { planToken: input.planToken, cleared: 0, clearedAll: true };
      },
    };
    return client;
  }

  test("openEntry/writeChunk/closeEntry stream bounded chunks to the request body (never aggregated into a Blob)", async () => {
    const client = mockClient();
    const sink = new StreamingArtifactStageSink(client, "plan-token-1");
    const entry = "media/artifacts/tok-aaaaaaaa.bin";
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])];
    await sink.openEntry(entry);
    for (const c of chunks) await sink.writeChunk(entry, c);
    await sink.closeEntry(entry);

    expect(client.stageCalls).toHaveLength(1);
    expect(client.stageCalls[0]!.bytesEntry).toBe(entry);
    // The mock pulled exactly the chunks the sink fed, in order, one at a
    // time — proving the body is a pull-based stream, not an aggregate Blob.
    expect(client.stageCalls[0]!.pulled.length).toBe(chunks.length);
    expect(
      client.stageCalls[0]!.pulled.flatMap((c) => Array.from(c)),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    // closeEntry recorded the stage response.
    expect(sink.getResults()).toHaveLength(1);
    expect(sink.getResults()[0]!.size).toBe(6);
  });

  test("a server-side checksum failure in closeEntry surfaces the error (caller cleans up)", async () => {
    const client = mockClient({ failWith: new Error("artifact_checksum_mismatch") });
    const sink = new StreamingArtifactStageSink(client, "plan-token-1");
    const entry = "media/artifacts/tok-aaaaaaaa.bin";
    await sink.openEntry(entry);
    await sink.writeChunk(entry, new Uint8Array([1, 2, 3]));
    let err: unknown;
    try {
      await sink.closeEntry(entry);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("artifact_checksum_mismatch");
    // The caller (CLI) would now abort + call the cleanup endpoint.
    await sink.abort();
    await client.abortProfileBundleArtifactStaging({ planToken: "plan-token-1" });
    expect(client.abortCalls).toEqual(["plan-token-1"]);
  });

  test("abort resolves an open (never-closed) entry with done so the in-flight request terminates", async () => {
    const client = mockClient();
    const sink = new StreamingArtifactStageSink(client, "plan-token-1");
    const entry = "media/artifacts/tok-aaaaaaaa.bin";
    await sink.openEntry(entry);
    await sink.writeChunk(entry, new Uint8Array([1, 2]));
    // Simulate a terminal manifest error: closeEntry is NEVER called.
    await sink.abort();
    // No results recorded (closeEntry never ran); no throw.
    expect(sink.getResults()).toHaveLength(0);
  });
});
