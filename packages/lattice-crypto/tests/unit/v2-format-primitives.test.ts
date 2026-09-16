import { describe, expect, test } from "bun:test";
import {
  CanonicalDecodingError,
  CanonicalEncodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected action to throw an Error");
}

describe("v2 canonical integer and frame encoding", () => {
  test("uses unsigned u32/u64 big-endian fixtures", () => {
    expect(hex(encodeU32(0x89ab_cdef))).toBe("89abcdef");
    expect(hex(encodeU64(0x0102_0304))).toBe("0000000001020304");
    expect(hex(encodeU64(Number.MAX_SAFE_INTEGER))).toBe(
      "001fffffffffffff",
    );
    expect(hex(encodeU64(0))).toBe("0000000000000000");
    expect(hex(frameText("alice"))).toBe("00000005616c696365");
    expect(hex(frameText("\ud800\udc00"))).toBe("00000004f0908080");
    expect(hex(frameText("\udbff\udfff"))).toBe("00000004f48fbfbf");
    expect(hex(frameText("a\ud800\udc00b"))).toBe(
      "0000000661f090808062",
    );
  });

  test("rejects integers outside the approved TypeScript domains", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeU32(value)).toThrow("u32");
      expect(() => encodeU64(value)).toThrow("u64");
    }
    expect(() => encodeU32(0x1_0000_0000)).toThrow("u32");
    expect(() => encodeU64(Number.MAX_SAFE_INTEGER + 1)).toThrow("u64");
    for (const value of [
      "\ud800",
      "\udbff",
      "\udc00",
      "\udfff",
      "a\ud800",
      "\ud800a",
      "\udc00a",
      "a\udc00",
    ]) {
      expect(() => frameText(value)).toThrow("unpaired UTF-16 surrogate");
    }
  });

  test("frames detached bytes and rejects impossible framing input", () => {
    const source = Uint8Array.of(1, 2, 3);
    const encoded = frame(source);
    source[0] = 9;
    expect(hex(encoded)).toBe("00000003010203");

    expect(() =>
      frame({ length: 0x1_0000_0000 } as unknown as Uint8Array)
    ).toThrow("u32");
  });
});

