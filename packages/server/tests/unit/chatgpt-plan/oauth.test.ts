import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  CHATGPT_ISSUER, CHATGPT_RESOURCE, ChatGPTOAuth, createChatGPTAuthorization,
  parseChatGPTCallback, type ChatGPTSession,
} from "../../../src/lib/chatgpt-plan/oauth";

const now = 1_800_000_000_000;
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const clientId = "oaiapp_fixture_registration";
const subject = "synthetic-subject";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
const verificationKey = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] });
const signal = new AbortController().signal;
function authorization() { return createChatGPTAuthorization({ hostId, port: 54321 }); }
function callback(attempt: ReturnType<typeof authorization>["attempt"], additions = {}) {
  const url = new URL(attempt.redirectUri);
  url.search = new URLSearchParams({ state: attempt.state, code: "synthetic-code", client_id: clientId, ...additions }).toString();
  return url;
}
async function idToken(nonce: string, claims: Record<string, unknown> = {}) {
  return new SignJWT({ nonce, ...claims }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(CHATGPT_ISSUER).setAudience(clientId).setSubject(subject)
    .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 3600).sign(privateKey);
}
async function tokenResponse(nonce: string, changes: Record<string, unknown> = {}) {
  return { access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: await idToken(nonce),
    token_type: "Bearer", expires_in: 3600,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", ...changes };
}

describe("ChatGPT public-client authorization", () => {
  test("dynamic registration has independent entropy, S256 and exact loopback URI", () => {
    const { attempt, url } = authorization(); const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("Nautilo");
    expect(q.get("resource")).toBe(CHATGPT_RESOURCE);
    expect(q.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(attempt.verifier).digest("base64url"));
    expect(new Set([attempt.state, attempt.nonce, attempt.verifier]).size).toBe(3);
    expect(authorization().attempt.state).not.toBe(attempt.state);
  });
  test("returning registration reuses client and host without secret URL hints", () => {
    const { url } = createChatGPTAuthorization({ hostId, port: 54322,
      registration: { issuer: CHATGPT_ISSUER, subject, clientId, hostId, email: "test@example.com" } });
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe(clientId);
    expect(q.has("agent_name_hint")).toBe(false);
    expect(q.has("id_token_hint")).toBe(false);
    expect(q.has("login_hint")).toBe(false);
  });
  test("rejects callback state, endpoint, duplicate parameters and missing issued ID", () => {
    const { attempt } = authorization();
    for (const changes of [{ state: "wrong" }, { client_id: "" }, { client_id: "dynamic_agent_client" }]) {
      expect(() => parseChatGPTCallback(attempt, callback(attempt, changes))).toThrow();
    }
    const duplicate = callback(attempt); duplicate.searchParams.append("state", attempt.state);
    expect(() => parseChatGPTCallback(attempt, duplicate)).toThrow("authorization_invalid");
    const elsewhere = callback(attempt); elsewhere.hostname = "localhost";
    expect(() => parseChatGPTCallback(attempt, elsewhere)).toThrow("authorization_invalid");
    const denied = callback(attempt, { error: "access_denied" });
    expect(() => parseChatGPTCallback(attempt, denied)).toThrow("authorization_denied");
  });
  test("returning callbacks may omit client ID but cannot replace it", () => {
    const { attempt } = createChatGPTAuthorization({ hostId, port: 54321,
      registration: { issuer: CHATGPT_ISSUER, subject, clientId, hostId } });
    const url = callback(attempt); url.searchParams.delete("client_id");
    expect(parseChatGPTCallback(attempt, url).clientId).toBe(clientId);
    expect(() => parseChatGPTCallback(attempt, callback(attempt, { client_id: "another-client" }))).toThrow("identity_invalid");
  });
});

describe("ChatGPT token validation", () => {
  test("exchanges issued client ID and accepts only verified account/scopes", async () => {
    const { attempt } = authorization(); let form: URLSearchParams | undefined;
    const oauth = new ChatGPTOAuth({ verificationKey, now: () => now, fetch: async (url, init) => {
      expect(String(url)).toBe(`${CHATGPT_ISSUER}/api/accounts/oauth/token`);
      expect(init?.redirect).toBe("error");
      form = init?.body as URLSearchParams;
      return Response.json(await tokenResponse(attempt.nonce));
    } });
    const session = await oauth.exchange(attempt, callback(attempt), signal);
    expect(form!.get("client_id")).toBe(clientId);
    expect(form!.get("code_verifier")).toBe(attempt.verifier);
    expect(form!.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(form!.has("client_secret")).toBe(false);
    expect(session.identity.subject).toBe(subject);
    expect(session.expiresAt).toBe(now + 3_600_000);
  });
  test("rejects a signed token with the wrong nonce or missing plan scope", async () => {
    for (const changes of [{ id_token: await idToken("wrong") }, { scope: "openid profile email" }]) {
      const { attempt } = authorization();
      const oauth = new ChatGPTOAuth({ verificationKey, now: () => now,
        fetch: async () => Response.json(await tokenResponse(attempt.nonce, changes)) });
      await assertRejects(oauth.exchange(attempt, callback(attempt), signal));
    }
  });
  test("rejects wrong issuer, audience, expiry, subject and signing key", async () => {
    const { attempt } = authorization();
    const other = await generateKeyPair("RS256");
    const cases = [
      new SignJWT({ nonce: attempt.nonce }).setIssuer("https://example.com").setAudience(clientId).setSubject(subject).setExpirationTime(now / 1000 + 3600),
      new SignJWT({ nonce: attempt.nonce }).setIssuer(CHATGPT_ISSUER).setAudience("other-client").setSubject(subject).setExpirationTime(now / 1000 + 3600),
      new SignJWT({ nonce: attempt.nonce }).setIssuer(CHATGPT_ISSUER).setAudience(clientId).setSubject(subject).setExpirationTime(now / 1000 - 1),
      new SignJWT({ nonce: attempt.nonce }).setIssuer(CHATGPT_ISSUER).setAudience(clientId).setExpirationTime(now / 1000 + 3600),
    ];
    const invalidTokens = await Promise.all(cases.map(t => t.setIssuedAt(now / 1000).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(privateKey)));
    invalidTokens.push(await new SignJWT({ nonce: attempt.nonce }).setIssuer(CHATGPT_ISSUER).setAudience(clientId).setSubject(subject)
      .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 3600).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(other.privateKey));
    for (const invalid of invalidTokens) {
      const oauth = new ChatGPTOAuth({ verificationKey, now: () => now,
        fetch: async () => Response.json(await tokenResponse(attempt.nonce, { id_token: invalid })) });
      await assertRejects(oauth.exchange(attempt, callback(attempt), signal), "identity_invalid");
    }
  });
  test("refuses a different verified Human on reauthorization", async () => {
    const { attempt } = createChatGPTAuthorization({ hostId, port: 54321,
      registration: { issuer: CHATGPT_ISSUER, subject: "different-synthetic-subject", clientId, hostId } });
    const oauth = new ChatGPTOAuth({ verificationKey, now: () => now,
      fetch: async () => Response.json(await tokenResponse(attempt.nonce)) });
    await assertRejects(oauth.exchange(attempt, callback(attempt), signal), "identity_invalid");
  });
  test("refresh uses its own registration, rotates credentials and retains omitted scope/ID token", async () => {
    const previous: ChatGPTSession = { identity: { issuer: CHATGPT_ISSUER, subject, clientId, hostId },
      accessToken: "synthetic-old-access", refreshToken: "synthetic-old-refresh", idToken: "synthetic-retained-id",
      scopes: ["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"], expiresAt: now, receivedAt: now - 3_600_000 };
    const oauth = new ChatGPTOAuth({ verificationKey, now: () => now, fetch: async (_url, init) => {
      const form = init?.body as URLSearchParams;
      expect(form.get("client_id")).toBe(clientId); expect(form.has("scope")).toBe(false);
      expect(form.get("refresh_token")).toBe(previous.refreshToken);
      return Response.json({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", token_type: "Bearer", expires_in: 3600 });
    } });
    const renewed = await oauth.refresh(previous, signal);
    expect(renewed.refreshToken).toBe("synthetic-new-refresh");
    expect(renewed.idToken).toBe(previous.idToken);
    expect(renewed.identity).toEqual(previous.identity);
  });
  test("provider failures do not leak response bodies or transport exceptions", async () => {
    const { attempt } = authorization();
    for (const fetcher of [async () => { throw new Error("synthetic-private-value"); },
      async () => Response.json({ error: "invalid_grant", details: "synthetic-private-value" }, { status: 400 })]) {
      const oauth = new ChatGPTOAuth({ verificationKey, fetch: fetcher });
      try { await oauth.exchange(attempt, callback(attempt), signal); throw new Error("Expected failure"); }
      catch (error) { expect(String(error)).not.toContain("synthetic-private-value"); }
    }
  });
});

async function assertRejects(promise: Promise<unknown>, message?: string): Promise<void> {
  let rejection: unknown;
  try { await promise; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  if (message) expect(String(rejection)).toContain(message);
}
