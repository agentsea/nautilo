import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveOfficeCliOrNull } from "@nautilo/config/officecli";
import { createAppToolHost, type AppDocumentOperations } from "../../src/apps/app-tool-host";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";

const binary = resolveOfficeCliOrNull({ repoRoot: resolve(import.meta.dirname, "../../../..") });
describe("workspace OfficeCLI argument transport", () => {
  test.skipIf(!binary)("large batches reach the converter and preserve failure without committing output", async () => {
    const host = createAppToolHost({
      appId: "office-test-app", appsRoot: "/tmp/unused-apps",
      manifest: { id: "office-test-app", name: "Office Test", version: "1.0.0", entry: "./main.ts", html: "./index.html",
        capabilities: { office: "convert", document: { artifact: "readwrite", currentFolder: "readwrite" } },
      } as MiniAppManifest,
      context: { ownerId: "synthetic-owner", userId: "synthetic-user", agentId: "synthetic-agent", memoryAccessEnvelope: {} } as AppToolRunnerContext,
      documentOps: {} as AppDocumentOperations,
    });
    // An invalid command after the large paragraph forces failure before the
    // persistence boundary: this packaged-binary test needs no database.
    const ops = [
      { command: "add", parent: "/body", type: "paragraph", props: { text: "Synthetic paragraph. ".repeat(8_000) } },
      { command: "not-a-command" },
    ];
    expect(Buffer.byteLength(JSON.stringify(ops))).toBeGreaterThan(131_072);
    const result = await host.office.run({ ops, output: { surface: "workspace", path: "must-not-be-written.docx" } });
    expect(result).toMatchObject({ ok: false, code: "OFFICECLI_BATCH_FAILED" });
  }, 30_000);
});
