import { createOoxmlByteSource, type OoxmlByteSource } from "@nautilo/browser-document-viewer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OOXML_ARCHIVE_PREFLIGHT_LIMITS } from "../../../src/viewers/ooxml/contract";

export function ooxmlTestMaster(): ArrayBuffer {
  const bytes = readFileSync(
    resolve(import.meta.dir, "../../fixtures/ooxml/xlsx/simple.xlsx"),
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function ooxmlTestSource(bytes = ooxmlTestMaster()): OoxmlByteSource {
  const result = createOoxmlByteSource({
    bytes,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
    archivePreflight: OOXML_ARCHIVE_PREFLIGHT_LIMITS,
  });
  if (result.kind !== "ready") throw new Error("OOXML test fixture rejected.");
  return result.source;
}
