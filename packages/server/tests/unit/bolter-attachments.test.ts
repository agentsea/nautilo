import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBolterAttachmentBytes } from "../../src/messaging/bolter-attachments";

const roots: string[] = [];
const original = process.env["NAUTILO_ARTIFACTS_ROOT"];
afterEach(async () => {
  if (original === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  else process.env["NAUTILO_ARTIFACTS_ROOT"] = original;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bolter-files-")); roots.push(root);
  process.env["NAUTILO_ARTIFACTS_ROOT"] = root;
  const id = "10000000-0000-4000-8000-000000000001", bytes = Buffer.from("Synthetic bytes");
  const path = join(root, "message-attachments", id);
  await mkdir(join(root, "message-attachments")); await writeFile(path, bytes);
  return { root, path, bytes, file: { id, storageUri: pathToFileURL(path).href, sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") } };
}
test("publication reads only unchanged, checksum-bound bytes from canonical storage", async () => {
  const f = await fixture();
  expect(await readBolterAttachmentBytes(f.file)).toEqual(f.bytes);
  for (const patch of [{ storageUri: pathToFileURL(join(f.root, "other")).href }, { id: "../other" }, { sizeBytes: f.bytes.length + 1 }, { sha256: "0".repeat(64) }]) {
    await Promise.resolve(expect(readBolterAttachmentBytes({ ...f.file, ...patch })).rejects.toThrow());
  }
  await writeFile(f.path, "Changed content");
  await Promise.resolve(expect(readBolterAttachmentBytes(f.file)).rejects.toThrow());
});
test.skipIf(process.platform === "win32")("a symlink never supplies outbound attachment bytes", async () => {
  const f = await fixture(); const outside = join(f.root, "other");
  await writeFile(outside, f.bytes); await rm(f.path); await symlink(outside, f.path);
  await Promise.resolve(expect(readBolterAttachmentBytes(f.file)).rejects.toThrow());
});
