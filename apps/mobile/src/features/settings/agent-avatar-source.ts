import type { AgentAvatarUploadInput } from "@nautilo/api-client/browser";
import type { AvatarRef } from "@nautilo/types";

/** Mirrors the current server image-upload boundary. Keep this in lockstep with
 * `persistUploadedServerImage`: client validation is a fast, truthful guard,
 * while the server remains authoritative. */
export const AGENT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AGENT_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/**
 * The shipped canonical preset asset set is avatar-01..07 and avatar-09..41.
 * `avatar-08` is intentionally absent. These are the same public onboarding
 * assets used by desktop and Workbench.
 */
export const AGENT_AVATAR_PRESET_IDS = Array.from({ length: 41 }, (_, index) => index + 1)
  .filter((number) => number !== 8)
  .map((number) => `avatar-${String(number).padStart(2, "0")}`);

/** Resolve a shipped preset through the server's existing public asset mount. */
export function agentAvatarPresetSource(serverUrl: string, id: string): { uri: string } {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  return {
    uri: `${baseUrl}/api/onboarding/images/avatars/${encodeURIComponent(id)}.webp`,
  };
}

const allowedAvatarMimes = new Set<string>(AGENT_AVATAR_MIME_TYPES);

export type PickedAgentImage = {
  uri: string;
  type?: "image" | "video" | "livePhoto" | "pairedVideo" | null;
  fileName?: string | null;
  fileSize?: number;
  mimeType?: string | null;
};

export type AgentAvatarFile = AgentAvatarUploadInput & {
  readonly name?: string;
  readonly size: number;
  readonly type?: string;
};

export type AgentAvatarUploadPreparation =
  | { ok: true; file: AgentAvatarFile; mimeType: (typeof AGENT_AVATAR_MIME_TYPES)[number] }
  | { ok: false; message: string };

/**
 * Reject unsupported/oversized picks before allocating multipart bytes. The
 * ImagePicker metadata is advisory, so the File's native size wins when it is
 * available. Unknown MIME is rejected rather than pretending a filename is a
 * safe image type.
 */
export function prepareAgentAvatarUpload(
  asset: PickedAgentImage,
  file: AgentAvatarFile,
): AgentAvatarUploadPreparation {
  if (asset.type && asset.type !== "image") {
    return { ok: false, message: "Choose an image, not a video or Live Photo." };
  }
  const mimeType = normalizeMime(asset.mimeType) ?? normalizeMime(file.type) ?? mimeFromName(asset.fileName ?? file.name);
  if (!mimeType || !allowedAvatarMimes.has(mimeType)) {
    return { ok: false, message: "Choose a PNG, JPEG, or WebP image." };
  }
  const size = Number.isFinite(file.size) && file.size > 0 ? file.size : asset.fileSize;
  if (!Number.isFinite(size) || !size || size <= 0) {
    return { ok: false, message: "Could not read the selected image size. Choose another image." };
  }
  if (size > AGENT_AVATAR_MAX_BYTES) {
    return { ok: false, message: "Choose an image smaller than 5 MiB." };
  }
  return { ok: true, file, mimeType: mimeType as (typeof AGENT_AVATAR_MIME_TYPES)[number] };
}

/** A self-only, versioned authenticated avatar URL. */
export function authenticatedAgentAvatarSource(args: {
  serverUrl: string;
  accessToken: string | null;
  avatar: AvatarRef;
}): { uri: string; headers: { Authorization: string } } | null {
  if (!args.accessToken) return null;
  const version = args.avatar.kind === "preset" ? args.avatar.id : args.avatar.blobId;
  const baseUrl = args.serverUrl.replace(/\/+$/, "");
  return {
    uri: `${baseUrl}/api/profile/avatar?v=${encodeURIComponent(version)}`,
    headers: { Authorization: `Bearer ${args.accessToken}` },
  };
}

/** Resolve an avatar header through the same refresh-aware token seam as API calls. */
export async function loadAuthenticatedAgentAvatarSource(args: {
  serverId: string;
  serverUrl: string;
  avatar: AvatarRef;
  getToken: (serverId: string, serverUrl: string) => Promise<string | null>;
}): Promise<{ uri: string; headers: { Authorization: string } } | null> {
  const accessToken = await args.getToken(args.serverId, args.serverUrl);
  return authenticatedAgentAvatarSource({
    serverUrl: args.serverUrl,
    accessToken,
    avatar: args.avatar,
  });
}

function normalizeMime(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function mimeFromName(name: string | null | undefined): string | null {
  const extension = name?.trim().toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}
