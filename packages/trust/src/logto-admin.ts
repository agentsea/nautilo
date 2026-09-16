/**
 * M052 (Logto cluster) — Logto Management API client.
 *
 * Auth-pure surface. Wraps the M2M credentials provisioned by M051's
 * bootstrap (`LOGTO_M2M_APP_ID` / `LOGTO_M2M_APP_SECRET`) and the
 * default-tenant Management API at `${LOGTO_ENDPOINT}/api/...`.
 *
 * **Boundary (per `research/logto-integration-v1.md` §4.8 + the issue's
 * Risks bullet "Authorization stays in the Nautilo trust layer").**
 * This client exposes ONLY auth-pure methods:
 *
 *   - `getAccessToken`            (M2M token mint)
 *   - `isUserActive`              (revocation cache, account-exists probe)
 *   - `createUser`                (account creation)
 *   - `createPersonalAccessToken` (D112 Phase 6 — claim handoff → token exchange)
 *   - `setUserPassword`           (M053 — temp-password rotation)
 *   - `createOneTimeToken`             (M105 — magic-link sign-up / reset URL)
 *   - `verifyUserPassword`        (D104 — current-password check before change)
 *   - `getPasswordPolicy`         (D518 — read configured password policy)
 *   - `revokeUser`                (account lifecycle — soft suspend)
 *   - `deleteUser`                (account lifecycle — hard delete, M053)
 *   - `findUserByEmailOrUsername` (account lookup, M053)
 *   - `getUser`                   (account read, M053 verify-user-link)
 *   - `patchUser`                 (M107 — partial user update, e.g. `username`)
 *
 * It DELIBERATELY does NOT expose any organization-role / organization-
 * membership method. Roles, group membership, and capabilities live in
 * the Nautilo trust layer (`packages/trust/src/personal-policy-resolver.ts`
 * + the seeded `roles` / `role_capabilities` / `groups` tables in
 * `packages/db/src/utils/seed-trust-personal.ts`). M053 / M056 / the
 * future workbench invite UI use the `@nautilo/trust` queries for
 * membership work — they MUST NOT route through this client.
 *
 * The boundary is enforced by a unit test
 * (`logto-admin.test.ts > LogtoAdminClient surface > does NOT expose
 * authorization-bearing methods`).
 *
 * Reference: docs.logto.io/integrate-logto/interact-with-management-api
 */

const DEFAULT_TENANT_AUDIENCE = "https://default.logto.app/api";

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface LogtoApplicationsTokenResponse {
  access_token: string;
  expires_in: number;
}

interface LogtoUserResponse {
  id: string;
  isSuspended?: boolean;
  primaryEmail?: string | null;
  username?: string | null;
}

/**
 * Public read shape for {@link LogtoAdminClient.getUser}. Surfaces what
 * `verify-user-link` needs to render the diagnostic without leaking the
 * full Logto user payload (custom data, MFA factors, etc.).
 */
export interface LogtoUserDetails {
  id: string;
  isSuspended: boolean;
  primaryEmail: string | null;
  username: string | null;
}

/**
 * Raw Logto password-policy document. The policy is validated by Logto's
 * pinned `passwordPolicyGuard` at the enforcement boundary so malformed or
 * newly incompatible Management API responses fail closed.
 */
export type LogtoPasswordPolicyDocument = Record<string, unknown>;

export interface CreateUserArgs {
  username: string;
  primaryEmail?: string;
  name?: string;
  /**
   * If set, Logto stores the password directly. Most M052 callers will
   * leave this unset and use {@link generatePasswordResetUrl} instead so
   * the user picks their own password via Logto's flow.
   */
  password?: string;
}

export interface CreateOneTimeTokenArgs {
  /** Email the token is bound to. Required. */
  email: string;
  /** TTL in seconds. Default 600 (10 min); throws RangeError if > 86400 (24h). */
  expiresIn?: number;
  /**
   * Opaque context object Logto stores on the token and returns on verify.
   * Used to round-trip the Nautilo invite token through Logto-hosted sign-up.
   */
  context?: Record<string, unknown>;
}

export interface OneTimeToken {
  id: string;
  /** The secret to embed in URLs (returned ONCE by Logto). */
  token: string;
  expiresAt: Date;
  email: string;
}

