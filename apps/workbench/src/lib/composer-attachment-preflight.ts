import {
  extensionOfBasename,
  workspaceDocumentMimeType,
  isComposerChatAttachmentPathAllowed,
} from "@nautilo/attachments/composer-chat-extensions";

export type ComposerChatAttachmentSkip = {
  basename: string;
  reason: "no_extension" | "unsupported_type";
};

export type ComposerChatAttachmentPreflight =
  | { ok: true }
  | { ok: false; skip: ComposerChatAttachmentSkip };

/** Strip C0/C1 control chars and cap length for safe toast/chip-adjacent UI. */
export function sanitizeComposerAttachmentBasenameForUi(name: string): string {
  // Match C0 controls + DEL for UI-safe filenames (binary paths, pasted NULs).
  // eslint-disable-next-line no-control-regex -- intentional strip of C0/DEL for display safety
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

/**
 * Cheap client-side gate before queueing a composer chip. The server attachment gate
 * remains authoritative (magic bytes, MIME, zone, size).
 */
export function preflightComposerChatAttachment(pathOrName: string, options?: { workspaceDocuments?: boolean }): ComposerChatAttachmentPreflight {
  const basename = pathOrName.split(/[/\\]/).pop() ?? pathOrName;
  const ext = extensionOfBasename(pathOrName);
  if (ext === "") {
    return { ok: false, skip: { basename, reason: "no_extension" } };
  }
  if (!(options?.workspaceDocuments && workspaceDocumentMimeType(pathOrName) !== null) && !isComposerChatAttachmentPathAllowed(pathOrName)) {
    return { ok: false, skip: { basename, reason: "unsupported_type" } };
  }
  return { ok: true };
}

const SUPPORTED_HINT =
  "Supported types: text (markdown, code, data files), images (PNG, JPEG, GIF, WebP), and audio (MP3, WAV, M4A, OGG, FLAC, OPUS, WebM).";

/** User-facing copy for Workbench toasts when files are skipped before send. */
export function formatComposerAttachmentSkipToast(skipped: readonly ComposerChatAttachmentSkip[], options?: { workspaceDocuments?: boolean }): {
  title: string;
  message: string;
} {
  const supportedHint = options?.workspaceDocuments
    ? `${SUPPORTED_HINT} Documents: PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX).`
    : SUPPORTED_HINT;
  if (skipped.length === 0) {
    return { title: "Unsupported attachment", message: supportedHint };
  }
  if (skipped.length === 1) {
    const s = skipped[0];
    const safe = sanitizeComposerAttachmentBasenameForUi(s.basename);
    const title = "Unsupported attachment";
    if (s.reason === "no_extension") {
      return {
        title,
        message: `Can't attach "${safe}" — the filename has no extension, so we can't tell what type it is.\n\n${supportedHint}`,
      };
    }
    return {
      title,
      message: `"${safe}" isn't a supported attachment type.\n\n${supportedHint}`,
    };
  }
  const names = skipped.map((s) => sanitizeComposerAttachmentBasenameForUi(s.basename)).join(", ");
  return {
    title: "Unsupported attachments",
    message: `Skipped ${skipped.length} files: ${names}.\n\n${supportedHint}`,
  };
}
