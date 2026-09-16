import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { Artifact } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { computeAppSourceHash } from "../../src/apps/app-registry";
import { createAppToolHost, handleHostRpc, type AppDocumentOperations } from "../../src/apps/app-tool-host";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { removePrivateSlideTemplate, savePrivateSlideTemplate, SLIDE_TEMPLATE_MIME_TYPE, SLIDE_TEMPLATE_PATH_PREFIX, type SlideTemplateRouteService } from "../../src/lib/slide-template-service";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const TEMPLATE_ID = "20000000-0000-4000-8000-000000000001";
const INTERNAL_ID = "30000000-0000-4000-8000-000000000001";
const NS = "10000000-0000-4000-8000-000000000001";
const CONTENT = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Presentation</title></head><body>\n<script id="manifest" type="application/vnd.nautilo.document+json">{"documentType":"presentation","editor":"wafflebase","payloadId":"wafflebase-presentation","payloadFormat":"application/vnd.wafflebase.presentation+json","version":"1.0"}</script>\n<script id="wafflebase-presentation" type="application/vnd.wafflebase.presentation+json">{"meta":{"title":"T","themeId":"t","masterId":"m"},"themes":[],"masters":[],"layouts":[],"slides":[{"id":"s"}],"guides":[]}</script>\n</body></html>';

function pngWithDimensions(source: Buffer, width: number, height: number): Buffer {
  const output = Buffer.from(source);
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  let crc = 0xffffffff;
  for (const byte of output.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return output;
}

function context(): AppToolRunnerContext {
  return { ownerId: "user-1", userId: "user-1", agentId: "agent-1", currentFolder: "/tmp", workspacePath: "/tmp", turnId: "turn-1", toolCallId: "tool-call-1", memoryAccessEnvelope: { ownerId: "user-1", agentId: "agent-1", memoryMode: "namespace", readableNamespaceIds: [NS], mutableNamespaceIds: [NS], writableNamespaceIds: [NS] } as unknown as MemoryAccessEnvelope };
}

function documentOps(): AppDocumentOperations {
  return {
    createFromAction: async () => { throw new Error("unused"); },
    read: async () => ({ content: PNG.toString("base64"), encoding: "base64", byteLength: PNG.byteLength, mimeType: null, displayPath: "photo.bin", baseSha256: "", baseRevision: null }),
    stat: async () => ({ exists: true, size: PNG.byteLength, mimeType: null, baseSha256: null, baseRevision: null }),
    write: async () => ({ kind: "error", message: "unused" }), getState: async () => undefined, setState: async () => undefined,
  };
}

function artifact(id = TEMPLATE_ID, name = "Launch", content = CONTENT, deletedAt: Date | null = null): Artifact {
  return { id: id === TEMPLATE_ID ? INTERNAL_ID : `internal-${id}`, artifactId: id, path: `${SLIDE_TEMPLATE_PATH_PREFIX}${id}.${Buffer.from(name).toString("base64url")}.slide-template.html`, mimeType: SLIDE_TEMPLATE_MIME_TYPE, size: Buffer.byteLength(content), storageUri: `file:///${id}`, revision: 1, createdAt: new Date(), updatedAt: new Date(), deletedAt };
}

async function host(service?: SlideTemplateRouteService, reads = { documents: 0, artifacts: 0 }, bytes: Buffer<ArrayBufferLike> = PNG, remainingToolTimeMs?: () => number) {
  const ops = documentOps();
  ops.read = async () => ({ content: bytes.toString("base64"), encoding: "base64", byteLength: bytes.byteLength, mimeType: null, displayPath: "photo.bin", baseSha256: "", baseRevision: null });
  const read = ops.read;
  ops.read = async (...args) => { reads.documents++; return read(...args); };
  const presentationRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "first-party-apps", "presentation");
  return createAppToolHost({ appId: "nautilo-presentation", appRoot: presentationRoot, appsRoot: dirname(presentationRoot), sourceHash: await computeAppSourceHash(presentationRoot), manifest: { ...TEST_MINI_APP_MANIFEST, id: "nautilo-presentation", capabilities: { document: { artifact: "read", currentFolder: "read" }, state: "none" } }, context: context(), documentOps: ops, assetDependencies: { findArtifact: async () => { reads.artifacts++; return null; } }, resolveHumanActorId: async () => "actor-1", ...(service ? { slideTemplateService: service } : {}), ...(remainingToolTimeMs ? { remainingToolTimeMs } : {}) });
}

