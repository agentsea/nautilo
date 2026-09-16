#!/usr/bin/env bun
/**
 * D362 Phase-0 spike — minimal WOPI host stub (throwaway).
 *
 * Serves ONE local file over the three WOPI endpoints Collabora needs to
 * load + save a document. This is the "confirm the WOPI-host shape" probe
 * (task 0.4.3): run it, open the doc via Collabora, and watch which
 * CheckFileInfo fields coolwsd actually demands (they get logged).
 *
 * NOT the real thing — the production WOPI module is a quarantined route in
 * the Nautilo server backed by workspace-artifacts + userSaveWorkspaceArtifact
 * (issue D-7). This stub exists only to de-risk the protocol shape.
 *
 * Run:   D362_DOC=./sample/sample.docx bun apps/desktop/scratch/d362-spike/wopi-stub.ts
 */
import { stat, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const PORT = Number(process.env["D362_WOPI_PORT"] ?? "8628");
const DOC_PATH = resolve(process.env["D362_DOC"] ?? "./sample/sample.docx");
const DOC_ID = "spike-doc";

function log(...args: unknown[]) {
  console.log("[d362-wopi]", ...args);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    log(req.method, pathname, `token=${url.searchParams.get("access_token") ?? "(none)"}`);

    // CheckFileInfo — GET /wopi/files/<id>
    if (req.method === "GET" && pathname === `/wopi/files/${DOC_ID}`) {
      let size = 0;
      let mtime = Date.now();
      try {
        const s = await stat(DOC_PATH);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        return new Response(`sample doc not found at ${DOC_PATH}`, { status: 404 });
      }
      // Minimal field set; expand as coolwsd complains — that's the point of the probe.
      const info = {
        BaseFileName: basename(DOC_PATH),
        Size: size,
        OwnerId: "spike-owner",
        UserId: "spike-user",
        UserCanWrite: true,
        UserFriendlyName: "D362 Spike User",
        Version: String(Math.floor(mtime)),
        SupportsUpdate: true,
        SupportsLocks: true,
      };
      return Response.json(info);
    }

    // GetFile — GET /wopi/files/<id>/contents
    if (req.method === "GET" && pathname === `/wopi/files/${DOC_ID}/contents`) {
      try {
        const bytes = await readFile(DOC_PATH);
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      } catch {
        return new Response("read failed", { status: 404 });
      }
    }

    // PutFile — POST /wopi/files/<id>/contents  (autosave + save)
    if (req.method === "POST" && pathname === `/wopi/files/${DOC_ID}/contents`) {
      const isAutosave = req.headers.get("x-wopi-isautosave");
      const isModifiedByUser = req.headers.get("x-wopi-ismodifiedbyuser");
      log(`PutFile  autosave=${isAutosave} modifiedByUser=${isModifiedByUser}  (note: prod must debounce autosaves — D-7)`);
      const buf = Buffer.from(await req.arrayBuffer());
      await writeFile(DOC_PATH, buf);
      log(`wrote ${buf.byteLength} bytes back to ${DOC_PATH}`);
      return Response.json({ LastModifiedTime: new Date().toISOString() });
    }

    // Lock endpoints land here as POST /wopi/files/<id> with X-WOPI-Override header.
    if (req.method === "POST" && pathname === `/wopi/files/${DOC_ID}`) {
      const override = req.headers.get("x-wopi-override");
      log(`lock op: X-WOPI-Override=${override} (stub: always OK)`);
      return new Response(null, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
});

log(`serving ${DOC_PATH}`);
log(`listening on http://0.0.0.0:${PORT}`);
log(`WOPISrc for Collabora (container reaches host): http://host.docker.internal:${PORT}/wopi/files/${DOC_ID}`);
