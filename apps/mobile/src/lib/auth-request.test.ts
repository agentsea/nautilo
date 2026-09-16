import { describe, expect, test } from "bun:test";

import {
  authFailureMessage,
  classifyAuthPromptResult,
  createNativeCodeExchangeParameters,
  createNativeAuthRequestParameters,
  NativeAuthError,
  type NativeAuthMode,
} from "./auth-request";

const baseConfig = {
  clientId: "native-client",
  redirectUri: "nautilo://callback",
  resource: "https://api.example.test",
} as const;

describe("createNativeAuthRequestParameters", () => {
  test("keeps ordinary sign-in's PKCE, scopes, prompt, and resource contract", () => {
    expect(createNativeAuthRequestParameters(baseConfig)).toEqual({
      clientId: "native-client",
      redirectUri: "nautilo://callback",
      scopes: ["openid", "profile", "offline_access"],
      usePKCE: true,
      extraParams: {
        prompt: "login consent",
        resource: "https://api.example.test",
      },
    });
  });

  test("registration only adds canonical Logto registration parameters", () => {
    const mode: NativeAuthMode = {
      kind: "invite-registration",
      loginHint: "  MARIA_7  ",
    };

    expect(createNativeAuthRequestParameters(baseConfig, mode).extraParams).toEqual({
      prompt: "consent",
      resource: "https://api.example.test",
      first_screen: "register",
      login_hint: "maria_7",
    });
  });

  test("omits resource and an absent or invalid registration hint", () => {
    expect(
      createNativeAuthRequestParameters(
        { ...baseConfig, resource: null },
        { kind: "invite-registration" },
      ).extraParams,
    ).toEqual({ prompt: "consent", first_screen: "register" });

    expect(
      createNativeAuthRequestParameters(baseConfig, {
        kind: "invite-registration",
        loginHint: "not a valid handle",
      }).extraParams,
    ).toEqual({
      prompt: "consent",
      resource: "https://api.example.test",
      first_screen: "register",
    });
  });

  test("keeps the code exchange resource contract, with no registration-only parameters", () => {
    expect(
      createNativeCodeExchangeParameters({
        ...baseConfig,
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
      }),
    ).toEqual({
      clientId: "native-client",
      code: "authorization-code",
      redirectUri: "nautilo://callback",
      extraParams: {
        code_verifier: "pkce-verifier",
        resource: "https://api.example.test",
      },
    });
    expect(
      createNativeCodeExchangeParameters({
        ...baseConfig,
        resource: null,
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
      }).extraParams,
    ).toEqual({ code_verifier: "pkce-verifier" });
  });

  test("does not accept ceremony secrets in its typed option surface", () => {
    const option: NativeAuthMode = { kind: "invite-registration", loginHint: "maria_7" };
    expect(Object.keys(option).sort()).toEqual(["kind", "loginHint"]);
    expect(JSON.stringify(createNativeAuthRequestParameters(baseConfig, option))).not.toContain("inviteToken");
    expect(JSON.stringify(createNativeAuthRequestParameters(baseConfig, option))).not.toContain("prepareState");
    expect(JSON.stringify(createNativeAuthRequestParameters(baseConfig, option))).not.toContain("recoveryCode");
  });
});

describe("classifyAuthPromptResult", () => {
  test("classifies cancellation and modal dismissal without provider text", () => {
    expect(classifyAuthPromptResult({ type: "cancel" })).toEqual({ kind: "failure", code: "cancelled" });
    expect(classifyAuthPromptResult({ type: "dismiss" })).toEqual({ kind: "failure", code: "cancelled" });
    expect(authFailureMessage("cancelled")).toBe("Sign-in cancelled");
  });

  test("classifies callback errors and missing authorization code safely", () => {
    expect(
      classifyAuthPromptResult({
        type: "error",
        params: {},
        error: { message: "provider-only diagnostic" },
      }),
    ).toEqual({ kind: "failure", code: "callback-error" });
    expect(classifyAuthPromptResult({ type: "success", params: {} })).toEqual({
      kind: "failure",
      code: "missing-authorization-code",
    });
  });

  test("returns only a non-empty authorization code after success", () => {
    expect(classifyAuthPromptResult({ type: "success", params: { code: "auth-code" } })).toEqual({
      kind: "authorization-code",
      code: "auth-code",
    });
  });

  test("keeps missing config and exchange failures typed and provider-text-free", () => {
    const missingConfig = new NativeAuthError("missing-logto-config");
    const exchange = new NativeAuthError("exchange-failed");
    expect(missingConfig.code).toBe("missing-logto-config");
    expect(missingConfig.message).toBe("This server isn't configured for mobile sign-in (missing Logto).");
    expect(exchange.code).toBe("exchange-failed");
    expect(exchange.message).toBe("Sign-in failed");
    expect(exchange.message).not.toContain("provider-only diagnostic");
  });
});
