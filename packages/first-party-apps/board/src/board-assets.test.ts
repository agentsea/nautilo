/* eslint-disable @typescript-eslint/await-thenable -- Bun promise matchers are awaited at runtime. */
import { expect, test } from "bun:test";
import { prepareBoardAssetOperations } from "./board-assets";

const pixel = "data:image/png;base64,iVBORw0KGgo=";

test("resolves authorized image bytes into one native add operation without changing them", async () => {
  const result = await prepareBoardAssetOperations([{ op: "insert-image", asset: { ref: "authorized" }, atIndex: 0,
    element: { frame: { x: 1, y: 2, w: 3, h: 4, rotation: 0 }, data: { alt: "Reference" } } }], {
    assets: { async read(target) {
      expect(target).toEqual({ ref: "authorized" });
      return { ok: true, dataUrl: pixel, sha256: "a".repeat(64), byteLength: 8, mimeType: "image/png" };
    } },
  });
  expect(result.operations[0]).toMatchObject({ op: "add", path: "/elements/0",
    value: { type: "image", frame: { x: 1, y: 2, w: 3, h: 4, rotation: 0 }, data: { alt: "Reference", src: pixel } } });
  expect((result.operations[0] as { value: { id: string } }).value.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.receipts).toEqual([{ op: "insert-image", elementId: (result.operations[0] as { value: { id: string } }).value.id,
    path: "/elements/0", sourceSha256: "a".repeat(64), sourceBytes: 8, mimeType: "image/png" }]);
});

test("resolves every image before returning any document mutation", async () => {
  const calls: unknown[] = [];
  await expect(prepareBoardAssetOperations([
    { op: "insert-image", asset: { ref: "allowed" }, element: { frame: { x: 0, y: 0, w: 1, h: 1, rotation: 0 } } },
    { op: "insert-image", asset: { ref: "missing" }, element: { frame: { x: 1, y: 1, w: 1, h: 1, rotation: 0 } } },
  ], { assets: { async read(target) {
    calls.push(target);
    return (target as { ref: string }).ref === "allowed"
      ? { ok: true, dataUrl: pixel, sha256: "a".repeat(64), byteLength: 8, mimeType: "image/png" }
      : { ok: false, code: "not_authorized", message: "Unavailable" };
  } } })).rejects.toMatchObject({ code: "not_authorized", phase: "resolve_asset", stateChanged: false });
  expect(calls).toEqual([{ ref: "allowed" }, { ref: "missing" }]);
});
