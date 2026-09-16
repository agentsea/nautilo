/**
 * Tests for the server binary's startup sentinel format.
 *
 * The server prints NAUTILO_SERVER_READY <url> to stdout when it is
 * ready to accept connections. Desktop and development orchestration parse
 * this line before attaching client surfaces.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_INDEX = resolve(THIS_DIR, "../../src/index.ts");

describe("server startup sentinel", () => {
  const source = readFileSync(SERVER_INDEX, "utf-8");

  test("prints NAUTILO_SERVER_READY sentinel to stdout", () => {
    expect(source).toContain("NAUTILO_SERVER_READY");
    expect(source).toContain("console.log(`NAUTILO_SERVER_READY ${serverUrl}`);");
  });

  test("port selection flows through resolveInstance (NAUTILO_PORT merged there)", () => {
    expect(source).toContain("resolveInstance()");
    expect(source).toContain("inst.server.port");
  });

  test("logs to nautilo-server.log", () => {
    expect(source).toContain("nautilo-server.log");
  });

  test("Claude Code Tasks require the exact opt-in outside test-mode-only boots", () => {
    expect(source).toContain(
      'enableClaudeCodeTasks: !TEST_MODE_ONLY && process.env["NAUTILO_CLAUDE_CODE_TASKS"] === "1",',
    );
    expect(source).not.toContain('process.env["NAUTILO_CLAUDE_CODE_TASKS"]?.trim()');
    expect(source).not.toContain('Boolean(process.env["NAUTILO_CLAUDE_CODE_TASKS"])');
  });

  // Regression guard: the HTTPS decision MUST flow through
  // `effectiveServerScheme` (or `resolveEffectiveServerUrl`) from
  // @nautilo/config so the printed sentinel URL and the actual listener
  // can never disagree on http vs https. The previous inline expression
  // `host !== "127.0.0.1" && host !== "localhost"` duplicated that
  // predicate and is forbidden here — if you need to change the LAN
  // detection, change it in packages/config/src/effective-server-url.ts
  // and let it propagate.
  test("HTTPS decision delegates to @nautilo/config (no inline LAN predicate)", () => {
    const importsHelper =
      source.includes("effectiveServerScheme") ||
      source.includes("resolveEffectiveServerUrl");
    expect(importsHelper).toBe(true);

    const inlinePredicate = /host\s*!==\s*["']127\.0\.0\.1["']\s*&&\s*host\s*!==\s*["']localhost["']/;
    expect(inlinePredicate.test(source)).toBe(false);
  });
});
