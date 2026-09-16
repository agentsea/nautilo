import * as path from "node:path";
import { checkPathAccess, type PathCheckResult } from "@nautilo/security";
import { fileTypeFromBuffer } from "file-type";
import type {
  AttachmentBatchClassification,
  AttachmentClassification,
  AttachmentEnvelope,
} from "./envelope";
import {
  ARCHIVE_EXTENSIONS,
  ATTACHMENT_POLICY,
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  RISKY_TEXT_MIME_PREFIXES,
  SCRIPT_LIKE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./policy";
import { attachmentFilenameExceedsUtf8Policy, attachmentIdExceedsUtf8Policy } from "./attachment-label-utf8";

export type AttachmentPathValidationResult =
  | { ok: true; resolvedPath: string; resolvedZone: "workspace" | "current" | "absolute" }
  | { ok: false; reason: string };

export type AttachmentPathValidator = (
  envelope: AttachmentEnvelope,
) => AttachmentPathValidationResult | Promise<AttachmentPathValidationResult>;

export type AttachmentSecurityGateOptions = {
  securityLevel?: "standard" | "permissive" | "yolo";
  validatePath?: AttachmentPathValidator;
  readHeadBytes?: (envelope: AttachmentEnvelope, maxBytes: number) => Uint8Array | Promise<Uint8Array>;
};

type MagicKind =
  | "audio"
  | "archive"
  | "executable"
  | "image"
  | "pdf"
  | "unknown";

type MagicDetection = {
  kind: MagicKind;
  mime?: string;
};

export async function classifyAttachment(
  envelope: AttachmentEnvelope,
  options: AttachmentSecurityGateOptions = {},
): Promise<AttachmentClassification> {
  const baseValidation = await validateEnvelope(envelope, options);
  if (baseValidation) {
    return baseValidation;
  }

  const extension = extensionOf(envelope.filename);
  const headBytes = await headBytesFor(envelope, options);
  if (envelope.path && headBytes.length === 0) {
    return reject("missing_header_bytes", "Path-backed attachments require header bytes before classification");
  }
  const magic = await detectMagic(headBytes);
  const normalizedMime = normalizeMime(envelope.claimedMime, magic);
  const mimeGroup = classifyMimeGroup(normalizedMime);

  if (isExecutableMagic(magic)) {
    return reject("executable_magic", "Executable files are not accepted", normalizedMime);
  }

  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return reject("executable_extension", "Executable/installable file extensions are not accepted", normalizedMime);
  }

  if (extension === ".svg") {
    return reject("svg_unsupported", "SVG requires an explicit sanitizer policy before acceptance", normalizedMime);
  }

  if (SCRIPT_LIKE_EXTENSIONS.has(extension) && envelope.declaredTreatment !== "source-text") {
    return reject("script_extension", "Script-like attachments require explicit source-text treatment", normalizedMime);
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return reject("archive_extension", "Generic archives are not accepted in the MVP", normalizedMime);
  }

  if (magic.kind === "archive" && !DOCUMENT_EXTENSIONS.has(extension)) {
    return reject("archive_magic", "Generic archive payloads are not accepted in the MVP", normalizedMime);
  }

  const mismatch = detectRiskyMismatch(extension, magic.kind, mimeGroup);
  if (mismatch) {
    return reject(mismatch.code, mismatch.reason, normalizedMime);
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return classifyDocument(extension, headBytes, magic, normalizedMime);
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return classifyImage(envelope, extension, magic, normalizedMime);
  }

  // Browser MediaRecorder often emits `video/webm` (same EBML container as
  // audio-only WebM). Multipart uploads may omit a filename extension
  // (`blob`). Route by MIME group so `/api/stt` accepts these blobs.
  if (AUDIO_EXTENSIONS.has(extension) || mimeGroup === "audio") {
    const effectiveExtension = AUDIO_EXTENSIONS.has(extension)
      ? extension
      : defaultAudioExtensionForMime(normalizedMime);
    return classifyAudio(envelope, effectiveExtension, magic, normalizedMime);
  }

  if (TEXT_EXTENSIONS.has(extension) || envelope.declaredTreatment === "source-text" || isTextMime(normalizedMime)) {
    return classifyText(envelope, magic, headBytes, normalizedMime);
  }

  if (magic.kind !== "unknown") {
    return reject("unsupported_binary", "Binary attachment type is not accepted in the MVP", normalizedMime);
  }

  return reject("unknown_type", "Unknown attachment type is not accepted", normalizedMime);
}

