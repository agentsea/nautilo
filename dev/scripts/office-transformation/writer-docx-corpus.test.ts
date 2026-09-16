import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CORPUS_FIXTURE,
  CorpusCaptureCancelledError,
  CorpusCaptureDeadlineError,
  assertAnonymousJsonLine,
  captureChild,
  classifyDocxBytes,
  jsonLineBytes,
  makeHighExpansionDocx,
  makeMalformedDocumentXmlDocx,
  makeTruncatedZip,
  sha256,
  unsupportedDescriptors,
  type UnsupportedCase,
} from "./writer-docx-corpus";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("Writer DOCX corpus harness", () => {
  test("generates deterministic high-expansion DOCX bytes from the committed fixture", async () => {
    const template = new Uint8Array(await readFile(resolve(repoRoot, CORPUS_FIXTURE)));
    const first = makeHighExpansionDocx(template);
    const second = makeHighExpansionDocx(template);
    expect(sha256(first)).toBe(sha256(second));
    expect(first.byteLength).toBe(second.byteLength);
    // Local ZIP header time/date are explicit 00:00:00 on 2000-01-01, not
    // sampled from the wall clock. This avoids a slow time-based test.
    expect(Array.from(first.slice(10, 14))).toEqual([0, 0, 33, 40]);
    expect(classifyDocxBytes(first)).toBe("valid-zip");
  });

  test("categorizes malformed ZIP and XML corpus cases", async () => {
    const template = new Uint8Array(await readFile(resolve(repoRoot, CORPUS_FIXTURE)));
    expect(classifyDocxBytes(makeTruncatedZip(template))).toBe("malformed-truncated-zip");
    expect(classifyDocxBytes(makeMalformedDocumentXmlDocx(template))).toBe("malformed-document-xml");
  });

  test("accounts for escaped UTF-8 JSON plus the JSON-line newline exactly", () => {
    const value = { emoji: "🦑", quote: "\\\"", newline: "\n" };
    expect(jsonLineBytes(value)).toBe(Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8"));
  });

  test("rejects path and document-name leakage in JSONL", () => {
    expect(() => assertAnonymousJsonLine('{"category":"external-real","source":{"bytes":1}}')).not.toThrow();
    expect(() => assertAnonymousJsonLine('{"path":"/Users/tester/private.docx"}')).toThrow();
    expect(() => assertAnonymousJsonLine('{"name":"d391-roundtrip.docx"}')).toThrow();
  });

  test("declares broad synthetic categories unsupported instead of inventing metrics", () => {
    const unsupported = unsupportedDescriptors();
    for (const row of unsupported) {
      expect(row.format).toBe("docx");
      expect(["import", "export"]).toContain(row.operation);
      expect(["workspace", "current-folder"]).toContain(row.surface);
    }
    const includesCase = (expected: Partial<UnsupportedCase>): boolean =>
      unsupported.some((row) => Object.entries(expected).every(
        ([key, value]) => row[key as keyof UnsupportedCase] === value,
      ));
    expect(includesCase({ category: "generated-near-canonical", status: "unsupported" })).toBe(true);
    expect(includesCase({ category: "generated-image-heavy", status: "unsupported" })).toBe(true);
    expect(includesCase({ category: "export-workspace", operation: "export", surface: "workspace" })).toBe(true);
    expect(includesCase({ category: "import-current-folder", operation: "import", surface: "current-folder" })).toBe(true);
    expect(includesCase({ category: "export-current-folder", operation: "export", surface: "current-folder" })).toBe(true);
  });

  async function expectRejectionInstance(
    promise: Promise<unknown>,
    expected: abstract new (...args: never[]) => Error,
  ): Promise<void> {
    let rejection: unknown;
    try {
      await promise;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(expected);
  }

  test("cancellation kills the child and removes its scratch streams", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      const result = captureChild(process.execPath, ["-e", "setInterval(() => process.stdout.write('x'), 1)"], {
        signal: controller.signal,
      });
      // Rejection happens only after child close, stream drain, and scratch rm.
      await expectRejectionInstance(result, CorpusCaptureCancelledError);
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);

  test("a pre-aborted signal never attempts process spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectRejectionInstance(
      captureChild("this-command-must-not-be-spawned", [], { signal: controller.signal }),
      CorpusCaptureCancelledError,
    );
  });

  test("a failed spawn clears a future deadline instead of retaining the harness", async () => {
    const outcome = await Promise.race([
      captureChild("this-command-must-not-exist", [], { deadlineAt: Date.now() + 60_000 })
        .then(() => "resolved", () => "rejected"),
      Bun.sleep(1_000).then(() => "timed-out"),
    ]);
    expect(outcome).toBe("rejected");
  });

  test("an absolute deadline kills and awaits a running child", async () => {
    await expectRejectionInstance(
      captureChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        deadlineAt: Date.now() + 30,
      }),
      CorpusCaptureDeadlineError,
    );
  }, 10_000);
});
