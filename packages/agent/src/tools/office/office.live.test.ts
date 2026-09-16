/**
 * Live test for the `office` agent tool — drives the real handler against a
 * temp `home` zone + the nwuno engine (NAUTILO_OFFICE_PORT, default :2003).
 * Self-skips when the engine is unreachable so CI stays green.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageZones } from "@nautilo/config";
import { LocalStorageProvider } from "@nautilo/config";
import { LofficeClient } from "@nautilo/loffice";
import { createOfficeTool } from "./office";
import { resetArtifactStorage, setArtifactStorage } from "../artifacts/storage-registry";

const URL = process.env["NAUTILO_OFFICE_URL"] ?? `http://localhost:${process.env["NAUTILO_OFFICE_PORT"] ?? "2003"}/`;
const up = await (async () => {
  try {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "text/xml" }, body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>', signal: AbortSignal.timeout(2000) });
    return (await r.text()).includes("find_replace");
  } catch {
    return false;
  }
})();
if (!up) console.warn(`[office.live] engine not at ${URL} — skipping`);

const dir = await mkdtemp(join(tmpdir(), "office-tool-"));
const home = new LocalStorageProvider("home", dir);
setArtifactStorage({ home, scratch: home } as unknown as StorageZones);
afterAll(() => resetArtifactStorage());

const client = new LofficeClient({ baseUrl: URL });
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("office tool (live)", () => {
  test.skipIf(!up)("info returns engine metadata", async () => {
    const res = String(await createOfficeTool().invoke({ command: "info" }));
    const env = JSON.parse(res) as { export_filters: number };
    expect(env.export_filters).toBeGreaterThan(50);
  });

  test.skipIf(!up)("find_replace on a home artifact round-trips", async () => {
    await home.write("in.docx", await client.convert(enc.encode("Hello FOO"), "docx"));
    const res = String(await createOfficeTool().invoke({
      command: "find_replace", zone: "home", path: "in.docx", out: "out.docx", find: "FOO", replace: "BAR",
    }));
    expect(res).toContain('"ok":true');
    const txt = dec.decode(await client.convert(await home.read("out.docx"), "txt")).trim();
    expect(txt).toBe("Hello BAR");
  });

  test.skipIf(!up)("template_fill on a home artifact", async () => {
    await home.write("t.docx", await client.convert(enc.encode("Dear ${who}"), "docx"));
    const res = String(await createOfficeTool().invoke({
      command: "template_fill", zone: "home", path: "t.docx", out: "t-out.docx", mapping: { who: "Ada" },
    }));
    expect(res).toContain('"ok":true');
    const txt = dec.decode(await client.convert(await home.read("t-out.docx"), "txt")).trim();
    expect(txt).toBe("Dear Ada");
  });
});
