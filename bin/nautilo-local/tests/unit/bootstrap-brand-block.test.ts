import { describe, expect, test } from "bun:test";
import {
  getLogtoHostedSignInColorPatch,
  NAUTILO_HOSTED_AUTH_CSS_DERIVED,
  NAUTILO_HOSTED_AUTH_CSS_PALETTE,
} from "@nautilo/config";
import {
  computeLogtoHostedBrandingReconcilePatch,
  mergeNautiloHostedBrandingCustomCss,
  stripNautiloHostedBrandingCss,
} from "../../src/logto-hosted-auth-branding";

describe("logto-hosted-auth-branding brand block (M105 Phase B)", () => {
  test("computeLogtoHostedBrandingReconcilePatch — sets unknownSessionRedirectUrl when option supplied and value differs", () => {
    const desiredColor = getLogtoHostedSignInColorPatch().color;
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    const current = {
      color: desiredColor,
      customCss: merged,
      passwordPolicy: { rejects: { pwned: false } },
      unknownSessionRedirectUrl: null,
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(
      current,
      { unknownSessionRedirectUrl: "http://localhost:3000" },
    );
    expect(changed).toBe(true);
    expect(patch["unknownSessionRedirectUrl"]).toBe("http://localhost:3000");
  });

  test("computeLogtoHostedBrandingReconcilePatch — leaves unknownSessionRedirectUrl alone when already matching", () => {
    const desiredColor = getLogtoHostedSignInColorPatch().color;
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    const current = {
      color: desiredColor,
      customCss: merged,
      passwordPolicy: { rejects: { pwned: false } },
      unknownSessionRedirectUrl: "http://localhost:3000",
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(
      current,
      { unknownSessionRedirectUrl: "http://localhost:3000" },
    );
    expect(changed).toBe(false);
    expect(patch["unknownSessionRedirectUrl"]).toBeUndefined();
  });

  test("computeLogtoHostedBrandingReconcilePatch — omits unknownSessionRedirectUrl entirely when option not supplied", () => {
    const desiredColor = getLogtoHostedSignInColorPatch().color;
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    const current = {
      color: desiredColor,
      customCss: merged,
      passwordPolicy: { rejects: { pwned: false } },
      unknownSessionRedirectUrl: "http://something-else.invalid",
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current);
    expect(changed).toBe(false);
    expect(patch["unknownSessionRedirectUrl"]).toBeUndefined();
  });


  test("emits v5 sentinels", () => {
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 begin");
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 end");
    expect(merged).not.toContain(":v1");
    expect(merged).not.toContain(":v2");
    expect(merged).not.toContain(":v3");
    expect(merged).not.toContain(":v4");
  });

  test("removes identifier clear controls from the browser tab order without hiding the password toggle", () => {
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    expect(merged).toContain(
      "#app form div[class*='inputField']:has(input[autocomplete^='username']) button[class*='suffix']",
    );
    expect(merged).toContain(
      "#app form div[class*='inputField']:has(input[autocomplete='email']) button[class*='suffix']",
    );
    expect(merged).toContain(
      "#app form div[class*='inputField']:has(input[autocomplete='tel']) button[class*='suffix']",
    );
    expect(merged).not.toContain(
      ":has(input[autocomplete='current-password']) button[class*='suffix']",
    );
  });

  test("hosted auth follows a keyboard-shortened touch viewport without compacting Electron", () => {
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    expect(merged).toContain("min-height: 100dvh !important");
    expect(merged).toContain("overflow-y: auto !important");
    expect(merged).toContain(
      "@media (max-height: 700px) and (hover: none) and (pointer: coarse)",
    );
    expect(merged).not.toContain("@media (max-height: 700px) {");
    expect(merged).toContain("align-items: flex-start !important");
    expect(merged).not.toContain(
      "#app main[class*='main']::after {\n    display: none;",
    );
  });

  test("generated custom CSS uses canonical hosted-auth accents from @nautilo/config", () => {
    const { merged } = mergeNautiloHostedBrandingCustomCss(null);
    expect(merged).toContain("#c85040");
    expect(merged).toContain("#82aaff");
    expect(merged).not.toContain("#cc5500");
    expect(merged).not.toContain("#a64200");
    expect(merged).toContain(
      `--nautilo-accent: ${NAUTILO_HOSTED_AUTH_CSS_PALETTE.accent};`,
    );
    expect(merged).toContain(
      `--nautilo-accent-2: ${NAUTILO_HOSTED_AUTH_CSS_PALETTE.accentDark};`,
    );
    expect(merged).toContain(
      `--nautilo-border: ${NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderLight};`,
    );
    expect(merged).toContain(NAUTILO_HOSTED_AUTH_CSS_DERIVED.focusRingLight);
    expect(merged).toContain(NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderDark);
    expect(merged).toContain(NAUTILO_HOSTED_AUTH_CSS_DERIVED.focusRingDark);
    expect(merged).toContain(
      `linear-gradient(135deg, ${NAUTILO_HOSTED_AUTH_CSS_DERIVED.buttonGradientStart} 0%, ${NAUTILO_HOSTED_AUTH_CSS_DERIVED.buttonGradientEnd} 100%)`,
    );
  });

  test("is idempotent — second merge of own output is no-op", () => {
    const first = mergeNautiloHostedBrandingCustomCss(null);
    expect(first.changed).toBe(true);
    const second = mergeNautiloHostedBrandingCustomCss(first.merged);
    expect(second.changed).toBe(false);
    expect(second.merged).toBe(first.merged);
  });

  test("preserves operator CSS outside sentinels", () => {
    const input = "/* operator */\nbody { color: red; }\n";
    const { merged } = mergeNautiloHostedBrandingCustomCss(input);
    expect(merged).toContain("body { color: red; }");
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 begin");
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 end");
    expect(stripNautiloHostedBrandingCss(merged).trim()).toContain(
      "body { color: red; }",
    );
  });

  test("migrates prior owned blocks to v5 in one merge", () => {
    const v1Block =
      "/* nautilo-hosted-auth-branding:v1 begin */\n.fake-v1 { color: blue; }\n/* nautilo-hosted-auth-branding:v1 end */";
    const v2Block =
      "/* nautilo-hosted-auth-branding:v2 begin */\n.fake-v2 { color: green; }\n/* nautilo-hosted-auth-branding:v2 end */";
    const v3Block =
      "/* nautilo-hosted-auth-branding:v3 begin */\n.fake-v3 { color: purple; }\n/* nautilo-hosted-auth-branding:v3 end */";
    const v4Block =
      "/* nautilo-hosted-auth-branding:v4 begin */\n.fake-v4 { color: orange; }\n/* nautilo-hosted-auth-branding:v4 end */";
    const input = `/* before */\n.op { x: 1; }\n\n${v1Block}\n\n${v2Block}\n\n${v3Block}\n\n${v4Block}\n\n/* after */\n.tail { y: 2; }\n`;
    const { merged } = mergeNautiloHostedBrandingCustomCss(input);
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 begin");
    expect(merged).toContain("nautilo-hosted-auth-branding:v5 end");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v1 begin");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v1 end");
    expect(merged).not.toContain(".fake-v1");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v2 begin");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v2 end");
    expect(merged).not.toContain(".fake-v2");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v3 begin");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v3 end");
    expect(merged).not.toContain(".fake-v3");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v4 begin");
    expect(merged).not.toContain("nautilo-hosted-auth-branding:v4 end");
    expect(merged).not.toContain(".fake-v4");
    expect(merged).toContain(".op { x: 1; }");
    expect(merged).toContain(".tail { y: 2; }");
  });

  test("computeLogtoHostedBrandingReconcilePatch — adds passwordPolicy.rejects.pwned:false when missing", () => {
    const once = mergeNautiloHostedBrandingCustomCss(null);
    const desired = getLogtoHostedSignInColorPatch().color;
    const current = {
      color: desired,
      customCss: once.merged,
      passwordPolicy: {
        length: { min: 8 },
        rejects: { repetitionAndSequence: true },
      },
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current);
    expect(changed).toBe(true);
    expect(patch["passwordPolicy"]).toEqual({
      length: { min: 8 },
      rejects: { repetitionAndSequence: true, pwned: false },
    });
  });

  test("computeLogtoHostedBrandingReconcilePatch — leaves passwordPolicy alone when pwned:false already set", () => {
    const once = mergeNautiloHostedBrandingCustomCss(null);
    const desired = getLogtoHostedSignInColorPatch().color;
    const current = {
      color: desired,
      customCss: once.merged,
      passwordPolicy: {
        rejects: { pwned: false, repetitionAndSequence: true },
      },
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current);
    expect(changed).toBe(false);
    expect(patch).not.toHaveProperty("passwordPolicy");
  });

  test("computeLogtoHostedBrandingReconcilePatch — handles current.passwordPolicy entirely missing", () => {
    const once = mergeNautiloHostedBrandingCustomCss(null);
    const desired = getLogtoHostedSignInColorPatch().color;
    const current = {
      color: desired,
      customCss: once.merged,
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current);
    expect(changed).toBe(true);
    expect(patch["passwordPolicy"]).toEqual({ rejects: { pwned: false } });
  });

  test("computeLogtoHostedBrandingReconcilePatch — handles current.passwordPolicy.rejects entirely missing", () => {
    const once = mergeNautiloHostedBrandingCustomCss(null);
    const desired = getLogtoHostedSignInColorPatch().color;
    const current = {
      color: desired,
      customCss: once.merged,
      passwordPolicy: { length: { min: 8 } },
    };
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current);
    expect(changed).toBe(true);
    expect(patch["passwordPolicy"]).toEqual({
      length: { min: 8 },
      rejects: { pwned: false },
    });
  });

  test("populated-clone reconciliation preserves the source password policy", () => {
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(
      {
        color: { primaryColor: "#000", darkPrimaryColor: "#000", isDarkModeEnabled: false },
        customCss: "/* operator */ body { color: red; }",
        passwordPolicy: { rejects: { pwned: true } },
      },
      { includePasswordPolicy: false },
    );
    expect(changed).toBe(true);
    expect(patch).not.toHaveProperty("passwordPolicy");
    expect(String(patch["customCss"])).toContain("/* operator */");
  });
});
