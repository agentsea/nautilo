import BrowserLogtoClient, { Prompt, type SignInOptions } from "@logto/browser";

import {
  mobileWebCallbackCleanupUrl,
  ownsMobileWebCallback,
  sanitizeMobileWebReturnPath,
  type MobileWebAuthBootstrap,
} from "./browser-auth-contract";

export interface MobileWebLogtoSessionClient {
  isAuthenticated(): Promise<boolean>;
  isSignInRedirected(url: string): Promise<boolean>;
  handleSignInCallback(url: string): Promise<void>;
  signIn(options: SignInOptions): Promise<void>;
  signOut(postLogoutRedirectUri?: string): Promise<void>;
  clearAccessToken(): Promise<void>;
  clearAllTokens(): Promise<void>;
  getAccessToken(resource?: string): Promise<string>;
  getPendingPostRedirectUri(): Promise<string | null>;
}

export interface BrowserAuthLocation {
  readonly href: string;
  readonly origin: string;
}

export interface BrowserAuthHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type BrowserAuthInitialization =
  | "callback-complete"
  | "signed-in"
  | "signed-out";

export class MobileWebCallbackError extends Error {
  constructor(
    readonly code: "callback-not-owned" | "callback-session-missing" | "callback-failed",
    readonly returnPath: string | null = null,
  ) {
    super(code);
    this.name = "MobileWebCallbackError";
  }
}

export function mapLogtoEndSessionEndpointForMobileWeb(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/end_session")) {
      url.pathname = `${path.slice(0, -"/end_session".length)}/session/end`;
      return url.href;
    }
  } catch {
    // The SDK will report malformed discovery; never invent another endpoint.
  }
  return value;
}

export class NautiloMobileWebLogtoClient extends BrowserLogtoClient {
  constructor(config: MobileWebAuthBootstrap["logto"]) {
    super(config);
    const baseGetOidcConfig = this.getOidcConfig.bind(this);
    type MutableOidcGetter = { getOidcConfig: typeof baseGetOidcConfig };
    (this as MutableOidcGetter).getOidcConfig = async () => {
      const oidc = await baseGetOidcConfig();
      return {
        ...oidc,
        endSessionEndpoint: mapLogtoEndSessionEndpointForMobileWeb(oidc.endSessionEndpoint),
      };
    };
  }

  async getPendingPostRedirectUri(): Promise<string | null> {
    const session = await this.getSignInSession();
    return session?.postRedirectUri ?? null;
  }
}

/**
 * Owns the browser redirect ceremony around the SDK's state/PKCE/nonce checks.
 * The callback URL is captured and replaced before awaiting network exchange,
 * preventing secrets from surviving in address-bar history or error screens.
 */
export class MobileWebAuthSession {
  readonly #client: MobileWebLogtoSessionClient;
  readonly #bootstrap: MobileWebAuthBootstrap;
  readonly #location: BrowserAuthLocation;
  readonly #history: BrowserAuthHistory;
  #accessTokenInFlight: Promise<string | null> | null = null;
  #forcedAccessTokenInFlight: Promise<string | null> | null = null;

  constructor(input: Readonly<{
    client: MobileWebLogtoSessionClient;
    bootstrap: MobileWebAuthBootstrap;
    location: BrowserAuthLocation;
    history: BrowserAuthHistory;
  }>) {
    this.#client = input.client;
    this.#bootstrap = input.bootstrap;
    this.#location = input.location;
    this.#history = input.history;
  }

  async initialize(): Promise<BrowserAuthInitialization> {
    const callback = ownsMobileWebCallback(this.#location.href, this.#location.origin);
    if (!callback) return await this.#client.isAuthenticated() ? "signed-in" : "signed-out";

    const callbackUri = this.#location.href;
    const pendingPostRedirectUri = await this.#client.getPendingPostRedirectUri().catch(() => null);
    const returnPath = pendingPostRedirectUri
      ? sanitizeMobileWebReturnPath(pendingPostRedirectUri, this.#location.origin)
      : null;
    this.#history.replaceState(null, "", mobileWebCallbackCleanupUrl(this.#location.origin));
    let redirected: boolean;
    try {
      redirected = await this.#client.isSignInRedirected(callbackUri);
    } catch {
      throw new MobileWebCallbackError("callback-failed", returnPath);
    }
    if (!redirected) throw new MobileWebCallbackError("callback-session-missing", returnPath);
    try {
      await this.#client.handleSignInCallback(callbackUri);
      return "callback-complete";
    } catch {
      throw new MobileWebCallbackError("callback-failed", returnPath);
    }
  }

  async signIn(returnPath?: string | null): Promise<void> {
    const safePath = sanitizeMobileWebReturnPath(returnPath, this.#location.origin);
    await this.#client.signIn({
      redirectUri: this.#bootstrap.redirectUri,
      postRedirectUri: new URL(safePath, this.#location.origin).href,
      prompt: [Prompt.Login, Prompt.Consent],
    });
  }

  async signOut(): Promise<void> {
    this.#accessTokenInFlight = null;
    this.#forcedAccessTokenInFlight = null;
    await this.#client.signOut(this.#bootstrap.postLogoutRedirectUri);
  }

  isAuthenticated(): Promise<boolean> {
    return this.#client.isAuthenticated();
  }

  clearLocalSession(): Promise<void> {
    this.#accessTokenInFlight = null;
    this.#forcedAccessTokenInFlight = null;
    return this.#client.clearAllTokens();
  }

  getAccessToken(options: Readonly<{ forceRefresh?: boolean }> = {}): Promise<string | null> {
    if (options.forceRefresh) {
      if (this.#forcedAccessTokenInFlight) return this.#forcedAccessTokenInFlight;
      const request = (async () => {
        if (this.#accessTokenInFlight) await this.#accessTokenInFlight;
        if (!await this.#client.isAuthenticated()) return null;
        await this.#client.clearAccessToken();
        try {
          return await this.#client.getAccessToken(this.#bootstrap.resource);
        } catch {
          return null;
        }
      })();
      this.#forcedAccessTokenInFlight = request;
      return request.finally(() => {
        if (this.#forcedAccessTokenInFlight === request) this.#forcedAccessTokenInFlight = null;
      });
    }
    if (this.#forcedAccessTokenInFlight) return this.#forcedAccessTokenInFlight;
    if (this.#accessTokenInFlight) return this.#accessTokenInFlight;
    const request = (async () => {
      if (!await this.#client.isAuthenticated()) return null;
      try {
        return await this.#client.getAccessToken(this.#bootstrap.resource);
      } catch {
        return null;
      }
    })();
    this.#accessTokenInFlight = request;
    return request.finally(() => {
      if (this.#accessTokenInFlight === request) this.#accessTokenInFlight = null;
    });
  }
}
