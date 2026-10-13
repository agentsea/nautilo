import { useCallback, useEffect, useRef, useState } from "react";
import type { BolterRoomLinkSummary } from "@nautilo/types";
import { useBolterStateReload } from "./use-bolter-state-reload";
import { apiClient } from "../lib/api";

/** A Room, viewer or credential change invalidates every pending display response. */
export function useBolterRoomState(roomId: string, scopeKey: string) {
  const [link, setLink] = useState<BolterRoomLinkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const epoch = useRef(0);
  const key = `${roomId}:${scopeKey}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const capture = useCallback(() => {
    const generation = epoch.current;
    const expectedKey = currentKey.current;
    const credentials = apiClient.getCredentialGeneration();
    return () => generation === epoch.current && currentKey.current === expectedKey
      && apiClient.getCredentialGeneration() === credentials;
  }, []);
  const reload = useBolterStateReload(async current => {
    setLoading(true); setError(null);
    try {
      const result = await apiClient.getBolterRoom(roomId);
      if (current()) { setLink(result.link); setLoadedKey(currentKey.current); }
    } catch {
      if (current()) { setLink(null); setLoadedKey(currentKey.current); setError("Could not check the Bolter room connection. Reload to try again."); }
    } finally { if (current()) setLoading(false); }
  }, capture);
  useEffect(() => {
    epoch.current += 1; setLink(null); setError(null); void reload();
    return () => { epoch.current += 1; };
  }, [key, reload]);
  return { link: loadedKey === key ? link : null, error: loadedKey === key ? error : null,
    loading: loadedKey !== key || loading, reload, capture };
}
