import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

export function temporaryDirectory(template: string): string {
  const root = mkdtempSync(template);
  roots.push(root);
  return root;
}
