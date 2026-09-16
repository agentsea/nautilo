import { createHash, randomBytes } from "node:crypto";

import {
  authorizeRailwayOAuth,
  RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT,
  RAILWAY_OAUTH_CLIENT_ID,
  RAILWAY_OAUTH_ISSUER,
  RAILWAY_OAUTH_MEMORY_SCOPES,
  RAILWAY_OAUTH_REDIRECT_URI,
  RAILWAY_OAUTH_TOKEN_ENDPOINT,
} from "@nautilo/railway-hosting";

let authorizationUrl: URL | undefined;
let callbackAccepted = false;
let tokenFormValidated = false;
const accessToken = randomBytes(32).toString("base64url");

const result = await authorizeRailwayOAuth({
  interactive: true,
  callbackTimeoutMs: 10_000,
  tokenTimeoutMs: 10_000,
  openBrowser: async (rawUrl) => {
    const url = new URL(rawUrl);
    if (
      url.origin + url.pathname !== RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT ||
      url.searchParams.get("client_id") !== RAILWAY_OAUTH_CLIENT_ID ||
      url.searchParams.get("redirect_uri") !== RAILWAY_OAUTH_REDIRECT_URI ||
      url.searchParams.get("scope") !== RAILWAY_OAUTH_MEMORY_SCOPES.join(" ") ||
      url.searchParams.get("prompt") !== "consent" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.has("client_secret") ||
      !url.searchParams.get("state") ||
      !url.searchParams.get("code_challenge")
    ) {
      throw new Error("authorization-contract");
    }
    authorizationUrl = url;
    const callback = new URL(RAILWAY_OAUTH_REDIRECT_URI);
    callback.searchParams.set("code", "qualification-code");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("iss", RAILWAY_OAUTH_ISSUER);
    const response = await fetch(callback);
    callbackAccepted = response.status === 200 && response.headers.get("cache-control") === "no-store";
    await response.arrayBuffer();
    if (!callbackAccepted) throw new Error("callback-contract");
  },
  fetch: async (input, init) => {
    if (String(input) !== RAILWAY_OAUTH_TOKEN_ENDPOINT || init?.method !== "POST") {
      throw new Error("token-endpoint-contract");
    }
    if (!(init.signal instanceof AbortSignal)) throw new Error("token-abort-contract");
    const form = new URLSearchParams(String(init.body));
    const verifier = form.get("code_verifier") ?? "";
    const expectedChallenge = authorizationUrl?.searchParams.get("code_challenge") ?? "";
    tokenFormValidated =
      form.get("grant_type") === "authorization_code" &&
      form.get("code") === "qualification-code" &&
      form.get("redirect_uri") === RAILWAY_OAUTH_REDIRECT_URI &&
      form.get("client_id") === RAILWAY_OAUTH_CLIENT_ID &&
      !form.has("client_secret") &&
      createHash("sha256").update(verifier).digest("base64url") === expectedChallenge;
    if (!tokenFormValidated) throw new Error("token-form-contract");
    return new Response(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: RAILWAY_OAUTH_MEMORY_SCOPES.join(" "),
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});

if (
  result.outcome !== "authorized" ||
  result.persistence !== "memory-only" ||
  authorizationUrl === undefined ||
  !callbackAccepted ||
  !tokenFormValidated ||
  JSON.stringify(result).includes(accessToken)
) {
  process.stderr.write("Standalone Railway OAuth loopback qualification failed.\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    fixedLoopbackCallback: true,
    pkceTokenFormValidated: true,
    browserBoundaryLocalOnly: true,
    tokenRedacted: true,
  })}\n`);
}
