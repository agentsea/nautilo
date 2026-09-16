/**
 * M051: unit tests for the pure / non-HTTP parts of `bootstrap-logto.ts`.
 *
 * Live-Logto integration is deferred to manual smoke (Option C). These
 * tests cover the contract pieces that wouldn't be caught by either:
 *   - The `LOGTO_*` keys that get persisted to instance.env (M072 removed the legacy auth env var op).
 *   - The boxed banner format the operator reads (admin URL, username,
 *     password, password-policy notice).
 *   - Default-tenant object names (workbench/tui/m2m), redirect URIs,
 *     and seed org roles — these are the contract M054/M055/M057
 *     consume in later cluster issues.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_CENTER_ENABLE_PATCH_BODY,
  APP_NAMES,
  buildLogtoEnvOperations,
  buildPreservedProjectionEnvOperations,
  computeOidcUriUnionPatch,
  computeOidcUriRebindPatch,
  deriveWorkbenchOidcRedirectUris,
  deriveWorkbenchPostLogoutRedirectUris,
  deriveMobileWebOidcRedirectUris,
  deriveMobileWebPostLogoutRedirectUris,
  DESKTOP_POST_LOGOUT_REDIRECT_URIS,
  DESKTOP_REDIRECT_URIS,
  MOBILE_POST_LOGOUT_REDIRECT_URIS,
  MOBILE_REDIRECT_URIS,
  TUI_LOOPBACK_REDIRECT_URIS,
  TUI_REDIRECT_URIS,
  ensureLogtoAdminCredentialFile,
  formatBootstrapBanner,
  formatLogtoAdminCredentialFile,
  LOGTO_ADMIN_CREDENTIAL_FILENAME,
  MANAGEMENT_API_REQUEST_TIMEOUT_MS,
  mergeCustomClientMetadata,
  mintM2mToken,
  ORG_ROLES_TO_SEED,
  PROVISIONED_LOGTO_APPLICATION_IDENTITIES,
  ProvisionedLogtoIdentityError,
  reconcileForgotPasswordRelay,
  reconcileOssRelayForgotPasswordPhrases,
  selectProvisionedLogtoConfig,
  SIGN_IN_EXP_USERNAME_PATCH_BODY,
  TOKEN_MINT_MAX_ATTEMPTS,
} from "../../src/bootstrap-logto";
import {
  __resetResolvedInstanceForTests,
  resolveInstance,
} from "@nautilo/config";
import {
  computeLogtoHostedBrandingReconcilePatch,
  mergeNautiloHostedBrandingCustomCss,
  stripNautiloHostedBrandingCss,
} from "../../src/logto-hosted-auth-branding";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SOURCE_PATH = resolve(THIS_DIR, "../../src/bootstrap-logto.ts");

const originalFetch = globalThis.fetch;

test("Logto PostgreSQL bootstrap probe is bounded and names its no-mutation phase", () => {
  const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf8");

  expect(source).toContain("connect_timeout: 5");
  expect(source).toContain("SET statement_timeout = 5000");
  expect(source).toContain(
    "Logto PostgreSQL bootstrap probe failed before any auth mutation",
  );
  expect(source).toContain(
    "[bootstrap-logto] probing Logto PostgreSQL bootstrap state...",
  );
  expect(source).not.toContain(
    "[bootstrap-logto] reading m-admin secret + idempotency probe...",
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("clone URI rebind removes only proven source-generated values", () => {
  const patch = computeOidcUriRebindPatch(
    ["http://qa-source/auth/callback", "https://operator.example/callback"],
    ["http://qa-source", "https://operator.example/logout"],
    ["http://tau/auth/callback"],
    ["http://tau"],
    ["http://qa-source/auth/callback"],
    ["http://qa-source"],
  );
  expect(patch.mergedRedirectUris).toEqual([
    "https://operator.example/callback",
    "http://tau/auth/callback",
  ]);
  expect(patch.mergedPostLogoutRedirectUris).toEqual([
    "https://operator.example/logout",
    "http://tau",
  ]);
  expect(patch.removedRedirects).toEqual(["http://qa-source/auth/callback"]);
});

describe("mintM2mToken — transient-tolerant retry", () => {
  const noSleep = async (): Promise<void> => {};

  function tokenResponse(): Response {
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  test("uses Logto's client_secret_basic contract without credentials in the form body", async () => {
    let observed: Request | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      observed = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      return tokenResponse();
    }) as unknown as typeof fetch;

    await mintM2mToken("http://localhost:5302", "m-admin", "secret", "res", noSleep);

    expect(observed?.headers.get("authorization")).toBe(`Basic ${Buffer.from("m-admin:secret").toString("base64")}`);
    const body = new URLSearchParams(await observed?.text());
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("resource")).toBe("res");
    expect(body.get("scope")).toBe("all");
  });

  test("retries through transient socket errors then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // First two attempts: simulate undici "socket closed" by throwing.
      if (calls <= 2) throw new TypeError("The socket connection was closed unexpectedly.");
      return tokenResponse();
    }) as unknown as typeof fetch;

    const token = await mintM2mToken("http://localhost:5302", "m-admin", "secret", "res", noSleep);
    expect(token).toBe("tok");
    expect(calls).toBe(3);
  });

  test("retries on HTTP 5xx then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("upstream down", { status: 503 });
      return tokenResponse();
    }) as unknown as typeof fetch;

    const token = await mintM2mToken("http://localhost:5302", "m-default", "secret", "res", noSleep);
    expect(token).toBe("tok");
    expect(calls).toBe(2);
  });

  test("does NOT retry a 4xx (real credential/config error)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("invalid_client", { status: 401 });
    }) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      mintM2mToken("http://localhost:5302", "m-admin", "bad", "res", noSleep),
    ).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  test("gives up after the max attempts with a clear error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("The socket connection was closed unexpectedly.");
    }) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      mintM2mToken("http://localhost:5302", "m-admin", "secret", "res", noSleep),
    ).rejects.toThrow(new RegExp(`after ${TOKEN_MINT_MAX_ATTEMPTS} attempts`));
    expect(calls).toBe(TOKEN_MINT_MAX_ATTEMPTS);
  });
});

describe("M064 — Account Center bootstrap", () => {
  test("PATCH body enables password editing on default tenant", () => {
    expect(ACCOUNT_CENTER_ENABLE_PATCH_BODY.enabled).toBe(true);
    expect(ACCOUNT_CENTER_ENABLE_PATCH_BODY.fields.password).toBe("Edit");
  });

  test("ensureAccountCenterEnabled runs on defaultClient (m-default audience)", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    expect(source).toContain("ensureAccountCenterEnabled(defaultClient)");
    expect(source).toContain("resource=https://default.logto.app/api");
    // Logto OSS serves the default tenant at the core `/api/...` route; the
    // caller may explicitly supply a loopback core endpoint for remote stacks.
    expect(source).toContain("base: options.defaultTenantEndpoint ?? endpoint");
    expect(source).not.toContain('pathPrefix: "/m/default"');
  });

  test("M071 / 1D.1 — workbench SPA redirect URIs come from resolveInstance()", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    expect(source).toContain("deriveWorkbenchOidcRedirectUris(instance)");
    expect(source).toContain("deriveWorkbenchPostLogoutRedirectUris(instance)");
  });

  test("M071 / 1D.2 — ensureApp URI reconciliation uses computeOidcUriUnionPatch", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    expect(source).toContain("computeOidcUriUnionPatch(");
  });

  test("managed hosted replacement passes the exact derived source URI sets to ensureApp", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const reconcileStart = source.indexOf("async function reconcileWorkbenchApplication(");
    const reconcileEnd = source.indexOf("export async function runBootstrap(", reconcileStart);
    expect(reconcileStart).toBeGreaterThan(-1);
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);
    const reconcile = source.slice(reconcileStart, reconcileEnd);
    expect(reconcile).toContain(
      "deriveManagedWorkbenchOriginUris(managedOriginReplacement.sourceOrigin)",
    );
    expect(reconcile).toContain("redirectUris: removedRedirectUris");
    expect(reconcile).toContain("postLogoutRedirectUris: removedPostLogoutRedirectUris");
    expect(reconcile).toContain("requireManagedWorkbenchIdentity: true as const");
  });

  test("M234 clone mode rebinds only Workbench and Nautilo-owned auth projections", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const preserveStart = source.indexOf(
      "if (options.preserveProvisionedState)",
    );
    const workbenchRebind = source.indexOf(
      "await reconcileWorkbenchApplication(defaultClient, options, managedOriginReplacement)",
      preserveStart,
    );
    const ordinaryProvisioning = source.indexOf(
      "let adminUsername =",
      preserveStart,
    );
    expect(preserveStart).toBeGreaterThan(-1);
    expect(workbenchRebind).toBeGreaterThan(preserveStart);
    expect(workbenchRebind).toBeLessThan(ordinaryProvisioning);
    const preserveSlice = source.slice(workbenchRebind, ordinaryProvisioning);
    expect(preserveSlice).toContain(
      "await reconcileDefaultTenantHostedAuthBranding(defaultClient",
    );
    expect(preserveSlice).toContain("includePasswordPolicy: false");
    expect(preserveSlice).toContain("return;");
    expect(source).toContain(
      '"--preserve-provisioned-state"',
    );
  });

  test("populated hosted restore reads exact existing identities without entering provisioning paths", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const preserveStart = source.indexOf("if (options.preserveProvisionedState)");
    const preserveEnd = source.indexOf("// M055: stages 4-10", preserveStart);
    const preserve = source.slice(preserveStart, preserveEnd);
    expect(preserve).toContain("readProvisionedLogtoConfig(defaultClient, endpoint, resource)");
    expect(preserve).toContain("if (options.persistConfig !== undefined)");
    expect(preserve).not.toContain("ensureApp(");
    expect(preserve).not.toContain("ensureResource(");
    expect(preserve).not.toContain("runFirstTimeAdminProvisioning(");
    expect(preserve).not.toContain('"POST"');
    expect(preserve).not.toContain('"DELETE"');
  });
});

describe("selectProvisionedLogtoConfig", () => {
  const applications = [
    { id: "workbench-id", name: APP_NAMES.workbench, type: "SPA" as const },
    { id: "tui-id", name: APP_NAMES.tui, type: "Native" as const },
    { id: "tui-loopback-id", name: APP_NAMES.tuiLoopback, type: "Native" as const },
    { id: "desktop-id", name: APP_NAMES.desktop, type: "Native" as const },
    { id: "mobile-id", name: APP_NAMES.mobile, type: "Native" as const },
    { id: "mobile-web-id", name: APP_NAMES.mobileWeb, type: "SPA" as const },
    { id: "m2m-id", name: APP_NAMES.m2m, type: "MachineToMachine" as const },
  ];
  const input = {
    endpoint: "https://identity.example.test",
    resource: "https://nautilo.example.test/api",
    applications,
    resources: [{ id: "resource-id", indicator: "https://nautilo.example.test/api", name: "Nautilo API" }],
    m2mSecret: "request-memory-secret",
  };

  test("returns every hosted handoff value from the exact restored identities", () => {
    expect(selectProvisionedLogtoConfig(input)).toEqual({
      endpoint: input.endpoint,
      workbenchAppId: "workbench-id",
      tuiAppId: "tui-id",
      tuiLoopbackAppId: "tui-loopback-id",
      desktopAppId: "desktop-id",
      mobileAppId: "mobile-id",
      mobileWebAppId: "mobile-web-id",
      m2mAppId: "m2m-id",
      m2mAppSecret: "request-memory-secret",
      resource: input.resource,
    });
  });

  test("fails closed for missing, duplicate, wrong-type, or secretless restored identities", () => {
    const invalid = [
      { ...input, applications: applications.filter((application) => application.name !== APP_NAMES.desktop) },
      { ...input, applications: applications.filter((application) => application.name !== APP_NAMES.mobileWeb) },
      { ...input, applications: [...applications, { ...applications[0]!, id: "duplicate-id" }] },
      { ...input, applications: applications.map((application) => application.name === APP_NAMES.tui ? { ...application, type: "SPA" as const } : application) },
      { ...input, m2mSecret: "" },
    ];
    for (const candidate of invalid) {
      expect(() => selectProvisionedLogtoConfig(candidate)).toThrow(ProvisionedLogtoIdentityError);
    }
  });
});

test("populated restore reads every exact provisioned Nautilo application identity", () => {
  expect(PROVISIONED_LOGTO_APPLICATION_IDENTITIES).toEqual([
    [APP_NAMES.workbench, "SPA"],
    [APP_NAMES.tui, "Native"],
    [APP_NAMES.tuiLoopback, "Native"],
    [APP_NAMES.desktop, "Native"],
    [APP_NAMES.mobile, "Native"],
    [APP_NAMES.mobileWeb, "SPA"],
    [APP_NAMES.m2m, "MachineToMachine"],
  ]);
});

const SAMPLE_CFG = {
  endpoint: "http://localhost:3301",
  workbenchAppId: "wb",
  tuiAppId: "tui",
  tuiLoopbackAppId: "tui-loopback",
  desktopAppId: "desktop",
  mobileAppId: "mobile",
  mobileWebAppId: "mobile-web",
  m2mAppId: "m2m",
  m2mAppSecret: "secret",
  resource: "https://api.nautilo.local",
} as const;

describe("buildLogtoEnvOperations", () => {
  test("persists only public browser app ids during clone projection rebind", () => {
    expect(buildPreservedProjectionEnvOperations({
      workbenchAppId: "workbench-id",
      mobileWebAppId: "mobile-web-id",
    })).toEqual([
      { type: "set", key: "LOGTO_WORKBENCH_APP_ID", value: "workbench-id" },
      { type: "set", key: "LOGTO_MOBILE_WEB_APP_ID", value: "mobile-web-id" },
    ]);
  });

  test("emits twelve LOGTO_* set operations (M072: dropped legacy auth env var)", () => {
    const ops = buildLogtoEnvOperations({ ...SAMPLE_CFG });
    expect(ops.length).toBe(12);
    expect(ops.every((o) => o.type === "set")).toBe(true);
    const keys = ops.map((o) => o.key);
    const legacyAuthEnvKey = "AUTH" + "_" + "MODE";
    expect(keys).not.toContain(legacyAuthEnvKey);
    expect(keys).toContain("LOGTO_DESKTOP_APP_ID");
    expect(keys).toContain("LOGTO_MOBILE_APP_ID");
    expect(keys).toContain("LOGTO_TUI_LOOPBACK_APP_ID");
    expect(keys).toEqual([
      "LOGTO_ENDPOINT",
      "LOGTO_ISSUER",
      "LOGTO_JWKS_URI",
      "LOGTO_RESOURCE",
      "LOGTO_WORKBENCH_APP_ID",
      "LOGTO_TUI_APP_ID",
      "LOGTO_TUI_LOOPBACK_APP_ID",
      "LOGTO_DESKTOP_APP_ID",
      "LOGTO_MOBILE_APP_ID",
      "LOGTO_MOBILE_WEB_APP_ID",
      "LOGTO_M2M_APP_ID",
      "LOGTO_M2M_APP_SECRET",
    ]);
    const byKey = Object.fromEntries(ops.map((o) => [o.key, o.value]));
    expect(byKey["LOGTO_DESKTOP_APP_ID"]).toBe("desktop");
    expect(byKey["LOGTO_MOBILE_APP_ID"]).toBe("mobile");
    expect(byKey["LOGTO_MOBILE_WEB_APP_ID"]).toBe("mobile-web");
    expect(byKey["LOGTO_TUI_LOOPBACK_APP_ID"]).toBe("tui-loopback");
  });

  test("derives ISSUER and JWKS_URI from endpoint", () => {
    const ops = buildLogtoEnvOperations({
      ...SAMPLE_CFG,
      endpoint: "https://auth.nautilo.local",
    });
    const byKey = Object.fromEntries(ops.map((o) => [o.key, o.value]));
    expect(byKey["LOGTO_ISSUER"]).toBe("https://auth.nautilo.local/oidc");
    expect(byKey["LOGTO_JWKS_URI"]).toBe("https://auth.nautilo.local/oidc/jwks");
  });

  test("preserves m2m secret verbatim (config-guard handles redaction at read time)", () => {
    const ops = buildLogtoEnvOperations({
      ...SAMPLE_CFG,
      m2mAppSecret: "should-be-stored-as-is",
    });
    const secret = ops.find((o) => o.key === "LOGTO_M2M_APP_SECRET");
    expect(secret?.value).toBe("should-be-stored-as-is");
  });
});

describe("formatBootstrapBanner", () => {
  test("points the operator to the protected credential file without printing its password", () => {
    const out = formatBootstrapBanner({
      adminUrl: "http://localhost:3302",
      username: "nautilo-admin",
      envPath: "/home/me/.nautilo/instance.env",
      passwordPolicyDisabled: true,
    });
    expect(out).toContain("http://localhost:3302");
    expect(out).toContain("nautilo-admin");
    expect(out).toContain("/home/me/.nautilo/instance.env");
    expect(out).toContain("/home/me/.nautilo/logto-admin.txt");
    expect(out).not.toContain("abc123def456");
  });

  test("password-policy notice appears only when disabled", () => {
    const yes = formatBootstrapBanner({
      adminUrl: "x",
      username: "u",
      envPath: "/p",
      passwordPolicyDisabled: true,
    });
    const no = formatBootstrapBanner({
      adminUrl: "x",
      username: "u",
      envPath: "/p",
      passwordPolicyDisabled: false,
    });
    expect(yes).toContain("pwned-password check disabled");
    expect(no).not.toContain("pwned-password check disabled");
  });

  test("warns operator that compose containers stay running on Ctrl+C", () => {
    const out = formatBootstrapBanner({
      adminUrl: "x",
      username: "u",
      envPath: "/p",
      passwordPolicyDisabled: false,
    });
    expect(out).toContain("docker compose down");
  });
});

describe("mergeCustomClientMetadata (M060)", () => {
  // Phase 1 found PATCH semantics on `customClientMetadata` are
  // REPLACE, not merge — sending `{a:1}` alone overwrites and drops
  // sibling keys like `isDeviceFlow`. The bootstrap helpers therefore
  // read-merge-write via this helper; these tests lock the contract.

  test("adds new keys to an empty object (Desktop app first-bootstrap path)", () => {
    const out = mergeCustomClientMetadata(undefined, {
      alwaysIssueRefreshToken: true,
    });
    expect(out.changed).toBe(true);
    expect(out.merged).toEqual({ alwaysIssueRefreshToken: true });
  });

  test("preserves sibling keys when adding (TUI app upgrade path: keep isDeviceFlow alongside the new flag)", () => {
    const out = mergeCustomClientMetadata(
      { isDeviceFlow: true },
      { alwaysIssueRefreshToken: true },
    );
    expect(out.changed).toBe(true);
    expect(out.merged).toEqual({
      isDeviceFlow: true,
      alwaysIssueRefreshToken: true,
    });
  });

  test("returns changed:false when desired is already a subset (idempotent re-run)", () => {
    const out = mergeCustomClientMetadata(
      { isDeviceFlow: true, alwaysIssueRefreshToken: true },
      { alwaysIssueRefreshToken: true },
    );
    expect(out.changed).toBe(false);
    expect(out.merged).toEqual({
      isDeviceFlow: true,
      alwaysIssueRefreshToken: true,
    });
  });

  test("flags changed:true when an existing key has a different value (operator manually flipped it false)", () => {
    const out = mergeCustomClientMetadata(
      { alwaysIssueRefreshToken: false },
      { alwaysIssueRefreshToken: true },
    );
    expect(out.changed).toBe(true);
    expect(out.merged).toEqual({ alwaysIssueRefreshToken: true });
  });
});

describe("M059 — admin credential file", () => {
  test("formatLogtoAdminCredentialFile contains username, password, admin URL, and headers", () => {
    const out = formatLogtoAdminCredentialFile(
      {
        username: "nautilo_admin",
        password: "deadbeef" + "cafe".repeat(8),
        adminUrl: "http://localhost:3302",
      },
      "2026-04-29T18:30:12Z",
    );
    expect(out).toContain("# Logto admin console credential");
    expect(out).toContain("# Console: http://localhost:3302");
    expect(out).toContain("# Created: 2026-04-29T18:30:12Z");
    expect(out).toContain("username: nautilo_admin");
    expect(out).toContain(`password: deadbeef${"cafe".repeat(8)}`);
    expect(out).toContain("Rotate after first login");
  });

  test("filename constant matches operations playbook + migration playbook references", () => {
    // The playbook docs reference `~/.nautilo/logto-admin.txt` —
    // this constant is the source of truth for that filename.
    expect(LOGTO_ADMIN_CREDENTIAL_FILENAME).toBe("logto-admin.txt");
  });

  test("ensureLogtoAdminCredentialFile writes with chmod 600 on first invocation", () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const wrote = ensureLogtoAdminCredentialFile(
      {
        username: "nautilo_admin",
        password: "secret",
        adminUrl: "http://localhost:3302",
      },
      {
        resolvePath: () => "/tmp/test-nautilo/logto-admin.txt",
        exists: () => false,
        writeFile: (path, contents) => {
          writes.push({ path, contents });
        },
        isoStamp: () => "fixed-stamp",
        log: () => {
          /* swallow */
        },
      },
    );
    expect(wrote).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/test-nautilo/logto-admin.txt");
    expect(writes[0]?.contents).toContain("password: secret");
  });

  test("ensureLogtoAdminCredentialFile is idempotent — preserves an existing file", () => {
    const writes: Array<unknown> = [];
    const wrote = ensureLogtoAdminCredentialFile(
      {
        username: "nautilo_admin",
        password: "fresh-but-should-not-overwrite",
        adminUrl: "http://localhost:3302",
      },
      {
        resolvePath: () => "/tmp/test-nautilo/logto-admin.txt",
        exists: () => true,
        writeFile: (path, contents) => {
          writes.push({ path, contents });
        },
        isoStamp: () => "fixed-stamp",
        log: () => {
          /* swallow */
        },
      },
    );
    expect(wrote).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("M102 — TUI device-flow vs loopback redirect contract", () => {
  test("bootstrap registers loopback URI only on TUI_LOOPBACK_REDIRECT_URIS (source slice)", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const loopStart = source.indexOf("export const TUI_LOOPBACK_REDIRECT_URIS = [");
    const loopEnd = source.indexOf("] as const;", loopStart);
    expect(loopStart).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loopBlock = source.slice(loopStart, loopEnd);
    expect(loopBlock).toContain('"http://127.0.0.1/callback"');

    const tuiBlockStart = source.indexOf("export const TUI_REDIRECT_URIS = [");
    const tuiBlockEnd = source.indexOf("] as const;", tuiBlockStart);
    expect(tuiBlockStart).toBeGreaterThan(0);
    expect(tuiBlockEnd).toBeGreaterThan(tuiBlockStart);
    const tuiRedirectBlock = source.slice(tuiBlockStart, tuiBlockEnd);
    expect(tuiRedirectBlock).toContain('"http://127.0.0.1/tui-device-flow-placeholder"');
    expect(tuiRedirectBlock).not.toContain('"http://127.0.0.1/callback"');
  });

  test("ensureDeviceFlowTuiApp reconciliation uses computeOidcUriUnionPatch (same merge as PATCH body)", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const tuiFnStart = source.indexOf("async function ensureDeviceFlowTuiApp");
    const tuiFnEnd = source.indexOf(
      "async function reconcileDefaultTenantHostedAuthBranding",
    );
    expect(tuiFnStart).toBeGreaterThan(0);
    expect(tuiFnEnd).toBeGreaterThan(tuiFnStart);
    const tuiFnBody = source.slice(tuiFnStart, tuiFnEnd);
    expect(tuiFnBody).toContain("computeOidcUriUnionPatch(");

    const currentOnlyPlaceholder = [
      "http://127.0.0.1/tui-device-flow-placeholder",
    ] as const;
    const desiredTuiRedirects = ["http://127.0.0.1/tui-device-flow-placeholder"] as const;
    const uriUnion = computeOidcUriUnionPatch(
      currentOnlyPlaceholder,
      [],
      desiredTuiRedirects,
      [],
    );
    expect(uriUnion.missingRedirects).toEqual([]);
    expect(uriUnion.mergedRedirectUris).toEqual([
      "http://127.0.0.1/tui-device-flow-placeholder",
    ]);
  });

  test("M102 — bootstrap registers the TUI loopback Native app after the desktop app", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    expect(source).toContain("APP_NAMES.tuiLoopback");
    expect(source).toContain("const tuiLoopbackApp = await ensureApp");
    expect(source).toContain("TUI_LOOPBACK_REDIRECT_URIS");
  });
});

