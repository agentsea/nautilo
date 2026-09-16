import { expect, test } from "bun:test";
import { inspectReferenceVideo } from "../../src/media-generation/reference-video-metadata";

/** Minimal ISO BMFF box fixture; not real encoded footage. */
export function referenceMovieFixture(seconds = 5.25, codec = "avc1", wide = false): Uint8Array {
  const atom = (type: string, ...parts: Uint8Array[]) => {
    const data = Buffer.concat(parts); const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length + 8); header.write(type, 4); return Buffer.concat([header, data]);
  };
  const header = Buffer.alloc(wide ? 32 : 20); header[0] = wide ? 1 : 0;
  header.writeUInt32BE(1000, wide ? 20 : 12);
  if (wide) header.writeBigUInt64BE(BigInt(Math.round(seconds * 1000)), 24);
  else header.writeUInt32BE(Math.round(seconds * 1000), 16);
  const handler = Buffer.alloc(12); handler.write("vide", 8);
  const stsd = Buffer.alloc(8); stsd.writeUInt32BE(1, 4);
  const sampleTable = atom("stbl", atom("stsd", stsd, atom(codec, Buffer.alloc(78))));
  const media = atom("mdia", atom("hdlr", handler), atom("minf", sampleTable));
  const movie = atom("moov", atom("mvhd", header), atom("trak", media));
  return Buffer.concat([atom("ftyp", Buffer.from("isom0000")), movie, atom("mdat", Buffer.from([1, 2, 3]))]);
}

test("measures fractional and 64-bit movie durations from bytes", () => {
  expect(inspectReferenceVideo(referenceMovieFixture()).durationSeconds).toBe(5.25);
  expect(inspectReferenceVideo(referenceMovieFixture(12, "hvc1", true)).durationSeconds).toBe(12);
});
test("malformed, truncated, wrong-codec and zero-timing references fail closed", () => {
  const bytes = referenceMovieFixture();
  for (const invalid of [bytes.subarray(0, bytes.length - 1), new Uint8Array(8), referenceMovieFixture(0), referenceMovieFixture(5, "vp09")]) {
    expect(() => inspectReferenceVideo(invalid)).toThrow();
  }
  const damaged = new Uint8Array(bytes); damaged.set([0xff, 0xff, 0xff, 0xff], 0);
  expect(() => inspectReferenceVideo(damaged)).toThrow();
});
