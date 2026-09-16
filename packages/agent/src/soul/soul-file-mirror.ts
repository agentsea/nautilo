import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveNautiloRootDir } from "@nautilo/config";

export function getSoulFileMirrorPath(): string {
  return join(resolveNautiloRootDir(), "soul.md");
}

export async function mirrorSoulFileToDisk(content: string): Promise<string> {
  const path = getSoulFileMirrorPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return path;
}

export async function loadSoulFileFromDisk(): Promise<string | null> {
  try {
    return await readFile(getSoulFileMirrorPath(), "utf-8");
  } catch {
    return null;
  }
}