describe("M071 / 1D.1 — workbench OIDC URIs from resolveInstance()", () => {
  test("default instance registers exact loopback browser redirect + post-logout literals", () => {
    __resetResolvedInstanceForTests();
    const instance = resolveInstance({});
    expect(deriveWorkbenchOidcRedirectUris(instance)).toEqual([
      "http://localhost:3001/auth/callback",
      "http://localhost:3001/settings/security",
      "http://127.0.0.1:3001/auth/callback",
      "http://127.0.0.1:3001/settings/security",
      "http://[::1]:3001/auth/callback",
      "http://[::1]:3001/settings/security",
      "http://localhost:3000/auth/callback",
      "http://localhost:3000/settings/security",
      "http://127.0.0.1:3000/auth/callback",
      "http://127.0.0.1:3000/settings/security",
      "http://[::1]:3000/auth/callback",
      "http://[::1]:3000/settings/security",
    ]);
    expect(deriveWorkbenchPostLogoutRedirectUris(instance)).toEqual([
      "http://localhost:3001",
      "http://localhost:3001/logout",
      "http://localhost:3001/claim",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3001/logout",
      "http://127.0.0.1:3001/claim",
      "http://[::1]:3001",
      "http://[::1]:3001/logout",
      "http://[::1]:3001/claim",
      "http://localhost:3000",
      "http://localhost:3000/logout",
      "http://localhost:3000/claim",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3000/logout",
      "http://127.0.0.1:3000/claim",
      "http://[::1]:3000",
      "http://[::1]:3000/logout",
      "http://[::1]:3000/claim",
    ]);
  });

  test("NAUTILO_PORT / NAUTILO_WORKBENCH_PORT env overlays flow into derived URIs", () => {
    __resetResolvedInstanceForTests();
    const instance = resolveInstance({
      NAUTILO_PORT: "3099",
      NAUTILO_WORKBENCH_PORT: "4000",
    });
    expect(deriveWorkbenchOidcRedirectUris(instance)).toEqual([
      "http://localhost:3099/auth/callback",
      "http://localhost:3099/settings/security",
      "http://127.0.0.1:3099/auth/callback",
      "http://127.0.0.1:3099/settings/security",
      "http://[::1]:3099/auth/callback",
      "http://[::1]:3099/settings/security",
      "http://localhost:4000/auth/callback",
      "http://localhost:4000/settings/security",
      "http://127.0.0.1:4000/auth/callback",
      "http://127.0.0.1:4000/settings/security",
      "http://[::1]:4000/auth/callback",
      "http://[::1]:4000/settings/security",
    ]);
    expect(deriveWorkbenchPostLogoutRedirectUris(instance)).toEqual([
      "http://localhost:3099",
      "http://localhost:3099/logout",
      "http://localhost:3099/claim",
      "http://127.0.0.1:3099",
      "http://127.0.0.1:3099/logout",
      "http://127.0.0.1:3099/claim",
      "http://[::1]:3099",
      "http://[::1]:3099/logout",
      "http://[::1]:3099/claim",
      "http://localhost:4000",
      "http://localhost:4000/logout",
      "http://localhost:4000/claim",
      "http://127.0.0.1:4000",
      "http://127.0.0.1:4000/logout",
      "http://127.0.0.1:4000/claim",
      "http://[::1]:4000",
      "http://[::1]:4000/logout",
      "http://[::1]:4000/claim",
    ]);
  });

  test("computeOidcUriUnionPatch is additive: instance B does not drop instance A URIs", () => {
    __resetResolvedInstanceForTests();
    const instanceA = resolveInstance({});
    const redirectA = deriveWorkbenchOidcRedirectUris(instanceA);
    const postA = deriveWorkbenchPostLogoutRedirectUris(instanceA);
    __resetResolvedInstanceForTests();
    const instanceB = resolveInstance({
      NAUTILO_PORT: "3099",
      NAUTILO_WORKBENCH_PORT: "4000",
    });
    const redirectB = deriveWorkbenchOidcRedirectUris(instanceB);
    const postB = deriveWorkbenchPostLogoutRedirectUris(instanceB);

    const ab = computeOidcUriUnionPatch(redirectA, postA, redirectB, postB);
    expect(redirectA.every((u) => ab.mergedRedirectUris.includes(u))).toBe(true);
    expect(redirectB.every((u) => ab.mergedRedirectUris.includes(u))).toBe(true);
    expect(postA.every((u) => ab.mergedPostLogoutRedirectUris.includes(u))).toBe(
      true,
    );
    expect(postB.every((u) => ab.mergedPostLogoutRedirectUris.includes(u))).toBe(
      true,
    );
    expect(ab.mergedRedirectUris).toEqual([
      ...redirectA,
      ...redirectB.filter((u) => !redirectA.includes(u)),
    ]);

    const ba = computeOidcUriUnionPatch(redirectB, postB, redirectA, postA);
    expect(new Set(ba.mergedRedirectUris)).toEqual(new Set(ab.mergedRedirectUris));
    expect(new Set(ba.mergedPostLogoutRedirectUris)).toEqual(
      new Set(ab.mergedPostLogoutRedirectUris),
    );
  });
});

