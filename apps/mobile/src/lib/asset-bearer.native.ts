import { loadTokens, serverIdFromUrl } from "@/lib/server-store";

/** Preserve the accepted native SecureStore-backed asset authorization path. */
export async function loadAssetBearer(serverUrl: string): Promise<string | null> {
  return (await loadTokens(serverIdFromUrl(serverUrl)))?.accessToken ?? null;
}
