import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { eq, getSharedDirectDb, profiles } from "@nautilo/db";
import type { AvatarRef } from "@nautilo/types";
import { getAvatarBlobDir, isSafeBlobId, readPresetAvatarPng } from "../routes/_helpers/avatar";

export interface MagentGenieAvatar {
  bytes: Uint8Array;
  contentType: "image/png";
}

export interface MagentAvatarDependencies {
  findAvatar(genieId: string): Promise<AvatarRef | null>;
  readAvatar(avatar: AvatarRef): Promise<Buffer | null>;
}

/** The caller supplies its fixed, authorized binding's Genie, never a request parameter. */
export function createMagentAvatarLoader(dependencies: MagentAvatarDependencies) {
  return async (genieId: string): Promise<MagentGenieAvatar | null> => {
    let input: Buffer | null;
    try {
      const avatar = await dependencies.findAvatar(genieId);
      if (!avatar) return null;
      input = await dependencies.readAvatar(avatar);
    } catch {
      throw new Error("magent_avatar_unavailable");
    }
    if (!input) return null;
    try {
      // Match persistUploadedServerImage and the canonical avatar thumbnail encoder.
      // PNG re-encoding strips source metadata.
      const bytes = await sharp(input).rotate().resize(256, 256, { fit: "cover", position: "center" })
        .png({ compressionLevel: 9 }).toBuffer();
      return { bytes, contentType: "image/png" };
    } catch {
      return null;
    }
  };
}

async function readCanonicalAvatar(avatar: AvatarRef): Promise<Buffer | null> {
  if (avatar.kind === "preset") return readPresetAvatarPng(avatar);
  if (!isSafeBlobId(avatar.blobId)) return null;
  try {
    return await readFile(join(getAvatarBlobDir(avatar.kind), `${avatar.blobId}.png`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // The socket must never return filesystem paths or raw filesystem errors.
    throw new Error("magent_avatar_unavailable");
  }
}

/** Portable pixels only: no local path, remote URL, or credentials cross the socket. */
export const loadMagentGenieAvatar = createMagentAvatarLoader({
  async findAvatar(genieId) {
    const [row] = await getSharedDirectDb().select({ avatarRef: profiles.avatarRef }).from(profiles)
      .where(eq(profiles.agentId, genieId)).limit(1);
    return row?.avatarRef ?? null;
  },
  readAvatar: readCanonicalAvatar,
});
