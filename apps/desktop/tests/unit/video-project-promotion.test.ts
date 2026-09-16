/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-base-to-string -- Fetch mocks decode Node Readable multipart bodies through the platform Request/FormData parser. */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createEmptyProject } from "../../../../packages/first-party-apps/video/src/edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { projectVideoPromotionResult, promoteVideoProject } from "../../electron/video-project-promotion";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function projectFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nautilo-promote-test-")); roots.push(root);
  await mkdir(path.join(root, "media"));
  await writeFile(path.join(root, "media", "picture.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await writeFile(path.join(root, "media", "sound.wav"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]));
  const project = createEmptyProject();
  project.metadata = { title: "My Film" };
  project.media.push(
    { id: "image-a", kind: "image", ref: "media/picture.png", lifecycle: "local-working", label: "Picture" },
    { id: "image-b", kind: "image", ref: "media/picture.png", lifecycle: "local-working", label: "Picture again" },
    { id: "audio-a", kind: "audio", ref: "media/sound.wav", lifecycle: "local-working", durationSec: 2, label: "Sound" },
  );
  const content = serializeVideoHtml(createDefaultManifest(), project);
  const documentPath = path.join(root, "film.video.html"); await writeFile(documentPath, content);
  return { root, documentPath, content, expectedSha256: createHash("sha256").update(content).digest("hex") };
}

const roomId = "10000000-0000-4000-8000-000000000001";
function receipt(index: number, upload: { path: string; mimeType: string; size: number }) {
  return { id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    artifactId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, ...upload };
}

describe("native Current Folder video project promotion", () => {
  test("post-effect authority loss reports uncertainty without disclosing the prior destination", () => {
    const result = { status: "succeeded" as const, document: { id: "private-row", artifactId: "private-artifact", path: "private-room/film.video.html", mimeType: "text/html" as const }, mediaCount: 2 };
    expect(projectVideoPromotionResult(result, true)).toBe(result);
    expect(projectVideoPromotionResult(result, false)).toEqual({ status: "unknown", code: "authority_changed", retainedPaths: [] });
  });
  test("uploads distinct mixed-kind refs once, rewrites a validated Workspace copy, and leaves the original unchanged", async () => {
    const fixture = await projectFixture(); const uploads: Array<{ path: string; mimeType: string; bytes: Buffer }> = [];
    const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: fixture.expectedSha256 }, {
      rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
      fetch: (async (_url, options) => {
        expect(options?.method).toBe("POST");
        const request = new Request("https://server.test", { method: "POST", headers: options?.headers, body: options?.body as BodyInit, duplex: "half" } as RequestInit & { duplex: "half" });
        const form = await request.formData(); const file = form.get("file") as File;
        const upload = { path: String(form.get("path")), mimeType: String(form.get("mimeType")), bytes: Buffer.from(await file.arrayBuffer()) };
        uploads.push(upload); return Response.json(receipt(uploads.length + 1, { path: upload.path, mimeType: upload.mimeType, size: upload.bytes.length }));
      }) as typeof fetch,
    });
    expect(result.status).toBe("succeeded");
    expect(result.status === "succeeded" && result.mediaCount).toBe(2);
    expect(uploads.map((item) => item.mimeType)).toEqual(["image/png", "audio/wav", "text/html"]);
    const promoted = parseVideoHtml(uploads.at(-1)!.bytes.toString("utf8"));
    expect(promoted.ok).toBe(true);
    if (promoted.ok) {
      expect(promoted.document.project.media.every((asset) => asset.lifecycle === "durable" && asset.source?.path === asset.ref)).toBe(true);
      expect(promoted.document.project.media[0]!.ref).toBe(promoted.document.project.media[1]!.ref);
    }
    expect(await readFile(fixture.documentPath, "utf8")).toBe(fixture.content);
  });

  test("rejects changed documents, media authority, and generation authority before upload", async () => {
    const fixture = await projectFixture(); let calls = 0;
    const authority = { rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
      fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch };
    expect((await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: "a".repeat(64) }, authority)).code).toBe("document_changed");
    const parsed = parseVideoHtml(fixture.content); if (!parsed.ok) throw new Error("fixture");
    parsed.document.project.media[0] = { ...parsed.document.project.media[0]!, lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: "30000000-0000-4000-8000-000000000001", path: parsed.document.project.media[0]!.ref } };
    const mixed = serializeVideoHtml(parsed.document.manifest, parsed.document.project); await writeFile(fixture.documentPath, mixed);
    expect((await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: createHash("sha256").update(mixed).digest("hex") }, authority)).code).toBe("mixed_workspace_authority_unsupported");
    const generatedParsed = parseVideoHtml(fixture.content); if (!generatedParsed.ok) throw new Error("fixture");
    generatedParsed.document.project.generatedTakes = [{ id: "take_abcdefghijklmnop", briefRevision: 1, mediaKind: "video", modelId: "model-1", settings: {},
      artifact: { artifactId: "40000000-0000-4000-8000-000000000001", path: "generated/take.mp4", zone: "workspace", mime: "video/mp4", bytes: 12 } }];
    const generated = serializeVideoHtml(generatedParsed.document.manifest, generatedParsed.document.project); await writeFile(fixture.documentPath, generated);
    expect((await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: createHash("sha256").update(generated).digest("hex") }, authority)).code).toBe("workspace_generation_binding_unsupported");
    expect(calls).toBe(0);
  });

  test("rejects a symlinked or outside-root ref before upload", async () => {
    const fixture = await projectFixture(); const outside = await mkdtemp(path.join(tmpdir(), "nautilo-promote-outside-")); roots.push(outside);
    await writeFile(path.join(outside, "outside.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await symlink(path.join(outside, "outside.png"), path.join(fixture.root, "media", "picture.png-link"));
    const parsed = parseVideoHtml(fixture.content); if (!parsed.ok) throw new Error("fixture");
    parsed.document.project.media[0]!.ref = "media/picture.png-link";
    const content = serializeVideoHtml(parsed.document.manifest, parsed.document.project); await writeFile(fixture.documentPath, content);
    let calls = 0;
    const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: createHash("sha256").update(content).digest("hex") }, {
      rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
      fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch,
    });
    expect(result.status).toBe("failed"); expect(calls).toBe(0);
  });

  test("rejects an ancestor-directory symlink before any upload", async () => {
    const fixture = await projectFixture(); await symlink(path.join(fixture.root, "media"), path.join(fixture.root, "linked-media"));
    const parsed = parseVideoHtml(fixture.content); if (!parsed.ok) throw new Error("fixture");
    for (const asset of parsed.document.project.media) {
      if (asset.ref.startsWith("media/")) asset.ref = asset.ref.replace("media/", "linked-media/");
    }
    const content = serializeVideoHtml(parsed.document.manifest, parsed.document.project); await writeFile(fixture.documentPath, content); let calls = 0;
    const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: createHash("sha256").update(content).digest("hex") }, {
      rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
      fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch,
    });
    expect(result.status).toBe("failed"); expect(result.status !== "succeeded" && result.code).toBe("source_unavailable"); expect(calls).toBe(0);
  });

  test("rechecks the saved document snapshot before publishing the Workspace document", async () => {
    const fixture = await projectFixture(); let posts = 0; let deletes = 0;
    const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: fixture.expectedSha256 }, {
      rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
      fetch: (async (_url, options) => {
        if (options?.method === "DELETE") { deletes++; return new Response(null, { status: 204 }); }
        posts++; const request = new Request("https://server.test", { method: "POST", headers: options?.headers, body: options?.body as BodyInit, duplex: "half" } as RequestInit & { duplex: "half" });
        const form = await request.formData(); const file = form.get("file") as File;
        const upload = { path: String(form.get("path")), mimeType: String(form.get("mimeType")), size: file.size };
        if (posts === 2) await writeFile(fixture.documentPath, `${fixture.content}\nchanged`);
        return Response.json(receipt(posts + 100, upload));
      }) as typeof fetch,
    });
    expect(result.status).toBe("failed"); expect(result.status !== "succeeded" && result.code).toBe("document_changed");
    expect(posts).toBe(2); expect(deletes).toBe(2);
  });

  test("cleans confirmed media after final refusal but retains every possible path after an unknown final outcome", async () => {
    for (const unknown of [false, true]) {
      const fixture = await projectFixture(); const created: string[] = []; const deleted: string[] = []; let posts = 0;
      const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: fixture.expectedSha256 }, {
        rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => true,
        fetch: (async (url, options) => {
          if (options?.method === "DELETE") { deleted.push(String(url)); return new Response(null, { status: 204 }); }
          posts++; const request = new Request("https://server.test", { method: "POST", headers: options?.headers, body: options?.body as BodyInit, duplex: "half" } as RequestInit & { duplex: "half" });
          const form = await request.formData(); const file = form.get("file") as File; const upload = { path: String(form.get("path")), mimeType: String(form.get("mimeType")), size: file.size };
          if (posts === 3) { if (unknown) throw new Error("lost response"); return new Response(null, { status: 409 }); }
          created.push(upload.path); return Response.json(receipt(posts + 20, upload));
        }) as typeof fetch,
      });
      expect(result.status).toBe(unknown ? "unknown" : "failed");
      expect(deleted.length).toBe(unknown ? 0 : created.length);
      expect(result.status !== "succeeded" && result.retainedPaths.length).toBe(unknown ? created.length + 1 : 0);
    }
  });

  test("authority loss stops publication and reports the confirmed artifact as retained", async () => {
    const fixture = await projectFixture(); let current = true; let calls = 0;
    const result = await promoteVideoProject({ documentPath: fixture.documentPath, expectedSha256: fixture.expectedSha256 }, {
      rootPath: fixture.root, roomId, serverUrl: "https://server.test", bearer: "test", isAuthorityCurrent: () => current,
      fetch: (async (_url, options) => {
        calls++; expect(options?.method).toBe("POST");
        const request = new Request("https://server.test", { method: "POST", headers: options?.headers, body: options?.body as BodyInit, duplex: "half" } as RequestInit & { duplex: "half" });
        const form = await request.formData(); const file = form.get("file") as File;
        const upload = { path: String(form.get("path")), mimeType: String(form.get("mimeType")), size: file.size };
        current = false; return Response.json(receipt(90, upload));
      }) as typeof fetch,
    });
    expect(result.status).toBe("cancelled");
    expect(result.status !== "succeeded" && result.retainedPaths).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
