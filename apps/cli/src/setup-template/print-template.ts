import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function printQuickstartTemplate(): string {
  const path = join(__dirname, "..", "templates", "nautilo-setup.quickstart.toml");
  return readFileSync(path, "utf8");
}
