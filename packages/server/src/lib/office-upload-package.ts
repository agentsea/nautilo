import { open } from "node:fs/promises";
import { extensionOfArtifactName } from "@nautilo/attachments/artifact-upload-policy";

const OFFICE_MAIN_PARTS: Readonly<Record<string, string>> = {
  ".docx": "word/document.xml",
  ".xlsx": "xl/workbook.xml",
  ".pptx": "ppt/presentation.xml",
};

/** ZIP format widths, not upload or document-size policy. */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const END_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

/** Resolve ZIP64 sentinel fields from their format-defined extra record. */
function zip64Values(extra: Buffer, needs: boolean[]): number[] {
  let zip64: Buffer | undefined;
  for (let at = 0; at < extra.length;) {
    if (at + 4 > extra.length) throw new Error("Invalid ZIP extra record");
    const tag = extra.readUInt16LE(at), size = extra.readUInt16LE(at + 2);
    at += 4;
    if (at + size > extra.length || tag === 0x9901) throw new Error("Invalid or encrypted ZIP extra record");
    if (tag === 1) {
      if (zip64) throw new Error("Duplicate ZIP64 record");
      zip64 = extra.subarray(at, at + size);
    }
    at += size;
  }
  if (!needs.some(Boolean)) return [];
  if (!zip64 || zip64.length !== needs.filter(Boolean).length * 8) throw new Error("Missing ZIP64 sizes");
  const values: number[] = [];
  for (let at = 0; at < zip64.length; at += 8) {
    const value = zip64.readBigUInt64LE(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP range is not addressable");
    values.push(Number(value));
  }
  return values;
}

/**
 * Storage admission checks package structure, independently of member order.
 * Read only ZIP metadata from the temporary upload; never inflate or buffer the
 * document. Rendering/import remains responsible for parsing the part contents.
 * Malformed metadata is denied without exposing archive-controlled details.
 */
export async function validateOfficeUploadPackage(path: string, filename: string): Promise<boolean> {
  const mainPart = OFFICE_MAIN_PARTS[extensionOfArtifactName(filename)];
  if (!mainPart) return false;
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const read = async (offset: number, length: number, boundary = size): Promise<Buffer> => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || length > boundary - offset) throw new Error("Invalid ZIP range");
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const result = await file.read(bytes, done, length - done, offset + done);
        if (!result.bytesRead) throw new Error("Truncated ZIP record");
        done += result.bytesRead;
      }
      return bytes;
    };
    const tailOffset = Math.max(0, size - END_SIZE - U16_MAX);
    const tail = await read(tailOffset, size - tailOffset);
    let endAt = -1;
    for (let at = tail.length - END_SIZE; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + END_SIZE + tail.readUInt16LE(at + 20) === tail.length) {
        endAt = at;
        break;
      }
    }
    if (endAt < 0) return false;
    const end = tail.subarray(endAt);
    if (end.readUInt16LE(4) || end.readUInt16LE(6) || end.readUInt16LE(8) !== end.readUInt16LE(10)) return false;
    let count = end.readUInt16LE(10), directorySize = end.readUInt32LE(12), directoryOffset = end.readUInt32LE(16);
    let directoryEnd = tailOffset + endAt;
    if (count === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
      const locator = await read(directoryEnd - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) return false;
      const recordOffset = Number(locator.readBigUInt64LE(8));
      const record = await read(recordOffset, 56, directoryEnd - 20);
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readBigUInt64LE(4) !== 44n
        || recordOffset + 56 !== directoryEnd - 20 || record.readUInt32LE(16) || record.readUInt32LE(20)
        || record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)) return false;
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
      directoryEnd = recordOffset;
    }
    if (![count, directorySize, directoryOffset].every(Number.isSafeInteger)
      || directoryOffset < 0 || directorySize < 0 || directoryOffset + directorySize !== directoryEnd
      || count < 1 || count > directorySize / CENTRAL_SIZE) return false;
    const names = new Set<string>();
    const ranges: Array<[number, number]> = [];
    let at = directoryOffset;
    for (let i = 0; i < count; i++) {
      const header = await read(at, CENTRAL_SIZE, directoryEnd);
      if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(34)) return false;
      const flags = header.readUInt16LE(8), method = header.readUInt16LE(10);
      if ((flags & 0x2041) || (method !== 0 && method !== 8)) return false;
      const nameSize = header.readUInt16LE(28), extraSize = header.readUInt16LE(30), commentSize = header.readUInt16LE(32);
      if (!nameSize) return false;
      const metadata = await read(at + CENTRAL_SIZE, nameSize + extraSize + commentSize, directoryEnd);
      const nameBytes = metadata.subarray(0, nameSize);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      if (names.has(name) || (/[\\:]/.test(name) || name.includes("\0")) || name.startsWith("/")
        || name.split("/").some((part) => part === ".." || part === ".")
        || /(^|\/)vbaproject\.bin$/i.test(name)) return false;
      names.add(name);
      const compressed32 = header.readUInt32LE(20), uncompressed32 = header.readUInt32LE(24), offset32 = header.readUInt32LE(42);
      const values = zip64Values(metadata.subarray(nameSize, nameSize + extraSize), [uncompressed32 === U32_MAX, compressed32 === U32_MAX, offset32 === U32_MAX]);
      let vi = 0;
      const uncompressed = uncompressed32 === U32_MAX ? values[vi++]! : uncompressed32;
      const compressed = compressed32 === U32_MAX ? values[vi++]! : compressed32;
      const localOffset = offset32 === U32_MAX ? values[vi++]! : offset32;
      const local = await read(localOffset, LOCAL_SIZE, directoryOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags
        || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameSize) return false;
      const localMetadata = await read(localOffset + LOCAL_SIZE, nameSize + local.readUInt16LE(28), directoryOffset);
      if (!localMetadata.subarray(0, nameSize).equals(nameBytes)) return false;
      const localCompressed32 = local.readUInt32LE(18), localUncompressed32 = local.readUInt32LE(22);
      const localValues = zip64Values(localMetadata.subarray(nameSize), [localUncompressed32 === U32_MAX, localCompressed32 === U32_MAX]);
      let li = 0;
      const localUncompressed = localUncompressed32 === U32_MAX ? localValues[li++]! : localUncompressed32;
      const localCompressed = localCompressed32 === U32_MAX ? localValues[li++]! : localCompressed32;
      let localEnd = localOffset + LOCAL_SIZE + localMetadata.length + compressed;
      if (!Number.isSafeInteger(localEnd) || localEnd > directoryOffset || (method === 0 && compressed !== uncompressed)) return false;
      if (flags & 8) {
        if (local.readUInt32LE(14) || localCompressed || localUncompressed) return false;
        const wide = compressed32 === U32_MAX || uncompressed32 === U32_MAX;
        const length = wide ? 20 : 12;
        const descriptor = await read(localEnd, length, directoryOffset);
        const matches = (body: Buffer): boolean => body.readUInt32LE(0) === header.readUInt32LE(16)
          && (wide ? body.readBigUInt64LE(4) === BigInt(compressed) : body.readUInt32LE(4) === compressed)
          && (wide ? body.readBigUInt64LE(12) === BigInt(uncompressed) : body.readUInt32LE(8) === uncompressed);
        // The optional signature can also equal an unsigned descriptor's CRC.
        if (descriptor.readUInt32LE(0) === 0x08074b50 && localEnd + length + 4 <= directoryOffset
          && matches(await read(localEnd + 4, length, directoryOffset))) {
          localEnd += 4;
        } else if (!matches(descriptor)) return false;
        localEnd += length;
      } else if (local.readUInt32LE(14) !== header.readUInt32LE(16)
        || localCompressed !== compressed || localUncompressed !== uncompressed) return false;
      if (["[Content_Types].xml", "_rels/.rels", mainPart].includes(name) && !uncompressed) return false;
      ranges.push([localOffset, localEnd]);
      at += CENTRAL_SIZE + metadata.length;
    }
    if (at !== directoryEnd) return false;
    ranges.sort((a, b) => a[0] - b[0]);
    // Every byte before the directory must belong to a declared ZIP member.
    // This also rejects executable prefixes and undeclared hidden local entries.
    let covered = 0;
    for (const [start, end] of ranges) {
      if (start !== covered) return false;
      covered = end;
    }
    return covered === directoryOffset && names.has("[Content_Types].xml") && names.has("_rels/.rels") && names.has(mainPart);
  } catch (error) {
    if (error instanceof Error && "syscall" in error) throw error;
    return false;
  } finally {
    await file.close();
  }
}
