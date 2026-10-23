import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getArtifactsRoot } from "@nautilo/config";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { bolterAttachmentDescriptorSchema } from "@nautilo/types";

/** Read only the canonical upload blob; filenames and URLs never choose a path. */
export async function readBolterAttachmentBytes(file: { id: string; storageUri: string; sizeBytes: number; sha256?: string }): Promise<Buffer> {
  if (!bolterAttachmentDescriptorSchema.shape.id.safeParse(file.id).success || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
    || file.sizeBytes > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) throw new Error("Attachment unavailable");
  const path = join(getArtifactsRoot(), "message-attachments", file.id);
  if (file.storageUri !== pathToFileURL(path).href) throw new Error("Attachment unavailable");
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new Error("Attachment unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== BigInt(file.sizeBytes)) throw new Error("Attachment unavailable");
    const bytes = Buffer.alloc(file.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Attachment unavailable");
      offset += read.bytesRead;
    }
    const [after, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.dev !== before.dev || named.ino !== before.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || (file.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.sha256)) throw new Error("Attachment changed");
    return bytes;
  } finally { await handle.close(); }
}
