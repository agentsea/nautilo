import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CommandListItem } from "@nautilo/api-client/browser";

import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { commandCatalogueScope, CommandCatalogueRequestGate } from "./command-catalogue-gate";
import {
  commandCatalogueRevision,
  subscribeCommandCatalogue,
} from "./command-catalogue-events";

export type CommandCatalogueState = {
  commands: readonly CommandListItem[];
  loading: boolean;
  error: boolean;
};

/**
 * Load the canonical catalogue through the authenticated shared API client.
 * No catalogue is retained across server switches: commands are speaker and
 * server scoped, so showing the prior server's entries would be misleading.
 */
export function useCommandCatalogue(serverUrl: string | undefined): CommandCatalogueState & {
  retry: () => void;
} {
  const { status, viewer, viewerState } = useAuth();
  const [state, setState] = useState<CommandCatalogueState>({
    commands: [],
    loading: false,
    error: false,
  });
  const [retryRevision, setRetryRevision] = useState(0);
  const catalogueRevision = useSyncExternalStore(
    subscribeCommandCatalogue,
    commandCatalogueRevision,
    commandCatalogueRevision,
  );
  const gate = useRef(new CommandCatalogueRequestGate()).current;
  const scope = commandCatalogueScope(serverUrl, {
    status,
    viewerState,
    viewer: viewer && viewerState === "verified" ? viewer : null,
  });

  useEffect(() => {
    const requestRevision = gate.begin();
    if (!scope || !serverUrl) {
      setState({ commands: [], loading: false, error: false });
      return;
    }

    setState({ commands: [], loading: true, error: false });
    void getApiClient(serverUrl)
      .getCommands()
      .then((response) => {
        if (!gate.isCurrent(requestRevision)) return;
        setState({ commands: response.commands, loading: false, error: false });
      })
      .catch(() => {
        if (!gate.isCurrent(requestRevision)) return;
        setState({ commands: [], loading: false, error: true });
      });
    // React may retain this shared composer while the AuthProvider changes.
    // Invalidate the callback before unmount or scope replacement so a slow
    // prior session can never call setState or repopulate the picker.
    return () => {
      if (gate.isCurrent(requestRevision)) gate.begin();
    };
  }, [catalogueRevision, gate, retryRevision, scope, serverUrl]);

  const retry = useCallback(() => setRetryRevision((revision) => revision + 1), []);
  return { ...state, retry };
}