describe("default-tenant object contract", () => {
  test("APP_NAMES match the spec the M054/M055/M057 cluster issues consume", () => {
    expect(APP_NAMES.workbench).toBe("Nautilo Workbench");
    expect(APP_NAMES.tui).toBe("Nautilo TUI");
    expect(APP_NAMES.tuiLoopback).toBe("Nautilo TUI (loopback)");
    expect(APP_NAMES.m2m).toBe("Nautilo Server");
    // M055 — fourth Native app for Electron loopback PKCE.
    expect(APP_NAMES.desktop).toBe("Nautilo Desktop");
    // M199 — Native app for mobile (Expo) custom-scheme PKCE.
    expect(APP_NAMES.mobile).toBe("Nautilo Mobile");
    expect(APP_NAMES.mobileWeb).toBe("Nautilo Mobile Web");
  });

  test("D515 Mobile Web registers only exact server-origin callback and logout paths", () => {
    __resetResolvedInstanceForTests();
    const instance = resolveInstance({});
    const redirects = deriveMobileWebOidcRedirectUris(instance);
    const logouts = deriveMobileWebPostLogoutRedirectUris(instance);
    expect(redirects).toContain("http://localhost:3001/mobile/callback");
    expect(redirects).toContain("http://127.0.0.1:3001/mobile/callback");
    expect(redirects).not.toContain("http://localhost:3000/mobile/callback");
    expect(logouts).toContain("http://localhost:3001/mobile");
    expect(logouts).not.toContain("http://localhost:3000/mobile");
  });

  test("deriveWorkbenchOidcRedirectUris covers explicit loopback browser aliases", () => {
    __resetResolvedInstanceForTests();
    const instance = resolveInstance({});
    const uris = deriveWorkbenchOidcRedirectUris(instance);
    expect(uris).toContain("http://localhost:3001/auth/callback");
    expect(uris).toContain("http://localhost:3001/settings/security");
    expect(uris).toContain("http://127.0.0.1:3001/auth/callback");
    expect(uris).toContain("http://127.0.0.1:3001/settings/security");
    expect(uris).toContain("http://[::1]:3001/auth/callback");
    expect(uris).toContain("http://[::1]:3001/settings/security");
    expect(uris).toContain("http://localhost:3000/auth/callback");
    expect(uris).toContain("http://localhost:3000/settings/security");
    expect(uris).toContain("http://127.0.0.1:3000/auth/callback");
    expect(uris).toContain("http://127.0.0.1:3000/settings/security");
    expect(uris).toContain("http://[::1]:3000/auth/callback");
    expect(uris).toContain("http://[::1]:3000/settings/security");
  });

  test("M055: DESKTOP_REDIRECT_URIS registers the bare-host loopback (RFC 8252 §7.3 port-flex)", () => {
    expect(DESKTOP_REDIRECT_URIS).toContain("http://127.0.0.1/callback");
  });

  test("M102: TUI_LOOPBACK_REDIRECT_URIS registers bare-host /callback for the loopback PKCE Native app", () => {
    expect(TUI_LOOPBACK_REDIRECT_URIS).toContain("http://127.0.0.1/callback");
  });

  test("M102: TUI_REDIRECT_URIS is device-flow placeholder only (no loopback /callback)", () => {
    expect(TUI_REDIRECT_URIS).toEqual(["http://127.0.0.1/tui-device-flow-placeholder"]);
  });

  test("M055: DESKTOP_POST_LOGOUT_REDIRECT_URIS covers both /logout and bare host", () => {
    expect(DESKTOP_POST_LOGOUT_REDIRECT_URIS).toContain(
      "http://127.0.0.1/logout",
    );
    expect(DESKTOP_POST_LOGOUT_REDIRECT_URIS).toContain("http://127.0.0.1");
  });

  test("M199: MOBILE_REDIRECT_URIS registers custom-scheme callback for Expo PKCE", () => {
    expect(MOBILE_REDIRECT_URIS).toEqual(["nautilo://callback"]);
  });

  test("M199: MOBILE_POST_LOGOUT_REDIRECT_URIS registers custom-scheme sign-out", () => {
    expect(MOBILE_POST_LOGOUT_REDIRECT_URIS).toEqual(["nautilo://sign-out"]);
  });

  test("M055: deriveWorkbenchPostLogoutRedirectUris covers M054's browser sign-out targets", () => {
    __resetResolvedInstanceForTests();
    const instance = resolveInstance({});
    const uris = deriveWorkbenchPostLogoutRedirectUris(instance);
    expect(uris).toContain("http://localhost:3001");
    expect(uris).toContain("http://localhost:3001/logout");
    expect(uris).toContain("http://127.0.0.1:3001");
    expect(uris).toContain("http://127.0.0.1:3001/logout");
    expect(uris).toContain("http://[::1]:3001");
    expect(uris).toContain("http://[::1]:3001/logout");
    expect(uris).toContain("http://localhost:3000");
    expect(uris).toContain("http://localhost:3000/logout");
    expect(uris).toContain("http://127.0.0.1:3000");
    expect(uris).toContain("http://127.0.0.1:3000/logout");
    expect(uris).toContain("http://[::1]:3000");
    expect(uris).toContain("http://[::1]:3000/logout");
  });

  test("ORG_ROLES_TO_SEED matches M043 RBAC seed list", () => {
    expect(ORG_ROLES_TO_SEED).toEqual([
      "owner",
      "household",
      "teammate",
      "guest",
    ]);
  });
});

