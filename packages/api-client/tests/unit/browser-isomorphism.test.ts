/**
 * Regression: api-client + workbench's `model-section.tsx` ship in browser
 * bundles, so transitively importing server-only Node modules (e.g.
 * `node:path` via `@nautilo/config`) breaks Vite with
 *   "Module 'node:path' has been externalized for browser compatibility".
 *
 * The audit "consolidation" pass reintroduced this by making both files
 * `import { getAllKeyDefinitions } from "@nautilo/config-guard"` at runtime,
 * which transitively pulled `@nautilo/config` (uses `node:path`).
 *
 * This test is a lightweight static scan of the relevant source files.
 * It rejects any non-`import type` import from `@nautilo/config`,
 * `@nautilo/config-guard`, or `node:*`.
 *
 * Limitation: this is a direct-import check, not a full module graph walk.
 * It catches the actual bug that occurred (top-level runtime import) but
 * does not catch deeper transitive regressions through other allowed
 * dependencies. Adequate for the reproducer; upgrade to a Bun.build-based
 * graph check if/when this proves insufficient.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const REPO_ROOT = join(PACKAGE_ROOT, "../..");

const FORBIDDEN_RUNTIME_IMPORTS = [
  "@nautilo/config",
  "@nautilo/config-guard",
] as const;

interface ImportLine {
  raw: string;
  isTypeOnly: boolean;
  source: string;
}

function extractImports(src: string): ImportLine[] {
  const out: ImportLine[] = [];
  // Matches: import [type] ... from "X"; (single line)
  // Strip block comments first to avoid matching inside JSDoc.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /^\s*import\s+(?:(type)\s+)?[^;]*?\bfrom\s+["']([^"']+)["'];?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.push({
      raw: m[0],
      isTypeOnly: m[1] === "type",
      source: m[2] ?? "",
    });
  }
  return out;
}

const FILES_TO_CHECK = [
  {
    label: "packages/api-client/src/client.ts",
    path: join(PACKAGE_ROOT, "src/client.ts"),
  },
  {
    label: "packages/api-client/src/browser.ts",
    path: join(PACKAGE_ROOT, "src/browser.ts"),
  },
  {
    label: "packages/api-client/src/schemas/remote-control.ts",
    path: join(PACKAGE_ROOT, "src/schemas/remote-control.ts"),
  },
  {
    label: "apps/workbench/src/pages/settings/sections/model-section.tsx",
    path: join(REPO_ROOT, "apps/workbench/src/pages/settings/sections/model-section.tsx"),
  },
] as const;

describe("browser-isomorphism: client-loaded modules must not pull server-only deps", () => {
  for (const { label, path } of FILES_TO_CHECK) {
    test(`${label} has no non-type runtime imports of forbidden packages`, () => {
      const src = readFileSync(path, "utf8");
      const imports = extractImports(src);
      const offenders = imports.filter((i) => {
        if (i.isTypeOnly) return false;
        return FORBIDDEN_RUNTIME_IMPORTS.some(
          (pkg) => i.source === pkg || i.source.startsWith(`${pkg}/`),
        );
      });
      if (offenders.length > 0) {
        const msg = offenders
          .map((o) => `  - ${o.raw.trim()}`)
          .join("\n");
        throw new Error(
          `${label} has runtime imports of server-only packages, which break the browser bundle:\n${msg}\n\n` +
            `Use \`import type\` for type-only references, or duplicate the small constant set you need.`,
        );
      }
    });

    test(`${label} has no node:* runtime imports`, () => {
      const src = readFileSync(path, "utf8");
      const imports = extractImports(src);
      const offenders = imports.filter(
        (i) => !i.isTypeOnly && i.source.startsWith("node:"),
      );
      if (offenders.length > 0) {
        const msg = offenders.map((o) => `  - ${o.raw.trim()}`).join("\n");
        throw new Error(
          `${label} imports node:* builtins at runtime — this file must remain browser-isomorphic:\n${msg}`,
        );
      }
      expect(offenders.length).toBe(0);
    });
  }
});
