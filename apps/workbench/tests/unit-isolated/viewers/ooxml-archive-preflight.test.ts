import { describe, expect, test } from "bun:test";
import { preflightOoxmlArchive } from "../../../src/viewers/ooxml/archive-preflight";

const enc = new TextEncoder();
const limits = {
  maxEntries: 4,
  maxDeclaredTotalUncompressedBytes: 100n,
  maxDeclaredPerEntryUncompressedBytes: 80n,
};
const U32_MAX = 0xffffffff;
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le64 = (n: bigint) =>
  Array.from({ length: 8 }, (_, index) =>
    Number((n >> BigInt(index * 8)) & 255n),
  );
const join = (...parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

type ZipEntry = {
  name: string;
  data?: number[];
  flags?: number;
  method?: number;
  localName?: string;
  size?: number;
  descriptor?: "signed" | "unsigned" | "zip64";
  descriptorMutation?: "crc" | "size" | "truncated";
};

/** Compact deliberately-uncompressed ZIP builder; CRC is a metadata sentinel for preflight parity tests. */
function zip(entries: ZipEntry[], comment = ""): Uint8Array {
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name),
      localName = enc.encode(entry.localName ?? entry.name),
      data = Uint8Array.from(entry.data ?? [1]);
    const descriptor = entry.descriptor,
      flags = (entry.flags ?? 0) | (descriptor ? 8 : 0),
      method = entry.method ?? 0,
      size = entry.size ?? data.length,
      crc = 0x12345678;
    const zip64Descriptor = descriptor === "zip64";
    let descriptorBytes =
      descriptor === "unsigned"
        ? join(le32(crc), le32(size), le32(size))
        : descriptor === "zip64"
          ? join(
              le32(0x08074b50),
              le32(crc),
              le64(BigInt(size)),
              le64(BigInt(size)),
            )
          : descriptor === "signed"
            ? join(le32(0x08074b50), le32(crc), le32(size), le32(size))
            : new Uint8Array();
    if (entry.descriptorMutation === "crc")
      descriptorBytes[descriptor === "unsigned" ? 0 : 4] ^= 1;
    if (entry.descriptorMutation === "size")
      descriptorBytes[descriptor === "unsigned" ? 4 : 8] ^= 1;
    if (entry.descriptorMutation === "truncated")
      descriptorBytes = descriptorBytes.slice(0, -4);
    const local = join(
      le32(0x04034b50),
      le16(zip64Descriptor ? 45 : 20),
      le16(flags),
      le16(method),
      le32(0),
      le32(descriptor ? 0 : crc),
      le32(descriptor ? 0 : size),
      le32(descriptor ? 0 : size),
      le16(localName.length),
      le16(0),
      localName,
      data,
      descriptorBytes,
    );
    locals.push(local);
    const centralExtra = zip64Descriptor
      ? join(le16(1), le16(16), le64(BigInt(size)), le64(BigInt(size)))
      : new Uint8Array();
    central.push(
      join(
        le32(0x02014b50),
        le16(zip64Descriptor ? 45 : 20),
        le16(zip64Descriptor ? 45 : 20),
        le16(flags),
        le16(method),
        le32(0),
        le32(crc),
        le32(zip64Descriptor ? U32_MAX : size),
        le32(zip64Descriptor ? U32_MAX : size),
        le16(name.length),
        le16(centralExtra.length),
        le16(0),
        le16(0),
        le16(0),
        le32(0),
        le32(offset),
        name,
        centralExtra,
      ),
    );
    offset += local.length;
  }
  const cd = join(...central),
    tail = join(
      le32(0x06054b50),
      le16(0),
      le16(0),
      le16(entries.length),
      le16(entries.length),
      le32(cd.length),
      le32(offset),
      le16(enc.encode(comment).length),
      enc.encode(comment),
    );
  return join(...locals, cd, tail);
}

const result = (bytes: Uint8Array, override = {}) =>
  preflightOoxmlArchive(bytes, { ...limits, ...override });

