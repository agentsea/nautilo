/** Strict, zero-copy ZIP metadata preflight. This is defense in depth, not parser-owned inflate accounting. */
export type OoxmlArchivePreflightReason =
  | "invalid_limits"
  | "missing_eocd"
  | "invalid_eocd"
  | "multi_disk"
  | "invalid_zip64"
  | "invalid_central_directory"
  | "entry_limit"
  | "total_uncompressed_limit"
  | "entry_uncompressed_limit"
  | "encrypted"
  | "unsupported_compression"
  | "invalid_entry"
  | "duplicate_name"
  | "local_mismatch"
  | "invalid_local_range";

export type OoxmlArchivePreflightResult =
  | { ok: true; entryCount: number; declaredTotalUncompressedBytes: bigint }
  | { ok: false; reason: OoxmlArchivePreflightReason };

export interface OoxmlArchivePreflightLimits {
  maxEntries: number;
  maxDeclaredTotalUncompressedBytes: bigint;
  maxDeclaredPerEntryUncompressedBytes: bigint;
}

const EOCD = 0x06054b50,
  ZIP64_LOCATOR = 0x07064b50,
  ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50,
  LOCAL = 0x04034b50;
const U16_MAX = 0xffff,
  U32_MAX = 0xffffffff;
const fail = (
  reason: OoxmlArchivePreflightReason,
): OoxmlArchivePreflightResult => ({ ok: false, reason });
const u64 = (view: DataView, offset: number): bigint =>
  view.getBigUint64(offset, true);
const inRange = (offset: bigint, length: bigint, size: bigint) =>
  offset >= 0n && length >= 0n && offset + length <= size;
const safe = (value: bigint): number | null =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;

function descriptorEnd(
  view: DataView,
  offset: number,
  boundary: number,
  crc: number,
  compressed: bigint,
  uncompressed: bigint,
  zip64: boolean,
): number | null {
  const sizeBytes = zip64 ? 8 : 4;
  const bodyLength = 4 + sizeBytes * 2;
  const matches = (at: number): boolean => {
    if (at + bodyLength > boundary || view.getUint32(at, true) !== crc)
      return false;
    const actualCompressed = zip64
      ? u64(view, at + 4)
      : BigInt(view.getUint32(at + 4, true));
    const actualUncompressed = zip64
      ? u64(view, at + 12)
      : BigInt(view.getUint32(at + 8, true));
    return actualCompressed === compressed && actualUncompressed === uncompressed;
  };
  if (
    offset + 4 <= boundary &&
    view.getUint32(offset, true) === 0x08074b50 &&
    matches(offset + 4)
  ) {
    return offset + 4 + bodyLength;
  }
  return matches(offset) ? offset + bodyLength : null;
}

function parseExtra(
  view: DataView,
  offset: number,
  length: number,
  needs: readonly boolean[],
): bigint[] | "aes" | null {
  let at = offset,
    zip64: { at: number; length: number } | undefined;
  const end = offset + length;
  while (at < end) {
    if (end - at < 4) return null;
    const tag = view.getUint16(at, true),
      size = view.getUint16(at + 2, true);
    at += 4;
    if (size > end - at) return null;
    if (tag === 0x9901) return "aes";
    if (tag === 1) {
      if (zip64) return null;
      zip64 = { at, length: size };
    }
    at += size;
  }
  if (!needs.some(Boolean)) return [];
  if (!zip64 || zip64.length !== needs.filter(Boolean).length * 8) return null;
  const out: bigint[] = [];
  let valueAt = zip64.at;
  for (const need of needs)
    if (need) {
      out.push(u64(view, valueAt));
      valueAt += 8;
    }
  return out;
}

/**
 * Validates one conventional single-disk ZIP without allocating or decompressing.
 * A rejected result intentionally contains no archive-controlled detail.
 */
