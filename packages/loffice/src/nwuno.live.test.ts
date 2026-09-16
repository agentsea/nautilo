/**
 * Live test for the nwuno *extended* methods — needs the nwuno image running
 * (NWUNO_URL, default :2005). Self-skips if that server lacks `find_replace`
 * (i.e. stock unoserver or nothing is there), so CI stays green.
 */
import { describe, expect, test } from "bun:test";
import { LofficeClient } from "./client";

const URL = process.env["NWUNO_URL"] ?? "http://localhost:2005/";

const hasExtended = await (async (): Promise<boolean> => {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>',
      signal: AbortSignal.timeout(2000),
    });
    return (await res.text()).includes("find_replace");
  } catch {
    return false;
  }
})();
if (!hasExtended) console.warn(`[nwuno.live] extended engine not at ${URL} — skipping`);

const c = new LofficeClient({ baseUrl: URL });
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("nwuno extended (live)", () => {
  test.skipIf(!hasExtended)("find_replace + template_fill round-trip", async () => {
    const docx = await c.convert(enc.encode("Hello FOO and ${name}!"), "docx");
    const r1 = await c.findReplace(docx, "docx", "FOO", "BAR");
    const r2 = await c.templateFill(r1, "docx", { name: "World" });
    const txt = dec.decode(await c.convert(r2, "txt")).trim();
    expect(txt).toBe("Hello BAR and World!");
  });

  test.skipIf(!hasExtended)("set_meta / get_meta round-trip", async () => {
    const docx = await c.convert(enc.encode("body"), "docx");
    const withMeta = await c.setMeta(docx, "docx", { title: "T1", author: "nwuno" });
    const meta = await c.getMeta(withMeta, "docx");
    expect(meta["title"]).toBe("T1");
    expect(meta["author"]).toBe("nwuno");
  });

  test.skipIf(!hasExtended)("get_structured returns text blocks", async () => {
    const docx = await c.convert(enc.encode("Alpha line"), "docx");
    const s = await c.getStructured(docx, "docx");
    expect(s["doctype"]).toBe("text");
    expect(Array.isArray(s["blocks"])).toBe(true);
  });
});
