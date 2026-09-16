import { createHash, randomBytes } from "node:crypto";
import { resolveInstance } from "@nautilo/config";
import type { LogtoAdminClient } from "@nautilo/trust";
import { db, users, eq, and, isNull } from "@nautilo/db";
import {
  ensureLogtoPrimaryEmail,
  findMatchingUnusedLogtoAccountRecoveryCode,
} from "@nautilo/trust";
import { createRecoverySession } from "./logto-recovery-session";

export type OpenRecoverySessionResult =
  | {
      outcome: "success";
      sessionId: string;
      sessionToken: string;
      resetUrl: string;
      email: string;
    }
  | { outcome: "reject" }
  | { outcome: "logto_unavailable" };

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function resolveRecoveryRedirectBase(
  env: NodeJS.ProcessEnv,
  fallbackServerUrl: string,
): string {
  return (
    env["NAUTILO_PUBLIC_BASE_URL"]?.trim() ||
    env["NAUTILO_SERVER_URL"]?.trim() ||
    fallbackServerUrl
  );
}

export function buildResetPasswordAuthorizeUrl(args: {
  logtoEndpoint: string;
  email: string;
}): string {
  const clientId = process.env["LOGTO_WORKBENCH_APP_ID"]?.trim();
  if (!clientId) {
    throw new Error("LOGTO_WORKBENCH_APP_ID is required for reset-password flow");
  }
  const redirectBase = resolveRecoveryRedirectBase(
    process.env,
    resolveInstance().server.url,
  );
  const redirectUri = new URL("/auth/callback", redirectBase).toString();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const url = new URL("/oidc/auth", args.logtoEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("state", base64Url(randomBytes(24)));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("first_screen", "reset_password");
  url.searchParams.set("identifier", "email");
  url.searchParams.set("login_hint", args.email);
  return url.toString();
}

/**
 * M120 — validate a Logto-account recovery code by handle, ensure the
 * Logto user has a `primaryEmail` (synthetic `<handle>@nautilo.local`
 * backfill), and open a short-lived recovery session that authorizes the
 * caller to receive the Logto ForgotPassword verification code relayed
 * through the HTTP Email connector.
 *
 * Nautilo never sees the new password: this function only proves the
 * recovery code and returns the Logto hosted reset URL + a session token.
 * The new password is set entirely inside Logto's hosted page.
 *
 * Lookup is by `users.handle` scoped to `server IS NULL` so foreign-stub
 * rows can never be a recovery target. The recovery code is verified here
 * but is not burned until the relay code is delivered to the client.
 */
export async function openLogtoRecoverySession(args: {
  handle: string;
  recoveryCode: string;
  admin: Pick<LogtoAdminClient, "getUser" | "patchUser">;
  logtoEndpoint: string;
  syntheticEmailHost?: string;
}): Promise<OpenRecoverySessionResult> {
  const [user] = await db
    .select({
      id: users.id,
      externalId: users.externalId,
      handle: users.handle,
      server: users.server,
    })
    .from(users)
    .where(and(eq(users.handle, args.handle), isNull(users.server)))
    .limit(1);

  if (!user) {
    return { outcome: "reject" };
  }

  const linked = user.externalId !== null && user.externalId.length > 0;
  if (!linked) {
    return { outcome: "reject" };
  }

  const rowId = await findMatchingUnusedLogtoAccountRecoveryCode(
    user.id,
    args.recoveryCode.trim(),
  );
  if (!rowId) {
    return { outcome: "reject" };
  }

  let email: string;
  try {
    const ensured = await ensureLogtoPrimaryEmail(args.admin, {
      userId: user.externalId!,
      handle: user.handle ?? args.handle,
      ...(args.syntheticEmailHost
        ? { syntheticEmailHost: args.syntheticEmailHost }
        : {}),
    });
    email = ensured.email;
  } catch {
    return { outcome: "logto_unavailable" };
  }

  const session = createRecoverySession({
    userId: user.id,
    syntheticEmail: email,
    recoveryCodeRowId: rowId,
  });

  let resetUrl: string;
  try {
    resetUrl = buildResetPasswordAuthorizeUrl({
      logtoEndpoint: args.logtoEndpoint,
      email,
    });
  } catch {
    return { outcome: "logto_unavailable" };
  }

  return {
    outcome: "success",
    sessionId: session.id,
    sessionToken: session.sessionToken,
    resetUrl,
    email,
  };
}
