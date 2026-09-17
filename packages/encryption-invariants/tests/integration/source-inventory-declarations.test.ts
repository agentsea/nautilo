import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE_DECLARATIONS,
  inspectDeclaredSourceInventory,
  scanSourceAlarms,
} from "../../src/node/source-inventory";

const repoRoot = join(import.meta.dir, "../../../..");
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nautilo source inventory with spaces "));
  temporaryRoots.push(root);
  return root;
}

describe("M220 source inventory declarations", () => {
  test("every reviewed declaration resolves to live production evidence", async () => {
    const result = await inspectDeclaredSourceInventory({ repoRoot });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(SOURCE_DECLARATIONS.length);
    expect(result.observations).toEqual(
      [...result.observations].sort((a, b) =>
        `${a.surface}:${a.locator}:${a.id}`.localeCompare(
          `${b.surface}:${b.locator}:${b.id}`,
        ),
      ),
    );

    const ids = new Set(result.observations.map((entry) => entry.id));
    expect(ids).toContain("source.file.runtime-paths");
    expect(ids).toContain("source.backup.compose-bundle");
    expect(ids).toContain("source.notification.desktop-room-label");
    expect(ids).toContain("source.processor.chat-model-factory");
    expect(ids).toContain("source.processor.cloudconvert");
  });

  test("reports missing evidence and missing symbols without absolute paths", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "writer.ts"),
      "export function liveWriter() {}\n",
    );

    const result = await inspectDeclaredSourceInventory({
      repoRoot: root,
      declarations: [
        {
          id: "source.file.fixture",
          surface: "file",
          locator: "packages/demo/writer.ts#liveWriter",
          role: "writer",
          evidence: [
            {
              path: "packages/demo/writer.ts",
              symbols: ["missingWriter"],
            },
            {
              path: "packages/demo/missing.ts",
              symbols: ["alsoMissing"],
            },
          ],
        },
      ],
    });

    expect(result.observations).toEqual([
      {
        id: "source.file.fixture",
        surface: "file",
        locator: "packages/demo/writer.ts#liveWriter",
      },
    ]);
    expect(result.errors).toEqual([
      "source.file.fixture: missing evidence file packages/demo/missing.ts",
      "source.file.fixture: packages/demo/writer.ts is missing symbol missingWriter",
    ]);
    expect(result.errors.join("\n")).not.toContain(root);
  });
});

