export const ATTACHMENT_POLICY = {
  maxTextBytes: 200 * 1024,
  maxAudioBytes: 25 * 1024 * 1024,
  /** Per-image cap before base64 expansion into the chat job payload */
  maxImageBytes: 15 * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  maxAcceptedBytesPerMessage: 30 * 1024 * 1024,
  maxSniffBytes: 64 * 1024,
  /** Composer/client attachment id — UUID-sized strings plus margin; bounds prompt/status payload. */
  maxAttachmentIdUtf8Bytes: 256,
  /** Display filename wire limit — below typical OS component caps; bounds prompt wrappers. */
  maxAttachmentFilenameUtf8Bytes: 512,
  /**
   * @deprecated Use {@link maxAttachmentIdUtf8Bytes} / {@link maxAttachmentFilenameUtf8Bytes}.
   * Kept for legacy tests and callers that applied one ceiling to both fields.
   */
  maxAttachmentLabelUtf8Bytes: 512,
} as const;

export const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".rs",
  ".go",
  ".py",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".sql",
]);

export const SCRIPT_LIKE_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".js",
  ".mjs",
  ".cjs",
]);

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".opus",
  ".webm",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
]);

export const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".7z",
  ".rar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
]);

export const EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".exe",
  ".msi",
  ".dll",
  ".dylib",
  ".so",
  ".deb",
  ".rpm",
  ".pkg",
  ".apk",
]);

export const RISKY_TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/toml",
] as const;
