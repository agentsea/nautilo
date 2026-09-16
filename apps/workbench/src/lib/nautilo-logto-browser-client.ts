import BrowserLogtoClient from "@logto/browser";
import type { LogtoConfig } from "@logto/browser";

/**
 * Logto OSS still exposes the OIDC discovery `end_session_endpoint`
 * (`…/oidc/end_session`), but the supported browser RP-initiated logout UX
 * is `…/oidc/session/end` (see Logto docs: end-user sign-out). The stock
 * `@logto/browser` client navigates to the discovery URL with GET, which
 * newer cores reject with `invalid_request`.
 */
export function mapLogtoEndSessionEndpointForBrowser(endSessionEndpoint: string): string {
  try {
    const u = new URL(endSessionEndpoint);
    const normalized = u.pathname.replace(/\/+$/, "");
    if (normalized.endsWith("/end_session")) {
      u.pathname = `${normalized.slice(0, -"/end_session".length)}/session/end`;
      return u.href;
    }
  } catch {
    // Malformed URL — fall through and return the original string.
  }
  return endSessionEndpoint;
}

export class NautiloWorkbenchLogtoClient extends BrowserLogtoClient {
  constructor(config: LogtoConfig, unstable_enableCache?: boolean) {
    super(config, unstable_enableCache);
    const baseGetOidcConfig = this.getOidcConfig.bind(this);
    type MutableOidcGetter = { getOidcConfig: typeof baseGetOidcConfig };
    (this as MutableOidcGetter).getOidcConfig = async () => {
      const oidc = await baseGetOidcConfig();
      return {
        ...oidc,
        endSessionEndpoint: mapLogtoEndSessionEndpointForBrowser(oidc.endSessionEndpoint),
      };
    };
  }
}
