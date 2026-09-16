import { createContext } from "react";

/** The admission gate owns this host outside the inert product subtree.
 * Only connection status, recovery actions, and the connection toast render here;
 * product overlays remain inside WorkbenchPortalProvider's protected host. */
export const ConnectionRecoveryPortalContext = createContext<HTMLElement | null>(null);