export function preflightOoxmlArchive(
  bytes: ArrayBuffer | ArrayBufferView,
  limits: OoxmlArchivePreflightLimits,
): OoxmlArchivePreflightResult {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 0 ||
    limits.maxEntries > 1_000_000 ||
    limits.maxDeclaredTotalUncompressedBytes < 0n ||
    limits.maxDeclaredPerEntryUncompressedBytes < 0n
  )
    return fail("invalid_limits");
  const source = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength),
    fileSize = BigInt(view.byteLength);
  if (view.byteLength < 22) return fail("missing_eocd");
  const first = Math.max(0, view.byteLength - 22 - U16_MAX);
  let eocd = -1;
  for (let at = view.byteLength - 22; at >= first; at -= 1)
    if (
      view.getUint32(at, true) === EOCD &&
      at + 22 + view.getUint16(at + 20, true) === view.byteLength
    ) {
      eocd = at;
      break;
    }
  if (eocd < 0) return fail("missing_eocd");
  const disk = view.getUint16(eocd + 4, true),
    cdDisk = view.getUint16(eocd + 6, true);
  let count = BigInt(view.getUint16(eocd + 10, true)),
    cdSize = BigInt(view.getUint32(eocd + 12, true)),
    cdOffset = BigInt(view.getUint32(eocd + 16, true));
  if (
    disk !== 0 ||
    cdDisk !== 0 ||
    view.getUint16(eocd + 8, true) !== view.getUint16(eocd + 10, true)
  )
    return fail("multi_disk");
  const zip64 =
    count === BigInt(U16_MAX) ||
    cdSize === BigInt(U32_MAX) ||
    cdOffset === BigInt(U32_MAX);
  let directoryEnd = BigInt(eocd);
  if (zip64) {
    if (
      eocd < 20 ||
      view.getUint32(eocd - 20, true) !== ZIP64_LOCATOR ||
      view.getUint32(eocd - 16, true) !== 0 ||
      view.getUint32(eocd - 4, true) !== 1
    )
      return fail("invalid_zip64");
    const recordOffset = safe(u64(view, eocd - 12));
    if (
      recordOffset === null ||
      recordOffset < 0 ||
      recordOffset + 56 > eocd - 20 ||
      view.getUint32(recordOffset, true) !== ZIP64_EOCD ||
      u64(view, recordOffset + 4) !== 44n ||
      recordOffset + 56 !== eocd - 20
    )
      return fail("invalid_zip64");
    if (
      view.getUint32(recordOffset + 16, true) !== 0 ||
      view.getUint32(recordOffset + 20, true) !== 0 ||
      u64(view, recordOffset + 24) !== u64(view, recordOffset + 32)
    )
      return fail("invalid_zip64");
    directoryEnd = BigInt(recordOffset);
    count = u64(view, recordOffset + 32);
    cdSize = u64(view, recordOffset + 40);
    cdOffset = u64(view, recordOffset + 48);
  }
  const countNumber = safe(count),
    cdStart = safe(cdOffset),
    cdLength = safe(cdSize);
  if (
    countNumber === null ||
    cdStart === null ||
    cdLength === null ||
    countNumber > limits.maxEntries ||
    !inRange(cdOffset, cdSize, fileSize) ||
    cdOffset + cdSize !== directoryEnd
  )
    return fail(
      countNumber !== null && countNumber > limits.maxEntries
        ? "entry_limit"
        : "invalid_central_directory",
    );
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let at = cdStart,
    total = 0n;
  for (let i = 0; i < countNumber; i += 1) {
    if (at + 46 > cdStart + cdLength || view.getUint32(at, true) !== CENTRAL)
      return fail("invalid_central_directory");
    const flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true),
      crc = view.getUint32(at + 16, true);
    const nameLength = view.getUint16(at + 28, true),
      extraLength = view.getUint16(at + 30, true),
      commentLength = view.getUint16(at + 32, true),
      diskStart = view.getUint16(at + 34, true);
    const compressed32 = view.getUint32(at + 20, true),
      uncompressed32 = view.getUint32(at + 24, true),
      local32 = view.getUint32(at + 42, true);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (entryLength > cdStart + cdLength - at || !nameLength)
      return fail("invalid_entry");
    if (diskStart !== 0) return fail("multi_disk");
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0)
      return fail("encrypted");
    if (method !== 0 && method !== 8) return fail("unsupported_compression");
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + at + 46, nameLength);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      return fail("invalid_entry");
    }
    if (names.has(name)) return fail("duplicate_name");
    names.add(name);
    const extraAt = at + 46 + nameLength,
      values = parseExtra(view, extraAt, extraLength, [
        uncompressed32 === U32_MAX,
        compressed32 === U32_MAX,
        local32 === U32_MAX,
      ]);
    if (values === null) return fail("invalid_entry");
    if (values === "aes") return fail("encrypted");
    const zip64Sizes = uncompressed32 === U32_MAX || compressed32 === U32_MAX;
    let vi = 0;
    const uncompressed =
      uncompressed32 === U32_MAX ? values[vi++] : BigInt(uncompressed32);
    const compressed =
      compressed32 === U32_MAX ? values[vi++] : BigInt(compressed32);
    const local = local32 === U32_MAX ? values[vi++] : BigInt(local32);
    if (
      compressed === undefined ||
      uncompressed === undefined ||
      local === undefined ||
      uncompressed > limits.maxDeclaredPerEntryUncompressedBytes ||
      (total += uncompressed) > limits.maxDeclaredTotalUncompressedBytes
    )
      return fail(
        uncompressed !== undefined &&
          uncompressed > limits.maxDeclaredPerEntryUncompressedBytes
          ? "entry_uncompressed_limit"
          : "total_uncompressed_limit",
      );
    const localAt = safe(local),
      compressedNumber = safe(compressed);
    if (
      localAt === null ||
      compressedNumber === null ||
      localAt + 30 > cdStart ||
      view.getUint32(localAt, true) !== LOCAL
    )
      return fail("invalid_local_range");
    const localFlags = view.getUint16(localAt + 6, true),
      localMethod = view.getUint16(localAt + 8, true),
      localNameLength = view.getUint16(localAt + 26, true),
      localExtraLength = view.getUint16(localAt + 28, true);
    const localCompressed32 = view.getUint32(localAt + 18, true),
      localUncompressed32 = view.getUint32(localAt + 22, true);
    const localExtraAt = localAt + 30 + localNameLength,
      localValues = parseExtra(view, localExtraAt, localExtraLength, [
        localUncompressed32 === U32_MAX,
        localCompressed32 === U32_MAX,
      ]);
    if (localValues === null) return fail("local_mismatch");
    if (localValues === "aes") return fail("encrypted");
    let localValueIndex = 0;
    const localUncompressed =
      localUncompressed32 === U32_MAX
        ? localValues[localValueIndex++]
        : BigInt(localUncompressed32);
    const localCompressed =
      localCompressed32 === U32_MAX
        ? localValues[localValueIndex++]
        : BigInt(localCompressed32);
    const dataStart = localAt + 30 + localNameLength + localExtraLength,
      dataEnd = dataStart + compressedNumber;
    if (
      dataStart > cdStart ||
      dataEnd > cdStart ||
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength
    )
      return fail("local_mismatch");
    for (let n = 0; n < nameLength; n += 1)
      if (view.getUint8(localAt + 30 + n) !== view.getUint8(at + 46 + n))
        return fail("local_mismatch");
    let localEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      if (
        view.getUint32(localAt + 14, true) !== 0 ||
        localCompressed !== 0n ||
        localUncompressed !== 0n
      )
        return fail("local_mismatch");
      const end = descriptorEnd(
        view,
        dataEnd,
        cdStart,
        crc,
        compressed,
        uncompressed,
        zip64Sizes,
      );
      if (end === null) return fail("local_mismatch");
      localEnd = end;
    } else if (
      view.getUint32(localAt + 14, true) !== crc ||
      localCompressed !== compressed ||
      localUncompressed !== uncompressed
    )
      return fail("local_mismatch");
    ranges.push([localAt, localEnd]);
    at += entryLength;
  }
  if (at !== cdStart + cdLength) return fail("invalid_central_directory");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1)
    if (ranges[i - 1]![1] > ranges[i]![0]) return fail("invalid_local_range");
  return {
    ok: true,
    entryCount: countNumber,
    declaredTotalUncompressedBytes: total,
  };
}
