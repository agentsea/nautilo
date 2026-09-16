import {
  ARCHIVE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  SCRIPT_LIKE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./policy";

const EXTRA_DATA_EXTENSIONS = [".ndjson", ".parquet", ".geojson", ".log", ".ini"] as const;

/**
 * D423 Phase 2 — video extensions admitted by the workspace artifact upload
 * policy ONLY. Deliberately NOT added to the composer-chat attachment sets in
 * `policy.ts` (which the chat classifier in `classify.ts` consumes), so chat
 * attachment extensions and the chat classifier are untouched. Workspace
 * artifact upload is a separate, broader surface with its own magic gate
 * (see {@link isLikelyIsoBmffMp4}); an `.mp4` is accepted only when its head
 * bytes carry the ISO-BMFF `ftyp` box, never on extension alone.
 */
export const ARTIFACT_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".mp4"]);

/** Broad workspace-artifact upload allowlist (not the tight composer-chat set). */
export const ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTENSIONS,
  ...SCRIPT_LIKE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...EXTRA_DATA_EXTENSIONS,
  ...ARTIFACT_VIDEO_EXTENSIONS,
]);

const SVG_EXTENSION = ".svg";

function basenameOf(pathOrName: string): string {
  return pathOrName.split(/[/\\]/).pop() ?? pathOrName;
}

/** Lowercase extension including the dot, or "" if none / dotfile-only. */
export function extensionOfArtifactName(name: string): string {
  const base = basenameOf(name);
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) {
    return "";
  }
  return base.slice(i).toLowerCase();
}