describe("OOXML archive preflight", () => {
  test("accepts a small OOXML-like ZIP, including an EOCD comment, without copying the source", () => {
    const bytes = zip(
      [
        { name: "[Content_Types].xml", data: [1, 2] },
        { name: "word/document.xml", data: [3] },
      ],
      "ok",
    );
    expect(result(bytes)).toEqual({
      ok: true,
      entryCount: 2,
      declaredTotalUncompressedBytes: 3n,
    });
    expect(result(bytes.subarray(0))).toEqual({
      ok: true,
      entryCount: 2,
      declaredTotalUncompressedBytes: 3n,
    });
  });

  test("enforces exact declared entry and aggregate limits", () => {
    const bytes = zip([
      { name: "a", data: [1, 2] },
      { name: "b", data: [3] },
    ]);
    expect(result(bytes, { maxEntries: 1 }).reason).toBe("entry_limit");
    expect(
      result(bytes, { maxDeclaredTotalUncompressedBytes: 2n }).reason,
    ).toBe("total_uncompressed_limit");
    expect(
      result(bytes, { maxDeclaredPerEntryUncompressedBytes: 1n }).reason,
    ).toBe("entry_uncompressed_limit");
  });

  test("fails closed for trailing/fake EOCD, truncated central directory, and multi-disk archives", () => {
    const valid = zip([{ name: "a" }]);
    expect(result(join(valid, [0]))).toMatchObject({
      ok: false,
      reason: "missing_eocd",
    });
    expect(result(valid.subarray(0, valid.length - 1))).toMatchObject({
      ok: false,
    });
    const multi = valid.slice();
    multi[multi.length - 18] = 1;
    expect(result(multi).reason).toBe("multi_disk");
  });

  test("rejects encryption/AES, unsupported methods, duplicate names, and local disagreement", () => {
    expect(result(zip([{ name: "a", flags: 1 }])).reason).toBe("encrypted");
    expect(result(zip([{ name: "a", method: 12 }])).reason).toBe(
      "unsupported_compression",
    );
    expect(result(zip([{ name: "a" }, { name: "a" }])).reason).toBe(
      "duplicate_name",
    );
    expect(result(zip([{ name: "a", localName: "b" }])).reason).toBe(
      "local_mismatch",
    );
    const diskStart = zip([{ name: "a" }]),
      centralAt = diskStart.indexOf(0x50, 20);
    diskStart[centralAt + 34] = 1;
    expect(result(diskStart).reason).toBe("multi_disk");
    const missingLocalZip64 = zip([{ name: "a" }]);
    for (const offset of [18, 22])
      for (let i = 0; i < 4; i += 1) missingLocalZip64[offset + i] = 0xff;
    expect(result(missingLocalZip64).reason).toBe("local_mismatch");
  });

  test("accepts signed, unsigned, and ZIP64 data descriptors with exact central-directory parity", () => {
    for (const descriptor of ["signed", "unsigned", "zip64"] as const) {
      expect(result(zip([{ name: "a", data: [1, 2, 3], descriptor }]))).toEqual(
        {
          ok: true,
          entryCount: 1,
          declaredTotalUncompressedBytes: 3n,
        },
      );
    }
  });

  test("continues validating entries after a valid data descriptor", () => {
    expect(
      result(
        zip([
          { name: "a", descriptor: "signed" },
          { name: "b", flags: 1 },
        ]),
      ).reason,
    ).toBe("encrypted");
  });

  test("rejects forged, mismatched, and truncated data descriptors", () => {
    expect(
      result(
        zip([{ name: "a", descriptor: "signed", descriptorMutation: "crc" }]),
      ).reason,
    ).toBe("local_mismatch");
    expect(
      result(
        zip([
          { name: "a", descriptor: "unsigned", descriptorMutation: "size" },
        ]),
      ).reason,
    ).toBe("local_mismatch");
    expect(
      result(
        zip([
          { name: "a", descriptor: "zip64", descriptorMutation: "truncated" },
        ]),
      ).reason,
    ).toBe("local_mismatch");
  });

  test("rejects overlapping local entry extents", () => {
    const bytes = zip([{ name: "a" }, { name: "b" }]);
    const secondLocal = 32;
    const firstCentralAt = 64;
    const overlappingSize = secondLocal + 5 - 31;
    for (const offset of [18, 22]) bytes.set(le32(overlappingSize), offset);
    for (const offset of [20, 24])
      bytes.set(le32(overlappingSize), firstCentralAt + offset);
    expect(result(bytes)).toMatchObject({
      ok: false,
      reason: "invalid_local_range",
    });

    // The first unsigned descriptor also forms the first 12 bytes of the
    // second local header. Both entries are independently metadata-valid, so
    // only descriptor-inclusive extent tracking can reject this overlap.
    const firstName = [...enc.encode("a")];
    const secondName = [...enc.encode("b")];
    const firstCrc = 0x04034b50;
    const secondCrc = 0x87654321;
    const firstLocal = join(
      le32(0x04034b50),
      le16(20),
      le16(8),
      le16(8),
      le32(0),
      le32(0),
      le32(0),
      le32(0),
      le16(firstName.length),
      le16(0),
      firstName,
      new Uint8Array(20),
    );
    const overlappingHeaderAndDescriptor = join(
      le32(firstCrc),
      le32(20),
      le32(0),
      le16(0),
      le32(secondCrc),
      le32(1),
      le32(1),
      le16(secondName.length),
      le16(0),
      secondName,
      [1],
    );
    const firstCentral = join(
      le32(0x02014b50),
      le16(20),
      le16(20),
      le16(8),
      le16(8),
      le32(0),
      le32(firstCrc),
      le32(20),
      le32(0),
      le16(firstName.length),
      le16(0),
      le16(0),
      le16(0),
      le16(0),
      le32(0),
      le32(0),
      firstName,
    );
    const secondCentral = join(
      le32(0x02014b50),
      le16(20),
      le16(20),
      le16(0),
      le16(0),
      le32(0),
      le32(secondCrc),
      le32(1),
      le32(1),
      le16(secondName.length),
      le16(0),
      le16(0),
      le16(0),
      le16(0),
      le32(0),
      le32(firstLocal.length),
      secondName,
    );
    const directory = join(firstCentral, secondCentral);
    const overlap = join(
      firstLocal,
      overlappingHeaderAndDescriptor,
      directory,
      le32(0x06054b50),
      le16(0),
      le16(0),
      le16(2),
      le16(2),
      le32(directory.length),
      le32(firstLocal.length + overlappingHeaderAndDescriptor.length),
      le16(0),
    );
    expect(result(overlap)).toMatchObject({
      ok: false,
      reason: "invalid_local_range",
    });
  });

  test("rejects malformed local ranges and malformed/unsupported ZIP64 metadata", () => {
    const bytes = zip([{ name: "a" }]);
    const cd = bytes.indexOf(0x50, 20); // first CD signature byte
    bytes[cd + 42] = 0xff;
    bytes[cd + 43] = 0xff;
    bytes[cd + 44] = 0xff;
    bytes[cd + 45] = 0xff;
    expect(result(bytes)).toMatchObject({ ok: false });
    const zip64 = zip([{ name: "a" }]);
    const eocd = zip64.length - 22;
    zip64[eocd + 8] = 0xff;
    zip64[eocd + 9] = 0xff;
    zip64[eocd + 10] = 0xff;
    zip64[eocd + 11] = 0xff;
    expect(result(zip64).reason).toBe("invalid_zip64");
  });

  test("accepts an exact ZIP64 locator/record and rejects an invalid ZIP64 locator", () => {
    const plain = zip([{ name: "a" }]),
      eocdAt = plain.length - 22,
      eocd = plain.slice(eocdAt);
    const cdSize = 47n,
      cdOffset = 32n,
      recordAt = BigInt(eocdAt);
    const record = join(
      le32(0x06064b50),
      le64(44n),
      le16(45),
      le16(45),
      le32(0),
      le32(0),
      le64(1n),
      le64(1n),
      le64(cdSize),
      le64(cdOffset),
    );
    const locator = join(le32(0x07064b50), le32(0), le64(recordAt), le32(1));
    for (const offset of [8, 10]) {
      eocd[offset] = 0xff;
      eocd[offset + 1] = 0xff;
    }
    for (const offset of [12, 16])
      for (let i = 0; i < 4; i += 1) eocd[offset + i] = 0xff;
    const valid = join(plain.subarray(0, eocdAt), record, locator, eocd);
    expect(result(valid)).toEqual({
      ok: true,
      entryCount: 1,
      declaredTotalUncompressedBytes: 1n,
    });
    valid[eocdAt + record.length + 16] = 2;
    expect(result(valid).reason).toBe("invalid_zip64");
  });
});