describe("v2 strict decoder", () => {
  test("owns Buffer wire bytes before decoding any field", () => {
    const wire = Buffer.from(frame(Uint8Array.of(1, 2, 3)));
    const reader = new StrictDecoder(wire);

    wire.fill(0);
    const decoded = reader.readFrame(16);
    expect(decoded).toEqual(Uint8Array.of(1, 2, 3));
    expect(Buffer.isBuffer(decoded)).toBeFalse();
  });

  test("round-trips exact values and requires complete consumption", () => {
    const wire = concatV2(
      encodeU32(2),
      encodeU64(258),
      frameText("alice"),
    );
    const decoded = decodeExact(wire, (reader) => ({
      version: reader.readVersion(2),
      epoch: reader.readU64(),
      participant: reader.readText(16),
    }));

    expect(decoded).toEqual({
      version: 2,
      epoch: 258,
      participant: "alice",
    });
  });

  test("rejects truncation, overflow, invalid UTF-8, and trailing bytes", () => {
    expect(() => new StrictDecoder(Uint8Array.of(0, 0, 0)).readU32()).toThrow(
      "truncated u32",
    );
    expect(() =>
      new StrictDecoder(Uint8Array.of(0, 0, 0, 0, 0, 0, 0)).readU64()
    ).toThrow("truncated u64");
    expect(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0x20, 0, 0, 0, 0, 0, 0),
      ).readU64()
    ).toThrow("safe integer");
    expect(
      new StrictDecoder(encodeU64(Number.MAX_SAFE_INTEGER)).readU64(),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      new StrictDecoder(Uint8Array.of(0, 0, 0, 2, 1)).readFrame(16)
    ).toThrow("truncated frame");
    expect(() =>
      new StrictDecoder(Uint8Array.of(0, 0, 0, 1, 0xff)).readText(16)
    ).toThrow("UTF-8");
    expect(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0, 0, 3, 0xf0, 0x90, 0x80),
      ).readText(16)
    ).toThrow("UTF-8");
    expect(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0, 0, 4, 0xef, 0xbb, 0xbf, 0x61),
      ).readText(16)
    ).toThrow("UTF-8");
    expect(() =>
      decodeExact(Uint8Array.of(0, 0, 0, 2, 0), (reader) =>
        reader.readVersion(2)
      )
    ).toThrow("trailing bytes");
  });

  test("enforces versions, counts, and frame ceilings before extraction", () => {
    expect(() =>
      new StrictDecoder(Uint8Array.of(0, 0, 0, 3)).readVersion(2)
    ).toThrow("unsupported version");
    expect(() =>
      new StrictDecoder(Uint8Array.of(0, 0, 1, 1)).readCount(256)
    ).toThrow("count");
    expect(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0, 0, 3, 1, 2, 3),
      ).readFrame(2)
    ).toThrow("frame length");
    for (const invalidMaximum of [-1, 1.5, 0x1_0000_0000]) {
      expect(() =>
        new StrictDecoder(encodeU32(0)).readCount(invalidMaximum)
      ).toThrow("maximum");
      expect(() =>
        new StrictDecoder(encodeU32(0)).readFrame(invalidMaximum)
      ).toThrow("maximum");
    }
    expect(new StrictDecoder(encodeU32(0)).readCount(0)).toBe(0);
    expect(
      new StrictDecoder(encodeU32(0)).readFrame(0),
    ).toEqual(new Uint8Array());
    expect(
      new StrictDecoder(encodeU32(0xffff_ffff)).readCount(0xffff_ffff),
    ).toBe(0xffff_ffff);
    expect(
      new StrictDecoder(encodeU32(0)).readFrame(0xffff_ffff),
    ).toEqual(new Uint8Array());
  });

  test("returns detached frame bytes", () => {
    const wire = Uint8Array.of(0, 0, 0, 2, 7, 8);
    const decoded = decodeExact(wire, (reader) => reader.readFrame(2));
    wire[4] = 99;
    expect(decoded).toEqual(Uint8Array.of(7, 8));
  });

  test("wipes transient text bytes after decoding", () => {
    const originalFill = Uint8Array.prototype.fill;
    const wipedInputs: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0) wipedInputs.push(Uint8Array.from(this));
      return originalFill.apply(this, args);
    };
    try {
      const reader = new StrictDecoder(frameText("alice"));
      expect(reader.readText(16)).toBe("alice");
      reader.destroy();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(wipedInputs).toContainEqual(Uint8Array.of(97, 108, 105, 99, 101));
  });

  test("destroys owned decoder bytes exactly once", () => {
    const originalFill = Uint8Array.prototype.fill;
    let fillCalls = 0;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0) fillCalls += 1;
      return originalFill.apply(this, args);
    };
    try {
      const reader = new StrictDecoder(Uint8Array.of(1, 2, 3));
      reader.destroy();
      reader.destroy();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(fillCalls).toBe(1);
  });

  test("wipes decoder backing storage and failed extracted frames", () => {
    const successfulWire = Buffer.from(frame(Uint8Array.of(7, 8, 9)));
    const successfulSnapshot = Uint8Array.from(successfulWire);
    const failedWire = Buffer.from(
      concatV2(frame(Uint8Array.of(4, 5, 6)), Uint8Array.of(0xff)),
    );
    const failedSnapshot = Uint8Array.from(failedWire);
    const originalFill = Uint8Array.prototype.fill;
    const wipedInputs: Uint8Array[] = [];
    let failedFrame: Uint8Array | null = null;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0) wipedInputs.push(Uint8Array.from(this));
      return originalFill.apply(this, args);
    };
    let successfulFrame: Uint8Array;
    try {
      successfulFrame = decodeExact(
        successfulWire,
        (reader) => reader.readFrame(3),
      );
      expect(() =>
        decodeExact(failedWire, (reader) => {
          failedFrame = reader.readFrame(3);
          return failedFrame;
        })
      ).toThrow("trailing bytes");
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(Array.from(successfulWire)).toEqual(Array.from(successfulSnapshot));
    expect(successfulFrame).toEqual(Uint8Array.of(7, 8, 9));
    expect(Array.from(failedWire)).toEqual(Array.from(failedSnapshot));
    expect(Array.from(failedFrame ?? new Uint8Array())).toEqual(
      Array.from(new Uint8Array(3)),
    );
    expect(wipedInputs).toContainEqual(successfulSnapshot);
    expect(wipedInputs).toContainEqual(failedSnapshot);
  });

  test("uses one stable fail-closed error family", () => {
    expect(new CanonicalEncodingError("invalid").name).toBe(
      "CanonicalEncodingError",
    );
    expect(new CanonicalDecodingError("invalid").name).toBe(
      "CanonicalDecodingError",
    );
    expect(() => new StrictDecoder(new Uint8Array()).readU32()).toThrow(
      CanonicalDecodingError,
    );
    const invalidUtf8 = thrownBy(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0, 0, 1, 0xff),
      ).readText(16)
    );
    expect(invalidUtf8).toBeInstanceOf(CanonicalDecodingError);
    expect(invalidUtf8.message).toBe("invalid UTF-8 text");
    expect(() =>
      new StrictDecoder(
        Uint8Array.of(0, 0, 0, 4, 0xef, 0xbb, 0xbf, 0x61),
      ).readText(16)
    ).toThrow("noncanonical UTF-8 text");
  });
});
