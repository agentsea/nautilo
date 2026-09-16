import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFfmpegFile } from "../../electron/ffmpeg-integrity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("pin matches pass; missing or modified unsigned files cannot use the re-sign exception", async () => {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-integrity-")); roots.push(root);
  const file = join(root, "libavcodec.dylib"); const original = Buffer.from("approved fixture bytes");
  const sha = createHash("sha256").update(original).digest("hex");
  expect(await verifyFfmpegFile(file, sha, new Map())).toBe(false);
  writeFileSync(file, original);
  expect(await verifyFfmpegFile(file, sha, new Map())).toBe(true);
  writeFileSync(file, "modified unsigned bytes");
  expect(await verifyFfmpegFile(file, sha, new Map())).toBe(false);
  expect(await verifyFfmpegFile(file, sha, new Map(), { allowAdHoc: true })).toBe(false);
  expect(await verifyFfmpegFile(file, sha, new Map(), { teamId: "EXPECTED" })).toBe(false);
});