/** Typed error for {@link LogtoAdminClient.createOneTimeToken}. */
export class LogtoOneTimeTokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "endpoint-missing" // 404 — Logto image too old
      | "m2m-auth-failed" // 401 — bootstrap creds bad
      | "bad-email" // 422 — Logto email validator rejected
      | "rate-limited" // 429
      | "unknown", // anything else
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LogtoOneTimeTokenError";
  }
}

const ONE_TIME_TOKEN_DEFAULT_TTL_SECONDS = 600;
const ONE_TIME_TOKEN_MAX_TTL_SECONDS = 86_400;

export class LogtoAdminClient {
  private cachedToken: CachedToken | null = null;

  /**
   * @param endpoint  `LOGTO_ENDPOINT` (e.g. `http://localhost:3301`)
   * @param appId     `LOGTO_M2M_APP_ID` (default-tenant M2M app id)
   * @param appSecret `LOGTO_M2M_APP_SECRET`
   */
  constructor(
    private readonly endpoint: string,
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Mint (or reuse) a Management API access token. Cached until ~1 min
   * before its `expires_in` runs out so a single client instance won't
   * re-handshake on every API call.
   *
   * `audience` selects the tenant — default-tenant Management API
   * (`https://default.logto.app/api`) is the only audience the M052
   * surface uses. Passed in to keep the method honest about its scope.
   */
  async getAccessToken(
    audience: string = DEFAULT_TENANT_AUDIENCE,
  ): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.value;
    }
    const credentials = Buffer.from(
      `${this.appId}:${this.appSecret}`,
    ).toString("base64");
    const res = await fetch(`${this.endpoint}/oidc/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: audience,
        scope: "all",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Logto M2M token failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as LogtoApplicationsTokenResponse;
    this.cachedToken = {
      value: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    };
    return json.access_token;
  }

  /**
   * True if the user exists in Logto and is not suspended.
   * Returns false on 404 (user removed) or 200+`isSuspended:true`.
   * Throws on other non-2xx status codes — the revocation cache fails
   * OPEN on those; see `logto-revocation-cache.ts`.
   */
  async isUserActive(sub: string): Promise<boolean> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(sub)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`Logto isUserActive failed: ${res.status}`);
    }
    const user = (await res.json()) as LogtoUserResponse;
    return !user.isSuspended;
  }

  /**
   * Creates a Logto user. Used by M053's data-migration tool to mint
   * Logto accounts for legacy PIN-mode users, and by the future
   * workbench invite UI when an owner invites a household member.
   *
   * Per playbook item 21 (M051): usernames must match `[A-Za-z0-9_]+`
   * — Logto rejects dashes with a Zod error. Caller is responsible for
   * normalizing.
   *
   * Returns the created user's id (Logto's `sub`). Throws on non-2xx.
   */
  async createUser(args: CreateUserArgs): Promise<{ id: string }> {
    const token = await this.getAccessToken();
    const body: Record<string, unknown> = { username: args.username };
    if (args.primaryEmail !== undefined) body["primaryEmail"] = args.primaryEmail;
    if (args.name !== undefined) body["name"] = args.name;
    if (args.password !== undefined) body["password"] = args.password;
    const res = await fetch(`${this.endpoint}/api/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logto createUser failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id: string };
    return { id: created.id };
  }

  /**
   * D112 Phase 6 — mint a short-lived PAT for a user, consumed immediately
   * by the legacy-named CLI app via RFC 8693 token exchange (see
   * `packages/server/src/lib/logto-bearer-session-after-trusted-auth.ts`
   * — D120 A1.6.2 renamed the helper from
   * `logto-claim-handoff-session` to reflect that both the redeem-claim
   * and password-login flows use it).
   *
   * @param userId Logto user id (`sub`) returned from {@link createUser}.
   */
  async createPersonalAccessToken(
    userId: string,
    args: { name: string; expiresAt?: number | null },
  ): Promise<{ value: string; name: string }> {
    const token = await this.getAccessToken();
    const body: Record<string, unknown> = { name: args.name };
    if (args.expiresAt !== undefined) {
      body["expiresAt"] = args.expiresAt;
    }
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}/personal-access-tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Logto createPersonalAccessToken failed: ${res.status} ${text}`,
      );
    }
    const created = (await res.json()) as {
      value: string;
      name: string;
    };
    return { value: created.value, name: created.name };
  }

  /**
   * M053 — set / rotate a Logto user's password.
   *
   * Backs the `migrate-to-logto` "temp password" flow: each freshly
   * minted Logto user gets a random one-time-use password the operator
   * prints in `claim-invitations.txt` and hands to that user out of
   * band. The user signs in once, then immediately rotates via Logto's
   * standard account-settings flow.
   *
   * Logto's REST surface is `PATCH /api/users/{id}/password` with body
   * `{ password: <plaintext> }`. The Management API hashes server-side
   * (Argon2id by default) and returns the public user object.
   *
   * Originally M052 had `generatePasswordResetUrl` pointed at
   * `POST /api/users/{id}/password-reset`, but Logto OSS does not
   * expose that endpoint (returns 404). The one-time-tokens API
   * (`POST /api/one-time-tokens`) is the documented magic-link
   * primitive but requires an SDK-aware landing page to redeem (M054).
   * Until M054 ships, the temp-password path is the only credential
   * provisioning flow that works end-to-end against vanilla Logto OSS.
   */
  async setUserPassword(userId: string, password: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}/password`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logto setUserPassword failed: ${res.status} ${text}`);
    }
  }

  /**
   * M105 — mint a single-use token bound to an email.
   *
   * Logto endpoint: `POST /api/one-time-tokens` (default-tenant Management API).
   * Free in OSS; does NOT require an email connector configured.
   *
   * Auth-pure: no role assignment, no group membership. Used by:
   *   - M101 ("Paste reset URL" flow)
   *   - M102 (CLI browser-mediated `/redeem` mode)
   *   - M103 (`reset-logto-user-password` rework + `nautilo-dev invite create`)
   *   - M104 (`/invite/<token>` wizard's `prepare-logto-signup` server route)
   *
   * Throws {@link LogtoOneTimeTokenError} on Logto-side failures (mapped by status).
   * Throws {@link RangeError} synchronously when `expiresIn` exceeds the 24h cap
   * (before any network call).
   */
  async createOneTimeToken(
    args: CreateOneTimeTokenArgs,
  ): Promise<OneTimeToken> {
    const expiresIn = args.expiresIn ?? ONE_TIME_TOKEN_DEFAULT_TTL_SECONDS;
    if (expiresIn > ONE_TIME_TOKEN_MAX_TTL_SECONDS) {
      throw new RangeError(
        `expiresIn ${expiresIn}s exceeds maximum ${ONE_TIME_TOKEN_MAX_TTL_SECONDS}s (24h)`,
      );
    }

    const token = await this.getAccessToken();
    const body: Record<string, unknown> = {
      email: args.email,
      expiresIn,
    };
    if (args.context !== undefined) body["context"] = args.context;

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/api/one-time-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken transport error: ${e instanceof Error ? e.message : String(e)}`,
        "unknown",
        e,
      );
    }

    if (res.status === 404) {
      const text = await safeText(res);
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken 404: endpoint missing (image too old?) ${text}`,
        "endpoint-missing",
      );
    }
    if (res.status === 401) {
      const text = await safeText(res);
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken 401: M2M auth failed ${text}`,
        "m2m-auth-failed",
      );
    }
    if (res.status === 422) {
      const text = await safeText(res);
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken 422: bad email ${text}`,
        "bad-email",
      );
    }
    if (res.status === 429) {
      const text = await safeText(res);
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken 429: rate limited ${text}`,
        "rate-limited",
      );
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new LogtoOneTimeTokenError(
        `Logto createOneTimeToken failed: ${res.status} ${text}`,
        "unknown",
      );
    }

    const json = (await res.json()) as {
      id: string;
      token: string;
      expiresAt: number | string;
      email: string;
    };

    const expiresAtMs =
      typeof json.expiresAt === "number"
        ? json.expiresAt
        : Date.parse(json.expiresAt);

    return {
      id: json.id,
      token: json.token,
      expiresAt: new Date(expiresAtMs),
      email: json.email,
    };
  }

  /**
   * D104 — checks whether `password` matches the user's Logto password.
   *
   * Logto OSS: `POST /api/users/{userId}/password/verify` with body
   * `{ password }`. **204** = match, **422** = no match. Other status
   * codes throw (caller maps to 502 / generic failure).
   */
  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}/password/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      },
    );
    if (res.status === 204) return true;
    if (res.status === 422) return false;
    const text = await res.text();
    throw new Error(`Logto verifyUserPassword failed: ${res.status} ${text}`);
  }

  /**
   * D518 — read the default tenant's configured password policy before a
   * password mutation. This remains auth-pure: it exposes identity-provider
   * policy, not Nautilo roles, groups, or capabilities.
   */
  async getPasswordPolicy(): Promise<LogtoPasswordPolicyDocument> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.endpoint}/api/sign-in-exp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Logto getPasswordPolicy failed: ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const policy = body["passwordPolicy"];
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error("Logto getPasswordPolicy returned an invalid response");
    }
    return policy as LogtoPasswordPolicyDocument;
  }

  /**
   * Marks a user as suspended in Logto. Suspension takes effect within
   * the revocation-cache TTL (60s, see `logto-revocation-cache.ts`).
   *
   * Logto's REST surface is `PATCH /api/users/{id}/is-suspended`
   * with body `{ isSuspended: true }`.
   */
  async revokeUser(userId: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}/is-suspended`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isSuspended: true }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logto revokeUser failed: ${res.status} ${text}`);
    }
  }

  /**
   * M053: hard-delete a Logto user via `DELETE /api/users/{id}`.
   *
   * Distinct from {@link revokeUser}: revoke flips `isSuspended` (M052
   * needs that to be reversible for the runtime revocation cache);
   * delete actually removes the row. `migrate-from-logto
   * --delete-logto-users` calls this when the operator wants a clean
   * slate. Stays auth-pure (account lifecycle, same family as
   * `revokeUser` and `createUser`).
   */
  async deleteUser(userId: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    // 404 = already gone; treat as success so retries are safe.
    if (res.status === 404) return;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logto deleteUser failed: ${res.status} ${text}`);
    }
  }

  /**
   * M053: identity-only lookup. Returns the first Logto user whose
   * `primaryEmail` exactly matches `email`, or — if no email match —
   * whose `username` exactly matches `username`. Returns null if neither
   * search produces an exact hit.
   *
   * Logto's `GET /api/users?search=...&searchFields[]=...` is fuzzy
   * (substring `LIKE %term%`), so the response is filtered client-side
   * for an exact match. Same pattern that `bin/nautilo-local/src/
   * bootstrap-logto.ts` uses for its admin-user lookup.
   *
   * Used by `migrate-to-logto` so a re-run after partial failure
   * (or after `migrate-from-logto`) attaches the existing Logto sub
   * instead of minting a duplicate account.
   */
  async findUserByEmailOrUsername(
    email: string | null | undefined,
    username: string | null | undefined,
  ): Promise<LogtoUserDetails | null> {
    if (email && email.length > 0) {
      const hit = await this.searchUsersExact(
        email,
        (u) => u.primaryEmail === email,
      );
      if (hit) return hit;
    }
    if (username && username.length > 0) {
      const hit = await this.searchUsersExact(
        username,
        (u) => u.username === username,
      );
      if (hit) return hit;
    }
    return null;
  }

  /**
   * M053: read-only details on a known Logto user. Returns null on 404
   * (orphan / already-deleted). Throws on other non-2xx so callers can
   * distinguish "doesn't exist" from "couldn't reach Logto".
   *
   * Wider surface than {@link isUserActive} (which collapses
   * everything into a single boolean). Used by `verify-user-link` to
   * render the join state for a single Nautilo↔Logto pairing.
   */
  async getUser(userId: string): Promise<LogtoUserDetails | null> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logto getUser failed: ${res.status} ${text}`);
    }
    const u = (await res.json()) as LogtoUserResponse;
    return toLogtoUserDetails(u);
  }

  /**
   * M107 — `PATCH /api/users/{id}` with a partial body (e.g. `{ username }`).
   * Returns the HTTP status so callers can treat **409** as a Logto-side
   * uniqueness collision without treating other failures as conflicts.
   */
  async patchUser(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<number> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.endpoint}/api/users/${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    return res.status;
  }

  /**
   * Logto v1.x rejects `search=<term>&searchFields[]=<field>` with a 400
   * ("Only one search value is allowed when search mode is not
   * `exact`") unless `mode=exact` is also set. To stay compatible with
   * the bootstrap-logto pattern (and avoid the mode-vs-fields footgun)
   * we issue the broad `?search=<term>` query and filter the response
   * client-side for an exact match — the same way
   * `bin/nautilo-local/src/bootstrap-logto.ts` does its admin-user
   * lookup. Fuzzy matches across other fields are dropped by the
   * predicate.
   */
  private async searchUsersExact(
    term: string,
    predicate: (u: LogtoUserResponse) => boolean,
  ): Promise<LogtoUserDetails | null> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.endpoint}/api/users`);
    url.searchParams.set("search", term);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Logto findUserByEmailOrUsername failed: ${res.status} ${text}`,
      );
    }
    const list = (await res.json()) as LogtoUserResponse[];
    const exact = list.find(predicate);
    return exact ? toLogtoUserDetails(exact) : null;
  }
}

