import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isBunRuntimeCached(binary: string, version: string): boolean {
  try {
    const stamp = JSON.parse(readFileSync(binary + ".version", "utf8")) as { version?: unknown; sha256?: unknown };
    return stamp.version === version && stamp.sha256 === digest(readFileSync(binary));
  } catch {
    return false;
  }
}

export function recordBunRuntimeCache(binary: string, version: string): void {
  writeFileSync(binary + ".version", JSON.stringify({ version, sha256: digest(readFileSync(binary)) }) + "\n");
}