describe("M220 source inventory alarm scanner", () => {
  test("uses root-relative paths even when the workspace path contains spaces", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "live source"), { recursive: true });
    await writeFile(
      join(root, "packages", "live source", "boundary.ts"),
      [
        "await writeFile(target, bytes);",
        "const response = await fetch(endpoint);",
        "const child = Bun.spawn([binary]);",
        "console.warn(payload);",
        "new Notification({ body });",
        "const scratch = await mkdtemp(join(tmpdir(), 'nautilo-fixture-'));",
      ].join("\n"),
    );

    const result = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.alarms.map((alarm) => alarm.kind)).toEqual([
      "filesystem_write",
      "network_processor",
      "subprocess_processor",
      "log_emitter",
      "notification_emitter",
      "temporary_storage",
    ]);
    for (const alarm of result.alarms) {
      expect(alarm.path).toBe("packages/live source/boundary.ts");
      expect(alarm.locator.startsWith("packages/live source/boundary.ts#")).toBe(
        true,
      );
      expect(alarm.locator).not.toContain(root);
    }
  });

  test("exact exclusions do not swallow similarly named production paths", async () => {
    const root = await fixtureRoot();
    const files = [
      "packages/tests/ignored.ts",
      "packages/tests-extra/live.ts",
      "packages/lattice-crypto/ignored.ts",
      "packages/lattice-crypto-extra/live.ts",
      "apps/desktop/scratch/ignored.ts",
      "apps/desktop/scratchpad/live.ts",
      "packages/first-party-apps/spreadsheet/engine/browser.js",
      "packages/first-party-apps/spreadsheet/engine/browser.cjs",
      "packages/first-party-apps/spreadsheet/engine/node.js",
      "packages/first-party-apps/spreadsheet/engine/node.cjs",
      "packages/first-party-apps/spreadsheet/engine-extra/live.ts",
      "packages/first-party-apps/presentation/engine/browser.js",
      "packages/first-party-apps/board/engine/main.js",
      "packages/office-sheets/src/live.ts",
      "packages/demo/ignored.test.ts",
      "packages/demo/live.ts",
    ];
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "await writeFile(target, bytes);\n");
    }

    const result = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["apps", "packages"],
    });

    expect(result.errors).toEqual([]);
    expect(result.alarms.map((alarm) => alarm.path)).toEqual([
      "apps/desktop/scratchpad/live.ts",
      "packages/demo/live.ts",
      "packages/first-party-apps/spreadsheet/engine-extra/live.ts",
      "packages/lattice-crypto-extra/live.ts",
      "packages/office-sheets/src/live.ts",
      "packages/tests-extra/live.ts",
    ]);
  });

  test("comments do not create alarms and output is byte-for-byte deterministic", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "commented.ts"),
      [
        "// fetch(secret);",
        "/*",
        "await writeFile(secretPath, secret);",
        "*/",
        "export const endpoint = 'https://example.test/path';",
        "await appendFile(target, payload); // actual writer",
      ].join("\n"),
    );

    const first = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });
    const second = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });

    expect(first).toEqual(second);
    expect(first.alarms).toHaveLength(1);
    expect(first.alarms[0]).toMatchObject({
      kind: "filesystem_write",
      path: "packages/demo/commented.ts",
      line: 6,
      evidence: "appendFile(",
    });
    expect(first.alarms[0]!.locator).toMatch(
      /^packages\/demo\/commented\.ts#filesystem_write:[a-f0-9]{16}:1$/,
    );
  });

  test("alarm identity is stable when unrelated lines move the call site", async () => {
    const root = await fixtureRoot();
    const file = join(root, "packages", "demo", "stable.ts");
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(file, "await writeFile(target, payload);\n");

    const before = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });
    await writeFile(file, "\n\nawait writeFile(target, payload);\n");
    const after = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });

    expect(before.alarms[0]!.line).toBe(1);
    expect(after.alarms[0]!.line).toBe(3);
    expect(after.alarms[0]!.locator).toBe(before.alarms[0]!.locator);
  });

  test("rejects wildcard, escaping, and undescribed exclusions", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "live.ts"),
      "await writeFile(target, payload);\n",
    );

    const result = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [
        {
          kind: "path_prefix",
          value: "../packages",
          reason: "Attempts to escape the repository root.",
        },
        {
          kind: "path_segment",
          value: "demo*",
          reason: "A wildcard is not an exact segment.",
        },
        {
          kind: "file_suffix",
          value: ".ts",
          reason: "short",
        },
      ],
    });

    expect(result.errors).toEqual([
      "invalid source exclusion file_suffix:.ts: reason must be descriptive",
      "invalid source exclusion path_prefix:../packages: value must be exact and repository-relative",
      "invalid source exclusion path_segment:demo*: value must be exact and repository-relative",
    ]);
    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({
      kind: "filesystem_write",
      path: "packages/demo/live.ts",
      line: 1,
      evidence: "writeFile(",
    });
  });

  test("logger alarms follow the real logger import instead of generic error helpers", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "logger.ts"),
      [
        'import { error as logError, warn } from "@nautilo/logger";',
        "logError(secret);",
        "warn(secret);",
      ].join("\n"),
    );
    await writeFile(
      join(root, "packages", "demo", "result.ts"),
      [
        "function error(message: string) { return { error: message }; }",
        "error('ordinary domain result');",
      ].join("\n"),
    );

    const result = await scanSourceAlarms({
      repoRoot: root,
      scanRoots: ["packages"],
      exclusions: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.alarms.map(({ kind, path, line, evidence }) => ({
      kind,
      path,
      line,
      evidence,
    }))).toEqual([
      {
        kind: "log_emitter",
        path: "packages/demo/logger.ts",
        line: 2,
        evidence: "logError(",
      },
      {
        kind: "log_emitter",
        path: "packages/demo/logger.ts",
        line: 3,
        evidence: "warn(",
      },
    ]);
    expect(new Set(result.alarms.map((alarm) => alarm.locator)).size).toBe(2);
  });

  test("unrelated named imports cannot hide logger calls or change their reviewed locators", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    const path = join(root, "packages", "demo", "invocation.ts");
    const original = [
      'import { log, warn as logWarn } from "@nautilo/logger";',
      'log("attempt");',
      'logWarn("failed");',
      'error("ordinary result");',
    ].join("\n");
    await writeFile(path, original);
    const before = await scanSourceAlarms({ repoRoot: root, scanRoots: ["packages"], exclusions: [] });
    // Matches the provider refactor: the first runtime import is no longer
    // @nautilo/logger. Its braces must not consume the logger import below.
    await writeFile(path, [
      'import { BaseCallbackHandler } from "@langchain/core/callbacks/base";',
      'import { CallbackManager, error } from "ordinary-helper";',
      original,
    ].join("\n"));
    const after = await scanSourceAlarms({ repoRoot: root, scanRoots: ["packages"], exclusions: [] });
    expect(before.errors).toEqual([]); expect(after.errors).toEqual([]);
    expect(after.alarms.map((alarm) => alarm.evidence)).toEqual(["log(", "logWarn("]);
    expect(after.alarms.map((alarm) => alarm.locator)).toEqual(before.alarms.map((alarm) => alarm.locator));
  });

});
