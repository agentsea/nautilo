import { describe, expect, test } from "bun:test";
import {
  PORTABLE_RECOVERY_MEMBERS,
  PortableRecoveryError,
  readPortableRecovery,
  writePortableRecovery,
  type PortableRecoveryMemberName,
} from "../../src/maintenance/portable-recovery-container";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nonceSeed = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function chunks(bytes: Uint8Array, size = 2): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += size) yield bytes.subarray(offset, offset + size);
  })();
}

function sources(values: Partial<Record<PortableRecoveryMemberName, string>> = {}) {
  return PORTABLE_RECOVERY_MEMBERS.map((name) => ({ name, chunks: chunks(encoder.encode(values[name] ?? "")) }));
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const part of source) {
    parts.push(part);
    bytes += part.byteLength;
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function sourceFrom(bytes: Uint8Array, size = 5): AsyncIterable<Uint8Array> {
  return chunks(bytes, size);
}

async function written(values: Partial<Record<PortableRecoveryMemberName, string>> = {}) {
  const writer = writePortableRecovery({ key, nonceSeed, sourceRelease: "sha256:release-under-test", members: sources(values), chunkBytes: 3 });
  const bytes = await collect(writer.stream);
  return { bytes, receipt: await writer.completion };
}

function splitFrames(container: Uint8Array): { prefix: Uint8Array; frames: Uint8Array[] } {
  const magicBytes = encoder.encode("nautilo-recovery-v1\\n").byteLength;
  const headerLength = new DataView(container.buffer, container.byteOffset + magicBytes, 4).getUint32(0, false);
  const prefixLength = magicBytes + 4 + headerLength;
  const frames: Uint8Array[] = [];
  let offset = prefixLength;
  while (offset < container.byteLength) {
    const ciphertextLength = new DataView(container.buffer, container.byteOffset + offset + 10, 4).getUint32(0, false);
    const frameLength = 14 + ciphertextLength;
    frames.push(container.slice(offset, offset + frameLength));
    offset += frameLength;
  }
  return { prefix: container.slice(0, prefixLength), frames };
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function requireFrame(result: { readonly done?: boolean; readonly value: unknown }, description: string): Uint8Array {
  if (result.done || !(result.value instanceof Uint8Array)) throw new Error(`writer ended before ${description}`);
  return result.value;
}

describe("nautilo-recovery-v1 portable recovery container", () => {
  test("round-trips every fixed member with a verified external receipt", async () => {
    const expected = {
      "app-postgres.dump": "app-db",
      "logto-postgres.dump": "logto-db",
      "artifacts.tar": "artifact bytes",
      "media.tar": "media bytes",
      "apps.tar": "app files",
    } as const;
    const { bytes, receipt } = await written(expected);
    const restored = new Map<PortableRecoveryMemberName, Uint8Array[]>();
    const result = await readPortableRecovery({
      source: sourceFrom(bytes),
      key,
      expectedReceipt: receipt,
      onChunk: ({ member, plaintext }) => {
        const parts = restored.get(member) ?? [];
        parts.push(plaintext);
        restored.set(member, parts);
      },
    });

    expect(result.receipt).toEqual(receipt);
    expect(result.manifest.sourceRelease).toBe("sha256:release-under-test");
    expect(result.manifest.members.map((member) => member.name)).toEqual([...PORTABLE_RECOVERY_MEMBERS]);
    for (const name of PORTABLE_RECOVERY_MEMBERS) {
      expect(decoder.decode(join(restored.get(name) ?? []))).toBe(expected[name]);
    }
  });

  test("applies causal backpressure while emitting bounded recovery frames", async () => {
    let secondChunkRequested = false;
    let releaseSecondChunk!: () => void;
    const waitForSecondChunk = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    async function* appSource(): AsyncIterable<Uint8Array> {
      yield encoder.encode("abc");
      secondChunkRequested = true;
      await waitForSecondChunk;
      yield encoder.encode("def");
    }
    const members = PORTABLE_RECOVERY_MEMBERS.map((name) => ({
      name,
      chunks: name === "app-postgres.dump" ? appSource() : chunks(new Uint8Array(0)),
    }));
    const writer = writePortableRecovery({ key, nonceSeed, sourceRelease: "sha256:release-under-test", members, chunkBytes: 3 });
    const iterator = writer.stream[Symbol.asyncIterator]();
    const emitted: Uint8Array[] = [];
    const header = await iterator.next();
    emitted.push(requireFrame(header, "public header"));
    const firstData = await iterator.next();
    emitted.push(requireFrame(firstData, "first data frame"));
    // The app source is suspended at its first yield. It has not been asked for
    // a second chunk simply because the writer has a first data frame ready.
    expect(secondChunkRequested).toBeFalse();

    const advancing = iterator.next();
    await Promise.resolve();
    expect(secondChunkRequested).toBeTrue();
    releaseSecondChunk();
    const secondData = await advancing;
    emitted.push(requireFrame(secondData, "second data frame"));
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      emitted.push(next.value);
    }
    await writer.completion;

    const observed: number[] = [];
    await readPortableRecovery({
      source: sourceFrom(join(emitted), 1),
      key,
      onChunk: ({ plaintext }) => { observed.push(plaintext.byteLength); },
    });
    expect(observed).toHaveLength(2);
    expect(Math.max(...observed)).toBe(3);
    expect(observed.reduce((sum, value) => sum + value, 0)).toBe(6);
  });

  test("snapshots construction authority and rejects malformed member arrays before streaming", async () => {
    const mutableKey = key.slice();
    const mutableSeed = nonceSeed.slice();
    const mutableMembers = sources({ "app-postgres.dump": "stable" });
    const writer = writePortableRecovery({ key: mutableKey, nonceSeed: mutableSeed, sourceRelease: "sha256:release-under-test", members: mutableMembers, chunkBytes: 3 });
    mutableKey.fill(0);
    mutableSeed.fill(0);
    (mutableMembers[0] as { name: string }).name = "media.tar";
    const bytes = await collect(writer.stream);
    const receipt = await writer.completion;
    const restored = await readPortableRecovery({ source: sourceFrom(bytes), key, expectedReceipt: receipt, onChunk: () => undefined });
    expect(restored).toBeDefined();

    const valid = sources();
    const invalid = (members: unknown) => () => writePortableRecovery({
      key,
      nonceSeed,
      sourceRelease: "sha256:release-under-test",
      members: members as readonly { name: PortableRecoveryMemberName; chunks: AsyncIterable<Uint8Array> }[],
    });
    expect(invalid(valid.slice(1))).toThrow(PortableRecoveryError);
    expect(invalid([valid[0], valid[0], valid[2], valid[3], valid[4]])).toThrow(PortableRecoveryError);
    expect(invalid([valid[1], valid[0], valid[2], valid[3], valid[4]])).toThrow(PortableRecoveryError);
    expect(invalid([{ ...valid[0]!, name: "unknown-member" }, ...valid.slice(1)])).toThrow(PortableRecoveryError);
  });

  test("rejects a wrong key, ciphertext tamper, truncation, and receipt mismatch", async () => {
    const { bytes, receipt } = await written({ "app-postgres.dump": "must remain sealed" });
    const wrongKey = Uint8Array.from(key, (value) => value ^ 0xff);
    const read = (source: Uint8Array, inputKey = key, expectedReceipt = receipt) => readPortableRecovery({
      source: sourceFrom(source),
      key: inputKey,
      expectedReceipt,
      onChunk: () => undefined,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(read(bytes, wrongKey)).rejects.toBeInstanceOf(PortableRecoveryError);
    const tampered = bytes.slice();
    tampered[Math.floor(tampered.byteLength / 2)]! ^= 1;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(read(tampered)).rejects.toBeInstanceOf(PortableRecoveryError);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(read(bytes.subarray(0, bytes.byteLength - 1))).rejects.toBeInstanceOf(PortableRecoveryError);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(read(bytes, key, { ...receipt, ciphertextBytes: receipt.ciphertextBytes + 1 })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  test("rejects reordered and unknown-member frames before accepting the bundle", async () => {
    const { bytes } = await written({ "app-postgres.dump": "abcdef", "logto-postgres.dump": "ghijkl" });
    const { prefix, frames } = splitFrames(bytes);
    // app-postgres has two chunks. Reordering them violates the canonical ordinal sequence.
    const reordered = join([prefix, frames[1]!, frames[0]!, ...frames.slice(2)]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(readPortableRecovery({ source: sourceFrom(reordered), key, onChunk: () => undefined })).rejects.toMatchObject({
      code: "NONCANONICAL_FRAME_ORDER",
    });

    const unknown = bytes.slice();
    const firstFrameOffset = prefix.byteLength;
    unknown[firstFrameOffset + 1] = 0xfe;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable; awaiting prevents test races.
    await expect(readPortableRecovery({ source: sourceFrom(unknown), key, onChunk: () => undefined })).rejects.toMatchObject({
      code: "INVALID_FORMAT",
    });
  });
});
