import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isFullWidthManagementRoute } from "./is-full-width-management-route";

/** Keep the editor mounted while a management route waits for its leave guard.
 * This covers rail, account/menu navigation and browser history equally. */
export function useMiniAppRouteGuard(
  appActive: boolean,
  requestLeave: (leave: () => void, stay?: () => void) => void,
): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const previousRoute = useRef("/");
  const [acceptedKey, setAcceptedKey] = useState<string | null>(null);
  const management = isFullWidthManagementRoute(location.pathname);
  const waiting = appActive && management && acceptedKey !== location.key;

  useEffect(() => {
    if (!management) {
      previousRoute.current = location.pathname + location.search + location.hash;
      setAcceptedKey(null);
    }
  }, [management, location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!waiting) return;
    let current = true;
    const returnTo = previousRoute.current;
    requestLeave(
      () => { if (current) setAcceptedKey(location.key); },
      () => { if (current) void navigate(returnTo, { replace: true }); },
    );
    return () => { current = false; };
  }, [waiting, location.key, navigate, requestLeave]);

  return waiting;
}
