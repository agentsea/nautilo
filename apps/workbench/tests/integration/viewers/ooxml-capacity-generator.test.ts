import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workbench = resolve(import.meta.dir, "../../..");
const generator = join(workbench, "scripts/ooxml-fixtures/generate_capacity.py");
const targetBytes = 1024 * 1024;

function run(command: string[], cwd = workbench) {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

describe("OOXML capacity fixture generator integration", () => {
  test("streams exact 1 MiB valid DOCX/XLSX/PPTX packages from the tracked templates", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "d431-capacity-"));
    try {
      for (const format of ["docx", "xlsx", "pptx"] as const) {
        const output = run(["python3", generator, "--format", format, "--target-mib", "1", "--output-dir", outputDir]);
        expect(output).toContain(`generated ${format} capacity package`);
      }
      const verifier = [
        "import sys, zipfile",
        "from pathlib import Path",
        "root = Path(sys.argv[1])",
        `expected = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}`,
        "for extension, required in expected.items():",
        "    path = next(root.glob(f'*.{extension}'))",
        `    assert path.stat().st_size == ${targetBytes}`,
        "    with zipfile.ZipFile(path) as package:",
        "        assert package.testzip() is None",
        "        assert required in package.namelist()",
        "        payloads = [name for name in package.namelist() if name.startswith('capacity/payload-')]",
        "        assert payloads == ['capacity/payload-000.bin']",
        "        assert package.getinfo(payloads[0]).compress_type == zipfile.ZIP_STORED",
        "        assert package.getinfo(payloads[0]).file_size <= 64 * 1024 * 1024",
        "        assert b'PartName=\"/capacity/payload-000.bin\"' in package.read('[Content_Types].xml')",
      ].join("\n");
      run(["python3", "-c", verifier, outputDir]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("refuses unsafe destinations and keeps the default capacity directory gitignored", () => {
    const unsafe = Bun.spawnSync({ cmd: ["python3", generator, "--format", "docx", "--target-mib", "1", "--output-dir", workbench], cwd: workbench, stdout: "pipe", stderr: "pipe" });
    expect(unsafe.exitCode).toBe(2);
    expect(new TextDecoder().decode(unsafe.stderr)).toContain("output directory must be under");
    const ignored = Bun.spawnSync({ cmd: ["git", "check-ignore", "-q", "apps/workbench/tests/fixtures/ooxml/capacity/capacity-docx-1mib.docx"], cwd: resolve(workbench, "../..") });
    expect(ignored.exitCode).toBe(0);
  });

  test("cleans a failed candidate so the same target can be retried", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "d431-capacity-retry-"));
    const failureProbe = [
      "import sys",
      "from pathlib import Path",
      "source = Path(sys.argv[1]).read_text()",
      "scope = {'__file__': sys.argv[1], '__name__': 'capacity_generator'}",
      "exec(compile(source, sys.argv[1], 'exec'), scope)",
      "output_dir = Path(sys.argv[2])",
      "original = scope['write_package']",
      "def fail_after_write(template, destination, payload_sizes):",
      "    result = original(template, destination, payload_sizes)",
      "    if any(payload_sizes): raise RuntimeError('injected validation-path failure')",
      "    return result",
      "scope['write_package'] = fail_after_write",
      "try: scope['generate']('docx', 1024 * 1024, output_dir)",
      "except RuntimeError: pass",
      "else: raise AssertionError('expected injected failure')",
      "output = output_dir / 'capacity-docx-1mib.docx'",
      "assert not output.exists() and not output.with_suffix('.docx.partial').exists() and not output.with_suffix('.docx.candidate').exists()",
      "scope['write_package'] = original",
      "assert scope['generate']('docx', 1024 * 1024, output_dir) == output",
      "assert output.is_file()",
    ].join("\n");
    try {
      const result = Bun.spawnSync({ cmd: ["python3", "-c", failureProbe, generator, outputDir], cwd: workbench, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