export async function classifyAttachments(
  envelopes: AttachmentEnvelope[],
  options: AttachmentSecurityGateOptions = {},
): Promise<AttachmentBatchClassification[]> {
  if (envelopes.length > ATTACHMENT_POLICY.maxAttachmentsPerMessage) {
    return envelopes.map((envelope) => ({
      envelope,
      classification: reject("too_many_attachments", "Too many attachments in one message"),
    }));
  }

  let acceptedBytes = 0;
  const results: AttachmentBatchClassification[] = [];
  for (const envelope of envelopes) {
    let classification = await classifyAttachment(envelope, options);
    if (classification.decision === "accept") {
      const nextAcceptedBytes = acceptedBytes + envelope.sizeBytes;
      if (nextAcceptedBytes > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) {
        classification = reject("total_bytes_exceeded", "Total accepted attachment bytes exceed the message cap");
      } else {
        acceptedBytes = nextAcceptedBytes;
      }
    }
    results.push({ envelope, classification });
  }
  return results;
}

type MimeGroup = "archive" | "audio" | "document" | "executable" | "image" | "text" | "unknown";

/**
 * When the client sends an audio MIME without a helpful filename (e.g.
 * multipart field name `blob`), pick a conservative extension for caps
 * and MIME fallbacks inside {@link classifyAudio}.
 */
function defaultAudioExtensionForMime(mime: string): string {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (m === "audio/mpeg" || m === "audio/mp3") return ".mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return ".wav";
  if (m === "audio/mp4" || m === "audio/m4a" || m === "audio/x-m4a") return ".m4a";
  if (m === "audio/ogg" || m === "audio/opus") return ".ogg";
  if (m === "audio/flac") return ".flac";
  if (m === "audio/webm" || m === "video/webm") return ".webm";
  if (m.startsWith("audio/")) return ".webm";
  return ".webm";
}

