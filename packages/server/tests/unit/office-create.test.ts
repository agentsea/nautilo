import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildAddArgv,
  buildAddPartArgv,
  buildBatchArgv,
  buildCloseArgv,
  buildCreateArgv,
  buildDumpArgv,
  buildGetArgv,
  buildHelpArgv,
  buildMergeArgv,
  buildMoveArgv,
  buildOpenArgv,
  buildQueryArgv,
  buildRawArgv,
  buildRawSetArgv,
  buildRefreshArgv,
  buildRemoveArgv,
  buildSaveArgv,
  buildSetArgv,
  buildSwapArgv,
  buildValidateArgv,
  buildViewArgv,
  generateOffice,
  inferOfficeDocType,
  makeOfficeCreateRun,
  OfficeCreateError,
  parseScreenshotPagesForTest,
  renderOffice,
  type OfficeBatchCommand,
  type OfficeCreateRunFn,
} from "@nautilo/config/officecli";

// ============================================================================
// Argv builders — pure
// ============================================================================

describe("argv builders", () => {
  test("buildCreateArgv emits type/locale/force/json in matrix order", () => {
    expect(
      buildCreateArgv({ file: "out.docx", type: "docx", locale: "en-US", force: true, json: true }),
    ).toEqual(["create", "out.docx", "--type", "docx", "--locale", "en-US", "--force", "--json"]);
  });

  test("buildCreateArgv omits absent flags and includes minimal when set", () => {
    expect(buildCreateArgv({ file: "out.docx", type: "docx", minimal: true, json: true })).toEqual([
      "create",
      "out.docx",
      "--type",
      "docx",
      "--minimal",
      "--json",
    ]);
  });

  test("buildCreateArgv rejects empty file", () => {
    expect(() => buildCreateArgv({ file: "" })).toThrow(/file is required/);
  });

  test("buildBatchArgv serializes commands as JSON and respects stop-on-error", () => {
    const commands: OfficeBatchCommand[] = [
      { command: "add", parent: "/body", type: "paragraph", props: { text: "Hi" } },
    ];
    const argv = buildBatchArgv({ file: "out.docx", commands, stopOnError: true, json: true });
    expect(argv[0]).toBe("batch");
    expect(argv[1]).toBe("out.docx");
    expect(argv[2]).toBe("--commands");
    expect(JSON.parse(argv[3]!)).toEqual(commands);
    expect(argv.slice(4)).toEqual(["--stop-on-error", "--json"]);
  });

  test("buildBatchArgv accepts --input as alternative to --commands", () => {
    expect(buildBatchArgv({ file: "out.docx", input: "cmds.json", json: true })).toEqual([
      "batch",
      "out.docx",
      "--input",
      "cmds.json",
      "--json",
    ]);
  });

  test("buildBatchArgv requires commands xor input", () => {
    expect(() => buildBatchArgv({ file: "out.docx" })).toThrow(/commands or input/);
    expect(() =>
      buildBatchArgv({ file: "out.docx", commands: [], input: "cmds.json" }),
    ).toThrow(/mutually exclusive/);
  });

  test("buildViewArgv screenshot mode wires out/page/width/height/grid", () => {
    expect(
      buildViewArgv({
        file: "out.docx",
        mode: "screenshot",
        page: "1",
        out: "/tmp/p1.png",
        screenshotWidth: 800,
        screenshotHeight: 600,
        grid: "auto",
        json: true,
      }),
    ).toEqual([
      "view",
      "out.docx",
      "screenshot",
      "--page",
      "1",
      "--out",
      "/tmp/p1.png",
      "--screenshot-width",
      "800",
      "--screenshot-height",
      "600",
      "--grid",
      "auto",
      "--json",
    ]);
  });

  test("buildViewArgv grid=true expands to 'auto'", () => {
    expect(buildViewArgv({ file: "out.docx", mode: "screenshot", grid: true })).toContain("--grid");
    expect(buildViewArgv({ file: "out.docx", mode: "screenshot", grid: true })).toContain("auto");
  });

  test("buildViewArgv issues mode threads --type filter", () => {
    expect(
      buildViewArgv({ file: "out.docx", mode: "issues", type: "format", json: true }),
    ).toEqual(["view", "out.docx", "issues", "--type", "format", "--json"]);
  });

  test("buildViewArgv html mode emits only required args", () => {
    expect(buildViewArgv({ file: "out.docx", mode: "html" })).toEqual([
      "view",
      "out.docx",
      "html",
    ]);
  });

  test("buildGetArgv threads path/depth/save/json", () => {
    expect(
      buildGetArgv({ file: "out.docx", path: "/body/p[1]", depth: 3, save: "/tmp/x.bin", json: true }),
    ).toEqual(["get", "out.docx", "/body/p[1]", "--depth", "3", "--save", "/tmp/x.bin", "--json"]);
  });

  test("buildGetArgv rejects negative depth", () => {
    expect(() => buildGetArgv({ file: "out.docx", depth: -1 })).toThrow(/non-negative integer/);
  });

  test("buildQueryArgv threads selector/find/json", () => {
    expect(
      buildQueryArgv({ file: "out.docx", selector: "paragraph[style=Normal]", find: "foo", json: true }),
    ).toEqual(["query", "out.docx", "paragraph[style=Normal]", "--find", "foo", "--json"]);
  });

  test("buildSetArgv emits --prop key=value pairs in input order", () => {
    const argv = buildSetArgv({
      file: "out.docx",
      path: "/body/p[1]",
      props: { bold: "true", text: "Hi" },
      force: true,
      json: true,
    });
    expect(argv.slice(0, 3)).toEqual(["set", "out.docx", "/body/p[1]"]);
    expect(argv).toContain("--prop");
    expect(argv).toContain("bold=true");
    expect(argv).toContain("text=Hi");
    expect(argv).toContain("--force");
    expect(argv).toContain("--json");
  });

  test("buildSetArgv threads --find/--replace", () => {
    expect(
      buildSetArgv({ file: "out.docx", path: "/body", find: "foo", replace: "bar", json: true }),
    ).toEqual(["set", "out.docx", "/body", "--find", "foo", "--replace", "bar", "--json"]);
  });

  test("buildAddArgv emits type/from/index/props", () => {
    expect(
      buildAddArgv({
        file: "out.docx",
        parent: "/body",
        type: "paragraph",
        from: "/body/p[2]",
        index: 0,
        props: { text: "Hi" },
        json: true,
      }),
    ).toEqual([
      "add",
      "out.docx",
      "/body",
      "--type",
      "paragraph",
      "--from",
      "/body/p[2]",
      "--index",
      "0",
      "--prop",
      "text=Hi",
      "--json",
    ]);
  });

  test("buildRemoveArgv threads --shift and props", () => {
    expect(
      buildRemoveArgv({ file: "out.xlsx", path: "/Sheet1/A1", shift: "left", json: true }),
    ).toEqual(["remove", "out.xlsx", "/Sheet1/A1", "--shift", "left", "--json"]);
  });

  test("buildMoveArgv threads --to/--index", () => {
    expect(
      buildMoveArgv({ file: "out.docx", path: "/body/p[3]", to: "/body", index: 1, json: true }),
    ).toEqual(["move", "out.docx", "/body/p[3]", "--to", "/body", "--index", "1", "--json"]);
  });

  test("buildSwapArgv emits file + two paths", () => {
    expect(
      buildSwapArgv({ file: "out.docx", path1: "/body/p[1]", path2: "/body/p[2]", json: true }),
    ).toEqual(["swap", "out.docx", "/body/p[1]", "/body/p[2]", "--json"]);
  });

  test("buildValidateArgv emits just file + json", () => {
    expect(buildValidateArgv({ file: "out.docx", json: true })).toEqual([
      "validate",
      "out.docx",
      "--json",
    ]);
  });

  test("buildDumpArgv threads path/format/out", () => {
    expect(
      buildDumpArgv({ file: "out.docx", path: "/body", format: "batch", out: "/tmp/d.json", json: true }),
    ).toEqual([
      "dump",
      "out.docx",
      "/body",
      "--format",
      "batch",
      "--out",
      "/tmp/d.json",
      "--json",
    ]);
  });

  test("buildMergeArgv emits template/output + --data", () => {
    expect(
      buildMergeArgv({
        template: "tmpl.docx",
        output: "out.docx",
        data: '{"k":"v"}',
        force: true,
        json: true,
      }),
    ).toEqual([
      "merge",
      "tmpl.docx",
      "out.docx",
      "--data",
      '{"k":"v"}',
      "--force",
      "--json",
    ]);
  });

  test("buildRawArgv threads part/start/end/cols", () => {
    expect(
      buildRawArgv({ file: "out.xlsx", part: "/Sheet1", start: 1, end: 10, cols: "A,B", json: true }),
    ).toEqual([
      "raw",
      "out.xlsx",
      "/Sheet1",
      "--start",
      "1",
      "--end",
      "10",
      "--cols",
      "A,B",
      "--json",
    ]);
  });

  test("buildRawSetArgv emits xpath/action/xml (all required)", () => {
    expect(
      buildRawSetArgv({
        file: "out.docx",
        part: "/document",
        xpath: "//w:p",
        action: "append",
        xml: "<w:p/>",
        json: true,
      }),
    ).toEqual([
      "raw-set",
      "out.docx",
      "/document",
      "--xpath",
      "//w:p",
      "--action",
      "append",
      "--xml",
      "<w:p/>",
      "--json",
    ]);
  });

  test("buildRawSetArgv rejects missing required fields", () => {
    expect(() =>
      buildRawSetArgv({ file: "out.docx", part: "", xpath: "x", action: "append" }),
    ).toThrow(/part is required/);
    expect(() =>
      buildRawSetArgv({ file: "out.docx", part: "/document", xpath: "", action: "append" }),
    ).toThrow(/xpath is required/);
  });

  test("buildAddPartArgv emits parent + --type", () => {
    expect(
      buildAddPartArgv({ file: "out.docx", parent: "/", type: "chart", json: true }),
    ).toEqual(["add-part", "out.docx", "/", "--type", "chart", "--json"]);
  });

  test("buildCloseArgv emits file + json", () => {
    expect(buildCloseArgv({ file: "out.docx", json: true })).toEqual([
      "close",
      "out.docx",
      "--json",
    ]);
  });

  test("buildOpenArgv emits file + optional --json", () => {
    expect(buildOpenArgv({ file: "out.docx" })).toEqual(["open", "out.docx"]);
    expect(buildOpenArgv({ file: "out.docx", json: true })).toEqual([
      "open",
      "out.docx",
      "--json",
    ]);
  });

  test("buildOpenArgv rejects empty file", () => {
    expect(() => buildOpenArgv({ file: "" })).toThrow(/file is required/);
  });

  test("buildSaveArgv emits file + optional --json", () => {
    expect(buildSaveArgv({ file: "out.docx" })).toEqual(["save", "out.docx"]);
    expect(buildSaveArgv({ file: "out.docx", json: true })).toEqual([
      "save",
      "out.docx",
      "--json",
    ]);
  });

  test("buildSaveArgv rejects empty file", () => {
    expect(() => buildSaveArgv({ file: "" })).toThrow(/file is required/);
  });

  test("buildRefreshArgv emits file + optional --json", () => {
    expect(buildRefreshArgv({ file: "out.docx" })).toEqual(["refresh", "out.docx"]);
    expect(buildRefreshArgv({ file: "out.docx", json: true })).toEqual([
      "refresh",
      "out.docx",
      "--json",
    ]);
  });

  test("buildRefreshArgv rejects empty file", () => {
    expect(() => buildRefreshArgv({ file: "" })).toThrow(/file is required/);
  });

  test("buildHelpArgv emits format only by default", () => {
    expect(buildHelpArgv({ format: "docx" })).toEqual(["help", "docx"]);
  });

  test("buildHelpArgv threads verb before element (matrix order)", () => {
    expect(buildHelpArgv({ format: "docx", verb: "add", element: "paragraph" })).toEqual([
      "help",
      "docx",
      "add",
      "paragraph",
    ]);
  });

  test("buildHelpArgv emits format + element only", () => {
    expect(buildHelpArgv({ format: "xlsx", element: "cell" })).toEqual([
      "help",
      "xlsx",
      "cell",
    ]);
  });

  test("buildHelpArgv emits format + verb only", () => {
    expect(buildHelpArgv({ format: "pptx", verb: "set" })).toEqual(["help", "pptx", "set"]);
  });

  test("buildHelpArgv appends --json when json=true", () => {
    expect(buildHelpArgv({ format: "docx", element: "paragraph", json: true })).toEqual([
      "help",
      "docx",
      "paragraph",
      "--json",
    ]);
  });

  test("buildHelpArgv ignores empty verb/element strings", () => {
    expect(buildHelpArgv({ format: "docx", verb: "", element: "" })).toEqual(["help", "docx"]);
  });
});

