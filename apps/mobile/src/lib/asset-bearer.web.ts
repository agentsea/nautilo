import { ensureValidToken } from "@/lib/auth.web";
import { serverIdFromUrl } from "@/lib/server-store.web";

/** Read through the exact-origin browser session owner; never browser registry storage. */
export function loadAssetBearer(serverUrl: string): Promise<string | null> {
  return ensureValidToken(serverIdFromUrl(serverUrl), serverUrl);
}
