/**
 * M101 Phase 3 — subscribe to `nautilo://` deep links from the Electron main
 * process and route invite tokens into the workbench SPA.
 *
 * `reset-password` and `account` kinds are intentionally ignored here until
 * M101 later phases wire their flows.
 *
 * Testing: the workbench package uses `bun:test` without
 * `@testing-library/react`; there is no RTL harness for hook mount/unmount
 * yet. Parsing and argv extraction are covered in
 * `apps/desktop/tests/unit/auth/deep-link.test.ts`; add a renderer test when
 * RTL lands.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { desktopAPI, isDesktop } from "../lib/desktop";

export function useDeepLink(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    return desktopAPI.deepLink.onReceived((link) => {
      if (link.kind === "invite" && link.payload.token) {
        void navigate(`/invite/${encodeURIComponent(link.payload.token)}`);
      }
    });
  }, [navigate]);
}
