import { basename } from "node:path";

/** Human-readable id: empty default instance is shown as "(default)". */
export function displayInstanceIdFromRoot(rootDir: string): string {
  const name = basename(rootDir);
  if (name === ".nautilo") return "(default)";
  if (name.startsWith(".nautilo-")) return name.slice(".nautilo-".length);
  return name;
}

/** Canonical instance id for `NAUTILO_INSTANCE_ID` (empty string for default). */
export function canonicalInstanceIdFromRoot(rootDir: string): string {
  const name = basename(rootDir);
  if (name === ".nautilo") return "";
  if (name.startsWith(".nautilo-")) return name.slice(".nautilo-".length);
  return "";
}