describe("M107 Phase 1b — default-tenant username SIE patch", () => {
  test("patch body matches the shape probed against Logto OSS 1.38.0 (Phase 0)", () => {
    // If this test fails because Logto's SIE schema changed, re-run the
    // Phase 0 probe (see playbook/logto-operations.md) and update both
    // the constant and this test in lockstep.
    expect(SIGN_IN_EXP_USERNAME_PATCH_BODY).toEqual({
      signIn: {
        methods: [
          {
            identifier: "username",
            password: true,
            verificationCode: false,
            isPasswordPrimary: true,
          },
        ],
      },
      signUp: {
        identifiers: ["username"],
        password: true,
        verify: false,
      },
    });
  });

  test("bootstrap PATCHes default tenant with this body, unconditionally", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    // PATCH lives on defaultClient (not adminClient — the username flip
    // is for end-user sign-in, not admin-console sign-in).
    expect(source).toMatch(
      /api\(\s*defaultClient,\s*"PATCH",\s*"\/api\/sign-in-exp",\s*SIGN_IN_EXP_USERNAME_PATCH_BODY/,
    );
    // M107 marker so future cleanup PRs can locate the call.
    expect(source).toContain("M107 Phase 1b");
  });

  test("patch body sits OUTSIDE the alreadyBootstrapped guard (runs on upgrade boots)", () => {
    // Upgrade installs that pre-date M107 must be auto-flipped on next
    // boot. The branding patch already follows this pattern; the M107
    // call must be in the same unconditional section. We assert this by
    // requiring the M107 log line appears AFTER the alreadyBootstrapped
    // branch closes (a brittle text check, but cheap and catches the
    // most likely regression: dropping the line into the if-branch).
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
    const guardCloseIdx = source.indexOf(
      "admin tenant already provisioned; skipping",
    );
    const m107LogIdx = source.indexOf(
      "ensuring default-tenant SIE is username-based",
    );
    expect(guardCloseIdx).toBeGreaterThan(0);
    expect(m107LogIdx).toBeGreaterThan(guardCloseIdx);
  });
});