function toLogtoUserDetails(u: LogtoUserResponse): LogtoUserDetails {
  return {
    id: u.id,
    isSuspended: Boolean(u.isSuspended),
    primaryEmail: u.primaryEmail ?? null,
    username: u.username ?? null,
  };
}

// ---------------------------------------------------------------------------
// M120 — ensure a Logto-linked user has a primaryEmail for the native
// ForgotPassword email-code flow (synthetic `<handle>@host` backfill).
// ---------------------------------------------------------------------------

export interface EnsurePrimaryEmailArgs {
  /** Logto user id (`users.external_id`). */
  userId: string;
  /** Local handle, used to synthesize `<handle>@<host>` when no email exists. */
  handle: string;
  /** Synthetic email host; defaults to `nautilo.local` (invite/mint-user parity). */
  syntheticEmailHost?: string;
}

/**
 * Return the user's `primaryEmail`, synthesizing `<handle>@<host>` via
 * `patchUser` when missing. Exported standalone (not a class method) so the
 * synthesis policy stays out of other call sites and tests can pass a shaped
 * mock. Throws if the user is missing or the patch fails.
 */
export async function ensureLogtoPrimaryEmail(
  admin: Pick<LogtoAdminClient, "getUser" | "patchUser">,
  args: EnsurePrimaryEmailArgs,
): Promise<{ email: string; synthesized: boolean }> {
  const user = await admin.getUser(args.userId);
  if (!user) {
    throw new Error(`logto user ${args.userId} not found`);
  }
  if (user.primaryEmail && user.primaryEmail.length > 0) {
    return { email: user.primaryEmail, synthesized: false };
  }
  const host = (args.syntheticEmailHost ?? "nautilo.local").trim() || "nautilo.local";
  const email = `${args.handle}@${host}`;
  const status = await admin.patchUser(args.userId, { primaryEmail: email });
  if (status >= 400) {
    throw new Error(`logto patchUser primaryEmail failed: ${status}`);
  }
  return { email, synthesized: true };
}