// ============================================================================
// inferOfficeDocType
// ============================================================================

describe("inferOfficeDocType", () => {
  test("maps lowercase extensions", () => {
    expect(inferOfficeDocType("report.docx")).toBe("docx");
    expect(inferOfficeDocType("ledger.xlsx")).toBe("xlsx");
    expect(inferOfficeDocType("deck.pptx")).toBe("pptx");
  });

  test("maps uppercase extensions case-insensitively", () => {
    expect(inferOfficeDocType("REPORT.DOCX")).toBe("docx");
  });

  test("returns null for unknown extensions", () => {
    expect(inferOfficeDocType("notes.txt")).toBeNull();
    expect(inferOfficeDocType("noext")).toBeNull();
  });
});

// ============================================================================
// makeOfficeCreateRun
// ============================================================================

describe("makeOfficeCreateRun", () => {
  test("returns a function that delegates to runOfficeCliRaw with binary + timeout", async () => {
    // We can't easily intercept runOfficeCliRaw here without an execFile
    // injection; instead, verify the factory returns a callable that throws
    // a spawn-style error (ENOENT) for a non-existent binary rather than
    // throwing synchronously. The unit tier covers the argv builders and
    // the higher-level flow with an injected runner below.
    const run = makeOfficeCreateRun({ binaryPath: "/nonexistent/officecli", timeoutMs: 50 });
    expect(typeof run).toBe("function");
    let threw = false;
    try {
      await run(["--version"]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ============================================================================
// generateOffice — injected runner
// ============================================================================

describe("generateOffice", () => {
  test("runs create → batch → close and returns bytes for a .docx", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "office-create-test-"));
    const seen: string[][] = [];
    const run: OfficeCreateRunFn = async (argv) => {
      seen.push([...argv]);
      if (argv[0] === "close") {
        writeFileSync(String(argv[1]), new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      }
      return {
        stdout:
          argv[0] === "batch"
            ? JSON.stringify({ success: true, data: { summary: { failed: 0 } } })
            : JSON.stringify({ success: true }),
        stderr: "",
        exitCode: 0,
      };
    };

    const result = await generateOffice({
      fileName: "report.docx",
      commands: [{ command: "add", parent: "/body", type: "paragraph", props: { text: "Hi" } }],
      tempDirRoot: scratch,
      run,
    });

    expect(result.bytes.byteLength).toBe(4);
    expect(result.type).toBe("docx");
    expect(seen.map((argv) => argv[0])).toEqual(["create", "batch", "close"]);
    // create argv includes --type docx and --force
    expect(seen[0]).toContain("--type");
    expect(seen[0]!.indexOf("docx")).toBeGreaterThan(0);
    expect(seen[0]).toContain("--force");
  });

  test("skips batch when commands array is empty", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "office-create-test-"));
    const seen: string[][] = [];
    const run: OfficeCreateRunFn = async (argv) => {
      seen.push([...argv]);
      if (argv[0] === "close") {
        writeFileSync(String(argv[1]), new Uint8Array([0x50, 0x4b]));
      }
      return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
    };

    await generateOffice({ fileName: "blank.xlsx", tempDirRoot: scratch, run });
    expect(seen.map((argv) => argv[0])).toEqual(["create", "close"]);
  });

  test("create non-zero exit maps to OfficeCreateError(OFFICECLI_CREATE_FAILED)", async () => {
    const run: OfficeCreateRunFn = async () => ({
      stdout: JSON.stringify({ success: false, error: { code: "io", message: "disk full" } }),
      stderr: "boom",
      exitCode: 2,
    });
    try {
      await generateOffice({ fileName: "bad.docx", run });
      throw new Error("expected generateOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("OFFICECLI_CREATE_FAILED");
      expect((err as OfficeCreateError).exitCode).toBe(2);
      expect((err as OfficeCreateError).cliErrorKind).toBe("io");
    }
  });

  test("batch summary failed>0 maps to OfficeCreateError(OFFICECLI_BATCH_FAILED) with cliErrorKind", async () => {
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "create") {
        return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
      }
      if (argv[0] === "batch") {
        return {
          stdout: JSON.stringify({
            success: true,
            data: { summary: { failed: 1, succeeded: 0, total: 1 } },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
    };
    try {
      await generateOffice({
        fileName: "bad.docx",
        commands: [{ command: "add", parent: "/body", type: "paragraph", props: {} }],
        run,
      });
      throw new Error("expected generateOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("OFFICECLI_BATCH_FAILED");
    }
  });

  test("close non-zero exit maps to OfficeCreateError(OFFICECLI_CLOSE_FAILED)", async () => {
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "close") {
        return { stdout: "", stderr: "no resident", exitCode: 1 };
      }
      return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
    };
    try {
      await generateOffice({ fileName: "bad.docx", run });
      throw new Error("expected generateOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("OFFICECLI_CLOSE_FAILED");
    }
  });

  test("unsupported extension maps to OfficeCreateError(UNSUPPORTED_TYPE)", async () => {
    const run: OfficeCreateRunFn = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    try {
      await generateOffice({ fileName: "notes.txt", run });
      throw new Error("expected generateOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("UNSUPPORTED_TYPE");
    }
  });

  test("empty filename maps to OfficeCreateError(INVALID_FILENAME)", async () => {
    const run: OfficeCreateRunFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    try {
      await generateOffice({ fileName: "  ", run });
      throw new Error("expected generateOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("INVALID_FILENAME");
    }
  });
});

// ============================================================================
// renderOffice — injected runner
// ============================================================================

describe("renderOffice", () => {
  test("no-op when no modes are enabled", async () => {
    const run: OfficeCreateRunFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const result = await renderOffice({ file: "x.docx", run });
    expect(result.screenshots).toEqual([]);
    expect(result.html).toBeNull();
    expect(result.issues).toBeNull();
  });

  test("returns html string from view html", async () => {
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "view" && argv[2] === "html") {
        return { stdout: "<html><body>Hi</body></html>", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await renderOffice({ file: "x.docx", run, html: true });
    expect(result.html).toBe("<html><body>Hi</body></html>");
  });

  test("returns parsed issues envelope from view issues --json", async () => {
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "view" && argv[2] === "issues") {
        return {
          stdout: JSON.stringify({
            success: true,
            data: { counts: { total: 2 }, issues: [{ id: "a" }, { id: "b" }] },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await renderOffice({ file: "x.docx", run, issues: true });
    expect(result.issues?.success).toBe(true);
    expect(result.issues?.data?.counts?.["total"]).toBe(2);
    expect(result.issues?.data?.issues?.length).toBe(2);
  });

  test("returns screenshot bytes per page", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "office-render-test-"));
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "view" && argv[2] === "screenshot") {
        const outIdx = argv.indexOf("--out");
        const outPath = argv[outIdx + 1]!;
        writeFileSync(outPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await renderOffice({
      file: "x.docx",
      run,
      screenshot: true,
      screenshotPages: "1,3",
      tempDirRoot: scratch,
    });
    expect(result.screenshots.length).toBe(2);
    expect(result.screenshots[0]!.page).toBe("1");
    expect(result.screenshots[0]!.bytes.byteLength).toBe(4);
    expect(result.screenshots[1]!.page).toBe("3");
  });

  test("screenshot non-zero exit maps to OfficeCreateError(OFFICECLI_RENDER_FAILED)", async () => {
    const run: OfficeCreateRunFn = async (argv) => {
      if (argv[0] === "view" && argv[2] === "screenshot") {
        return {
          stdout: JSON.stringify({ success: false, error: { code: "not_found", message: "no such page" } }),
          stderr: "render err",
          exitCode: 3,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    try {
      await renderOffice({ file: "x.docx", run, screenshot: true });
      throw new Error("expected renderOffice to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeCreateError);
      expect((err as OfficeCreateError).code).toBe("OFFICECLI_RENDER_FAILED");
      expect((err as OfficeCreateError).exitCode).toBe(3);
      expect((err as OfficeCreateError).cliErrorKind).toBe("not_found");
    }
  });

  test("parses --page ranges into individual pages", () => {
    expect(parseScreenshotPagesForTest("1")).toEqual(["1"]);
    expect(parseScreenshotPagesForTest("1-3")).toEqual(["1", "2", "3"]);
    expect(parseScreenshotPagesForTest("1,3,5")).toEqual(["1", "3", "5"]);
    expect(parseScreenshotPagesForTest("1-2,4")).toEqual(["1", "2", "4"]);
    expect(parseScreenshotPagesForTest("")).toEqual(["1"]);
  });
});
