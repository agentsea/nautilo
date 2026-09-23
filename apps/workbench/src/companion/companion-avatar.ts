import type { CompanionBinding } from "../../../desktop/electron/companion-contract";
import { fetchAvatarObjectUrl } from "../components/avatar/authenticated-image";
import { agentAvatarUrl } from "../modes/rooms/shape/agent-author-label";
import { apiClient } from "../lib/api";

/** Resolve the pinned Room's protected portrait in the authenticated owner.
 * Send only a raster image sized for the largest avatar, never a token or URL. */
export async function loadCompanionAvatar(binding: CompanionBinding): Promise<string | null> {
  const tokenProvider = apiClient.getTokenProvider();
  const token = tokenProvider ? await tokenProvider() : apiClient.getToken();
  const source = agentAvatarUrl({ roomId: binding.roomId, agentId: binding.agentId, avatar: null, fallbackAvatarSrc: "" });
  const result = await fetchAvatarObjectUrl(source, token);
  if (result.kind !== "image") return null;
  try {
    const image = new Image();
    image.src = result.objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    // The bubble's portrait is 76 logical pixels, rendered at the host's scale.
    canvas.width = canvas.height = Math.ceil(76 * window.devicePixelRatio);
    const context = canvas.getContext("2d");
    if (!context || !image.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } catch { return null; }
  finally { URL.revokeObjectURL(result.objectUrl); }
}
