import { describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  readAttachmentBytesVerifiedSize,
  readAttachmentHeadPrefix,
} from "../../src/fs/attachment-path-read";

describe("attachment path reads", () => {
  test("head prefix read returns ok:false without throwing on missing path", async () => {
    const res = await readAttachmentHeadPrefix(path.join(os.tmpdir(), "nautilo-does-not-exist-xyz"), 64);
    expect(res.ok).toBe(false);
  });

  test("verified full read handles size mismatch", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-att-read-"));
    try {
      const fp = path.join(dir, "x.bin");
      await fsp.writeFile(fp, Buffer.from([1, 2, 3]));
      const res = await readAttachmentBytesVerifiedSize(fp, 99);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("size_mismatch");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
