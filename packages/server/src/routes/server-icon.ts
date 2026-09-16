import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getServerIconRoot } from "@nautilo/config";
import { getServerProfile } from "@nautilo/db";
import type { AvatarRef } from "@nautilo/types";
import { getServerDirectDb } from "../lib/server-direct-db";
// D243 Phase 2 — share the cache-policy + blob-id jail with the avatar serve
// path so the public server icon and private avatars stop drifting apart.
import { isSafeBlobId, requestIsVersioned, setMediaCacheHeaders } from "./_helpers/avatar";
import { presetAssetPath } from "./server-icon-presets";

const serverIconBlobDir = () => getServerIconRoot();

function sendPresetIcon(reply: FastifyReply, presetId: string, versioned: boolean) {
  const assetPath = presetAssetPath(presetId);
  if (!assetPath || !existsSync(assetPath)) {
    return reply.code(404).send({ error: "Not found" });
  }
  setMediaCacheHeaders(reply, { visibility: "public", etag: presetId, versioned });
  reply.type("image/png");
  return reply.send(readFileSync(assetPath));
}

function sendBlobIcon(
  reply: FastifyReply,
  avatar: Extract<AvatarRef, { kind: "uploaded" | "generated" }>,
  versioned: boolean,
) {
  if (!isSafeBlobId(avatar.blobId)) {
    return reply.code(404).send({ error: "Not found" });
  }

  const filePath = join(serverIconBlobDir(), `${avatar.blobId}.png`);
  if (!existsSync(filePath)) {
    return reply.code(404).send({ error: "Not found" });
  }

  setMediaCacheHeaders(reply, { visibility: "public", etag: avatar.blobId, versioned });
  reply.type("image/png");
  return reply.send(readFileSync(filePath));
}

export function serverIconRoutes(app: FastifyInstance): void {
  app.get("/api/server/icon", async (request: FastifyRequest, reply) => {
    const profile = await getServerProfile(getServerDirectDb());
    const icon = profile.icon;
    // D243 Phase 3 — `/api/server/icon?v=<blobId>` opts into immutable caching
    // (switcher/admin consumers will build the versioned URL from the ref).
    const versioned = requestIsVersioned(request);

    if (icon.kind === "preset") {
      return sendPresetIcon(reply, icon.id, versioned);
    }

    return sendBlobIcon(reply, icon, versioned);
  });
}
