/**
 * Live integration test — requires the engine on NAUTILO_LOFFICE_URL (default
 * :2003). Self-skips when unreachable so CI without a container stays green.
 */
import { describe, expect, test } from "bun:test";
import { LofficeClient } from "./client";

const URL = process.env["NAUTILO_LOFFICE_URL"] ?? "http://localhost:2003/";

// Probe at module load (top-level await) so `skipIf` sees the real value —
// `skipIf` is evaluated when the test is defined, before `beforeAll` runs.
const up = await (async (): Promise<boolean> => {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
})();
if (!up) console.warn(`[loffice.live] engine unreachable at ${URL} — skipping live tests`);

describe("LofficeClient (live)", () => {
  test.skipIf(!up)("info() returns filters keyed by internal filter name", async () => {
    const info = await new LofficeClient().info();
    expect(Object.keys(info.export_filters).length).toBeGreaterThan(50);
    // keys are LO internal filter names (verified live), not UI descriptions
    expect(info.export_filters).toHaveProperty("writer_pdf_Export");
    expect(info.export_filters).toHaveProperty("calc_pdf_Export");
    expect(typeof info.unoserver).toBe("string");
  });

  test.skipIf(!up)("convert txt→pdf returns a %PDF- document", async () => {
    const src = new TextEncoder().encode("D362 loffice live test.\n");
    const pdf = await new LofficeClient().convert(src, "pdf");
    expect(pdf.byteLength).toBeGreaterThan(400);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
});
