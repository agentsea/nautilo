import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBoardArtifacts, fingerprintBoardSource } from "./board-artifacts";

describe("Board application artifacts", () => {
  test("builds a hermetic browser and agent-tool bundle with deterministic provenance", async () => {
    const root = join(import.meta.dir, "../..");
    const destination = await mkdtemp(join(tmpdir(), "nautilo-board-artifacts-"));
    await rm(destination, { recursive: true });
    try {
      await buildBoardArtifacts(root, destination, { build: false });
      const names = (await readdir(destination)).sort();
      for (const required of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "agent-tools.js", "main.js", "provenance.json"]) expect(names).toContain(required);
      const browser = await readFile(join(destination, "main.js"), "utf8");
      const tools = await readFile(join(destination, "agent-tools.js"), "utf8");
      for (const bundled of [browser, tools]) {
        expect(bundled).not.toContain(root);
        expect(bundled).not.toMatch(/(?:from\s+|import\()["'](?:@nautilo|\.{1,2}\/)/);
      }
      const sandbox = await mkdtemp(join(tmpdir(), "nautilo-board-handler-"));
      const imported = Bun.spawnSync(["node", "--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(join(destination, "agent-tools.js")).href)})`], { cwd: sandbox, stderr: "pipe" });
      expect(imported.exitCode, imported.stderr.toString()).toBe(0);
      await rm(sandbox, { recursive: true, force: true });
      const provenance = JSON.parse(await readFile(join(destination, "provenance.json"), "utf8")) as { sourceSha256: string; recipeSha256: string; inputs: string[]; files: Record<string, string> };
      expect(provenance.sourceSha256).toBe((await fingerprintBoardSource(root)).hash);
      expect(provenance.recipeSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(provenance.inputs).toContain("packages/first-party-apps/board/main.ts");
      expect(provenance.inputs).toContain("turbo.json");
      expect(provenance.inputs).toContain("tsconfig.base.json");
      expect(provenance.inputs).toContain("packaging/wafflebase/slides-artifacts.mjs");
      expect(provenance.inputs).toContain("packaging/wafflebase/upstream.json");
      for (const required of ["main.js", "agent-tools.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) expect(provenance.files[required]).toMatch(/^[a-f0-9]{64}$/);
      const notices = await readFile(join(destination, "THIRD_PARTY_NOTICES.md"), "utf8");
      for (const dependency of ["@nautilo/office-board", "@nautilo/office-slides", "@nautilo/office-docs", "@nautilo/office-core", "parse5"]) expect(notices).toContain(dependency);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  }, 30_000);
});
