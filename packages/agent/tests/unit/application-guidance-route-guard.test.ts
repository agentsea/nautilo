import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const agentRoot = resolve(import.meta.dir, "../..");

/**
 * Compatibility is allowed only for a named, temporary migration file with a
 * removal condition. D513 has no remaining agent-facing route compatibility.
 */
const ROUTE_COMPATIBILITY_ALLOWLIST = new Set<string>();

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory()
      ? sourceFiles(child)
      : (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [child] : []);
  });
}

test("agent production guidance contains no internal Settings, Connections, or Admin route prose", () => {
  const internalRoute = /["'`]\/(?:settings|connections|admin)(?:[/#"'`])/u;
  const retiredSentinel = /NAUTILO_ACTION:|launch-customization-action|google-workspace-connect/u;

  expect([...ROUTE_COMPATIBILITY_ALLOWLIST]).toEqual([]);
  for (const path of sourceFiles(resolve(agentRoot, "src"))) {
    const relativePath = path.slice(agentRoot.length + 1);
    if (ROUTE_COMPATIBILITY_ALLOWLIST.has(relativePath)) continue;
    const contents = readFileSync(path, "utf8");
    expect(contents).not.toMatch(internalRoute);
    expect(contents).not.toMatch(retiredSentinel);
  }
});