describe("logto-hosted-auth-branding (D104 Phase 5)", () => {
  test("mergeNautiloHostedBrandingCustomCss is idempotent when block already present", () => {
    const first = mergeNautiloHostedBrandingCustomCss(null);
    expect(first.changed).toBe(true);
    const second = mergeNautiloHostedBrandingCustomCss(first.merged);
    expect(second.changed).toBe(false);
    expect(second.merged).toBe(first.merged);
  });

  test("stripNautiloHostedBrandingCss removes only the marked block", () => {
    const inner = mergeNautiloHostedBrandingCustomCss("body { margin: 0 }").merged;
    expect(inner).toContain("body { margin: 0 }");
    const stripped = stripNautiloHostedBrandingCss(inner);
    expect(stripped.trim()).toBe("body { margin: 0 }");
  });

  test("computeLogtoHostedBrandingReconcilePatch no-op when already aligned", () => {
    const once = mergeNautiloHostedBrandingCustomCss(null);
    const cur = {
      color: {
        // D254: canonical light hosted-auth brand is #c85040 (was the stale
        // #cc5500); darkPrimaryColor stays #82aaff per the deliberate
        // light=accent / dark=primary(blue) split. Tracks the token source.
        primaryColor: "#c85040",
        isDarkModeEnabled: true,
        darkPrimaryColor: "#82aaff",
      },
      customCss: once.merged,
      passwordPolicy: { rejects: { pwned: false } },
    };
    const { changed } = computeLogtoHostedBrandingReconcilePatch(cur);
    expect(changed).toBe(false);
  });
});

