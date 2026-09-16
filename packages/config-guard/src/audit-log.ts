import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types";

/** Sync append for boot-time paths (`resolveDotenvPath`) where async I/O is avoided. */
export function appendAuditEntrySync(path: string, entry: AuditEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(path, line, "utf-8");
}

export async function readAuditLog(path: string, limit = 100): Promise<AuditEntry[]> {
  try {
    if (limit <= 0) {
      return [];
    }
    const raw = await readFile(path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}