describe("Slides host resources", () => {
  test("returns exact image bytes with server-decoded MIME and dimensions", async () => {
    const value = await handleHostRpc(await host(), "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(value).toMatchObject({ ok: true, mimeType: "image/png", width: 1, height: 1, byteLength: PNG.byteLength });
    expect(value["dataUrl"]).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(value).not.toHaveProperty("base64");
  });

  test("fully decodes pixels and inherits the app tool deadline", async () => {
    const encoded = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const truncated = encoded.subarray(0, encoded.byteLength - 13);
    expect(await sharp(truncated).metadata()).toMatchObject({ width: 32, height: 32 });

    const corrupt = await handleHostRpc(await host(undefined, undefined, truncated, () => 10_000), "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(corrupt).toMatchObject({ ok: false, code: "ASSET_DECODE_FAILED", message: "Image pixels could not be decoded." });

    const expired = await handleHostRpc(await host(undefined, undefined, PNG, () => 0), "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(expired).toMatchObject({ ok: false, code: "ASSET_DECODE_TIMEOUT", message: "Image decoding exceeded the app tool deadline." });
  });

  test("retains Sharp's dependency-owned pixel guard", async () => {
    const oversizedDimensions = pngWithDimensions(PNG, 20_000, 20_000);
    expect(await sharp(oversizedDimensions, { limitInputPixels: false }).metadata()).toMatchObject({ width: 20_000, height: 20_000 });
    const rejected = await sharp(oversizedDimensions, { limitInputPixels: true }).metadata()
      .then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toMatch(/pixel limit/iu);

    const value = await handleHostRpc(await host(undefined, undefined, oversizedDimensions, () => 10_000), "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(value).toMatchObject({ ok: false, code: "ASSET_DECODE_LIMIT", message: "Image dimensions or channels exceed decoder safety limits. Resize the image or choose a smaller source." });
  });

  test("rechecks the wall deadline after a successful full decode", async () => {
    const remaining = [10_000, 10_000, 0];
    const value = await handleHostRpc(await host(undefined, undefined, PNG, () => remaining.shift() ?? 0), "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(value).toMatchObject({ ok: false, code: "ASSET_DECODE_TIMEOUT", message: "Image decoding exceeded the app tool deadline." });
    expect(remaining).toEqual([]);
  });

  test("rejects conflicting image source fields before reading bytes", async () => {
    const reads = { documents: 0, artifacts: 0 };
    const value = await host(undefined, reads);
    const result = await handleHostRpc(value, "assets.read", [{ ref: `artifact:${TEMPLATE_ID}:${"0".repeat(64)}`, surface: "currentFolder", relativePath: "photo.bin" }]) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, code: "INVALID_ASSET_SOURCE" });
    expect(reads).toEqual({ documents: 0, artifacts: 0 });
    await handleHostRpc(value, "assets.read", [{ surface: "currentFolder", relativePath: "photo.bin" }]);
    expect(reads).toEqual({ documents: 1, artifacts: 0 });
  });

  test("uses the exact private template service and denies foreign namespace membership", async () => {
    let admitted = 0;
    const service: SlideTemplateRouteService = {
      resolvePrivateNamespace: async (_user, actor) => actor === "actor-1" ? NS : null,
      listPage: async () => [artifact()], findById: async () => artifact(), getNamespaceIds: async () => [NS], read: async () => CONTENT,
      persist: async (input) => ({ ...artifact(), artifactId: input.templateId }), remove: async () => artifact(),
      assertCanWriteArtifacts: async () => { admitted += 1; }, publish: () => undefined,
    };
    const value = await host(service);
    expect(await handleHostRpc(value, "templates.list", [{}])).toMatchObject({ templates: [{ id: TEMPLATE_ID, name: "Launch" }] });
    expect(await handleHostRpc(value, "templates.read", [{ templateId: TEMPLATE_ID }])).toEqual({ content: CONTENT });
    await handleHostRpc(value, "templates.save", [{ name: "Copy", content: CONTENT }]);
    await handleHostRpc(value, "templates.remove", [{ templateId: TEMPLATE_ID }]);
    expect(admitted).toBe(2);
    service.getNamespaceIds = async () => ["foreign"];
    expect(handleHostRpc(value, "templates.read", [{ templateId: TEMPLATE_ID }])).rejects.toThrow("Template not found");
  });
});

function mutationService() {
  const rows = new Map<string, { artifact: Artifact; content: string; namespaceIds: string[] }>();
  let writes = 0;
  let persistMode: "normal" | "throw-before" | "throw-after" = "normal";
  let reconcileThrows = false;
  const service: SlideTemplateRouteService = {
    resolvePrivateNamespace: async () => NS,
    listPage: async () => [],
    findById: async (id, namespace) => {
      const row = rows.get(id);
      return row && row.artifact.deletedAt === null && row.namespaceIds.includes(namespace) ? row.artifact : null;
    },
    getNamespaceIds: async (internalId) => [...rows.values()].find((row) => row.artifact.id === internalId)?.namespaceIds ?? [],
    read: async (uri) => {
      const row = [...rows.values()].find((candidate) => candidate.artifact.storageUri === uri);
      if (!row) throw new Error("missing");
      return row.content;
    },
    persist: async (input) => {
      writes += 1;
      if (persistMode === "throw-before") throw new Error("before commit");
      const created = artifact(input.templateId, input.name, input.content);
      rows.set(input.templateId, { artifact: created, content: input.content, namespaceIds: [input.namespaceId] });
      if (persistMode === "throw-after") throw new Error("lost acknowledgement");
      return created;
    },
    remove: async (internalId, namespaceId) => {
      const row = [...rows.values()].find((candidate) => candidate.artifact.id === internalId && candidate.namespaceIds.includes(namespaceId));
      if (!row) return null;
      row.artifact = { ...row.artifact, deletedAt: new Date() };
      return row.artifact;
    },
    assertCanWriteArtifacts: async () => undefined,
    publish: () => undefined,
    findIdentity: async (id) => {
      if (reconcileThrows) throw new Error("reconciliation unavailable");
      const row = rows.get(id);
      return row ? { artifact: row.artifact, namespaceIds: row.namespaceIds } : null;
    },
  };
  return { service, rows, writes: () => writes, setPersistMode: (mode: typeof persistMode) => { persistMode = mode; }, setReconcileThrows: () => { reconcileThrows = true; } };
}

describe("Slides template mutation reconciliation", () => {
  test("same retry identity resumes the exact payload and rejects changed payload without another write", async () => {
    const fixture = mutationService();
    const input = { userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT };
    expect(await savePrivateSlideTemplate(input, fixture.service)).toMatchObject({ ok: true, template: { id: TEMPLATE_ID }, stateChanged: true });
    expect(await savePrivateSlideTemplate(input, fixture.service)).toMatchObject({ ok: true, template: { id: TEMPLATE_ID }, stateChanged: false });
    expect(await savePrivateSlideTemplate({ ...input, name: "Changed" }, fixture.service)).toMatchObject({ ok: false, code: "TEMPLATE_IDENTITY_CONFLICT", stateChanged: false });
    expect(fixture.writes()).toBe(1);
  });

  test("does not resurrect a deleted deterministic save identity", async () => {
    const fixture = mutationService();
    fixture.rows.set(TEMPLATE_ID, { artifact: artifact(TEMPLATE_ID, "Launch", CONTENT, new Date()), content: CONTENT, namespaceIds: [NS] });
    const result = await savePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT }, fixture.service);
    expect(result).toMatchObject({ ok: false, code: "TEMPLATE_IDENTITY_CONFLICT", stateChanged: false });
    expect(fixture.writes()).toBe(0);
  });

  test("distinguishes committed, absent, and unknown persistence failures", async () => {
    const committed = mutationService();
    committed.setPersistMode("throw-after");
    expect(await savePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT }, committed.service)).toMatchObject({ ok: true, stateChanged: false });

    const absent = mutationService();
    absent.setPersistMode("throw-before");
    expect(await savePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT }, absent.service)).toMatchObject({ ok: false, code: "TEMPLATE_SAVE_FAILED", retrySafe: true, stateChanged: false });

    const unknown = mutationService();
    unknown.setPersistMode("throw-before");
    let calls = 0;
    const original = unknown.service.findIdentity!;
    unknown.service.findIdentity = async (id) => {
      calls += 1;
      if (calls > 1) throw new Error("unavailable");
      return original(id);
    };
    expect(await savePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT }, unknown.service)).toMatchObject({ ok: false, code: "TEMPLATE_RECONCILIATION_UNAVAILABLE", stateChanged: "unknown", retrySafe: false });
  });

  test("treats already-deleted exact private ownership as unchanged success and foreign scope as absent", async () => {
    const same = mutationService();
    same.rows.set(TEMPLATE_ID, { artifact: artifact(TEMPLATE_ID, "Launch", CONTENT, new Date()), content: CONTENT, namespaceIds: [NS] });
    expect(await removePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID }, same.service)).toEqual({ ok: true, stateChanged: false });

    const foreign = mutationService();
    foreign.rows.set(TEMPLATE_ID, { artifact: artifact(TEMPLATE_ID, "Launch", CONTENT, new Date()), content: CONTENT, namespaceIds: ["foreign"] });
    expect(await removePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID }, foreign.service)).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND", stateChanged: false });
  });

  test("reports durable success when notification publication fails", async () => {
    const saved = mutationService();
    saved.service.publish = () => { throw new Error("event bus unavailable"); };
    expect(await savePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID, name: "Launch", content: CONTENT }, saved.service)).toMatchObject({ ok: true, stateChanged: true, warnings: [expect.any(String)] });
    expect(await removePrivateSlideTemplate({ userId: "user-1", namespaceId: NS, templateId: TEMPLATE_ID }, saved.service)).toMatchObject({ ok: true, stateChanged: true, warnings: [expect.any(String)] });
  });
});