// ---------------------------------------------------------------------------
// Singleton + test seam
// ---------------------------------------------------------------------------

let singleton: LogtoAdminClient | null = null;

/**
 * Returns the process-wide `LogtoAdminClient`. Throws if any of the
 * three required env vars are missing — only call from code paths
 * where Logto-backed admin APIs are expected to run.
 */
export function getLogtoAdminClient(): LogtoAdminClient {
  if (singleton) return singleton;
  // M092 — prefer `LOGTO_ENDPOINT_INTERNAL` for the server's
  // request-path calls to Logto's Management API. The deploy stack
  // sets it to `http://logto:<corePort>` (container DNS) while
  // `LOGTO_ENDPOINT` stays host-facing for workbench/desktop. Falls
  // back to `LOGTO_ENDPOINT` for host-mode (`bun run server`) where
  // both audiences share one URL.
  const endpoint =
    process.env["LOGTO_ENDPOINT_INTERNAL"] ?? process.env["LOGTO_ENDPOINT"];
  const appId = process.env["LOGTO_M2M_APP_ID"];
  const appSecret = process.env["LOGTO_M2M_APP_SECRET"];
  if (!endpoint || !appId || !appSecret) {
    throw new Error(
      "LOGTO_ENDPOINT / LOGTO_M2M_APP_ID / LOGTO_M2M_APP_SECRET required",
    );
  }
  singleton = new LogtoAdminClient(endpoint, appId, appSecret);
  return singleton;
}

/** Test-only: resets the singleton + cached token state. */
export function _resetLogtoAdminClientForTests(): void {
  singleton = null;
}

/**
 * Test-only: inject a (usually stubbed) admin client so integration
 * fixtures can exercise Management-API code paths without real
 * `LOGTO_M2M_APP_ID` / `LOGTO_M2M_APP_SECRET` credentials or a live
 * Logto. `getLogtoAdminClient()` returns the injected singleton before
 * the env-var check, so this fully bypasses the credential requirement.
 */
export function _setLogtoAdminClientForTests(client: LogtoAdminClient): void {
  singleton = client;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
