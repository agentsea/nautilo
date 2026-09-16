import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InstanceJsonSchema } from "@nautilo/config";

/** Read `server.url` from `<root>/instance.json` when valid. */
export function readServerUrlFromLayoutRoot(root: string): string | null {
  const instancePath = join(root, "instance.json");
  if (!existsSync(instancePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(instancePath, "utf8")) as unknown;
    const parsed = InstanceJsonSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data.server.url.replace(/\/$/, "");
  } catch {
    return null;
  }
}
