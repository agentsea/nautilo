import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, parseArgs, runCli } from "./cli";

describe("parseArgs", () => {
  test("command + positionals + boolean flag", () => {
    const p = parseArgs(["convert", "a.docx", "b.pdf", "--json"]);
    expect(p.command).toBe("convert");
    expect(p.positionals).toEqual(["a.docx", "b.pdf"]);
    expect(p.flags["json"]).toBe(true);
  });

  test("value flags: --to=pdf and --url <val>", () => {
    const p = parseArgs(["convert", "a", "b", "--to=pdf", "--url", "http://x:2003/"]);
    expect(p.flags["to"]).toBe("pdf");
    expect(p.flags["url"]).toBe("http://x:2003/");
  });

  test("empty argv → empty command", () => {
    expect(parseArgs([]).command).toBe("");
  });
});

// capture stdout for a single call
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = orig;
  }
}

const URL = process.env["NAUTILO_LOFFICE_URL"] ?? "http://localhost:2003/";
const up = await (async () => {
  try {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "text/xml" }, body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>', signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
})();

describe("runCli (usage, no engine)", () => {
  test("no command → usage exit 2", async () => {
    const { code } = await capture(() => runCli([]));
    expect(code).toBe(EXIT.usage);
  });

  test("convert missing args → usage exit 2 with --json error envelope", async () => {
    const { code, out } = await capture(() => runCli(["convert", "--json"]));
    expect(code).toBe(EXIT.usage);
    expect((JSON.parse(out) as { ok: boolean }).ok).toBe(false);
  });
});

describe("runCli (live)", () => {
  test.skipIf(!up)("info --json → ok envelope with filter counts", async () => {
    const { code, out } = await capture(() => runCli(["info", "--json"]));
    expect(code).toBe(EXIT.ok);
    const env = JSON.parse(out) as { ok: boolean; export_filters: number };
    expect(env.ok).toBe(true);
    expect(env.export_filters).toBeGreaterThan(50);
  });

  test.skipIf(!up)("convert txt→pdf writes a valid PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loffice-cli-"));
    const inp = join(dir, "in.txt");
    const outp = join(dir, "out.pdf");
    await writeFile(inp, "D362 CLI live test\n");
    const { code } = await capture(() => runCli(["convert", inp, outp, "--json"]));
    expect(code).toBe(EXIT.ok);
    const pdf = await readFile(outp);
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
  });
});

const NWUNO = process.env["NWUNO_URL"] ?? "http://localhost:2005/";
const nwunoUp = await (async () => {
  try {
    const r = await fetch(NWUNO, { method: "POST", headers: { "content-type": "text/xml" }, body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>', signal: AbortSignal.timeout(2000) });
    return (await r.text()).includes("find_replace");
  } catch {
    return false;
  }
})();

describe("runCli mutation verbs (live nwuno)", () => {
  test.skipIf(!nwunoUp)("convert → find-replace → template-fill → back to txt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loffice-mut-"));
    const src = join(dir, "s.txt"), d1 = join(dir, "d.docx"), d2 = join(dir, "d2.docx"), d3 = join(dir, "d3.docx"), out = join(dir, "o.txt"), map = join(dir, "m.json");
    await writeFile(src, "Hello FOO and ${name}!");
    await writeFile(map, JSON.stringify({ name: "World" }));
    expect((await capture(() => runCli(["convert", src, d1, "--url", NWUNO]))).code).toBe(EXIT.ok);
    expect((await capture(() => runCli(["find-replace", d1, d2, "--url", NWUNO, "--find", "FOO", "--replace", "BAR"]))).code).toBe(EXIT.ok);
    expect((await capture(() => runCli(["template-fill", d2, d3, "--url", NWUNO, "--map", map]))).code).toBe(EXIT.ok);
    expect((await capture(() => runCli(["convert", d3, out, "--url", NWUNO]))).code).toBe(EXIT.ok);
    expect((await readFile(out, "utf8")).trim()).toBe("Hello BAR and World!");
  });
});
