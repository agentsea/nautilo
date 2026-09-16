import * as path from "node:path";
import { normalizeFormat } from "./backend-resolver";

const EXTENSION_TO_FORMAT: Record<string, string> = {
  ".md": "md",
  ".markdown": "md",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "doc",
  ".xlsx": "xlsx",
  ".xls": "xls",
  ".pptx": "pptx",
  ".ppt": "ppt",
  ".odt": "odt",
  ".rtf": "rtf",
  ".txt": "txt",
  ".csv": "csv",
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".epub": "epub",
};

export function inferFormatFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_FORMAT[ext] ?? ext.slice(1);
}

export function expectedExtensionForFormat(format: string): string {
  const normalized = normalizeFormat(format);
  if (normalized === "jpeg") return ".jpg";
  return `.${normalized}`;
}

export function pathMatchesOutputFormat(destinationPath: string, format: string): boolean {
  const expected = expectedExtensionForFormat(format);
  return destinationPath.toLowerCase().endsWith(expected);
}