describe("M120 — reconcileForgotPasswordRelay I/O", () => {
  const client = { base: "https://auth.example", token: "m2m-token" };
  const relay = {
    webhookEndpoint: "http://nautilo-server:3001/api/internal/logto/email-webhook",
    webhookSecret: "relay-secret",
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function requestUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  test("bounds every Logto management API request with an abort signal", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      signals.push(init!.signal!);
      calls += 1;
      if (calls === 1) return jsonResponse([]);
      if (calls === 2) return jsonResponse({ forgotPasswordMethods: [] });
      if (calls === 3) return jsonResponse({ id: "connector-1" });
      if (calls === 4) return jsonResponse({});
      throw new Error("unexpected fetch call");
    }) as typeof fetch;

    await reconcileForgotPasswordRelay(client, relay);

    expect(MANAGEMENT_API_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  test("fresh tenant: GET connectors/SIE, POST http-email, PATCH methods with exact bodies", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({
        method: String(init?.method ?? "GET"),
        url: requestUrl(url),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (calls.length === 1) return jsonResponse([]);
      if (calls.length === 2) return jsonResponse({ forgotPasswordMethods: [] });
      if (calls.length === 3) return jsonResponse({ id: "connector-1" });
      if (calls.length === 4) return jsonResponse({});
      throw new Error("unexpected fetch call");
    }) as typeof fetch;

    await reconcileForgotPasswordRelay(client, relay);

    expect(calls).toEqual([
      { method: "GET", url: "https://auth.example/api/connectors" },
      { method: "GET", url: "https://auth.example/api/sign-in-exp" },
      {
        method: "POST",
        url: "https://auth.example/api/connectors",
        body: {
          connectorId: "http-email",
          config: {
            endpoint: relay.webhookEndpoint,
            authorization: "Bearer relay-secret",
          },
        },
      },
      {
        method: "PATCH",
        url: "https://auth.example/api/sign-in-exp",
        body: { forgotPasswordMethods: ["EmailVerificationCode"] },
      },
    ]);
  });

  test("null forgotPasswordMethods preserves Logto fallback semantics (no PATCH)", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (url, init) => {
      methods.push(String(init?.method ?? "GET"));
      const s = requestUrl(url);
      if (s.endsWith("/api/connectors")) return jsonResponse([]);
      if (s.endsWith("/api/sign-in-exp")) return jsonResponse({ forgotPasswordMethods: null });
      return jsonResponse({ id: "connector-1" });
    }) as typeof fetch;

    await reconcileForgotPasswordRelay(client, relay);

    expect(methods).toEqual(["GET", "GET", "POST"]);
  });

  test("operator-owned http-email endpoint conflict throws before POST/PATCH", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const s = requestUrl(url);
      calls.push(`${String(init?.method ?? "GET")} ${s}`);
      if (s.endsWith("/api/connectors")) {
        return jsonResponse([
          {
            id: "operator-http",
            connectorId: "http-email",
            type: "Email",
            config: { endpoint: "https://operator.example/mail", authorization: "Bearer x" },
          },
        ]);
      }
      if (s.endsWith("/api/sign-in-exp")) return jsonResponse({ forgotPasswordMethods: [] });
      throw new Error("POST/PATCH should not happen");
    }) as typeof fetch;

    let threw = false;
    try {
      await reconcileForgotPasswordRelay(client, relay);
    } catch (err) {
      threw = /operator-owned email connector/.test(err instanceof Error ? err.message : String(err));
    }
    expect(threw).toBe(true);
    expect(calls).toEqual([
      "GET https://auth.example/api/connectors",
      "GET https://auth.example/api/sign-in-exp",
    ]);
  });
});

