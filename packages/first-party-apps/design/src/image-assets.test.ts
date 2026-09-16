import { describe, expect, test } from "bun:test";
import { DesignImagePreviews, isDesignAssetRef } from "./image-assets";
import { createEmptyDocument, validateDesignDocument } from "./scene-graph";
import { applyDesignTransaction } from "./transactions";
import { parseDesignHtml, renderSceneSvg, serializeDesignHtml, createDefaultManifest } from "./design-document";
import { editOpenDesign } from "./design-operations";
import { semanticVersionForPage, semanticVersionForNode } from "./design-inspection";

const REF = `artifact:12345678-1234-4234-8234-123456789abc:${"a".repeat(64)}`;
const NEXT_REF = REF.replace(/a{64}$/, "b".repeat(64));
const ASSET = { ref: REF, name: "photo.png", width: 32, height: 24, dataUrl: "data:image/png;base64,cGl4ZWxz" };

describe("referenced Design images", () => {
  test("save/reopen retains only pinned custody and a readable placeholder", () => {
    const result = applyDesignTransaction(createEmptyDocument(), { kind: "create", node: { type: "image", assetRef: REF, width: 32, height: 24 } });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const html = serializeDesignHtml(createDefaultManifest(), result.document);
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("nautilo-asset:");
    expect(html).toContain("open in Nautilo Design");
    const parsed = parseDesignHtml(html); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.document.scene.nodes["node-1"]?.assetRef).toBe(REF);
    expect(renderSceneSvg(result.document, "page-1", { hostAssetReferences: true, outlineText: true, rejectImageSources: true })).toContain(`href="nautilo-asset:${REF}"`);
    const replaced = applyDesignTransaction(result.document, { kind: "image", nodeId: "node-1", assetRef: NEXT_REF });
    expect(replaced.ok).toBe(true); if (!replaced.ok) return;
    expect(replaced.document.nodes["node-1"]?.assetRef).toBe(NEXT_REF);
    expect(result.document.nodes["node-1"]?.assetRef).toBe(REF);
  });

  test("URLs/inline bytes cannot become asset identity, and locked images cannot be replaced", () => {
    for (const assetRef of ["https://example.com/image.png", "data:image/png;base64,x", "../../file", `${REF}:extra`]) {
      expect(isDesignAssetRef(assetRef)).toBe(false);
      expect(applyDesignTransaction(createEmptyDocument(), { kind: "create", node: { type: "image", assetRef } }).ok).toBe(false);
    }
    const created = applyDesignTransaction(createEmptyDocument(), { kind: "create", node: { type: "image", assetRef: REF } });
    if (!created.ok) throw new Error("Fixture creation failed");
    const doc = created.document;
    expect(() => validateDesignDocument({ ...doc, nodes: { "node-1": { ...doc.nodes["node-1"], src: "data:image/png;base64,x" } } })).toThrow();
    const locked = { ...doc, nodes: { "node-1": { ...doc.nodes["node-1"]!, locked: true } } };
    expect(applyDesignTransaction(locked, { kind: "image", nodeId: "node-1", assetRef: NEXT_REF }).ok).toBe(false);
  });

  test("Genie creates and relinks images through the same kernel with semantic preconditions", () => {
    const doc = createEmptyDocument();
    const created = editOpenDesign(doc, { idempotencyKey: "image-create", preconditions: [{ handle: "page:page-1", semanticVersion: semanticVersionForPage(doc.pages[0]!) }], operations: [{ op: "create", node: { type: "image", assetRef: REF }, pageId: "page:page-1", parentId: null }] });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const replaced = editOpenDesign(created.document, { idempotencyKey: "image-replace", preconditions: [{ handle: "node:node-1", semanticVersion: semanticVersionForNode(created.document.nodes["node-1"]!, created.document) }], operations: [{ op: "image", nodeId: "node:node-1", assetRef: NEXT_REF }] });
    expect(replaced.ok).toBe(true); if (!replaced.ok) return;
    expect(replaced.document.nodes["node-1"]?.assetRef).toBe(NEXT_REF);
    const stale = editOpenDesign(replaced.document, { idempotencyKey: "image-stale", preconditions: [{ handle: "node:node-1", semanticVersion: semanticVersionForNode(created.document.nodes["node-1"]!, created.document) }], operations: [{ op: "image", nodeId: "node:node-1", assetRef: REF }] });
    expect(stale.ok).toBe(false);
  });
});

describe("image preview lifecycle", () => {
  test("deduplicates current reads, preserves explicit failure and retries only on request", async () => {
    let calls = 0;
    const previews = new DesignImagePreviews(async () => { calls++; if (calls === 1) throw new Error("Image was deleted."); return ASSET; }, () => {});
    previews.reconcile([REF, REF]); previews.reconcile([REF]);
    await Bun.sleep(0);
    expect(calls).toBe(1); expect(previews.entries.get(REF)).toEqual({ status: "failed", message: "Image was deleted." });
    previews.reconcile([REF]); expect(calls).toBe(1);
    previews.retry(REF); previews.reconcile([REF]); await Bun.sleep(0);
    expect(calls).toBe(2); expect(previews.entries.get(REF)?.status).toBe("ready");
    previews.dispose(); expect(previews.entries.size).toBe(0);
  });

  test("late reads cannot resurrect a removed image or publish after close", async () => {
    let resolve!: (value: typeof ASSET) => void;
    let renders = 0;
    const previews = new DesignImagePreviews(() => new Promise((done) => { resolve = done; }), () => { renders++; });
    previews.reconcile([REF]); previews.reconcile([]); resolve(ASSET); await Bun.sleep(0);
    expect(previews.entries.size).toBe(0); expect(renders).toBe(0);
    previews.reconcile([REF]); previews.dispose(); resolve(ASSET); await Bun.sleep(0);
    expect(renders).toBe(0);
  });
});
