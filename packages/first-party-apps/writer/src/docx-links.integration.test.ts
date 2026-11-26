import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveOfficeCliOrNull } from "../../../config/src/officecli/provisioning";
import { runOfficeCliRaw } from "../../../config/src/officecli/run";
import { mapOfficeCliGetEnvelope, mapWriterDocumentToOfficeCliBatch } from "./docx-mapper";

const binaryPath = resolveOfficeCliOrNull({ repoRoot: resolve(import.meta.dirname, "../../../..") });
describe("Writer large DOCX hyperlink export", () => {
  test.skipIf(!binaryPath)("file-based batch preserves paragraph and table URLs beyond Linux's single-argument capacity", async () => {
    if (!binaryPath) throw new Error("OfficeCLI unavailable");
    const scratch = await mkdtemp(join(tmpdir(), "writer-link-export-"));
    const output = join(scratch, "links.docx");
    const commandsPath = join(scratch, "commands.json");
    const url = "https://example.com/research?q=one&source=two#section";
    const cellUrl = "https://example.org/table-source";
    const longText = "Synthetic document content. ".repeat(6_000);
    const paragraph = (id: string, text: string, href?: string) => ({ id, type: "paragraph", style: {}, inlines: [{ text, style: href ? { href } : {} }] });
    const mapped = mapWriterDocumentToOfficeCliBatch({ blocks: [
      { ...paragraph("title", "Document title", url), type: "title" },
      { ...paragraph("subtitle", "Document subtitle"), type: "subtitle" },
      paragraph("long", longText), paragraph("linked", "Research source", url),
      { id: "table", type: "table", inlines: [], style: {}, tableData: { columnWidths: [120, 120], rows: [{ cells: [
        { blocks: [paragraph("cell", "Table source", cellUrl), paragraph("cell2", "Following paragraph")], style: {} },
        { blocks: [paragraph("plain", "Unlinked cell")], style: {} },
      ] }] } },
    ] });
    const serialized = JSON.stringify(mapped.commands);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(131_072);
    try {
      await writeFile(commandsPath, serialized, { mode: 0o600 });
      for (const argv of [
        ["create", output, "--type", "docx", "--force", "--json"],
        ["batch", output, "--input", commandsPath, "--stop-on-error", "--json"],
      ]) {
        const result = await runOfficeCliRaw({ binaryPath, argv });
        if (result.exitCode !== 0) throw new Error(result.stdout + result.stderr);
        expect(result.exitCode).toBe(0);
      }
      const get = await runOfficeCliRaw({ binaryPath, argv: ["get", output, "/body", "--depth", "10", "--json"] });
      expect(get.exitCode).toBe(0);
      const imported = mapOfficeCliGetEnvelope(JSON.parse(get.stdout));
      const text = JSON.stringify(imported.document);
      expect(text).toContain(url);
      expect(text).toContain(cellUrl);
      expect(text).toContain(longText);
      expect(text).toContain("Following paragraph");
      expect(text).toContain("Unlinked cell");
      expect(text).toContain("Document title");
      expect(text).toContain("Document subtitle");
      expect(mapped.skipped).toEqual([]);
      expect((await readFile(output)).subarray(0, 2).toString()).toBe("PK");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
