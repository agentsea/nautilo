import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNautiloRootDir } from "@nautilo/config";

const TUI_LAST_SERVER_TARGET_FILE = "tui-last-server-target.json";

export function tuiLastServerTargetPath(): string {
  return join(resolveNautiloRootDir(), TUI_LAST_SERVER_TARGET_FILE);
}

/** Rejects non-http(s) bases and protocol-relative URLs (persisted-pick hygiene). */
export function looksLikeHttpServerBaseUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("//")) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * D112 — last interactive server pick. Desktop retains the legacy filename
 * (`~/.nautilo/tui-last-server-target.json`) for installation compatibility.
 */
export function readPersistedTuiServerTarget(): string | null {
  try {
    const p = tuiLastServerTargetPath();
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const u = (raw as { serverUrl?: unknown }).serverUrl;
    if (typeof u !== "string" || u.trim() === "") return null;
    const normalized = u.trim().replace(/\/$/, "");
    if (!looksLikeHttpServerBaseUrl(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function writePersistedTuiServerTarget(url: string): void {
  const normalized = url.trim().replace(/\/$/, "");
  if (!looksLikeHttpServerBaseUrl(normalized)) {
    throw new Error(
      `[instance-discovery] Refusing to persist invalid server URL: ${JSON.stringify(url)}`,
    );
  }
  writeFileSync(
    tuiLastServerTargetPath(),
    `${JSON.stringify({ serverUrl: normalized }, null, 0)}\n`,
    "utf8",
  );
}
