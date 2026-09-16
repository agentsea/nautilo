/**
 * M054 / M072 — Logto resource context.
 *
 * Carries the Logto access-token audience URL from `/health` (see
 * `main.tsx` bootstrap). Descendants read this instead of reaching for
 * window globals or re-fetching `/health`.
 *
 * Values are decided once at bootstrap and never change for the
 * component-tree lifetime.
 */
import { createContext, useContext } from "react";

export interface LogtoResourceConfig {
  /** Logto access-token audience (API resource indicator). */
  logtoResource: string;
  /** Logto tenant HTTP origin (Account Center, OIDC). */
  logtoEndpoint: string;
  /**
   * Canonical Workbench origins from `/health`. Used to build OIDC
   * redirects without drifting between localhost and 127.0.0.1.
   */
  redirectOrigins: readonly string[];
}

export const LogtoResourceContext = createContext<LogtoResourceConfig>({
  logtoResource: "https://api.nautilo.local",
  logtoEndpoint: "",
  redirectOrigins: [],
});

export function useLogtoResource(): LogtoResourceConfig {
  return useContext(LogtoResourceContext);
}