describe("M120 — OSS relay Logto custom phrases", () => {
  const client = { base: "https://auth.example", token: "m2m-token" };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function requestUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  test("bootstrap applies OSS relay phrases through the Logto DB bootstrap path", () => {
    const source = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf8");
    expect(source).toContain("reconcileOssRelayForgotPasswordPhrasesInLogtoDb(postgresUrl)");
  });

  test("creates English custom phrases for the OSS relay verification screen", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({
        method: String(init?.method ?? "GET"),
        url: requestUrl(url),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (calls.length === 1) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ ok: true }, 201);
    }) as typeof fetch;

    await reconcileOssRelayForgotPasswordPhrases(client);

    expect(calls).toEqual([
      {
        method: "GET",
        url: "https://auth.example/api/custom-phrases/en",
      },
      {
        method: "PUT",
        url: "https://auth.example/api/custom-phrases/en",
        body: {
          description: {
            verify_email: "Enter verification code",
            enter_passcode: "Enter the verification code shown in Nautilo for {{target}}.",
          },
        },
      },
    ]);
  });

  test("preserves operator custom phrases while replacing confusing email copy", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({
        method: String(init?.method ?? "GET"),
        url: requestUrl(url),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (calls.length === 1) {
        return jsonResponse({
          translation: {
            input: { username: "Handle" },
            description: {
              verify_email: "Verify your email",
              custom_note: "Keep me",
            },
          },
        });
      }
      return jsonResponse({ ok: true }, 201);
    }) as typeof fetch;

    await reconcileOssRelayForgotPasswordPhrases(client);

    expect(calls[1]).toEqual({
      method: "PUT",
      url: "https://auth.example/api/custom-phrases/en",
      body: {
        input: { username: "Handle" },
        description: {
          verify_email: "Enter verification code",
          custom_note: "Keep me",
          enter_passcode: "Enter the verification code shown in Nautilo for {{target}}.",
        },
      },
    });
  });
});