function classifyMimeGroup(mime: string): MimeGroup {
  if (!mime) {
    return "unknown";
  }
  if (isTextMime(mime)) {
    return "text";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  // Chromium / Electron MediaRecorder uses this for Opus-in-WebM captures.
  if (mime === "video/webm") {
    return "audio";
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (
    mime === "application/pdf" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument")
  ) {
    return "document";
  }
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("rar") || mime.includes("7z")) {
    return "archive";
  }
  if (
    mime.includes("executable") ||
    mime.includes("msdownload") ||
    mime.includes("x-elf") ||
    mime.includes("x-mach-binary")
  ) {
    return "executable";
  }
  return "unknown";
}

function detectRiskyMismatch(
  extension: string,
  magicKind: MagicKind,
  mimeGroup: MimeGroup,
): { code: string; reason: string } | null {
  const extensionGroup = classifyExtensionGroup(extension);
  if (extensionGroup === "unknown" || mimeGroup === "unknown") {
    return null;
  }
  if (extensionGroup === mimeGroup) {
    return null;
  }
  if (extensionGroup === "document" && mimeGroup === "archive") {
    return null;
  }
  if (extensionGroup === "audio" && magicKind === "audio") {
    return null;
  }
  return {
    code: "mime_extension_mismatch",
    reason: "Attachment filename extension and MIME type disagree",
  };
}

function classifyExtensionGroup(extension: string): MimeGroup {
  if (TEXT_EXTENSIONS.has(extension) || SCRIPT_LIKE_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (IMAGE_EXTENSIONS.has(extension) || extension === ".svg") {
    return "image";
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return "archive";
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return "executable";
  }
  return "unknown";
}

async function validateEnvelope(
  envelope: AttachmentEnvelope,
  options: AttachmentSecurityGateOptions,
): Promise<AttachmentClassification | null> {
  if (!envelope.id.trim()) {
    return reject("missing_id", "Attachment id is required");
  }
  if (!envelope.filename.trim()) {
    return reject("missing_filename", "Attachment filename is required");
  }
  if (attachmentIdExceedsUtf8Policy(envelope.id)) {
    return reject(
      "id_too_long",
      `Attachment id exceeds ${ATTACHMENT_POLICY.maxAttachmentIdUtf8Bytes} UTF-8 bytes`,
    );
  }
  if (attachmentFilenameExceedsUtf8Policy(envelope.filename)) {
    return reject(
      "filename_too_long",
      `Attachment filename exceeds ${ATTACHMENT_POLICY.maxAttachmentFilenameUtf8Bytes} UTF-8 bytes`,
    );
  }
  if (!Number.isSafeInteger(envelope.sizeBytes) || envelope.sizeBytes < 0) {
    return reject("invalid_size", "Attachment size must be a non-negative safe integer");
  }
  if (envelope.bytes && envelope.path) {
    return reject("ambiguous_transport", "Attachment envelopes cannot carry both bytes and path");
  }
  if (envelope.bytes && envelope.sizeBytes !== envelope.bytes.byteLength) {
    return reject("size_mismatch", "Attachment size does not match byte payload length");
  }
  if (!envelope.bytes && !envelope.path) {
    return reject("missing_payload", "Attachment envelope must carry bytes or a path");
  }
  if (envelope.path) {
    const pathResult = await validatePathBackedEnvelope(envelope, options);
    if (pathResult) {
      return pathResult;
    }
  }
  return null;
}

async function validatePathBackedEnvelope(
  envelope: AttachmentEnvelope,
  options: AttachmentSecurityGateOptions,
): Promise<AttachmentClassification | null> {
  if (!envelope.zone) {
    return reject("missing_zone", "Path-backed attachment envelopes require a zone");
  }
  if (!options.validatePath) {
    return reject("missing_path_validator", "Path-backed attachments require D079 zone validation");
  }
  const result = await options.validatePath(envelope);
  if (!result.ok) {
    return reject("path_zone_denied", result.reason);
  }
  const pathCheck: PathCheckResult = checkPathAccess(
    result.resolvedPath,
    options.securityLevel ?? "standard",
  );
  if (!pathCheck.allowed) {
    return reject("protected_path_denied", pathCheck.reason ?? "Path is protected");
  }
  return null;
}

async function headBytesFor(
  envelope: AttachmentEnvelope,
  options: AttachmentSecurityGateOptions,
): Promise<Uint8Array> {
  if (envelope.bytes) {
    return envelope.bytes.subarray(0, ATTACHMENT_POLICY.maxSniffBytes);
  }
  if (options.readHeadBytes) {
    return options.readHeadBytes(envelope, ATTACHMENT_POLICY.maxSniffBytes);
  }
  return new Uint8Array();
}

function classifyText(
  envelope: AttachmentEnvelope,
  magic: MagicDetection,
  bytes: Uint8Array,
  normalizedMime: string,
): AttachmentClassification {
  if (envelope.sizeBytes > ATTACHMENT_POLICY.maxTextBytes) {
    return reject("text_too_large", "Text attachment exceeds the configured size cap", normalizedMime);
  }
  if (magic.kind !== "unknown") {
    return reject("text_magic_mismatch", "Text attachment has binary magic bytes", normalizedMime);
  }
  if (!looksLikeText(bytes)) {
    return reject("binary_as_text", "Attachment does not decode as safe text", normalizedMime);
  }
  const warnings = envelope.declaredTreatment === "source-text" ? ["source-text-read-only"] : [];
  return accept("text", normalizedMime || "text/plain", warnings);
}

function classifyAudio(
  envelope: AttachmentEnvelope,
  extension: string,
  magic: MagicDetection,
  normalizedMime: string,
): AttachmentClassification {
  if (envelope.sizeBytes > ATTACHMENT_POLICY.maxAudioBytes) {
    return reject("audio_too_large", "Audio attachment exceeds the configured size cap", normalizedMime);
  }
  if (magic.kind !== "unknown" && magic.kind !== "audio") {
    return reject("audio_magic_mismatch", "Audio attachment has conflicting magic bytes", normalizedMime);
  }
  return accept("audio", normalizedMime || audioMimeForExtension(extension), []);
}

function classifyImage(
  envelope: AttachmentEnvelope,
  extension: string,
  magic: MagicDetection,
  normalizedMime: string,
): AttachmentClassification {
  if (magic.kind !== "unknown" && magic.kind !== "image") {
    return reject("image_magic_mismatch", "Image attachment has conflicting magic bytes", normalizedMime);
  }
  if (envelope.sizeBytes > ATTACHMENT_POLICY.maxImageBytes) {
    return reject("image_too_large", "Image attachment exceeds the configured size cap", normalizedMime);
  }
  return accept("image", normalizedMime || imageMimeForExtension(extension), []);
}

function classifyDocument(
  extension: string,
  bytes: Uint8Array,
  magic: MagicDetection,
  normalizedMime: string,
): AttachmentClassification {
  if (containsAscii(bytes, "vbaProject.bin")) {
    return reject("office_macro_payload", "Office documents with macro payload indicators are not accepted", normalizedMime);
  }
  if (extension === ".pdf") {
    if (magic.kind !== "unknown" && magic.kind !== "pdf") {
      return reject("document_magic_mismatch", "PDF attachment has conflicting magic bytes", normalizedMime);
    }
    return reject(
      "document_extraction_unavailable",
      "PDF attachments are not accepted until bounded document extraction lands",
      normalizedMime || "application/pdf",
    );
  }
  if (magic.kind !== "unknown" && magic.kind !== "archive") {
    return reject("document_magic_mismatch", "Office attachment has conflicting magic bytes", normalizedMime);
  }
  return reject(
    "document_extraction_unavailable",
    "Office attachments are not accepted until bounded document extraction lands",
    normalizedMime || officeMimeForExtension(extension),
  );
}

async function detectMagic(bytes: Uint8Array): Promise<MagicDetection> {
  const hardDeny = detectHardDenyMagic(bytes);
  if (hardDeny.kind !== "unknown") {
    return hardDeny;
  }

  if (bytes.length > 0) {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected) {
      return magicFromMime(detected.mime);
    }
  }

  return detectFallbackMagic(bytes);
}

function detectHardDenyMagic(bytes: Uint8Array): MagicDetection {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
      return { kind: "executable", mime: "application/x-elf" };
    }
    if (
      (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && (bytes[3] === 0xce || bytes[3] === 0xcf)) ||
      (bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
      (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe)
    ) {
      return { kind: "executable", mime: "application/x-mach-binary" };
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return { kind: "executable", mime: "application/x-msdownload" };
  }
  return { kind: "unknown" };
}

function detectFallbackMagic(bytes: Uint8Array): MagicDetection {
  if (bytes.length >= 4) {
    if (startsWithAscii(bytes, "%PDF")) {
      return { kind: "pdf", mime: "application/pdf" };
    }
    if (startsWithAscii(bytes, "PK\u0003\u0004") || startsWithAscii(bytes, "PK\u0005\u0006") || startsWithAscii(bytes, "PK\u0007\u0008")) {
      return { kind: "archive", mime: "application/zip" };
    }
    if (startsWithAscii(bytes, "OggS")) {
      return { kind: "audio", mime: "audio/ogg" };
    }
    if (startsWithAscii(bytes, "fLaC")) {
      return { kind: "audio", mime: "audio/flac" };
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { kind: "audio", mime: "audio/webm" };
    }
  }
  if (bytes.length >= 3 && startsWithAscii(bytes, "ID3")) {
    return { kind: "audio", mime: "audio/mpeg" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0) {
    return { kind: "audio", mime: "audio/mpeg" };
  }
  if (bytes.length >= 12 && startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WAVE")) {
    return { kind: "audio", mime: "audio/wav" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWithAscii(bytes.subarray(1), "PNG\r\n\u001a\n")) {
    return { kind: "image", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mime: "image/jpeg" };
  }
  if (bytes.length >= 6 && (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a"))) {
    return { kind: "image", mime: "image/gif" };
  }
  if (bytes.length >= 12 && startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return { kind: "image", mime: "image/webp" };
  }
  return { kind: "unknown" };
}

function magicFromMime(mime: string): MagicDetection {
  const normalized = mime.toLowerCase();
  const group = classifyMimeGroup(normalized);
  switch (group) {
    case "archive":
      return { kind: "archive", mime: normalized };
    case "audio":
      return { kind: "audio", mime: normalized };
    case "document":
      return normalized === "application/pdf"
        ? { kind: "pdf", mime: normalized }
        : { kind: "archive", mime: normalized };
    case "executable":
      return { kind: "executable", mime: normalized };
    case "image":
      return { kind: "image", mime: normalized };
    case "text":
    case "unknown":
      return { kind: "unknown", mime: normalized };
  }
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return true;
  }
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      return false;
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controls += 1;
    }
  }
  if (controls / bytes.length > 0.01) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function normalizeMime(claimedMime: string | undefined, magic: MagicDetection): string {
  const claimed = claimedMime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (magic.mime) {
    return magic.mime;
  }
  if (!claimed || claimed === "application/octet-stream") {
    return "";
  }
  return claimed;
}

function isTextMime(mime: string): boolean {
  return RISKY_TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isExecutableMagic(magic: MagicDetection): boolean {
  return magic.kind === "executable";
}

function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (bytes[offset + i] !== value.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) {
    return false;
  }
  for (let i = 0; i <= bytes.length - value.length; i += 1) {
    if (asciiAt(bytes, i, value)) {
      return true;
    }
  }
  return false;
}

function accept(
  kind: "text" | "audio" | "image" | "document",
  normalizedMime: string,
  warnings: string[],
): AttachmentClassification {
  return { decision: "accept", kind, normalizedMime, warnings };
}

function reject(code: string, reason: string, normalizedMime?: string): AttachmentClassification {
  if (normalizedMime) {
    return { decision: "reject", code, reason, normalizedMime };
  }
  return { decision: "reject", code, reason };
}

function audioMimeForExtension(extension: string): string {
  switch (extension) {
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mpeg";
  }
}

function imageMimeForExtension(extension: string): string {
  switch (extension) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

function officeMimeForExtension(extension: string): string {
  switch (extension) {
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
}
