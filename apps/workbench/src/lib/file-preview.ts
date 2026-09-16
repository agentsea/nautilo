import { READER_SHIKI_LANGUAGES } from "./reader-languages";

const EXACT_TEXT_FILENAMES = new Map<string, string | null>([
  [".editorconfig", null],
  [".env", null],
  [".gitignore", null],
  [".npmrc", null],
  ["dockerfile", null],
  ["license", null],
  ["makefile", null],
  ["readme", null],
]);

const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".rb", ".java", ".kt", ".swift",
  ".css", ".scss", ".html", ".xml", ".sh", ".bash",
]);

/**
 * Cap for in-app text/markdown preview + edit. Raised to 50 MB (the officecli
 * `.docx` ceiling / office-document cap) so large documents preview instead of
 * being turned away; files above this show an explicit "too large" message
 * (not a misleading "not supported"). Binary viewers keep their own caps.
 */
export const MAX_TEXT_PREVIEW_BYTES = 50 * 1024 * 1024;

export type PreviewKind =
  | { kind: "markdown"; language: "markdown" }
  | { kind: "text"; language: string | null }
  | { kind: "unsupported"; ext: string | null };

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

function isMarkdownExtension(ext: string | null): boolean {
  return ext === ".md" || ext === ".markdown";
}

function isTextPreviewExtension(ext: string | null): boolean {
  return ext !== null && (TEXT_PREVIEW_EXTENSIONS.has(ext) || isMarkdownExtension(ext));
}

function langFromExtension(ext: string | null): string | null {
  if (!ext) return null;
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".rs": "rust", ".go": "go", ".rb": "ruby",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".md": "markdown", ".markdown": "markdown",
    ".html": "html", ".css": "css", ".scss": "scss",
    ".sh": "bash", ".bash": "bash", ".xml": "xml",
  };
  const language = map[ext] ?? null;
  return language !== null && READER_SHIKI_LANGUAGES.has(language)
    ? language
    : null;
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function previewKindForPath(path: string): PreviewKind {
  const name = basename(path);
  const lowerName = name.toLowerCase();
  const exact = EXACT_TEXT_FILENAMES.get(lowerName);
  if (EXACT_TEXT_FILENAMES.has(lowerName)) {
    return { kind: "text", language: exact ?? null };
  }
  if (/^\.env(?:\.|$)/.test(lowerName)) {
    return { kind: "text", language: null };
  }
  const ext = extensionOf(name);
  if (isMarkdownExtension(ext)) return { kind: "markdown", language: "markdown" };
  if (isTextPreviewExtension(ext)) {
    return { kind: "text", language: langFromExtension(ext) };
  }
  return { kind: "unsupported", ext };
}