export function isArtifactUploadAllowedByExtension(name: string): boolean {
  const ext = extensionOfArtifactName(name);
  if (ext === "") {
    return false;
  }
  if (ext === SVG_EXTENSION) {
    return false;
  }
  if (EXECUTABLE_EXTENSIONS.has(ext) || ARCHIVE_EXTENSIONS.has(ext)) {
    return false;
  }
  return ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Self-contained magic-byte deny for executables and zip-style archives.
 * Byte patterns copied from `classify.ts` `detectHardDenyMagic` / `detectFallbackMagic`
 * (source of truth for attachment security sniffing).
 */
export function detectExecutableOrArchiveMagic(headBytes: Uint8Array): "executable" | "archive" | null {
  if (headBytes.length >= 4) {
    if (headBytes[0] === 0x7f && headBytes[1] === 0x45 && headBytes[2] === 0x4c && headBytes[3] === 0x46) {
      return "executable";
    }
    if (
      (headBytes[0] === 0xfe &&
        headBytes[1] === 0xed &&
        headBytes[2] === 0xfa &&
        (headBytes[3] === 0xce || headBytes[3] === 0xcf)) ||
      (headBytes[0] === 0xce && headBytes[1] === 0xfa && headBytes[2] === 0xed && headBytes[3] === 0xfe) ||
      (headBytes[0] === 0xcf && headBytes[1] === 0xfa && headBytes[2] === 0xed && headBytes[3] === 0xfe)
    ) {
      return "executable";
    }
    if (headBytes[0] === 0x50 && headBytes[1] === 0x4b && headBytes[2] === 0x03 && headBytes[3] === 0x04) {
      return "archive";
    }
    if (headBytes[0] === 0x50 && headBytes[1] === 0x4b && headBytes[2] === 0x05 && headBytes[3] === 0x06) {
      return "archive";
    }
    if (headBytes[0] === 0x50 && headBytes[1] === 0x4b && headBytes[2] === 0x07 && headBytes[3] === 0x08) {
      return "archive";
    }
  }
  if (headBytes.length >= 2 && headBytes[0] === 0x4d && headBytes[1] === 0x5a) {
    return "executable";
  }
  return null;
}

/**
 * Extensions that name OOXML packages (ECMA-376 / ISO/IEC 29500).
 * Despite the .docx/.xlsx/.pptx extension these files are physically ZIP
 * archives, so they trip {@link detectExecutableOrArchiveMagic}'s archive
 * branch and need an explicit carve-out.
 */
const OOXML_EXTENSIONS: ReadonlySet<string> = new Set([".docx", ".xlsx", ".pptx"]);

/**
 * Per-part marker file required at the start of every OOXML package. Per
 * ECMA-376 §10.1.1, `[Content_Types].xml` is the first part in the package
 * and therefore appears near the very start of the ZIP stream — its local
 * file header sits at byte 0 and the filename bytes follow the 30-byte
 * local-file header, so the marker is reachable within a small sniff window.
 */
const OOXML_MARKER = new TextEncoder().encode("[Content_Types].xml");

function containsSubarray(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) {
    return true;
  }
  if (hay.length < needle.length) {
    return false;
  }
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/**
 * Conservative carve-out for OOXML office files (.docx/.xlsx/.pptx), which
 * are physically ZIP archives but should be accepted as workspace artifacts
 * when their content actually looks like an OOXML package.
 *
 * Required signals, all three:
 *   1. Extension is one of `.docx` / `.xlsx` / `.pptx`.
 *   2. The sniffed prefix starts with the ZIP local-file-header magic
 *      `PK\x03\x04`. Empty-archive signatures (`PK\x05\x06` / `PK\x07\x08`)
 *      are not valid leading bytes for a real OOXML file and are rejected.
 *   3. The sniffed prefix contains the `[Content_Types].xml` marker, which
 *      is the first filename inside every OOXML package.
 *
 * RISK / sniff-window sizing: {@link ATTACHMENT_POLICY.maxSniffBytes} is
 * 64 KiB. The first ZIP local-file header (30 bytes) plus the
 * `[Content_Types].xml` filename (19 bytes) lands within the first ~50
 * bytes of a compliant package, so 64 KiB is comfortably enough for
 * well-formed OOXML files produced by Word/Excel/PowerPoint and most
 * libraries. We do NOT accept extension-only proof: a `.docx` whose head
 * bytes look like a plain ZIP without the marker is rejected as
 * `archive_magic`. If a real OOXML producer ever places enough data before
 * the `[Content_Types].xml` entry that the marker falls outside the 64 KiB
 * sniff window, the upload will be wrongly rejected; that case is a tracked
 * follow-up for the server route to do a deeper sniff / full central
 * directory check rather than a prefix-only sniff.
 */
export function isLikelyOoxmlZip(filename: string, headBytes: Uint8Array): boolean {
  const ext = extensionOfArtifactName(filename);
  if (!OOXML_EXTENSIONS.has(ext)) {
    return false;
  }
  if (headBytes.length < 4) {
    return false;
  }
  if (
    !(
      headBytes[0] === 0x50 &&
      headBytes[1] === 0x4b &&
      headBytes[2] === 0x03 &&
      headBytes[3] === 0x04
    )
  ) {
    return false;
  }
  return containsSubarray(headBytes, OOXML_MARKER);
}

/**
 * ISO-BMFF `ftyp` box sniff for workspace-artifact `.mp4` uploads.
 *
 * Reuses the exact local-media ingest semantics from
 * `packages/agent/src/tools/media/ingest-local-media.ts`'s
 * `hasIsoBmffFileTypeBox`: an ISO-BMFF file (MP4) begins with a 4-byte box
 * size at offset 0, then the ASCII box type `ftyp` at offset 4..8. We require
 * at least 12 head bytes (size + `ftyp` + 4-byte major brand) before trusting
 * the prefix — the same floor the local-media sniff uses.
 *
 * No new dependency: a 4-byte ASCII compare against the sniffed head, the
 * same approach {@link detectExecutableOrArchiveMagic} already takes. We do
 * NOT accept `.mp4` on extension alone; a renamed non-MP4 lacking `ftyp` is
 * rejected with `mp4_ftyp_missing` by {@link classifyArtifactUpload}.
 *
 * Note: `ftyp` is a necessary, not sufficient, signal — a byte-for-byte valid
 * MP4 is not fully validated here. That matches the local-media ingest
 * contract and the OOXML carve-out's prefix-only philosophy.
 */
export function isLikelyIsoBmffMp4(headBytes: Uint8Array): boolean {
  if (headBytes.length < 12) {
    return false;
  }
  return (
    headBytes[4] === 0x66 && // 'f'
    headBytes[5] === 0x74 && // 't'
    headBytes[6] === 0x79 && // 'y'
    headBytes[7] === 0x70 //   'p'
  );
}

export function classifyArtifactUpload({
  filename,
  headBytes,
}: {
  filename: string;
  headBytes: Uint8Array;
}): { ok: true } | { ok: false; reason: string; code: string } {
  const magic = detectExecutableOrArchiveMagic(headBytes);
  if (magic === "executable") {
    return {
      ok: false,
      reason: "Executable content detected in upload",
      code: "executable_magic",
    };
  }
  if (magic === "archive") {
    if (isLikelyOoxmlZip(filename, headBytes)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "Archive content detected in upload",
      code: "archive_magic",
    };
  }
  if (!isArtifactUploadAllowedByExtension(filename)) {
    return {
      ok: false,
      reason: "Unsupported artifact file type",
      code: "unsupported_artifact_type",
    };
  }
  const ext = extensionOfArtifactName(filename);
  if (ARTIFACT_VIDEO_EXTENSIONS.has(ext) && !isLikelyIsoBmffMp4(headBytes)) {
    return {
      ok: false,
      reason: "MP4 artifact missing ISO-BMFF ftyp header",
      code: "mp4_ftyp_missing",
    };
  }
  return { ok: true };
}
